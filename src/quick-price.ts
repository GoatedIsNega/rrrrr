import type { BrowserContext, Page, Route } from 'playwright';
import { AssetCache } from './asset-cache.ts';
import type { BrowserSessions } from './browser.ts';
import { classifyProposal, fromNegotiation, isCheckoutPage, parseCheckout, type CheckoutResult, type ProposalState } from './checkout.ts';
import { ResearchError } from './errors.ts';
import { getJson, isPasswordPage, passwordError } from './research.ts';
import { parseTarget, type Target } from './shopify.ts';
import { assertPublicHost } from './url-guard.ts';

export const ADDRESS_FIELDS = ['country', 'zip', 'province', 'city', 'address1', 'address2', 'first_name', 'last_name', 'phone'] as const;
type AddressField = (typeof ADDRESS_FIELDS)[number];
export type ShippingAddressInput = Partial<Record<AddressField, string>> & { country: string };

export type QuickPriceRequest = Partial<Record<AddressField | 'state' | 'email', string>> & {
  site: string;
  variant?: string;
};

export interface QuickPriceDeps {
  sessions: BrowserSessions;
  allowPrivateHosts: boolean;
  assetCache: AssetCache | null;
}

interface CheckoutOptions {
  address: ShippingAddressInput | null;
  email: string | undefined;
  assetCache: AssetCache | null;
  deadline: number;
}

/** Headroom kept before the request deadline to return whatever checkout has computed so far. */
const PARTIAL_RESULT_MARGIN_MS = 400;
const BLOCKED_TYPES = new Set(['image', 'font', 'media', 'stylesheet']);

type Json = Record<string, any>;

/** Auto-picked variants tried before giving up (stores may reject e.g. gift-with-purchase items). */
const MAX_ATTEMPTS = 3;

/**
 * Real checkout price for one variant: adds it to a brand-new cart through the
 * `/cart/<variantId>:1` permalink and reads the resulting checkout.
 */
export async function quickPrice(deps: QuickPriceDeps, req: QuickPriceRequest) {
  const started = performance.now();
  const target = parseTarget(req.site);
  const address = toAddress(req);
  const guard = deps.allowPrivateHosts ? Promise.resolve() : assertPublicHost(target.hostname);
  guard.catch(() => {});

  const result = await deps.sessions.run(async (ctx, deadline) => {
    await guard;
    const opts: CheckoutOptions = { address, email: req.email, assetCache: deps.assetCache, deadline };
    const explicit = req.variant ?? target.variantId;
    if (explicit) return checkout(ctx, target.origin, explicit, opts);

    const candidates = await pickVariants(ctx, target);
    for (const [i, variantId] of candidates.entries()) {
      try {
        return await checkout(ctx, target.origin, variantId, opts);
      } catch (err) {
        const retryable = err instanceof ResearchError && err.code === 'checkout_unavailable';
        if (!retryable || i === candidates.length - 1) throw err;
        await ctx.clearCookies();
      }
    }
    throw new ResearchError(404, 'product_not_found', 'Store has no purchasable products');
  });

  const { price, shipping, tax, total, currency, ...details } = result;
  return {
    price,
    shipping,
    tax,
    total,
    currency,
    timetaken: `${((performance.now() - started) / 1000).toFixed(2)}s`,
    ...details,
  };
}

function toAddress(req: QuickPriceRequest): ShippingAddressInput | null {
  const fields: Partial<Record<AddressField, string>> = { ...req, province: req.province ?? req.state };
  const given = ADDRESS_FIELDS.filter((f) => fields[f]);
  if (!given.length) return null;
  if (!fields.country) {
    throw new ResearchError(400, 'invalid_address', 'country is required when a shipping address is given');
  }
  const address = Object.fromEntries(given.map((f) => [f, fields[f]!.trim()])) as ShippingAddressInput;
  address.country = address.country.toUpperCase();
  return address;
}

