import type { BrowserContext } from 'playwright';
import type { BrowserSessions } from './browser.ts';
import { isCheckoutPage, parseCheckout } from './checkout.ts';
import { ResearchError } from './errors.ts';
import { getJson, isPasswordPage, passwordError } from './research.ts';
import { parseTarget, type Target } from './shopify.ts';
import { assertPublicHost } from './url-guard.ts';

export interface QuickPriceRequest {
  site: string;
  variant?: string;
}

export interface QuickPriceDeps {
  sessions: BrowserSessions;
  allowPrivateHosts: boolean;
}

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
  const guard = deps.allowPrivateHosts ? Promise.resolve() : assertPublicHost(target.hostname);
  guard.catch(() => {});

  const result = await deps.sessions.run(async (ctx) => {
    await guard;
    const explicit = req.variant ?? target.variantId;
    if (explicit) return checkout(ctx, target.origin, explicit);

    const candidates = await pickVariants(ctx, target);
    for (const [i, variantId] of candidates.entries()) {
      try {
        return await checkout(ctx, target.origin, variantId);
      } catch (err) {
        const retryable = err instanceof ResearchError && err.code === 'checkout_unavailable';
        if (!retryable || i === candidates.length - 1) throw err;
        await ctx.clearCookies();
      }
    }
    throw new ResearchError(404, 'product_not_found', 'Store has no purchasable products');
  });

  const { price, currency, ...details } = result;
  return {
    price,
    currency,
    timetaken: `${((performance.now() - started) / 1000).toFixed(2)}s`,
    ...details,
  };
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

async function checkout(ctx: BrowserContext, origin: string, variantId: string) {
  if (!/^\d+$/.test(variantId)) throw new ResearchError(400, 'invalid_variant', 'variant must be a numeric variant ID');
  const page = await ctx.newPage();
  try {
    // The price data is in the server-rendered document; checkout's JS, CSS and images aren't needed.
    await page.route('**/*', (route) =>
      route.request().resourceType() === 'document' ? route.continue() : route.abort(),
    );
    // skip_shop_pay avoids an extra redirect hop through shop.app.
    const res = await page.goto(`${origin}/cart/${variantId}:1?skip_shop_pay=true`, { waitUntil: 'commit' });
    if (!res) throw new ResearchError(502, 'no_response', 'No response from the store');
    const finalUrl = res.url();
    if (isPasswordPage(finalUrl)) throw passwordError();
    if (res.status() === 404 || res.status() === 410) {
      throw new ResearchError(404, 'variant_not_found', `Variant ${variantId} does not exist on this store`);
    }
    if (res.status() === 429) throw new ResearchError(429, 'rate_limited', 'The store is rate limiting requests');

    const html = (await res.body()).toString('utf8');
    const parsed = isCheckoutPage(html) ? parseCheckout(html, new URL(finalUrl).origin) : null;
    if (!parsed) {
      throw new ResearchError(
        502,
        'checkout_unavailable',
        'The store did not open a checkout for this variant (cart rules or bot protection may have blocked it)',
      );
    }
    return parsed;
  } finally {
    await page.close().catch(() => {});
  }
}
