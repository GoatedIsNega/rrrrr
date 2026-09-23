/**
 * Parses Shopify's one-page checkout HTML. The server-rendered page embeds the
 * negotiated order ("seller proposal") as HTML-escaped JSON in
 * `<meta name="serialized-graphql">`, so no checkout JavaScript needs to run.
 */

export interface CheckoutIssue {
  code: string;
  message: string;
}

export interface CheckoutResult {
  currency: string | null;
  /** Unit price the buyer actually pays at checkout, after automatic discounts. */
  price: number | null;
  listPrice: number | null;
  compareAtPrice: number | null;
  subtotal: number | null;
  total: number | null;
  tax: number | null;
  savings: number | null;
  available: boolean;
  issues: CheckoutIssue[];
  product: {
    title: string;
    variant: string | null;
    variantId: number | null;
    productId: number | null;
    sku: string | null;
    vendor: string | null;
    productType: string | null;
    url: string | null;
    image: string | null;
    options: Array<{ name: string; value: string }>;
    requiresShipping: boolean | null;
  } | null;
  store: { name: string | null; domain: string | null };
}

type Json = Record<string, any>;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeAttr(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function readMeta(html: string, name: string): unknown {
  const m = new RegExp(`<meta name="${name}" content="([^"]*)"`).exec(html);
  if (!m) return undefined;
  try {
    return JSON.parse(decodeAttr(m[1]!));
  } catch {
    return undefined;
  }
}

/** Query keys are hashed per deploy, so locate the negotiation node by shape. */
function findNegotiation(node: unknown, depth = 0): Json | null {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  const obj = node as Json;
  if (obj.result && typeof obj.result === 'object' && obj.result.sellerProposal) return obj;
  for (const value of Object.values(obj)) {
    const found = findNegotiation(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Money constraints are either `{ value: Money }` or an unresolved `AnyConstraint`. */
function money(value: Json | null | undefined): { amount: number; currency: string } | null {
  const m = value?.value ?? value;
  if (!m || m.amount === undefined) return null;
  const amount = Number(m.amount);
  return Number.isFinite(amount) ? { amount, currency: m.currencyCode } : null;
}

function gidNumber(gid: unknown): number | null {
  const m = /\/(\d+)$/.exec(String(gid ?? ''));
  return m ? Number(m[1]) : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function isCheckoutPage(html: string): boolean {
  return html.includes('<meta name="serialized-graphql"');
}

export function parseCheckout(html: string, origin: string): CheckoutResult | null {
  const negotiation = findNegotiation(readMeta(html, 'serialized-graphql'));
  if (!negotiation) return null;
  const seller: Json = negotiation.result.sellerProposal;
  const shop = (readMeta(html, 'serialized-shop') ?? {}) as Json;

  const lines: Json[] = Array.isArray(seller.merchandise?.merchandiseLines) ? seller.merchandise.merchandiseLines : [];
  const line = lines[0];
  const merch: Json | undefined = line?.merchandise;

  let price: number | null = null;
  const allocations: Json[] = line?.lineAllocations ?? [];
  const paid = allocations.map((a) => money(a.totalAmountAfterDiscounts)?.amount);
  const units = allocations.reduce((n, a) => n + (Number(a.quantity) || 0), 0);
  if (paid.length && paid.every((p) => p !== undefined) && units > 0) {
    price = round2((paid as number[]).reduce((s, p) => s + p, 0) / units);
  } else if (merch) {
    price = money(merch.price)?.amount ?? null;
  }

  const issues: CheckoutIssue[] = (Array.isArray(negotiation.errors) ? negotiation.errors : [])
    .filter((e: Json) => /^MERCHANDISE_/.test(e.code ?? '') || /^\$\.merchandise/.test(e.target ?? ''))
    .map((e: Json) => ({ code: String(e.code), message: String(e.nonLocalizedMessage ?? e.localizedMessage ?? '') }));

  const currency =
    money(seller.subtotalBeforeTaxesAndShipping)?.currency ??
    money(merch?.price)?.currency ??
    seller.buyerIdentity?.customer?.presentmentCurrency ??
    null;

  return {
    currency,
    price,
    listPrice: money(merch?.price)?.amount ?? null,
    compareAtPrice: money(merch?.compareAtPrice)?.amount ?? null,
    subtotal: money(seller.subtotalBeforeTaxesAndShipping)?.amount ?? null,
    total: money(seller.checkoutTotal)?.amount ?? money(seller.runningTotal)?.amount ?? null,
    tax: money(seller.tax?.totalTaxAmount)?.amount ?? null,
    savings: money(seller.totalSavings)?.amount ?? null,
    available: Boolean(line) && !issues.some((i) => /OUT_OF_STOCK|UNAVAILABLE|NOT_ENOUGH_STOCK/.test(i.code)),
    issues,
    product: merch
      ? {
          title: String(merch.title ?? ''),
          variant: merch.subtitle || null,
          variantId: gidNumber(merch.variantId),
          productId: gidNumber(merch.product?.id),
          sku: merch.sku || null,
          vendor: merch.product?.vendor || null,
          productType: merch.product?.productType || null,
          url: merch.productUrl ? new URL(merch.productUrl, origin).toString() : null,
          image: merch.image?.url ?? null,
          options: (merch.options ?? []).map((o: Json) => ({ name: String(o.name), value: String(o.value) })),
          requiresShipping: typeof merch.requiresShipping === 'boolean' ? merch.requiresShipping : null,
        }
      : null,
    store: { name: shop.name ?? null, domain: shop.domain ?? null },
  };
}
