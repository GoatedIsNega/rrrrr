import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { BrowserSessions } from '../src/browser.ts';
import { parseTarget } from '../src/shopify.ts';
import { startFakeStore, type FakeStore } from './fake-shopify.ts';

let sessions: BrowserSessions;
let app: FastifyInstance;
let store: FakeStore;

before(async () => {
  sessions = new BrowserSessions({ mode: 'context', maxConcurrent: 4, timeoutMs: 10_000 });
  await sessions.start();
  app = buildApp({ sessions, allowPrivateHosts: true });
  store = await startFakeStore();
});

after(async () => {
  await app.close();
  await sessions.close();
  await store.close();
});

const research = (query: Record<string, string>) =>
  app.inject({ method: 'GET', url: '/research', query });

describe('parseTarget', () => {
  test('detects stores and product URLs in their common shapes', () => {
    assert.deepEqual(parseTarget('shop.example.com'), { kind: 'store', origin: 'https://shop.example.com', hostname: 'shop.example.com' });
    for (const url of [
      'https://shop.example.com/products/tee',
      'https://shop.example.com/collections/all/products/tee?variant=1',
      'https://shop.example.com/en-gb/products/tee.json',
    ]) {
      assert.equal((parseTarget(url) as { handle: string }).handle, 'tee', url);
    }
    assert.throws(() => parseTarget('ftp://shop.example.com'), { code: 'invalid_url' });
  });
});

describe('GET /research', () => {
  test('researches a whole store from products.json', async () => {
    const res = await research({ url: store.origin });
    assert.equal(res.statusCode, 200);
    const body = res.json();

    assert.equal(body.kind, 'store');
    assert.equal(body.source, 'products.json');
    assert.equal(body.freshSession, true);
    assert.equal(body.store.name, 'Fake Store');
    assert.equal(body.store.currency, 'EUR');
    assert.equal(body.products.length, 3);

    const blue = body.products[0];
    assert.equal(blue.url, `${store.origin}/products/blue-widget`);
    assert.equal(blue.description, 'A blue widget & more');
    assert.deepEqual([blue.priceMin, blue.priceMax, blue.compareAtPriceMax], [10, 15, 20]);
    assert.equal(blue.available, true);
    assert.equal(blue.onSale, true);
    assert.equal(blue.maxDiscountPercent, 50);
    assert.deepEqual(blue.images, ['https://cdn.example.com/blue.jpg']);

    assert.deepEqual(body.summary.price, { min: 10, max: 50, average: 30, median: 30 });
    assert.equal(body.summary.availableCount, 2);
    assert.equal(body.summary.soldOutCount, 1);
    assert.equal(body.summary.onSaleCount, 2);
    assert.deepEqual(body.summary.topVendors, [{ name: 'Acme', count: 2 }, { name: 'Globex', count: 1 }]);
    assert.deepEqual(body.summary.topTags[0], { name: 'sale', count: 2 });
    assert.equal(body.summary.newestProducts[0].title, 'Red Gadget');
  });

  test('respects limit and paginates products.json in parallel', async () => {
    const res = await app.inject({ method: 'POST', url: '/research', payload: { url: store.origin, limit: 2 } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().products.map((p: { handle: string }) => p.handle), ['blue-widget', 'red-gadget']);
  });

  test('researches a single product via the AJAX .js API', async () => {
    const res = await research({ url: `${store.origin}/collections/all/products/blue-widget` });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.source, 'product.js');
    assert.equal(body.store.name, 'Fake Store');
    assert.equal(body.product.title, 'Blue Widget');
    assert.equal(body.product.priceMin, 10);
    assert.equal(body.product.compareAtPriceMax, 20);
    assert.equal(body.product.productType, 'Widgets');
  });

  test('falls back to JSON-LD without waiting on page subresources', async () => {
    const started = Date.now();
    const res = await research({ url: `${store.origin}/products/hidden-lamp` });
    assert.equal(res.statusCode, 200);
    assert.ok(Date.now() - started < 5_000, 'stylesheet should have been blocked');
    const { source, product } = res.json();
    assert.equal(source, 'html');
    assert.equal(product.title, 'Hidden Lamp');
    assert.equal(product.vendor, 'Lumen');
    assert.deepEqual([product.priceMin, product.priceMax, product.available], [45, 55, true]);
  });

  test('returns 404 when a product redirects to a non-product page', async () => {
    const res = await research({ url: `${store.origin}/products/gone` });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'product_not_found');
  });

  test('reports password-protected stores', async () => {
    const locked = await startFakeStore({ password: true });
    try {
      const res = await research({ url: locked.origin });
      assert.equal(res.statusCode, 423);
      assert.equal(res.json().error.code, 'password_protected');
    } finally {
      await locked.close();
    }
  });

  test('validates input', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/research' })).statusCode, 400);
    assert.equal((await research({ url: store.origin, limit: '5000' })).statusCode, 400);
    assert.equal((await research({ url: 'ftp://x' })).json().error.code, 'invalid_url');
  });

  test('blocks private hosts unless explicitly allowed', async () => {
    const guarded = buildApp({ sessions, allowPrivateHosts: false });
    try {
      for (const url of [store.origin, 'http://localhost:1', 'http://169.254.169.254/', 'http://[::ffff:127.0.0.1]/']) {
        const res = await guarded.inject({ method: 'GET', url: '/research', query: { url } });
        assert.equal(res.statusCode, 403, url);
        assert.equal(res.json().error.code, 'blocked_host');
      }
    } finally {
      await guarded.close();
    }
  });
});

