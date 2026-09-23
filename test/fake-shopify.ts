import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeStore {
  origin: string;
  /** `setCookie` is a unique value per response, so cookies can be traced back to their session. */
  requests: Array<{ path: string; cookie: string | undefined; setCookie: string }>;
  close(): Promise<void>;
}

const products = [
  {
    id: 1,
    title: 'Blue Widget',
    handle: 'blue-widget',
    body_html: '<p>A <strong>blue</strong> widget &amp; more</p>',
    published_at: '2026-01-01T00:00:00Z',
    created_at: '2025-12-01T00:00:00Z',
    updated_at: '2026-02-01T00:00:00Z',
    vendor: 'Acme',
    product_type: 'Widgets',
    tags: ['blue', 'sale'],
    variants: [
      { id: 11, title: 'Small', sku: 'BW-S', price: '10.00', compare_at_price: '20.00', available: true },
      { id: 12, title: 'Large', sku: 'BW-L', price: '15.00', compare_at_price: null, available: false },
    ],
    images: [{ src: '//cdn.example.com/blue.jpg' }],
    options: [{ name: 'Size', values: ['Small', 'Large'] }],
  },
  {
    id: 2,
    title: 'Red Gadget',
    handle: 'red-gadget',
    body_html: '',
    published_at: '2026-03-01T00:00:00Z',
    created_at: '2026-03-01T00:00:00Z',
    updated_at: '2026-03-01T00:00:00Z',
    vendor: 'Acme',
    product_type: 'Gadgets',
    tags: ['red'],
    variants: [{ id: 21, title: 'Default Title', sku: '', price: '30.00', compare_at_price: null, available: false }],
    images: [],
    options: [{ name: 'Title', values: ['Default Title'] }],
  },
  {
    id: 3,
    title: 'Green Gizmo',
    handle: 'green-gizmo',
    body_html: 'Plain',
    published_at: '2025-06-01T00:00:00Z',
    created_at: '2025-06-01T00:00:00Z',
    updated_at: '2025-06-01T00:00:00Z',
    vendor: 'Globex',
    product_type: 'Gadgets',
    tags: ['green', 'sale'],
    variants: [{ id: 31, title: 'Default Title', sku: 'GG', price: '50.00', compare_at_price: '100.00', available: true }],
    images: [],
    options: [],
  },
];

const productJs = {
  id: 1,
  title: 'Blue Widget',
  handle: 'blue-widget',
  description: '<p>Blue</p>',
  published_at: '2026-01-01T00:00:00Z',
  created_at: '2025-12-01T00:00:00Z',
  vendor: 'Acme',
  type: 'Widgets',
  tags: ['blue'],
  available: true,
  variants: [{ id: 11, title: 'Small', sku: 'BW-S', price: 1000, compare_at_price: 2000, available: true }],
  images: ['//cdn.example.com/blue.jpg'],
  options: [{ name: 'Size', position: 1, values: ['Small'] }],
};

const htmlOnlyPage = `<!doctype html><html><head>
<meta property="og:type" content="product"><meta property="og:title" content="OG Title">
<link rel="stylesheet" href="/slow.css">
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'Organization', name: 'Acme' },
    {
      '@type': 'Product',
      name: 'Hidden Lamp',
      brand: { '@type': 'Brand', name: 'Lumen' },
      description: 'A lamp',
      image: ['https://cdn.example.com/lamp.jpg'],
      offers: [
        { '@type': 'Offer', price: '45.00', sku: 'L1', availability: 'https://schema.org/InStock' },
        { '@type': 'Offer', price: '55.00', sku: 'L2', availability: 'https://schema.org/OutOfStock' },
      ],
    },
  ],
})}</script></head><body>Lamp</body></html>`;

const homePage = '<!doctype html><html><head><meta property="og:type" content="website"><meta property="og:title" content="Home"></head></html>';

