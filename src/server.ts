import { buildApp } from './app.ts';
import { AssetCache } from './asset-cache.ts';
import { BrowserSessions } from './browser.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const sessions = new BrowserSessions({
  mode: config.sessionMode,
  maxConcurrent: config.maxConcurrentSessions,
  timeoutMs: config.requestTimeoutMs,
});
await sessions.start();

const assetCache = config.checkoutAssetCacheMb > 0 ? new AssetCache(config.checkoutAssetCacheMb * 1024 * 1024) : null;
const app = buildApp({ sessions, allowPrivateHosts: config.allowPrivateHosts, assetCache, logger: true });
app.addHook('onClose', () => sessions.close());

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: config.host, port: config.port });
