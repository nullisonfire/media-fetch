import { z } from 'zod';

/** Bindings declared in wrangler.toml. */
export interface Env {
  ASSETS: Fetcher;
  /**
   * Metadata cache + rate-limit counters. Optional so the Worker deploys and
   * runs with no resources provisioned at all — caching and rate limiting
   * degrade to off rather than taking the app down.
   */
  CACHE?: KVNamespace;
  /**
   * Holds the ffmpeg.wasm core. Optional so the app still boots (and progressive
   * downloads still work) before the bucket is provisioned — only muxing needs it.
   */
  FFMPEG_BUCKET?: R2Bucket;

  ENVIRONMENT?: string;
  RESOLVER_BACKEND?: string;
  RESOLVER_BASE_URL?: string;
  PROXY_TOKEN_TTL_SECONDS?: string;
  RATE_LIMIT_RESOLVE_PER_MINUTE?: string;

  /** Secrets — absent in local dev unless set in .dev.vars. */
  SIGNING_KEY?: string;
  RESOLVER_TOKEN?: string;
  /** Optional. Raises Bilibili's anonymous 480p ceiling (a SESSDATA value). */
  BILIBILI_COOKIE?: string;
  /** Optional. Unlocks gated Instagram posts and view counts. */
  INSTAGRAM_COOKIE?: string;
}

const numeric = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).catch(fallback);

const configSchema = z.object({
  environment: z.string().default('production'),
  resolverBackend: z.enum(['cobalt', 'ytdlp']).catch('ytdlp'),
  /**
   * OPTIONAL. Four of the five platforms extract natively inside the Worker, so a
   * deployment with no resolver at all is a first-class configuration — an empty
   * or placeholder value simply disables the fallback rather than failing boot.
   */
  resolverBaseUrl: z.string().url().optional().catch(undefined),
  resolverToken: z.string().optional(),
  bilibiliCookie: z.string().optional(),
  instagramCookie: z.string().optional(),
  signingKey: z.string().min(16, 'SIGNING_KEY must be at least 16 characters'),
  proxyTokenTtlSeconds: numeric(1800, 60, 21_600),
  rateLimitResolvePerMinute: numeric(20, 1, 10_000),
});

export type AppConfig = z.infer<typeof configSchema>;

/**
 * Parsed once per isolate. A misconfigured Worker should fail loudly at the edge
 * of the request rather than producing subtly broken tokens, so this throws and
 * the error middleware turns it into a 500 with a stable code.
 */
/**
 * Thrown when bindings are invalid.
 *
 * A distinct type so the error handler can report WHICH setting is wrong instead
 * of collapsing it into a generic 500. Naming a missing variable is not a secret
 * leak — it is the difference between a two-minute fix and an hour of guessing.
 * Secret VALUES are never included.
 */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid Worker configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Non-throwing config check, for /api/health.
 *
 * A health endpoint whose whole purpose is diagnosing misconfiguration must not
 * itself die from misconfiguration — that was the original bug: a missing
 * SIGNING_KEY made every diagnostic route return "Something went wrong on our
 * end", which is the least useful thing it could have said.
 */
export function describeConfig(env: Env): { valid: boolean; problems: string[] } {
  try {
    loadConfig(env);
    return { valid: true, problems: [] };
  } catch (err) {
    return {
      valid: false,
      problems: err instanceof ConfigError ? err.problems : ['configuration could not be read'],
    };
  }
}

export function loadConfig(env: Env): AppConfig {
  const parsed = configSchema.safeParse({
    environment: env.ENVIRONMENT,
    resolverBackend: env.RESOLVER_BACKEND,
    // The shipped placeholder counts as "not configured".
    resolverBaseUrl:
      env.RESOLVER_BASE_URL && !/resolver(-staging)?\.example\.com/.test(env.RESOLVER_BASE_URL)
        ? env.RESOLVER_BASE_URL
        : undefined,
    resolverToken: env.RESOLVER_TOKEN,
    bilibiliCookie: env.BILIBILI_COOKIE,
    instagramCookie: env.INSTAGRAM_COOKIE,
    signingKey: env.SIGNING_KEY,
    proxyTokenTtlSeconds: env.PROXY_TOKEN_TTL_SECONDS,
    rateLimitResolvePerMinute: env.RATE_LIMIT_RESOLVE_PER_MINUTE,
  });

  if (!parsed.success) {
    // Map the schema's field names back to the binding names an operator sets,
    // and attach the fix. Anything else sends them reading source code.
    const FIX: Record<string, string> = {
      signingKey:
        'SIGNING_KEY secret is missing or too short. Set it with `wrangler secret put SIGNING_KEY` ' +
        '(value: openssl rand -base64 48), or in the dashboard under Settings -> Variables and Secrets.',
      resolverBaseUrl: 'RESOLVER_BASE_URL is not a valid URL. Remove it to disable the resolver.',
    };
    const problems = parsed.error.issues.map((issue) => {
      const field = issue.path.join('.') || 'config';
      return FIX[field] ?? `${field}: ${issue.message}`;
    });
    throw new ConfigError(problems);
  }
  return parsed.data;
}

/**
 * User-Agent sent to upstream CDNs. Honest identification rather than browser
 * impersonation: several of these CDNs reject empty UAs outright, and pretending
 * to be Chrome is both fragile and dishonest.
 */
export const UPSTREAM_USER_AGENT = 'MediaFetch/1.0 (+https://github.com/your-org/mediafetch)';