const money = (amount: string) => ({ amount, currencyCode: 'EUR', __typename: 'Money' });
const constraint = (amount: string) => ({ value: money(amount), __typename: 'MoneyValueConstraint' });
const attr = (value: unknown) => JSON.stringify(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

export const CHECKOUT_APP_PATH = '/cdn/shopifycloud/checkout-web/assets/c1/app.test123.js';

type Delivery = 'none' | 'pending' | 'unselected' | 'selected' | 'unshippable';
type Address = Record<string, string>;

function deliveryTerms(delivery: Delivery, address: Address, lineTotal: string) {
  if (delivery === 'none') return { __typename: 'UnavailableTerms' };
  if (delivery === 'pending') return { __typename: 'PendingTerms' };
  const strategies =
    delivery === 'unshippable'
      ? []
      : [
          { handle: 'std', title: 'Standard', methodType: 'SHIPPING', carrierName: 'Post', amount: constraint('5.0'), amountAfterDiscounts: constraint('5.0'), minDeliveryDateTime: '2026-10-01', maxDeliveryDateTime: '2026-10-05' },
          { handle: 'exp', title: 'Express', methodType: 'SHIPPING', carrierName: 'Post', amount: constraint('15.0'), amountAfterDiscounts: constraint('15.0'), minDeliveryDateTime: null, maxDeliveryDateTime: null },
        ];
  return {
    __typename: 'FilledDeliveryTerms',
    deliveryLines: [
      {
        destinationAddress: { address1: address.address1 ?? null, city: address.city ?? '', zoneCode: address.province ?? null, postalCode: address.zip ?? null, countryCode: address.country },
        selectedDeliveryStrategy: delivery === 'selected' ? { handle: 'std' } : null,
        availableDeliveryStrategies: strategies,
        targetMerchandise: { total: lineTotal },
      },
    ],
  };
}

/** Trimmed-down copy of Shopify's negotiation result (server-rendered and from `Proposal`). */
function negotiation(variantId: number, delivery: Delivery = 'none', address: Address = {}) {
  const soldOut = variantId === 12;
  const priced = delivery === 'selected';
  // 8% tax for NY once an address is known.
  const tax = priced && address.province === 'NY' ? '0.68' : '0.0';
  const total = priced ? (8.5 + 5 + Number(tax)).toFixed(2) : null;
  return {
    result: {
      __typename: 'NegotiationResultAvailable',
      buyerProposal: {},
      sellerProposal: {
        merchandise: {
          merchandiseLines: [
            {
              merchandise: {
                variantId: `gid://shopify/ProductVariant/${variantId}`,
                title: 'Blue Widget',
                subtitle: soldOut ? 'Large' : 'Small',
                sku: soldOut ? 'BW-L' : 'BW-S',
                price: money(soldOut ? '15.0' : '10.0'),
                compareAtPrice: soldOut ? null : money('20.0'),
                product: { id: 'gid://shopify/Product/1', vendor: 'Acme', productType: 'Widgets' },
                productUrl: '/products/blue-widget',
                image: { url: 'https://cdn.example.com/blue.jpg' },
                options: [{ name: 'Size', value: soldOut ? 'Large' : 'Small' }],
                requiresShipping: true,
              },
              quantity: { items: { value: 1 } },
              totalAmount: constraint(soldOut ? '15.0' : '8.5'),
              lineAllocations: [
                {
                  quantity: 1,
                  totalAmountBeforeReductions: money(soldOut ? '15.0' : '10.0'),
                  // An automatic discount only applied at checkout.
                  totalAmountAfterDiscounts: money(soldOut ? '15.0' : '8.5'),
                },
              ],
            },
          ],
        },
        delivery: deliveryTerms(delivery, address, '8.5'),
        subtotalBeforeTaxesAndShipping: constraint(soldOut ? '0.0' : '8.5'),
        runningTotal: constraint(total ?? (soldOut ? '0.0' : '8.5')),
        checkoutTotal: total ? constraint(total) : { __typename: 'AnyConstraint' },
        totalSavings: constraint(soldOut ? '0.0' : '1.5'),
        tax: { totalTaxAmount: constraint(tax) },
        buyerIdentity: { customer: { presentmentCurrency: 'EUR' } },
      },
    },
    errors: [
      { code: 'BUYER_IDENTITY_MISSING_CONTACT_METHOD', nonLocalizedMessage: 'Missing a valid contact method.', target: '$.buyerIdentity' },
      ...(delivery !== 'none' && !address.first_name
        ? [{ code: 'DELIVERY_FIRST_NAME_REQUIRED', nonLocalizedMessage: 'A first name is required.', target: '$.delivery' }]
        : []),
      ...(delivery === 'unshippable'
        ? [{ code: 'DELIVERY_NO_DELIVERY_STRATEGY_AVAILABLE', nonLocalizedMessage: 'No delivery strategy available.', target: '$.delivery' }]
        : []),
      ...(soldOut
        ? [{ code: 'MERCHANDISE_OUT_OF_STOCK', nonLocalizedMessage: 'This item is out of stock.', target: '$.merchandise.merchandiseLines[0]' }]
        : []),
    ],
  };
}

function checkoutPage(variantId: number, thirdPartyOrigin: string): string {
  const graphql = {
    // Real keys are per-deploy hashes; the parser must not depend on them.
    'hashedquerykey{}': { shop: { id: 'gid://shopify/Shop/123' } },
    'anotherhashedkey{"queueToken":null}': { session: { negotiate: negotiation(variantId) } },
  };
  return `<!doctype html><html><head>
<meta name="serialized-shop" content="${attr({ name: 'Fake Store', domain: 'fake.example' })}">
<meta name="serialized-graphql" content="${attr(graphql)}">
<link rel="stylesheet" href="/slow-checkout.css">
<script type="module" src="${CHECKOUT_APP_PATH}"></script>
<script src="${thirdPartyOrigin}/tracker.js"></script>
</head><body><div class="LoadingShell"></div></body></html>`;
}

/** Stand-in for Shopify's checkout app: re-negotiates until delivery is settled, like the real one. */
const checkoutApp = `
const post = () => fetch('/checkouts/internal/graphql/persisted?operationName=Proposal', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
}).then((r) => r.json());
(async () => { for (let i = 0; i < 4; i++) await post(); })();
`;

export async function startFakeStore(opts: { password?: boolean; rejectVariants?: number[] } = {}): Promise<FakeStore> {
  const requests: FakeStore['requests'] = [];
  let counter = 0;
  const sessions = new Map<string, { variantId: number; address: Address; proposals: number }>();
  let port = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const setCookie = `visited=${++counter}`;
    requests.push({ path: url.pathname, cookie: req.headers.cookie, setCookie });
    const send = (res: ServerResponse, status: number, type: string, body: string) => {
      res.writeHead(status, { 'content-type': type, 'x-shopid': '123', 'set-cookie': `${setCookie}; Path=/` });
      res.end(body);
    };

    if (opts.password && url.pathname !== '/password') {
      res.writeHead(302, { location: '/password' });
      return res.end();
    }
    switch (url.pathname) {
      case '/password':
        return send(res, 200, 'text/html', '<html>Enter password</html>');
      case '/meta.json':
        return send(res, 200, 'application/json', JSON.stringify({
          name: 'Fake Store', domain: 'fake.example', myshopify_domain: 'fake.myshopify.com',
          currency: 'EUR', country: 'DE', description: '', published_products_count: 3, published_collections_count: 1,
        }));
      case '/products.json': {
        const limit = Number(url.searchParams.get('limit') ?? 30);
        const page = Number(url.searchParams.get('page') ?? 1);
        const slice = products.slice((page - 1) * limit, page * limit);
        return send(res, 200, 'application/json', JSON.stringify({ products: slice }));
      }
      case '/products/blue-widget.js':
        return send(res, 200, 'text/javascript; charset=utf-8', JSON.stringify(productJs));
      case '/products/hidden-lamp':
        return send(res, 200, 'text/html', htmlOnlyPage);
      case '/products/gone':
        res.writeHead(302, { location: '/' });
        return res.end();
      case '/slow.css':
        // Would stall the fallback if subresources were not blocked.
        setTimeout(() => send(res, 200, 'text/css', ''), 10_000).unref();
        return;
      case '/':
        return send(res, 200, 'text/html', homePage);
      case CHECKOUT_APP_PATH:
        return send(res, 200, 'text/javascript', checkoutApp);
      case '/slow-checkout.css':
      case '/tracker.js':
        // Would stall the checkout if these weren't blocked.
        setTimeout(() => send(res, 200, 'text/plain', ''), 10_000).unref();
        return;
      case '/checkouts/internal/graphql/persisted': {
        const token = /cart_token=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
        const session = token ? sessions.get(token) : undefined;
        if (!session) return send(res, 401, 'application/json', '{}');
        session.proposals++;
        const { address } = session;
        // Like Shopify: rates arrive first, then a later proposal selects one; zip 00000 never settles.
        const delivery: Delivery =
          address.country === 'AQ' ? 'unshippable'
          : address.zip === '00000' || session.proposals === 1 ? 'pending'
          : session.proposals === 2 ? 'unselected'
          : 'selected';
        return send(res, 200, 'application/json', JSON.stringify({ data: { session: { negotiate: negotiation(session.variantId, delivery, address) } } }));
      }
      default: {
        const cart = /^\/cart\/(\d+):1$/.exec(url.pathname);
        if (cart) {
          if (!products.some((p) => p.variants.some((v) => v.id === Number(cart[1])))) {
            return send(res, 410, 'text/html', '<title>Link no longer exists.</title>');
          }
          if (opts.rejectVariants?.includes(Number(cart[1]))) {
            // Mimics cart-validation apps that bounce the permalink back to the homepage.
            res.writeHead(302, { location: '/' });
            return res.end();
          }
          const address: Address = {};
          for (const [key, value] of url.searchParams) {
            const field = /^checkout\[shipping_address\]\[(\w+)\]$/.exec(key)?.[1];
            if (field) address[field] = value;
          }
          const token = `t${++counter}`;
          sessions.set(token, { variantId: Number(cart[1]), address, proposals: 0 });
          // Like Shopify, checkout only works with the cookie set by the cart permalink.
          res.writeHead(302, { location: `/checkouts/cn/${token}/en-us`, 'set-cookie': `cart_token=${token}; Path=/` });
          return res.end();
        }
        const co = /^\/checkouts\/cn\/(\w+)\/en-us$/.exec(url.pathname);
        if (co) {
          const session = sessions.get(co[1]!);
          if (!session || !req.headers.cookie?.includes(`cart_token=${co[1]}`)) {
            res.writeHead(302, { location: '/' });
            return res.end();
          }
          // "localhost" and "127.0.0.1" are different hosts to the browser, so this acts as a third party.
          return send(res, 200, 'text/html', checkoutPage(session.variantId, `http://localhost:${port}`));
        }
        return send(res, 404, 'text/html', '<html>Not found</html>');
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
