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

### `GET /sh?site=…&variant=…` returns the checkout price

Adds one unit to a brand-new cart through Shopify's cart permalink (`/cart/<variantId>:1`), follows
it into checkout, and reads the order summary the checkout page server-renders. The price therefore
includes anything checkout applies (automatic discounts, market currency), not just the listed price.

| Param     | Description |
|-----------|-------------|
| `site`    | Store (`xyz.com`) or product URL (`…/products/<handle>`, optionally `?variant=<id>`). |
| `variant` | Optional variant ID. This is the **fastest** option (~1.5 s), because it skips the product lookup and goes straight to `/cart/<variant>:1`. |

With only a store, the first purchasable product is used (gift cards and $0 add-ons are skipped). If
checkout rejects it, up to two more products are tried. With a product URL, the first available
variant is used.

```json
{
  "price": 140,
  "currency": "USD",
  "timetaken": "1.53s",
  "listPrice": 140, "compareAtPrice": null,
  "subtotal": 140, "total": 140, "tax": 0, "savings": 0,
  "available": true, "issues": [],
  "product": { "title": "Women's Dasher NZ…", "variant": "5", "variantId": 41271218896976, "sku": "A12464W050",
               "vendor": "Allbirds", "productType": "Shoes", "url": "…", "image": "…", "options": [ … ] },
  "store": { "name": "Allbirds", "domain": "www.allbirds.com" }
}
```

- `price` is the unit price after checkout discounts. `listPrice` and `compareAtPrice` are the variant's own prices.
- `total` and `tax` are what checkout knows before a shipping address is entered. Many stores report tax as 0 until then.
- Sold-out variants still return prices, with `available: false` and `issues: [{ "code": "MERCHANDISE_OUT_OF_STOCK", … }]`.
- Errors add `variant_not_found` (404), `checkout_unavailable` (502: cart rules or bot protection kept checkout
  from opening), and `site_unreachable` (502: DNS/TLS/connection failure).

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

Browser status and current session counts.

## How it stays fast

- **Warm browser, fresh context:** Chromium is launched once at boot. Each request gets a brand-new
  `BrowserContext` (its own cookies, cache, storage, and no service workers), which is always closed
  afterwards. That costs ~50 ms, compared with ~200 ms+ to launch a whole browser.
- **JSON first:** the service reads Shopify's public `/products.json`, `/products/<handle>.js`, and
  `/meta.json` instead of rendering pages, navigating with `waitUntil: 'commit'`.
- **Parallel:** metadata and every `products.json` page are fetched concurrently in separate tabs.
- **Lean fallback:** if a store disables the AJAX API, the product page is loaded with every
  subresource blocked, and data is read from JSON-LD/OpenGraph.
- **Checkout without rendering:** `/sh` blocks every checkout script, stylesheet, and image, and
  parses the `serialized-graphql` data from the checkout HTML. `skip_shop_pay=true` avoids a redirect
  through shop.app. The remaining ~1.5 s is Shopify creating the cart and rendering checkout.
- A realistic user agent replaces `HeadlessChrome`, which some storefronts block.

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address |
| `SESSION_MODE` | `context` | `context` = fresh isolated context on a warm browser (fastest). `browser` = launch and kill a separate Chromium process per request (strictest isolation, ~200 ms slower). |
| `MAX_CONCURRENT_SESSIONS` | `8` | Sessions allowed at once. Extra requests queue until their timeout. |
| `REQUEST_TIMEOUT_MS` | `15000` | End-to-end budget per request, including time spent queued |
| `ALLOW_PRIVATE_HOSTS` | `false` | Allow localhost/private IPs (only for local testing) |

Private, loopback, and link-local targets are rejected by default (SSRF protection). The service
has no built-in authentication, so put it behind your gateway or add auth before exposing it publicly.

## Development

```bash
pnpm test        # node:test against a local fake Shopify store with real Chromium
pnpm typecheck
```
