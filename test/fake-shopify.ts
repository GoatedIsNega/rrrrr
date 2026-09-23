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

/** Trimmed-down copy of the structure Shopify's one-page checkout server-renders. */
function checkoutPage(variantId: number): string {
  const soldOut = variantId === 12;
  const graphql = {
    // Real keys are per-deploy hashes; the parser must not depend on them.
    'hashedquerykey{}': { shop: { id: 'gid://shopify/Shop/123' } },
    'anotherhashedkey{"queueToken":null}': {
      session: {
        negotiate: {
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
              subtotalBeforeTaxesAndShipping: constraint(soldOut ? '0.0' : '8.5'),
              runningTotal: constraint(soldOut ? '0.0' : '8.5'),
              checkoutTotal: { __typename: 'AnyConstraint' },
              totalSavings: constraint(soldOut ? '0.0' : '1.5'),
              tax: { totalTaxAmount: constraint('0.0') },
              buyerIdentity: { customer: { presentmentCurrency: 'EUR' } },
            },
          },
          errors: [
            { code: 'BUYER_IDENTITY_MISSING_CONTACT_METHOD', nonLocalizedMessage: 'Missing a valid contact method.', target: '$.buyerIdentity' },
            ...(soldOut
              ? [{ code: 'MERCHANDISE_OUT_OF_STOCK', nonLocalizedMessage: 'This item is out of stock.', target: '$.merchandise.merchandiseLines[0]' }]
              : []),
          ],
        },
      },
    },
  };
  return `<!doctype html><html><head>
<meta name="serialized-shop" content="${attr({ name: 'Fake Store', domain: 'fake.example' })}">
<meta name="serialized-graphql" content="${attr(graphql)}">
<script src="/checkout-app.js"></script>
</head><body><div class="LoadingShell"></div></body></html>`;
}

export async function startFakeStore(opts: { password?: boolean; rejectVariants?: number[] } = {}): Promise<FakeStore> {
  const requests: FakeStore['requests'] = [];
  let counter = 0;

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
      case '/checkout-app.js':
        // Would stall the checkout if subresources were not blocked.
        setTimeout(() => send(res, 200, 'text/javascript', ''), 10_000).unref();
        return;
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
          // Like Shopify, checkout only works with the cookie set by the cart permalink.
          res.writeHead(302, { location: `/checkouts/cn/tok${cart[1]}/en-us`, 'set-cookie': `cart=${cart[1]}; Path=/` });
          return res.end();
        }
        const co = /^\/checkouts\/cn\/tok(\d+)\/en-us$/.exec(url.pathname);
        if (co) {
          if (!req.headers.cookie?.includes(`cart=${co[1]}`)) {
            res.writeHead(302, { location: '/' });
            return res.end();
          }
          return send(res, 200, 'text/html', checkoutPage(Number(co[1])));
        }
        return send(res, 404, 'text/html', '<html>Not found</html>');
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
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
