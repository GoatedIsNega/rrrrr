# Shopify Product Researcher

A fast HTTP service that researches any public Shopify storefront and reads the **real checkout
price**, using a **fresh, isolated browser session for every request**.

## Quick start

```bash
pnpm install          # also downloads Chromium via postinstall
pnpm start            # listens on :3000

curl 'localhost:3000/research?url=allbirds.com&limit=250'
curl 'localhost:3000/research?url=https://www.allbirds.com/products/mens-strider-explore'
curl 'localhost:3000/sh?site=allbirds.com'
```

Requires Node ≥ 22.18. TypeScript runs natively, so there's no build step. On a fresh Linux
host you may need Chromium's system libraries: `pnpm exec playwright install --with-deps chromium`.

## API

### `GET /sh?site=…[&variant=…][&country=…&zip=…]` returns the real cart value

Adds one unit to a brand-new cart through Shopify's cart permalink (`/cart/<variantId>:1`) and
follows it into checkout.

- **Without an address (~1.5 s):** reads the order summary the checkout server-renders. `price`
  already includes checkout-only discounts, but `shipping` is `null`.
- **With an address (~3.5–7.5 s):** the address is prefilled through Shopify's documented permalink
  parameters (`checkout[shipping_address][…]`). The checkout app then runs and negotiates shipping
  and tax, and the first `Proposal` with a selected rate supplies **price + shipping + tax = total**.

| Param | Description |
|-------|-------------|
| `site` | Store (`xyz.com`) or product URL (`…/products/<handle>`, optionally `?variant=<id>`). |
| `variant` | Optional variant ID. Fastest, because it skips the product lookup. |
| `country` | ISO-2 country code. Required when any address field is given, and turns on shipping mode. |
| `zip`, `province` (or `state`), `city`, `address1`, `address2` | Destination. `country` + `zip` + `province` is usually enough for rates and tax. Some carrier-calculated rates need `city` and `address1` too. |
| `first_name`, `last_name`, `phone`, `email` | Optional. Not needed for pricing. |

With only a store, the first purchasable product is used (gift cards and $0 add-ons are skipped). If
checkout rejects it, up to two more products are tried. With a product URL, the first available
variant is used.

```json
GET /sh?site=colourpop.com&country=US&zip=94103&state=CA&city=San%20Francisco&address1=1%20Market%20St
{
  "price": 17, "shipping": 5.99, "tax": 1.46, "total": 24.45, "currency": "USD", "timetaken": "7.03s",
  "listPrice": 17, "compareAtPrice": null, "subtotal": 17, "savings": 0, "available": true,
  "shippingMethod": { "title": "Standard Shipping (est. 5-7 business days)", "carrier": null, "methodType": "SHIPPING",
                      "price": 5.99, "minDeliveryDate": null, "maxDeliveryDate": null },
  "shippingOptions": [ { "title": "Standard Shipping…", "price": 5.99, … }, { "title": "Expedited…", "price": 9.99, … } ],
  "shippingAddress": { "address1": "1 Market St", "address2": null, "city": "San Francisco", "province": "CA", "zip": "94103", "country": "US" },
  "issues": [],
  "items": [ { "title": "Mocha Moment", "variant": null, "variantId": 42663557595218, "quantity": 1, "total": 17 } ],
  "product": { "title": "Mocha Moment", "variantId": 42663557595218, "sku": "…", "vendor": "ColourPop", … },
  "store": { "name": "ColourPop Cosmetics", "domain": "colourpop.com" }
}
```

- `price` is the unit price after checkout discounts. `listPrice` and `compareAtPrice` are the variant's own prices.
- `shipping` is the rate checkout selects by default (usually the cheapest). Every rate is listed in `shippingOptions`.
- `total` is checkout's own total for this one item: product + shipping + tax − discounts. Add-ons that checkout UI
  extensions insert later (e.g. shipping insurance) are excluded, because those extensions are blocked.
