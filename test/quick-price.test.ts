import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { BrowserSessions } from '../src/browser.ts';
import { CHECKOUT_APP_PATH, startFakeStore, type FakeStore } from './fake-shopify.ts';

let sessions: BrowserSessions;
let app: FastifyInstance;
let store: FakeStore;

before(async () => {
  sessions = new BrowserSessions({ mode: 'context', maxConcurrent: 4, timeoutMs: 8_000 });
  await sessions.start();
  app = buildApp({ sessions, allowPrivateHosts: true });
  store = await startFakeStore();
});

after(async () => {
  await app.close();
  await sessions.close();
  await store.close();
});

const sh = (query: Record<string, string>) => app.inject({ method: 'GET', url: '/sh', query });

describe('GET /sh', () => {
  test('returns the checkout price and time taken for a store', async () => {
    const res = await sh({ site: store.origin });
    assert.equal(res.statusCode, 200);
    const body = res.json();

    assert.match(body.timetaken, /^\d+\.\d{2}s$/);
    assert.equal(body.price, 8.5, 'price comes from checkout, after its automatic discount');
    assert.equal(body.currency, 'EUR');
    assert.equal(body.listPrice, 10);
    assert.equal(body.compareAtPrice, 20);
    assert.equal(body.subtotal, 8.5);
    assert.equal(body.total, 8.5);
    assert.equal(body.savings, 1.5);
    assert.equal(body.available, true);
    assert.deepEqual(body.issues, []);
    assert.deepEqual(body.product, {
      title: 'Blue Widget',
      variant: 'Small',
      variantId: 11,
      productId: 1,
      sku: 'BW-S',
      vendor: 'Acme',
      productType: 'Widgets',
      url: `${store.origin}/products/blue-widget`,
      image: 'https://cdn.example.com/blue.jpg',
      options: [{ name: 'Size', value: 'Small' }],
      requiresShipping: true,
    });
    assert.deepEqual(body.store, { name: 'Fake Store', domain: 'fake.example' });
    assert.deepEqual(Object.keys(body).slice(0, 6), ['price', 'shipping', 'tax', 'total', 'currency', 'timetaken']);
  });

  test('goes through the /cart/<variant>:1 permalink into checkout', async () => {
    const start = store.requests.length;
    await sh({ site: store.origin, variant: '11' });
    const paths = store.requests.slice(start).map((r) => r.path);
    assert.equal(paths.length, 2, 'explicit variant skips lookups and subresources');
    assert.equal(paths[0], '/cart/11:1');
    assert.match(paths[1]!, /^\/checkouts\/cn\/\w+\/en-us$/);
  });

  test('accepts product URLs, including ?variant=', async () => {
    const res = await sh({ site: `${store.origin}/collections/all/products/blue-widget` });
    assert.equal(res.json().product.variantId, 11);

    const sold = await sh({ site: `${store.origin}/products/blue-widget?variant=12` });
    assert.equal(sold.statusCode, 200);
    const body = sold.json();
    assert.equal(body.price, 15);
    assert.equal(body.available, false);
    assert.deepEqual(body.issues, [{ code: 'MERCHANDISE_OUT_OF_STOCK', message: 'This item is out of stock.' }]);
  });

  test('maps store failures to clear errors', async () => {
    const missing = await sh({ site: store.origin, variant: '999' });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'variant_not_found');

    assert.equal((await sh({ site: store.origin, variant: 'abc' })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/sh' })).statusCode, 400);

    const locked = await startFakeStore({ password: true });
    try {
      const res = await sh({ site: locked.origin, variant: '11' });
      assert.equal(res.statusCode, 423);
    } finally {
      await locked.close();
    }
  });

  test('tries another product when checkout rejects an auto-picked variant', async () => {
    const picky = await startFakeStore({ rejectVariants: [11] });
    try {
      const res = await sh({ site: picky.origin });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().product.variantId, 31);

      const explicit = await sh({ site: picky.origin, variant: '11' });
      assert.equal(explicit.statusCode, 502);
      assert.equal(explicit.json().error.code, 'checkout_unavailable');
    } finally {
      await picky.close();
    }
  });

  test('each call starts from an empty cart in a fresh session', async () => {
    const start = store.requests.length;
    await sh({ site: store.origin, variant: '11' });
    await sh({ site: store.origin, variant: '12' });
    const carts = store.requests.slice(start).filter((r) => r.path.startsWith('/cart/'));
    assert.equal(carts.length, 2);
    assert.ok(carts.every((r) => !r.cookie?.includes('cart_token=')), 'no cart cookie carried into the next call');
  });

  test('without an address, shipping is null and the checkout app never runs', async () => {
    const start = store.requests.length;
    const body = (await sh({ site: store.origin, variant: '11' })).json();
    assert.equal(body.shipping, null);
    assert.equal(body.shippingAddress, null);
    assert.ok(!store.requests.slice(start).some((r) => r.path.includes('graphql')));
  });
});

