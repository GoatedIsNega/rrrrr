import { chromium, type Browser, type BrowserContext, type LaunchOptions } from 'playwright';
import type { SessionMode } from './config.ts';
import { ResearchError } from './errors.ts';

const LAUNCH_OPTIONS: LaunchOptions = {
  headless: true,
  args: ['--disable-dev-shm-usage', '--disable-extensions', '--mute-audio', '--no-first-run'],
};

export interface SessionOptions {
  mode: SessionMode;
  maxConcurrent: number;
  timeoutMs: number;
}

/**
 * Hands every caller a brand-new, isolated browser session (no shared cookies,
 * cache, storage or service workers) and always tears it down afterwards.
 */
export class BrowserSessions {
  readonly #opts: SessionOptions;
  #warm: Promise<Browser> | null = null;
  #active = 0;
  #waiting: Array<() => void> = [];
  #closed = false;

  constructor(opts: SessionOptions) {
    this.#opts = opts;
  }

  get stats() {
    return { mode: this.#opts.mode, active: this.#active, queued: this.#waiting.length };
  }

  /** Pre-launches the shared browser so the first request doesn't pay for it. */
  async start(): Promise<void> {
    if (this.#opts.mode === 'context') await this.#warmBrowser();
  }

  async isHealthy(): Promise<boolean> {
    if (this.#opts.mode === 'browser') return !this.#closed;
    try {
      return (await this.#warmBrowser()).isConnected();
    } catch {
      return false;
    }
  }

  /** `fn` receives the absolute deadline (ms epoch) so it can return partial results in time. */
  async run<T>(fn: (ctx: BrowserContext, deadline: number) => Promise<T>): Promise<T> {
    if (this.#closed) throw new ResearchError(503, 'shutting_down', 'Service is shutting down');
    const deadline = Date.now() + this.#opts.timeoutMs;
    await this.#acquire(deadline);

    let ownBrowser: Browser | null = null;
    let ctx: BrowserContext | null = null;
    let timedOut = false;
    // Closing the context on expiry makes any in-flight navigation reject promptly.
    const timer = setTimeout(() => {
      timedOut = true;
      void (ownBrowser ?? ctx)?.close().catch(() => {});
    }, Math.max(0, deadline - Date.now()));

    try {
      const browser =
        this.#opts.mode === 'browser'
          ? (ownBrowser = await chromium.launch(LAUNCH_OPTIONS))
          : await this.#warmBrowser();
      ctx = await browser.newContext({
        userAgent: userAgentFor(browser),
        locale: 'en-US',
        serviceWorkers: 'block',
        viewport: { width: 1280, height: 800 },
      });
      if (timedOut) throw timeoutError();
      const remaining = Math.max(1, deadline - Date.now());
      ctx.setDefaultTimeout(remaining);
      ctx.setDefaultNavigationTimeout(remaining);
      return await fn(ctx, deadline);
    } catch (err) {
      if (timedOut || isPlaywrightTimeout(err)) throw timeoutError();
      throw err;
    } finally {
      clearTimeout(timer);
      await ctx?.close().catch(() => {});
      await (ownBrowser as Browser | null)?.close().catch(() => {});
      this.#release();
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const warm = this.#warm;
    this.#warm = null;
    if (warm) await warm.then((b) => b.close()).catch(() => {});
  }

  #warmBrowser(): Promise<Browser> {
    if (!this.#warm) {
      const launching = chromium.launch(LAUNCH_OPTIONS).then((browser) => {
        // Relaunch lazily on the next request if Chromium crashes.
        browser.on('disconnected', () => {
          if (this.#warm === launching) this.#warm = null;
        });
        return browser;
      });
      launching.catch(() => {
        if (this.#warm === launching) this.#warm = null;
      });
      this.#warm = launching;
    }
    return this.#warm;
  }

  async #acquire(deadline: number): Promise<void> {
    if (this.#active < this.#opts.maxConcurrent) {
      this.#active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.#waiting = this.#waiting.filter((w) => w !== grant);
        reject(timeoutError());
      }, Math.max(0, deadline - Date.now()));
      this.#waiting.push(grant);
    });
  }

  #release(): void {
    const next = this.#waiting.shift();
    // Slot is handed over directly, so #active stays unchanged.
    if (next) next();
    else this.#active--;
  }
}

/** Headless Chromium advertises "HeadlessChrome", which some storefronts block. */
function userAgentFor(browser: Browser): string {
  const major = browser.version().split('.')[0];
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

function isPlaywrightTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

function timeoutError(): ResearchError {
  return new ResearchError(504, 'timeout', 'Research did not finish within the request timeout');
}
