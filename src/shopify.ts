import { ResearchError } from './errors.ts';

export type Target =
  | { kind: 'store'; origin: string; hostname: string; variantId?: string }
  | { kind: 'product'; origin: string; hostname: string; handle: string; variantId?: string };

export interface Variant {
  id: number;
  title: string;
  sku: string | null;
  price: number;
  compareAtPrice: number | null;
  available: boolean | null;
}

export interface Product {
  id: number | null;
  title: string;
  handle: string;
  url: string;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  description: string;
  createdAt: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  available: boolean | null;
  priceMin: number | null;
  priceMax: number | null;
  compareAtPriceMax: number | null;
  onSale: boolean;
  maxDiscountPercent: number;
  options: Array<{ name: string; values: string[] }>;
  variants: Variant[];
  images: string[];
}

export interface StoreMeta {
  name: string | null;
  domain: string | null;
  myshopifyDomain: string | null;
  currency: string | null;
  country: string | null;
  description: string | null;
  publishedProductsCount: number | null;
  publishedCollectionsCount: number | null;
}

const DESCRIPTION_MAX = 500;

export function parseTarget(input: string): Target {
  let raw = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ResearchError(400, 'invalid_url', 'url must be a valid store or product URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ResearchError(400, 'invalid_url', 'url must use http or https');
  }
  // Matches /products/x, /collections/y/products/x and locale-prefixed paths.
  const match = /\/products\/([^/]+?)(?:\.(?:js|json|oembed|xml))?\/?$/.exec(url.pathname);
  const variant = url.searchParams.get('variant');
  const extra = variant && /^\d+$/.test(variant) ? { variantId: variant } : {};
  if (match) {
    return { kind: 'product', origin: url.origin, hostname: url.hostname, handle: match[1]!, ...extra };
  }
  return { kind: 'store', origin: url.origin, hostname: url.hostname, ...extra };
}

