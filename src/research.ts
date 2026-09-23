import type { BrowserContext } from 'playwright';
import type { BrowserSessions } from './browser.ts';
import { ResearchError } from './errors.ts';
import {
  fromMetaJson,
  fromProductJs,
  fromProductPage,
  fromProductsJson,
  parseTarget,
  summarize,
  type PageExtract,
  type Target,
} from './shopify.ts';
import { assertPublicHost } from './url-guard.ts';

const PAGE_SIZE = 250; // Shopify's max for /products.json

export interface ResearchRequest {
  url: string;
  limit: number;
}

export interface ResearchDeps {
  sessions: BrowserSessions;
  allowPrivateHosts: boolean;
}

interface JsonResult {
  status: number;
  finalUrl: string;
  isShopify: boolean;
  data: any;
}

export async function research(deps: ResearchDeps, req: ResearchRequest) {
  const started = performance.now();
  const target = parseTarget(req.url);
  // DNS check overlaps with fresh-session creation; it must pass before any navigation.
  const guard = deps.allowPrivateHosts ? Promise.resolve() : assertPublicHost(target.hostname);
  guard.catch(() => {});

  const result = await deps.sessions.run(async (ctx) => {
    await guard;
    return target.kind === 'product' ? researchProduct(ctx, target) : researchStore(ctx, target, req.limit);
  });

  return { ...result, freshSession: true, tookMs: Math.round(performance.now() - started) };
}

async function researchStore(ctx: BrowserContext, target: Extract<Target, { kind: 'store' }>, limit: number) {
  const pageCount = Math.ceil(limit / PAGE_SIZE);
  const perPage = Math.min(limit, PAGE_SIZE);
  const pageUrls = Array.from(
    { length: pageCount },
    (_, i) => `${target.origin}/products.json?limit=${perPage}&page=${i + 1}`,
  );

  // Everything is fetched in parallel, each on its own tab of the same fresh session.
  const [meta, ...pages] = await Promise.all([
    getJson(ctx, `${target.origin}/meta.json`).catch(() => null),
    ...pageUrls.map((url) => getJson(ctx, url)),
  ]);

  const first = pages[0]!;
  assertShopifyJson(first, 'products');
  // Use the canonical domain the store redirected to (e.g. apex -> www).
  const origin = new URL(first.finalUrl).origin;

  const products = [];
  for (const page of pages) {
    const batch = Array.isArray(page.data?.products) ? page.data.products : [];
    if (!batch.length) break;
    products.push(...batch);
  }
  const normalized = products.slice(0, limit).map((p) => fromProductsJson(p, origin));

  return {
    kind: 'store' as const,
    source: 'products.json',
    store: { url: origin, ...fromMetaJson(meta?.status === 200 ? meta.data : null) },
    summary: summarize(normalized),
    products: normalized,
  };
}

async function researchProduct(ctx: BrowserContext, target: Extract<Target, { kind: 'product' }>) {
  const productUrl = `${target.origin}/products/${target.handle}`;
  const [meta, js] = await Promise.all([
    getJson(ctx, `${target.origin}/meta.json`).catch(() => null),
    getJson(ctx, `${productUrl}.js`).catch(() => null),
  ]);
  const store = { url: target.origin, ...fromMetaJson(meta?.status === 200 ? meta.data : null) };

  if (js?.status === 200 && js.data?.handle) {
    const origin = new URL(js.finalUrl).origin;
    return { kind: 'product' as const, source: 'product.js', store, product: fromProductJs(js.data, origin) };
  }
  if (js && isPasswordPage(js.finalUrl)) throw passwordError();

  // Some stores disable the AJAX API; fall back to the rendered page's structured data.
  const page = await extractProductPage(ctx, productUrl);
  const product = fromProductPage(page.extract, productUrl, target.handle);
  if (!product) throw new ResearchError(404, 'product_not_found', 'Product not found on this store');
  return { kind: 'product' as const, source: 'html', store, product };
}

export async function getJson(ctx: BrowserContext, url: string): Promise<JsonResult> {
  const page = await ctx.newPage();
  try {
    // 'commit' returns as soon as headers arrive; body() then waits only for the payload.
    const res = await page.goto(url, { waitUntil: 'commit' });
    if (!res) throw new ResearchError(502, 'no_response', `No response from ${url}`);
    const headers = await res.allHeaders();
    let data: unknown = null;
    // `/products/<handle>.js` is JSON served as text/javascript, so sniff instead of trusting content-type.
    if (!(headers['content-type'] ?? '').includes('html')) {
      try {
        data = JSON.parse((await res.body()).toString('utf8'));
      } catch {
        data = null;
      }
    }
    return {
      status: res.status(),
      finalUrl: res.url(),
      isShopify: Boolean(headers['x-shopid'] || headers['x-shopify-stage'] || /shopify/i.test(headers['powered-by'] ?? '')),
      data,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function extractProductPage(ctx: BrowserContext, url: string): Promise<{ status: number; extract: PageExtract }> {
  const page = await ctx.newPage();
  try {
    // Only the HTML document is needed; skipping subresources keeps this fast.
    await page.route('**/*', (route) =>
      route.request().resourceType() === 'document' ? route.continue() : route.abort(),
    );
    const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (res && isPasswordPage(res.url())) throw passwordError();
    const extract = await page.evaluate(() => {
      const jsonLd: unknown[] = [];
      for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          jsonLd.push(JSON.parse(el.textContent ?? ''));
        } catch {
          // ignore malformed blocks
        }
      }
      const meta: Record<string, string> = {};
      for (const el of document.querySelectorAll('meta[property], meta[name]')) {
        const key = el.getAttribute('property') ?? el.getAttribute('name');
        const value = el.getAttribute('content');
        if (key && value && !(key in meta)) meta[key] = value;
      }
      return { jsonLd, meta };
    });
    return { status: res?.status() ?? 0, extract };
  } finally {
    await page.close().catch(() => {});
  }
}

function assertShopifyJson(res: JsonResult, key: string): void {
  if (isPasswordPage(res.finalUrl)) throw passwordError();
  if (res.status === 429) throw new ResearchError(429, 'rate_limited', 'The store is rate limiting requests');
  if (res.status === 401 || res.status === 403) {
    throw new ResearchError(502, 'blocked_by_store', `The store refused the request (HTTP ${res.status})`);
  }
  if (res.status !== 200 || !Array.isArray(res.data?.[key])) {
    throw new ResearchError(
      422,
      'not_shopify',
      res.isShopify
        ? 'This Shopify store does not expose its public product catalog'
        : 'URL does not look like a Shopify storefront',
    );
  }
}

export function isPasswordPage(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/$/, '') === '/password';
  } catch {
    return false;
  }
}

export function passwordError(): ResearchError {
  return new ResearchError(423, 'password_protected', 'The store is password protected');
}
