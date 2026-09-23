/**
 * Parses Shopify's one-page checkout HTML. The server-rendered page embeds the
 * negotiated order ("seller proposal") as HTML-escaped JSON in
 * `<meta name="serialized-graphql">`, so no checkout JavaScript needs to run.
 */

export interface CheckoutIssue {
  code: string;
  message: string;
}

export interface ShippingOption {
  title: string;
  carrier: string | null;
  methodType: string | null;
  price: number | null;
  minDeliveryDate: string | null;
  maxDeliveryDate: string | null;
}

export interface ShippingAddress {
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  zip: string | null;
  country: string | null;
}

export interface CheckoutResult {
  currency: string | null;
  /** Unit price the buyer actually pays at checkout, after automatic discounts. */
  price: number | null;
  /** Null until a shipping address is known. */
  shipping: number | null;
  tax: number | null;
  total: number | null;
  listPrice: number | null;
  compareAtPrice: number | null;
  subtotal: number | null;
  savings: number | null;
  available: boolean;
  shippingMethod: ShippingOption | null;
  shippingOptions: ShippingOption[];
  shippingAddress: ShippingAddress | null;
  issues: CheckoutIssue[];
  items: Array<{ title: string; variant: string | null; variantId: number | null; quantity: number; total: number | null }>;
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
  const shop = (readMeta(html, 'serialized-shop') ?? {}) as Json;
  return {
    ...fromNegotiation(negotiation, origin),
    store: { name: shop.name ?? null, domain: shop.domain ?? null },
  };
}

/** Status of a live `Proposal` GraphQL response from the running checkout app. */
export type ProposalState =
  | { kind: 'ignore' }
  | { kind: 'pending'; negotiation: Json }
  | { kind: 'ready'; negotiation: Json }
  | { kind: 'blocked'; reason: string };

export function classifyProposal(body: unknown): ProposalState {
  const negotiate = (body as Json)?.data?.session?.negotiate;
  if (!negotiate?.result) return { kind: 'ignore' };
  const type = String(negotiate.result.__typename ?? '');
  if (!negotiate.result.sellerProposal) {
    // Throttled / queue / checkpoint (bot challenge) results carry no proposal.
    return /Throttl|Queue|Checkpoint|Captcha/i.test(type) ? { kind: 'blocked', reason: type } : { kind: 'ignore' };
  }
  const seller: Json = negotiate.result.sellerProposal;
  const delivery: Json | undefined = seller.delivery;
  const errors: Json[] = Array.isArray(negotiate.errors) ? negotiate.errors : [];
  const codes = errors.map((e) => String(e.code ?? ''));
  if (codes.some((c) => /^MERCHANDISE_(OUT_OF_STOCK|NOT_ENOUGH_STOCK|UNAVAILABLE)/.test(c))) {
    return { kind: 'ready', negotiation: negotiate };
  }
  if (delivery?.__typename !== 'FilledDeliveryTerms') {
    // Items that don't ship still produce a final total.
    const needsShipping = seller.isShippingRequired !== false;
    return !needsShipping && money(seller.checkoutTotal) ? { kind: 'ready', negotiation: negotiate } : { kind: 'pending', negotiation: negotiate };
  }
  const lines: Json[] = Array.isArray(delivery.deliveryLines) ? delivery.deliveryLines : [];
  // No rates plus a delivery error (unshippable or incomplete address) won't resolve by waiting.
  if (lines.every((l) => !l.availableDeliveryStrategies?.length) && codes.some(isDeliveryIssue)) {
    return { kind: 'ready', negotiation: negotiate };
  }
  const allSelected = lines.every((l) => l.selectedDeliveryStrategy?.handle);
  return { kind: allSelected && money(seller.checkoutTotal) !== null ? 'ready' : 'pending', negotiation: negotiate };
}

function isDeliveryIssue(code: string): boolean {
  // DELIVERY_DELIVERY_LINE_DETAIL_CHANGED is routine noise when lines are re-negotiated.
  return /^DELIVERY_/.test(code) && code !== 'DELIVERY_DELIVERY_LINE_DETAIL_CHANGED';
}