describe('BrowserSessions', () => {
  test('every request gets a fresh session with no carried-over cookies', async () => {
    const start = store.requests.length;
    await research({ url: store.origin });
    const mid = store.requests.length;
    await research({ url: store.origin });
    const first = store.requests.slice(start, mid);
    const second = store.requests.slice(mid);
    assert.ok(first.length >= 2 && second.length >= 2);

    // A reused session would send back cookies the store set during the first request.
    const firstCookies = new Set(first.map((r) => r.setCookie));
    const leaked = second.filter((r) => r.cookie?.split('; ').some((c) => firstCookies.has(c)));
    assert.deepEqual(leaked, []);

    // Sanity check: cookies do persist *within* one session.
    const [set, sent] = await sessions.run(async (ctx) => {
      const page = await ctx.newPage();
      await page.goto(`${store.origin}/`);
      const set = store.requests.at(-1)!.setCookie;
      await page.goto(`${store.origin}/meta.json`);
      return [set, store.requests.at(-1)!.cookie];
    });
    assert.equal(sent, set);
  });

  test('handles concurrent requests and enforces the timeout', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => research({ url: store.origin })));
    assert.deepEqual(results.map((r) => r.statusCode), [200, 200, 200, 200, 200, 200]);
    assert.equal(sessions.stats.active, 0);

    const quick = new BrowserSessions({ mode: 'context', maxConcurrent: 1, timeoutMs: 300 });
    try {
      const slow = quick.run((ctx) => ctx.newPage().then((p) => p.goto(`${store.origin}/slow.css`)));
      const queued = quick.run(async () => 'never');
      await Promise.all([
        assert.rejects(slow, { code: 'timeout', status: 504 }),
        assert.rejects(queued, { code: 'timeout' }),
      ]);
      assert.equal(quick.stats.active, 0);
    } finally {
      await quick.close();
    }
  });

  test('browser mode launches and tears down a dedicated browser per request', async () => {
    const isolated = new BrowserSessions({ mode: 'browser', maxConcurrent: 2, timeoutMs: 10_000 });
    const isolatedApp = buildApp({ sessions: isolated, allowPrivateHosts: true });
    try {
      const res = await isolatedApp.inject({ method: 'GET', url: '/research', query: { url: store.origin } });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().products.length, 3);
    } finally {
      await isolatedApp.close();
      await isolated.close();
    }
  });
});