describe('GET /sh with a shipping address', () => {
  const ny = { country: 'us', zip: '10118', state: 'NY', city: 'New York', address1: '350 5th Ave' };

  test('returns the real cart value: price + shipping + tax', async () => {
    const res = await sh({ site: store.origin, variant: '11', ...ny });
    assert.equal(res.statusCode, 200);
    const body = res.json();

    assert.deepEqual(Object.keys(body).slice(0, 6), ['price', 'shipping', 'tax', 'total', 'currency', 'timetaken']);
    assert.equal(body.price, 8.5);
    assert.equal(body.shipping, 5);
    assert.equal(body.tax, 0.68);
    assert.equal(body.total, 14.18);
    assert.equal(body.currency, 'EUR');
    assert.deepEqual(body.shippingMethod, {
      title: 'Standard', carrier: 'Post', methodType: 'SHIPPING', price: 5, minDeliveryDate: '2026-10-01', maxDeliveryDate: '2026-10-05',
    });
    assert.deepEqual(body.shippingOptions.map((o: { title: string; price: number }) => [o.title, o.price]), [['Standard', 5], ['Express', 15]]);
    assert.deepEqual(body.shippingAddress, { address1: '350 5th Ave', address2: null, city: 'New York', province: 'NY', zip: '10118', country: 'US' });
    assert.deepEqual(body.issues, [], 'form-completeness violations (e.g. first name) are not pricing issues');
    assert.deepEqual(body.items, [{ title: 'Blue Widget', variant: 'Small', variantId: 11, quantity: 1, total: 8.5 }]);
    assert.equal(body.product.title, 'Blue Widget');
    assert.deepEqual(body.store, { name: 'Fake Store', domain: 'fake.example' });
  });

  test('waits for a selected rate rather than the first proposal', async () => {
    const start = store.requests.length;
    const body = (await sh({ site: store.origin, variant: '11', ...ny })).json();
    const proposals = store.requests.slice(start).filter((r) => r.path.includes('graphql'));
    // pending → rates without selection → selected (the fake app may fire one more before the page closes)
    assert.ok(proposals.length >= 3, `expected at least 3 proposals, got ${proposals.length}`);
    assert.equal(body.shipping, 5);
    assert.deepEqual(body.issues, []);
  });

  test('prefills the address via cart permalink params and skips non-essential requests', async () => {
    const start = store.requests.length;
    await sh({ site: store.origin, variant: '11', country: 'US', zip: '94103', province: 'CA' });
    const paths = store.requests.slice(start).map((r) => r.path);
    assert.ok(!paths.includes('/slow-checkout.css'), 'stylesheets blocked');
    assert.ok(!paths.includes('/tracker.js'), 'third-party scripts blocked');
    assert.ok(paths.some((p) => p.includes('graphql')), 'checkout app ran');
  });

  test('works with a minimal address and reports tax for it', async () => {
    const body = (await sh({ site: store.origin, variant: '11', country: 'US', zip: '94103', province: 'CA' })).json();
    assert.deepEqual([body.shipping, body.tax, body.total], [5, 0, 13.5]);
    assert.equal(body.shippingAddress.city, null);
  });

  test('serves checkout bundles from the shared cache on later calls', async () => {
    await sh({ site: store.origin, variant: '11', ...ny });
    const start = store.requests.length;
    const res = await sh({ site: store.origin, variant: '11', ...ny });
    assert.equal(res.json().shipping, 5);
    assert.ok(!store.requests.slice(start).some((r) => r.path === CHECKOUT_APP_PATH), 'app bundle came from cache');
  });

  test('returns sold-out items immediately without waiting for rates', async () => {
    const started = Date.now();
    const body = (await sh({ site: store.origin, variant: '12', ...ny })).json();
    assert.ok(Date.now() - started < 3_000);
    assert.equal(body.available, false);
    assert.equal(body.shipping, null);
    assert.deepEqual(body.issues.map((i: { code: string }) => i.code), ['MERCHANDISE_OUT_OF_STOCK']);
  });

  test('reports addresses the store cannot ship to', async () => {
    const body = (await sh({ site: store.origin, variant: '11', country: 'AQ', zip: '1234' })).json();
    assert.equal(body.shipping, null);
    assert.deepEqual(body.shippingOptions, []);
    assert.ok(body.issues.some((i: { code: string }) => i.code === 'DELIVERY_NO_DELIVERY_STRATEGY_AVAILABLE'));
  });

  test('returns partial totals before the request deadline if rates never settle', async () => {
    const quick = new BrowserSessions({ mode: 'context', maxConcurrent: 1, timeoutMs: 2_500 });
    const quickApp = buildApp({ sessions: quick, allowPrivateHosts: true });
    try {
      const res = await quickApp.inject({ method: 'GET', url: '/sh', query: { site: store.origin, variant: '11', country: 'US', zip: '00000' } });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.price, 8.5);
      assert.equal(body.shipping, null);
      assert.ok(body.issues.some((i: { code: string }) => i.code === 'SHIPPING_NOT_CALCULATED'));
    } finally {
      await quickApp.close();
      await quick.close();
    }
  });

  test('validates address input', async () => {
    const noCountry = await sh({ site: store.origin, zip: '10118' });
    assert.equal(noCountry.statusCode, 400);
    assert.equal(noCountry.json().error.code, 'invalid_address');
    assert.equal((await sh({ site: store.origin, country: 'USA' })).statusCode, 400);
    assert.equal((await sh({ site: store.origin, country: 'US', email: 'nope' })).statusCode, 400);
  });
});
