import { AppError } from '../lib/http';
import type { RawStream, ResolverBackend, ResolverResult } from './types';

/**
 * Adapter for a self-hosted Cobalt instance (API v10).
 *
 * KNOWN LIMITATION, by design of Cobalt's API: it returns ONE prepared result
 * per request rather than a format list. So this backend gives you
 * "best video+audio" and "audio only" instead of a full quality picker, and the
 * in-browser muxer is mostly bypassed because Cobalt has already combined the
 * tracks server-side.
 *
 * Use it when you want the simplest possible deployment. Use the yt-dlp backend
 * when you want the quality picker and client-side muxing this app was built for.
 */

interface CobaltResponse {
  status?: 'tunnel' | 'redirect' | 'picker' | 'local-processing' | 'error';
  url?: string;
  filename?: string;
  error?: { code?: string };
  picker?: Array<{ type?: string; url?: string; thumb?: string }>;
  audio?: string;
}

/** Maps Cobalt's error codes onto our stable client-facing codes. */
function translateError(code: string | undefined): AppError {
  const c = code ?? '';
  if (c.includes('link.unsupported')) return AppError.unsupported();
  if (c.includes('content.video.unavailable') || c.includes('link.invalid')) {
    return AppError.notFound();
  }
  if (c.includes('content.video.age') || c.includes('content.video.private')) {
    return new AppError('requires_auth', 'That media requires an account to view.', 422);
  }
  if (c.includes('content.video.region')) {
    return new AppError('geo_restricted', 'That media is not available in this region.', 451);
  }
  if (c.includes('content.video.live')) {
    return new AppError(
      'live_stream_unsupported',
      'Live streams cannot be downloaded as a file.',
      422,
    );
  }
  if (c.includes('fetch.rate')) return AppError.rateLimited(30);
  return AppError.upstream('The extraction service could not process that link.');
}

export function createCobaltResolver(options: {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
}): ResolverBackend {
  const { baseUrl, token, timeoutMs = 20_000 } = options;

  async function call(url: string, downloadMode: 'auto' | 'audio'): Promise<CobaltResponse> {
    try {
      const res = await fetch(new URL('/', baseUrl).toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(token ? { authorization: `Api-Key ${token}` } : {}),
        },
        body: JSON.stringify({
          url,
          downloadMode,
          videoQuality: 'max',
          audioFormat: 'best',
          filenameStyle: 'basic',
          // We want a direct URL we can proxy and hand to the muxer, never an
          // HLS manifest the browser would have to assemble.
          alwaysProxy: false,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return (await res.json()) as CobaltResponse;
    } catch {
      throw AppError.resolverDown('The extraction service did not respond in time.');
    }
  }

  return {
    name: 'cobalt',

    async resolve({ url }): Promise<ResolverResult> {
      const [video, audio] = await Promise.all([call(url, 'auto'), call(url, 'audio')]);

      if (video.status === 'error') throw translateError(video.error?.code);

      const streams: RawStream[] = [];

      const primary = video.url ?? video.picker?.find((p) => p.type === 'video')?.url;
      if (primary) {
        streams.push({
          url: primary,
          // Cobalt's `auto` mode returns an already-combined file.
          kind: 'muxed',
          container: video.filename?.split('.').pop() ?? 'mp4',
          codec: 'avc1',
        });
      }

      if (audio.status !== 'error' && audio.url) {
        streams.push({
          url: audio.url,
          kind: 'audio',
          container: audio.filename?.split('.').pop() ?? 'm4a',
          codec: 'mp4a',
        });
      }

      if (streams.length === 0) throw translateError(video.error?.code);

      // Cobalt returns no metadata beyond the filename, so the title is derived
      // from it and providers' enrich() fills in the rest.
      const title = video.filename?.replace(/\.[a-z0-9]{2,5}$/i, '')?.trim();

      return {
        title: title || 'Untitled',
        isLive: false,
        streams,
      };
    },
  };
}