- `issues` reports pricing-relevant problems: `MERCHANDISE_OUT_OF_STOCK` (returned immediately, with `available: false`),
  `DELIVERY_NO_DELIVERY_STRATEGY_AVAILABLE` (the store doesn't ship there), and `SHIPPING_NOT_CALCULATED`
  (no rate before the request timeout; best-known totals are returned).
- Errors add `invalid_address` (400), `variant_not_found` (404), `checkout_unavailable` (502: cart rules or bot
  protection kept checkout from opening), `checkout_blocked` (503: queue or bot challenge), and `site_unreachable` (502).

### `GET /research?url=…&limit=…` / `POST /research` `{ "url": "…", "limit": 250 }`

| Param   | Description |
|---------|-------------|
| `url`   | Store (`shop.com`, `https://shop.com/collections/x`) or product URL (`…/products/<handle>`, including collection and locale-prefixed paths). |
| `limit` | Store mode only: max products to analyse, 1–1000 (default 250). |

**Store response:** `kind: "store"`, `store` (name, currency, country, product counts from
`/meta.json`), `summary` (availability, on-sale count, price min/max/average/median, top vendors,
product types, and tags, newest products, biggest discounts), and normalized `products`.

**Product response:** `kind: "product"`, `store`, and one normalized `product` (prices in major
currency units, variants, options, images, availability, discount).

Each response also includes `source` (`products.json`, `product.js`, or `html`), `freshSession: true`,
and `tookMs`.

Errors use the shape `{ "error": { "code", "message" } }`: `invalid_url`/`invalid_request` (400),
`blocked_host` (403), `product_not_found` (404), `not_shopify` (422), `password_protected` (423),
`rate_limited` (429), `blocked_by_store`/`upstream_error` (502), `timeout` (504).

### `GET /health`

Browser status, current session counts, and checkout bundle cache stats.

## How it stays fast

- **Warm browser, fresh context:** Chromium is launched once at boot. Each request gets a brand-new
  `BrowserContext` (its own cookies, cache, storage, and no service workers), which is always closed
  afterwards. That costs ~50 ms, compared with ~200 ms+ to launch a whole browser.
- **JSON first:** the service reads Shopify's public `/products.json`, `/products/<handle>.js`, and
  `/meta.json` instead of rendering pages, navigating with `waitUntil: 'commit'`.
- **Parallel:** metadata and every `products.json` page are fetched concurrently in separate tabs.
- **Lean fallback:** if a store disables the AJAX API, the product page is loaded with every
  subresource blocked, and data is read from JSON-LD/OpenGraph.
- **Checkout without rendering:** without an address, `/sh` blocks every checkout subresource and
  parses the `serialized-graphql` data from the checkout HTML. `skip_shop_pay=true` avoids a redirect
  through shop.app. The remaining ~1.5 s is Shopify creating the cart and rendering checkout.
- **Lean checkout app for shipping:** with an address, only the checkout's own hosts and
  `cdn.shopify.com` are allowed. CSS, images, fonts, analytics, and checkout UI extensions are
  blocked. Same-origin web pixels stay allowed, because checkout waits ~10 s for them before
  negotiating. The request resolves on the first `Proposal` with a selected rate. The remaining time
  is mostly Shopify's own negotiation (one to two ~0.9 s rounds).
- **Shared bundle cache:** the ~140 content-hashed checkout JS modules are immutable and public, so
  they're cached in memory (`CHECKOUT_ASSET_CACHE_MB`) and served into each fresh session. No
  cookies, storage, or responses containing user data are shared.
- A realistic user agent replaces `HeadlessChrome`, which some storefronts block.

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address |
| `SESSION_MODE` | `context` | `context` = fresh isolated context on a warm browser (fastest). `browser` = launch and kill a separate Chromium process per request (strictest isolation, ~200 ms slower). |
| `MAX_CONCURRENT_SESSIONS` | `8` | Sessions allowed at once. Extra requests queue until their timeout. |
| `REQUEST_TIMEOUT_MS` | `15000` | End-to-end budget per request, including time spent queued |
| `ALLOW_PRIVATE_HOSTS` | `false` | Allow localhost/private IPs (only for local testing) |
| `CHECKOUT_ASSET_CACHE_MB` | `64` | Memory for Shopify's immutable checkout bundles. `0` disables it (each call re-downloads ~4 MB). |

Private, loopback, and link-local targets are rejected by default (SSRF protection). The service
has no built-in authentication, so put it behind your gateway or add auth before exposing it publicly.

## Development

```bash
pnpm test        # node:test against a local fake Shopify store with real Chromium
pnpm typecheck
```
