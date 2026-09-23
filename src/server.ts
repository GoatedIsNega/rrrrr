import { buildApp } from './app.ts';
import { BrowserSessions } from './browser.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const sessions = new BrowserSessions({
  mode: config.sessionMode,
  maxConcurrent: config.maxConcurrentSessions,
  timeoutMs: config.requestTimeoutMs,
});
await sessions.start();

const app = buildApp({ sessions, allowPrivateHosts: config.allowPrivateHosts, logger: true });
app.addHook('onClose', () => sessions.close());

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: config.host, port: config.port });