/** Without an explicit variant, pick purchasable variants in order of preference. */
async function pickVariants(ctx: BrowserContext, target: Target): Promise<string[]> {
  if (target.kind === 'product') {
    const res = await getJson(ctx, `${target.origin}/products/${target.handle}.js`);
    if (isPasswordPage(res.finalUrl)) throw passwordError();
    const variants: Json[] = res.status === 200 && Array.isArray(res.data?.variants) ? res.data.variants : [];
    const pick = variants.find((v) => v.available) ?? variants[0];
    if (!pick) throw new ResearchError(404, 'product_not_found', 'Product not found on this store');
    return [String(pick.id)];
  }

  const res = await getJson(ctx, `${target.origin}/products.json?limit=20`);
  if (isPasswordPage(res.finalUrl)) throw passwordError();
  if (res.status === 429) throw new ResearchError(429, 'rate_limited', 'The store is rate limiting requests');
  const products: Json[] = res.status === 200 && Array.isArray(res.data?.products) ? res.data.products : [];
  if (!products.length) {
    throw new ResearchError(422, 'not_shopify', 'Could not list products; pass a product URL or ?variant=');
  }
  // Skip gift cards and $0 add-ons (e.g. shipping protection), which can't be checked out alone.
  const eligible = products.filter((p) => !/gift ?card/i.test(`${p.product_type} ${p.title}`));
  const rank = (v: Json) => (v.available && Number(v.price) > 0 ? (v.requires_shipping !== false ? 0 : 1) : 2);
  // One variant per product, so a retry tries a different product.
  const picks = eligible
    .map((p) => ((p.variants ?? []) as Json[]).slice().sort((a, b) => rank(a) - rank(b))[0])
    .filter((v): v is Json => Boolean(v))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, MAX_ATTEMPTS);
  if (!picks.length) throw new ResearchError(404, 'product_not_found', 'Store has no purchasable products');
  return picks.map((v) => String(v.id));
}

function cartUrl(origin: string, variantId: string, opts: CheckoutOptions): string {
  // skip_shop_pay avoids an extra redirect hop through shop.app.
  const params = new URLSearchParams({ skip_shop_pay: 'true' });
  // Shopify's documented cart-permalink prefill parameters.
  if (opts.email) params.set('checkout[email]', opts.email);
  for (const [field, value] of Object.entries(opts.address ?? {})) {
    params.set(`checkout[shipping_address][${field}]`, value);
  }
  return `${origin}/cart/${variantId}:1?${params}`;
}

