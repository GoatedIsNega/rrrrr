import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { AssetCache } from './asset-cache.ts';
import type { BrowserSessions } from './browser.ts';
import { ResearchError } from './errors.ts';
import { quickPrice, type QuickPriceRequest } from './quick-price.ts';
import { research, type ResearchRequest } from './research.ts';

export interface AppOptions {
  sessions: BrowserSessions;
  allowPrivateHosts: boolean;
  /** Shared cache of Shopify's immutable checkout bundles; `null` disables it. */
  assetCache?: AssetCache | null;
  logger?: FastifyServerOptions['logger'];
}

const requestSchema = {
  type: 'object',
  required: ['url'],
  additionalProperties: false,
  properties: {
    url: { type: 'string', minLength: 1, maxLength: 2048 },
    limit: { type: 'integer', minimum: 1, maximum: 1000, default: 250 },
  },
} as const;

const quickPriceSchema = {
  type: 'object',
  required: ['site'],
  additionalProperties: false,
  properties: {
    site: { type: 'string', minLength: 1, maxLength: 2048 },
    variant: { type: 'string', pattern: '^[0-9]{1,20}$' },
    country: { type: 'string', pattern: '^[A-Za-z]{2}$' },
    zip: { type: 'string', maxLength: 20 },
    province: { type: 'string', maxLength: 100 },
    state: { type: 'string', maxLength: 100 },
    city: { type: 'string', maxLength: 100 },
    address1: { type: 'string', maxLength: 200 },
    address2: { type: 'string', maxLength: 200 },
    first_name: { type: 'string', maxLength: 100 },
    last_name: { type: 'string', maxLength: 100 },
    phone: { type: 'string', maxLength: 30 },
    email: { type: 'string', maxLength: 200, format: 'email' },
  },
} as const;

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  const deps = {
    sessions: opts.sessions,
    allowPrivateHosts: opts.allowPrivateHosts,
    assetCache: opts.assetCache === undefined ? new AssetCache() : opts.assetCache,
  };

  app.get<{ Querystring: ResearchRequest }>('/research', { schema: { querystring: requestSchema } }, (req) =>
    research(deps, req.query),
  );
  app.post<{ Body: ResearchRequest }>('/research', { schema: { body: requestSchema } }, (req) =>
    research(deps, req.body),
  );
  app.get<{ Querystring: QuickPriceRequest }>('/sh', { schema: { querystring: quickPriceSchema } }, (req) =>
    quickPrice(deps, req.query),
  );

  app.get('/health', async (_req, reply) => {
    const healthy = await opts.sessions.isHealthy();
    return reply
      .code(healthy ? 200 : 503)
      .send({ ok: healthy, sessions: opts.sessions.stats, checkoutAssetCache: deps.assetCache?.stats ?? null });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ResearchError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }
    const e = err as { validation?: unknown; statusCode?: number; message?: string };
    if (e.validation) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: e.message } });
    }
    if (e.statusCode && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: { code: 'bad_request', message: e.message } });
    }
    const netError = /net::(ERR_[A-Z_]+)/.exec(e.message ?? '');
    if (netError) {
      return reply.code(502).send({ error: { code: 'site_unreachable', message: `Could not connect to the store (${netError[1]})` } });
    }
    req.log.error(err);
    return reply.code(502).send({ error: { code: 'upstream_error', message: 'Failed to research the store' } });
  });

  return app;
}
