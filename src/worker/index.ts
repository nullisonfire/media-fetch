import { Hono } from 'hono';
import { PLATFORM_LIST } from '@shared/platforms';
import { describeConfig, loadConfig, type Env } from './config/env';
import { onError, onNotFound } from './middleware/errors';
import { rateLimit } from './middleware/rateLimit';
import { sameOriginOnly, securityHeaders } from './middleware/security';
import { detectRoute } from './routes/detect';
import { resolveRoute } from './routes/resolve';
import { streamRoute } from './routes/stream';
import { vendorRoute } from './routes/vendor';
import { AppError, jsonResponse } from './lib/http';

/**
 * MediaFetch Worker — the control plane.
 *
 * Responsibilities: identify the platform behind a URL, ask the resolver backend
 * what streams exist, mint signed proxy URLs, and pipe bytes.
 *
 * Explicitly NOT its responsibility: muxing. Workers cannot execute native code
 * and have a bounded CPU budget per request, so combining audio and video
 * happens in the browser via ffmpeg.wasm (src/client/lib/muxer.ts). That
 * constraint turns out to be a feature — the media never touches this server,
 * egress cost stays at zero, and the work scales with the number of users.
 */
const app = new Hono<{ Bindings: Env }>();

app.onError(onError);
app.notFound(onNotFound);

const api = new Hono<{ Bindings: Env }>();
api.use('*', securityHeaders);
api.use('*', sameOriginOnly);

/**
 * Liveness + config sanity. Safe to expose: reports config STATE, never values.
 *
 * Deliberately does not call loadConfig directly — a health check that crashes on
 * bad config tells you nothing about the bad config.
 */
api.get('/health', (c) => {
  const config = describeConfig(c.env);
  return jsonResponse(
    {
    ok: config.valid,
    ...(config.valid ? {} : { problems: config.problems }),
    platforms: PLATFORM_LIST.length,
    // Surfaced so a misconfigured deploy is diagnosable from one URL rather
    // than from a runtime failure three clicks into the UI.
    features: {
      signingKey: config.valid,
      cache: Boolean(c.env.CACHE),
      rateLimiting: Boolean(c.env.CACHE),
      // Ships as split static assets, so it is always available. The R2
      // binding is only an alternative delivery route.
      muxerCore: true,
      muxerCoreFromR2: Boolean(c.env.FFMPEG_BUCKET),
      resolverFallback: Boolean(
        c.env.RESOLVER_BASE_URL && !c.env.RESOLVER_BASE_URL.includes('example.'),
      ),
      /**
       * Echoed verbatim so a misconfigured var is visible rather than inferred.
       * Not a secret — the resolver's own token is what protects it — and
       * without this, "I set the variable but nothing happened" has no answer
       * short of guessing.
       */
      resolverBaseUrl: c.env.RESOLVER_BASE_URL ?? '(not set — check wrangler.toml [vars], then redeploy)',
      resolverTokenSet: Boolean(c.env.RESOLVER_TOKEN),
      nativePlatforms: ['youtube', 'bilibili', 'facebook', 'instagram'],
    },
    },
    // 503 when misconfigured, so uptime monitors notice too.
    config.valid ? 200 : 503,
  );
});

/** Platform catalogue for the dropdown. Static, so cache it hard. */
api.get('/platforms', () =>
  jsonResponse({ ok: true, platforms: PLATFORM_LIST }, 200, {
    'cache-control': 'public, max-age=3600',
  }),
);

api.route('/detect', detectRoute);

// Resolve is the expensive path (it hits the extraction backend), so it is the
// only one that is rate limited. Stream is protected by token signing instead —
// limiting it would break large multi-hour downloads.
api.use(
  '/resolve',
  rateLimit({
    bucket: 'resolve',
    // Read through loadConfig, not raw env: that applies the schema's bounds and
    // fallback. Reading the var directly here meant an unparsable value became
    // NaN and silently disabled the limiter.
    limitPerMinute: (env) => loadConfig(env).rateLimitResolvePerMinute,
  }),
);
api.route('/resolve', resolveRoute);

api.route('/stream', streamRoute);

/**
 * Unknown /api/* paths must return a JSON 404.
 *
 * Without this, they fall through to the static-asset catch-all below and get
 * answered with index.html and a 200 — because `not_found_handling` is set to
 * single-page-application, which is correct for page routes and badly wrong for
 * an API. A client parsing that response sees HTML where JSON was promised.
 */
api.all('*', () => {
  throw AppError.notFound('No such endpoint.');
});

app.route('/api', api);

/**
 * The ffmpeg core is served from R2 by the Worker rather than as a static asset:
 * it exceeds the 25 MiB Workers Assets file limit, and COEP requires it to be
 * same-origin. Mounted before the asset fallback so it wins the path.
 */
app.route('/vendor', vendorRoute);

/**
 * Anything that is not /api/* is a static asset. Workers Assets normally serves
 * these before the Worker runs; this fallback covers direct invocations and the
 * SPA deep-link case.
 */
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
