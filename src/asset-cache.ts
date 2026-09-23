export interface CachedAsset {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const ASSET_PATH = /\/shopifycloud\/(checkout-web\/assets\/.+)$/;
const KEPT_HEADERS = ['content-type', 'cache-control', 'access-control-allow-origin', 'timing-allow-origin'];

/**
 * In-memory LRU of Shopify's content-hashed checkout bundles. These files are
 * immutable and public (no cookies or per-user data), so sharing them across
 * otherwise fresh sessions is safe and skips ~140 module downloads per checkout.
 */
export class AssetCache {
  readonly #maxBytes: number;
  readonly #entries = new Map<string, CachedAsset>();
  #bytes = 0;
  #hits = 0;
  #misses = 0;

  constructor(maxBytes = 64 * 1024 * 1024) {
    this.#maxBytes = maxBytes;
  }

  /** Same file is served from cdn.shopify.com and each store's /cdn/ proxy, so key by asset path. */
  static keyFor(url: string): string | null {
    try {
      return ASSET_PATH.exec(new URL(url).pathname)?.[1] ?? null;
    } catch {
      return null;
    }
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  get(key: string): CachedAsset | undefined {
    const hit = this.#entries.get(key);
    if (hit) this.#hits++;
    else this.#misses++;
    if (hit) {
      this.#entries.delete(key);
      this.#entries.set(key, hit);
    }
    return hit;
  }

  set(key: string, status: number, headers: Record<string, string>, body: Buffer): void {
    if (status !== 200 || body.length > this.#maxBytes / 4 || this.#entries.has(key)) return;
    const kept: Record<string, string> = {};
    for (const name of KEPT_HEADERS) if (headers[name]) kept[name] = headers[name];
    // Module scripts are fetched in CORS mode from both origins that share this entry.
    kept['access-control-allow-origin'] = '*';
    this.#entries.set(key, { status, headers: kept, body });
    this.#bytes += body.length;
    for (const [oldKey, old] of this.#entries) {
      if (this.#bytes <= this.#maxBytes) break;
      this.#entries.delete(oldKey);
      this.#bytes -= old.body.length;
    }
  }

  get stats() {
    return { entries: this.#entries.size, bytes: this.#bytes, hits: this.#hits, misses: this.#misses };
  }
}
