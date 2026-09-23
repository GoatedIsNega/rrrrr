export type SessionMode = 'context' | 'browser';

export interface Config {
  host: string;
  port: number;
  /** `context`: new isolated context on a warm browser. `browser`: new browser process per request. */
  sessionMode: SessionMode;
  maxConcurrentSessions: number;
  requestTimeoutMs: number;
  allowPrivateHosts: boolean;
  checkoutAssetCacheMb: number;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function loadConfig(): Config {
  const sessionMode = (process.env.SESSION_MODE ?? 'context') as SessionMode;
  if (sessionMode !== 'context' && sessionMode !== 'browser') {
    throw new Error('SESSION_MODE must be "context" or "browser"');
  }
  return {
    host: process.env.HOST ?? '0.0.0.0',
    port: int('PORT', 3000),
    sessionMode,
    maxConcurrentSessions: int('MAX_CONCURRENT_SESSIONS', 8),
    requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 15_000),
    allowPrivateHosts: process.env.ALLOW_PRIVATE_HOSTS === 'true',
    // 0 disables sharing of Shopify's immutable checkout bundles between sessions.
    checkoutAssetCacheMb: process.env.CHECKOUT_ASSET_CACHE_MB === '0' ? 0 : int('CHECKOUT_ASSET_CACHE_MB', 64),
  };
}