async function checkout(ctx: BrowserContext, origin: string, variantId: string, opts: CheckoutOptions): Promise<CheckoutResult> {
  if (!/^\d+$/.test(variantId)) throw new ResearchError(400, 'invalid_variant', 'variant must be a numeric variant ID');
  const page = await ctx.newPage();
  const proposal = opts.address ? watchProposals(page) : null;
  try {
    if (opts.address) {
      const firstParty = new Set([new URL(origin).hostname]);
      // Route handlers don't see redirects, and checkout often lives on another host (e.g. checkout.brand.com).
      page.on('request', (req) => {
        if (req.isNavigationRequest() && req.frame() === page.mainFrame()) firstParty.add(new URL(req.url()).hostname);
      });
      await page.route('**/*', (route) => routeCheckoutApp(route, page, firstParty, opts.assetCache));
      const cache = opts.assetCache;
      if (cache) {
        page.on('response', (res) => {
          const key = res.request().method() === 'GET' && res.status() === 200 ? AssetCache.keyFor(res.url()) : null;
          if (key && !cache.has(key)) {
            res.body().then((body) => cache.set(key, res.status(), res.headers(), body), () => {});
          }
        });
      }
    } else {
      // Without an address the price is already in the server-rendered document; no JS/CSS/images needed.
      await page.route('**/*', (route) =>
        route.request().resourceType() === 'document' ? route.continue() : route.abort(),
      );
    }

    const res = await page.goto(cartUrl(origin, variantId, opts), { waitUntil: 'commit' });
    if (!res) throw new ResearchError(502, 'no_response', 'No response from the store');
    const finalUrl = res.url();
    if (isPasswordPage(finalUrl)) throw passwordError();
    if (res.status() === 404 || res.status() === 410) {
      throw new ResearchError(404, 'variant_not_found', `Variant ${variantId} does not exist on this store`);
    }
    if (res.status() === 429) throw new ResearchError(429, 'rate_limited', 'The store is rate limiting requests');

    const html = (await res.body()).toString('utf8');
    const checkoutOrigin = new URL(finalUrl).origin;
    const parsed = isCheckoutPage(html) ? parseCheckout(html, checkoutOrigin) : null;
    if (!parsed) {
      throw new ResearchError(
        502,
        'checkout_unavailable',
        'The store did not open a checkout for this variant (cart rules or bot protection may have blocked it)',
      );
    }
    // Sold-out lines never get shipping rates, so there's nothing to wait for.
    if (!proposal || !parsed.available) return parsed;

    // Shipping and tax are only negotiated by the checkout app once it applies the prefilled address.
    const state = await proposal.settled(opts.deadline - PARTIAL_RESULT_MARGIN_MS - Date.now());
    if (state.kind === 'blocked') {
      throw new ResearchError(503, 'checkout_blocked', `Checkout did not compute totals (${state.reason})`);
    }
    const partial = state.kind !== 'ready';
    const negotiation = state.kind === 'ready' ? state.negotiation : proposal.latest();
    const result = negotiation ? { ...fromNegotiation(negotiation, checkoutOrigin), store: parsed.store } : parsed;
    if (partial) {
      result.issues.push({ code: 'SHIPPING_NOT_CALCULATED', message: 'Checkout did not return shipping costs before the timeout' });
    }
    return result;
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    await page.close().catch(() => {});
  }
}

/** Resolves with the first `Proposal` response that has final shipping, tax and total. */
function watchProposals(page: Page) {
  let latest: Record<string, any> | null = null;
  let resolve!: (state: ProposalState) => void;
  const done = new Promise<ProposalState>((r) => (resolve = r));

  page.on('response', async (res) => {
    if (!res.url().includes('operationName=Proposal')) return;
    let state: ProposalState;
    try {
      state = classifyProposal(await res.json());
    } catch {
      return;
    }
    if (state.kind === 'pending') latest = state.negotiation;
    // Later proposals can include add-ons inserted by checkout extensions; the first final one is the cart itself.
    else if (state.kind === 'ready' || state.kind === 'blocked') resolve(state);
  });

  return {
    latest: () => latest,
    settled(timeoutMs: number): Promise<ProposalState> {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<ProposalState>((r) => {
        timer = setTimeout(() => r({ kind: 'ignore' }), Math.max(0, timeoutMs));
      });
      return Promise.race([done, timeout]).finally(() => clearTimeout(timer));
    },
  };
}

/**
 * Lets the checkout app run while cutting everything it doesn't need to compute totals:
 * images/fonts/CSS, third-party hosts (analytics, checkout UI extensions that inject
 * upsells), and repeat downloads of its immutable bundles.
 * Same-origin web pixels must stay allowed: checkout waits ~10s for them before negotiating.
 */
async function routeCheckoutApp(route: Route, page: Page, firstParty: Set<string>, cache: AssetCache | null) {
  const req = route.request();
  try {
    const url = new URL(req.url());
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) return await route.continue();
    if (BLOCKED_TYPES.has(req.resourceType())) return await route.abort();
    const host = url.hostname;
    const allowed = firstParty.has(host) || host === 'cdn.shopify.com' || host === new URL(page.mainFrame().url()).hostname;
    if (!allowed) return await route.abort();

    const key = cache && req.method() === 'GET' ? AssetCache.keyFor(req.url()) : null;
    const hit = key ? cache!.get(key) : undefined;
    if (hit) return await route.fulfill({ status: hit.status, headers: hit.headers, body: hit.body });
    // Misses load natively (parallel, HTTP/2) and are stored from the 'response' event.
    return await route.continue();
  } catch {
    // Page/context closed mid-request.
    await route.abort().catch(() => {});
  }
}