function strategyToOption(s: Json): ShippingOption {
  return {
    title: String(s.title ?? s.code ?? ''),
    carrier: s.carrierName || null,
    methodType: s.methodType ?? null,
    price: money(s.amountAfterDiscounts)?.amount ?? money(s.amount)?.amount ?? null,
    minDeliveryDate: s.minDeliveryDateTime ?? null,
    maxDeliveryDate: s.maxDeliveryDateTime ?? null,
  };
}

function toAddress(a: Json | null | undefined): ShippingAddress | null {
  if (!a || typeof a !== 'object') return null;
  const v = (x: unknown) => (typeof x === 'string' && x !== '' ? x : null);
  return {
    address1: v(a.address1),
    address2: v(a.address2),
    city: v(a.city),
    province: v(a.zoneCode),
    zip: v(a.postalCode),
    country: v(a.countryCode),
  };
}

export function fromNegotiation(negotiation: Json, origin: string): Omit<CheckoutResult, 'store'> {
  const seller: Json = negotiation.result.sellerProposal;
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
    .filter((e: Json) => /^MERCHANDISE_/.test(e.code ?? '') || /^\$\.merchandise/.test(e.target ?? '') || isDeliveryIssue(e.code ?? ''))
    .map((e: Json) => ({ code: String(e.code), message: String(e.nonLocalizedMessage ?? e.localizedMessage ?? '') }));

  const deliveryLines: Json[] =
    seller.delivery?.__typename === 'FilledDeliveryTerms' && Array.isArray(seller.delivery.deliveryLines)
      ? seller.delivery.deliveryLines
      : [];
  const selected = deliveryLines
    .map((l) => (l.availableDeliveryStrategies ?? []).find((s: Json) => s.handle && s.handle === l.selectedDeliveryStrategy?.handle))
    .filter((s): s is Json => Boolean(s));
  const shippingOptions = (deliveryLines[0]?.availableDeliveryStrategies ?? []).map(strategyToOption);
  const selectedOptions = selected.map(strategyToOption);
  const shipping =
    selectedOptions.length && selectedOptions.length === deliveryLines.length && selectedOptions.every((o) => o.price !== null)
      ? round2(selectedOptions.reduce((s, o) => s + o.price!, 0))
      : null;

  // "<field> required" violations are about placing the order, not pricing; only surface them if they blocked rates.
  const soldOut = issues.some((i) => /^MERCHANDISE_/.test(i.code));
  const relevantIssues =
    shipping === null && !soldOut ? issues : issues.filter((i) => !/^DELIVERY_(.*_REQUIRED|NO_DELIVERY_STRATEGY_AVAILABLE)$/.test(i.code));

  const currency =
    money(seller.subtotalBeforeTaxesAndShipping)?.currency ??
    money(merch?.price)?.currency ??
    seller.buyerIdentity?.customer?.presentmentCurrency ??
    null;

  return {
    currency,
    price,
    shipping,
    tax: money(seller.tax?.totalTaxAmount)?.amount ?? null,
    total: money(seller.checkoutTotal)?.amount ?? money(seller.runningTotal)?.amount ?? null,
    listPrice: money(merch?.price)?.amount ?? null,
    compareAtPrice: money(merch?.compareAtPrice)?.amount ?? null,
    subtotal: money(seller.subtotalBeforeTaxesAndShipping)?.amount ?? null,
    savings: money(seller.totalSavings)?.amount ?? null,
    available: Boolean(line) && !relevantIssues.some((i) => /OUT_OF_STOCK|UNAVAILABLE|NOT_ENOUGH_STOCK/.test(i.code)),
    shippingMethod: selectedOptions[0] ?? null,
    shippingOptions,
    shippingAddress: toAddress(deliveryLines[0]?.destinationAddress),
    issues: relevantIssues,
    items: lines.map((l) => ({
      title: String(l.merchandise?.title ?? ''),
      variant: l.merchandise?.subtitle || null,
      variantId: gidNumber(l.merchandise?.variantId),
      quantity: Number(l.quantity?.items?.value ?? 1),
      total: money(l.totalAmount)?.amount ?? null,
    })),
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
  };
}