export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 1)}…` : text;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((t) => t.trim()).filter(Boolean);
  return [];
}

function absoluteUrl(src: string, origin: string): string {
  if (src.startsWith('//')) return `https:${src}`;
  return new URL(src, origin).toString();
}

function finalize(base: Omit<Product, 'priceMin' | 'priceMax' | 'compareAtPriceMax' | 'onSale' | 'maxDiscountPercent' | 'available'> & { available?: boolean | null }): Product {
  const prices = base.variants.map((v) => v.price);
  const compares = base.variants.map((v) => v.compareAtPrice).filter((c): c is number => c !== null);
  let maxDiscount = 0;
  for (const v of base.variants) {
    if (v.compareAtPrice && v.compareAtPrice > v.price) {
      maxDiscount = Math.max(maxDiscount, (1 - v.price / v.compareAtPrice) * 100);
    }
  }
  const availability = base.variants.map((v) => v.available).filter((a): a is boolean => a !== null);
  return {
    ...base,
    available: base.available ?? (availability.length ? availability.some(Boolean) : null),
    priceMin: prices.length ? Math.min(...prices) : null,
    priceMax: prices.length ? Math.max(...prices) : null,
    compareAtPriceMax: compares.length ? Math.max(...compares) : null,
    onSale: maxDiscount > 0,
    maxDiscountPercent: Math.round(maxDiscount),
  };
}

type Json = Record<string, any>;

/** Normalizes a product from `/products.json` (prices are decimal strings). */
export function fromProductsJson(p: Json, origin: string): Product {
  return finalize({
    id: toNumber(p.id),
    title: String(p.title ?? ''),
    handle: String(p.handle ?? ''),
    url: `${origin}/products/${p.handle}`,
    vendor: p.vendor || null,
    productType: p.product_type || null,
    tags: toTags(p.tags),
    description: htmlToText(p.body_html),
    createdAt: p.created_at ?? null,
    publishedAt: p.published_at ?? null,
    updatedAt: p.updated_at ?? null,
    options: (p.options ?? []).map((o: Json) => ({ name: String(o.name), values: (o.values ?? []).map(String) })),
    variants: (p.variants ?? []).map((v: Json) => ({
      id: Number(v.id),
      title: String(v.title ?? ''),
      sku: v.sku || null,
      price: toNumber(v.price) ?? 0,
      compareAtPrice: toNumber(v.compare_at_price),
      available: typeof v.available === 'boolean' ? v.available : null,
    })),
    images: (p.images ?? []).map((i: Json) => absoluteUrl(String(i.src), origin)),
  });
}

/** Normalizes a product from the AJAX `/products/<handle>.js` API (prices are in cents). */
export function fromProductJs(p: Json, origin: string): Product {
  const cents = (v: unknown) => {
    const n = toNumber(v);
    return n === null ? null : round2(n / 100);
  };
  return finalize({
    id: toNumber(p.id),
    title: String(p.title ?? ''),
    handle: String(p.handle ?? ''),
    url: `${origin}/products/${p.handle}`,
    vendor: p.vendor || null,
    productType: p.type || null,
    tags: toTags(p.tags),
    description: htmlToText(p.description),
    createdAt: p.created_at ?? null,
    publishedAt: p.published_at ?? null,
    updatedAt: null,
    available: typeof p.available === 'boolean' ? p.available : null,
    options: (p.options ?? []).map((o: Json) => ({ name: String(o.name), values: (o.values ?? []).map(String) })),
    variants: (p.variants ?? []).map((v: Json) => ({
      id: Number(v.id),
      title: String(v.title ?? ''),
      sku: v.sku || null,
      price: cents(v.price) ?? 0,
      compareAtPrice: cents(v.compare_at_price),
      available: typeof v.available === 'boolean' ? v.available : null,
    })),
    images: (p.images ?? []).map((src: unknown) => absoluteUrl(String(src), origin)),
  });
}

export interface PageExtract {
  jsonLd: unknown[];
  meta: Record<string, string>;
}

/** Last-resort normalization from a rendered product page's JSON-LD / OpenGraph tags. */
export function fromProductPage(extract: PageExtract, url: string, handle: string): Product | null {
  const node = findProductNode(extract.jsonLd);
  const meta = extract.meta;
  // Missing products often redirect to a collection/home page; don't mistake that for a product.
  if (!node && meta['og:type'] !== 'product') return null;
  const title = node?.name ?? meta['og:title'];
  if (!title) return null;

  const offers: Json[] = [node?.offers ?? []].flat().flatMap((o: Json) => (o?.offers ? [o.offers].flat() : [o]));
  const variants: Variant[] = offers
    .map((o, i): Variant | null => {
      const price = toNumber(o.price ?? o.lowPrice);
      if (price === null) return null;
      return {
        id: toNumber(o.sku) ?? i,
        title: String(o.name ?? title),
        sku: o.sku ? String(o.sku) : null,
        price,
        compareAtPrice: null,
        available: typeof o.availability === 'string' ? /InStock|PreOrder|LimitedAvailability/i.test(o.availability) : null,
      };
    })
    .filter((v): v is Variant => v !== null);
  const metaPrice = toNumber(meta['og:price:amount'] ?? meta['product:price:amount']);
  if (!variants.length && metaPrice !== null) {
    variants.push({ id: 0, title: String(title), sku: null, price: metaPrice, compareAtPrice: null, available: null });
  }
  const images = [node?.image ?? meta['og:image'] ?? []]
    .flat()
    .map((i: unknown) => (typeof i === 'string' ? i : (i as Json)?.url))
    .filter((i): i is string => typeof i === 'string')
    .map((i) => absoluteUrl(i, url));
  const brand = node?.brand;

  return finalize({
    id: null,
    title: String(title),
    handle,
    url,
    vendor: (typeof brand === 'string' ? brand : brand?.name) ?? null,
    productType: node?.category ?? null,
    tags: [],
    description: htmlToText(node?.description ?? meta['og:description']),
    createdAt: null,
    publishedAt: null,
    updatedAt: null,
    options: [],
    variants,
    images: [...new Set(images)],
  });
}

function findProductNode(nodes: unknown[]): Json | null {
  const queue = [...nodes];
  while (queue.length) {
    const node = queue.shift();
    if (Array.isArray(node)) {
      queue.push(...node);
    } else if (node && typeof node === 'object') {
      const obj = node as Json;
      const type = [obj['@type']].flat();
      if (type.includes('Product') || type.includes('ProductGroup')) return obj;
      if (obj['@graph']) queue.push(obj['@graph']);
    }
  }
  return null;
}

export function fromMetaJson(m: Json | null): StoreMeta | null {
  if (!m || typeof m !== 'object') return null;
  return {
    name: m.name ?? null,
    domain: m.domain ?? null,
    myshopifyDomain: m.myshopify_domain ?? null,
    currency: m.currency ?? null,
    country: m.country ?? null,
    description: m.description || null,
    publishedProductsCount: toNumber(m.published_products_count),
    publishedCollectionsCount: toNumber(m.published_collections_count),
  };
}

function topCounts(values: string[], n: number) {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

export function summarize(products: Product[]) {
  const prices = products.map((p) => p.priceMin).filter((p): p is number => p !== null).sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  const brief = (p: Product) => ({ title: p.title, url: p.url, priceMin: p.priceMin });

  return {
    productsAnalyzed: products.length,
    availableCount: products.filter((p) => p.available === true).length,
    soldOutCount: products.filter((p) => p.available === false).length,
    onSaleCount: products.filter((p) => p.onSale).length,
    price: prices.length
      ? {
          min: prices[0]!,
          max: prices[prices.length - 1]!,
          average: round2(prices.reduce((s, p) => s + p, 0) / prices.length),
          median: prices.length % 2 ? prices[mid]! : round2((prices[mid - 1]! + prices[mid]!) / 2),
        }
      : null,
    topVendors: topCounts(products.map((p) => p.vendor ?? ''), 10),
    topProductTypes: topCounts(products.map((p) => p.productType ?? ''), 10),
    topTags: topCounts(products.flatMap((p) => p.tags), 20),
    newestProducts: products
      .filter((p) => p.publishedAt)
      .sort((a, b) => Date.parse(b.publishedAt!) - Date.parse(a.publishedAt!))
      .slice(0, 10)
      .map((p) => ({ ...brief(p), publishedAt: p.publishedAt })),
    biggestDiscounts: products
      .filter((p) => p.onSale)
      .sort((a, b) => b.maxDiscountPercent - a.maxDiscountPercent)
      .slice(0, 10)
      .map((p) => ({ ...brief(p), maxDiscountPercent: p.maxDiscountPercent })),
  };
}
