import type { AppConfig } from '../config/env';
import { createCobaltResolver } from './cobalt';
import { createYtDlpResolver } from './ytdlp';
import type { ResolverBackend } from './types';

/**
 * Backend factory. Selected by the RESOLVER_BACKEND var so swapping extraction
 * strategies is a config change, not a code change.
 *
 * Future Extension: register additional backends here (a second yt-dlp pool for
 * failover, a platform-specific official API client, etc.) and add the name to
 * the enum in config/env.ts.
 */
export function createResolver(config: AppConfig): ResolverBackend | null {
  // No resolver configured is a valid, fully-supported deployment: every platform
  // with a native extractor works without one.
  if (!config.resolverBaseUrl) return null;

  const options = {
    baseUrl: config.resolverBaseUrl,
    token: config.resolverToken,
  };

  switch (config.resolverBackend) {
    case 'ytdlp':
      return createYtDlpResolver(options);
    case 'cobalt':
      return createCobaltResolver(options);
  }
}

export type { ResolverBackend, ResolverResult, RawStream, ResolverInput } from './types';
