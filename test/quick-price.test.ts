import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { BrowserSessions } from '../src/browser.ts';
import { startFakeStore, type FakeStore } from './fake-shopify.ts';

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
    assert.deepEqual(Object.keys(body).slice(0, 3), ['price', 'currency', 'timetaken']);
  });

  test('goes through the /cart/<variant>:1 permalink into checkout', async () => {
    const start = store.requests.length;
    await sh({ site: store.origin, variant: '11' });
    const paths = store.requests.slice(start).map((r) => r.path);
    assert.deepEqual(paths, ['/cart/11:1', '/checkouts/cn/tok11/en-us'], 'explicit variant skips lookups and subresources');
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
    assert.ok(carts.every((r) => !r.cookie?.includes('cart=')), 'no cart cookie carried into the next call');
  });
});
