/**
 * RESOLVER BYTE PASSTHROUGH
 * =========================
 *
 * Why this exists, in one measured fact:
 *
 *   A googlevideo URL produced by the resolver contains `ip=<resolver IP>`, and
 *   `ip` is listed in the URL's own `sparams`, meaning it is covered by the
 *   signature. Fetching it from anywhere else returns 403 — the redirect even
 *   names the mismatch (`ipbypass=yes&mip=<caller>`). Dailymotion's CDN is the
 *   same class of problem from the other direction: it refuses datacenter IPs
 *   and sends no `Access-Control-Allow-Origin`, so neither the Worker nor the
 *   browser can read it.
 *
 * Both collapse to a single requirement: the bytes must leave from the machine
 * that did the extraction. So the resolver grows a streaming endpoint, and the
 * browser talks to it DIRECTLY — the Worker never touches media. That keeps
 * Cloudflare's CPU limits and egress out of the picture entirely; the only cost
 * is bandwidth on the resolver's host.
 *
 * SECURITY. An open "fetch any URL" endpoint on someone's shared hosting is a
 * gift to the internet, so this is closed three ways:
 *
 *   1. Every URL is HMAC-signed by the Worker, with the already-shared
 *      RESOLVER_TOKEN as the key. The resolver serves nothing it did not mint.
 *   2. Tokens expire with the rest of the download session.
 *   3. The resolver additionally enforces its own CDN host allowlist, so even a
 *      leaked signing key cannot turn it into a general-purpose proxy.
 *
 * The token format is byte-identical to lib/signing.ts, so the Python side has
 * exactly one scheme to implement.
 */
import type { PlatformId } from '@shared/platforms';
import { signStreamToken } from '../lib/signing';
import { joinResolverUrl } from './types';
import type { RawStream } from './types';

export interface PassthroughConfig {
  /** Resolver base URL, path included (cPanel mounts apps on a path). */
  baseUrl: string;
  /** Shared bearer token, reused here as the HMAC key. Never sent to the browser. */
  token: string;
}

/**
 * Mints a browser-usable URL that streams `stream.url` from the resolver's IP.
 *
 * Returns undefined when the stream did not come from the resolver, or when no
 * resolver token is configured — an unsigned passthrough would be an open proxy,
 * so the absence of a token disables the feature rather than weakening it.
 */
export async function signPassthroughUrl(options: {
  stream: RawStream;
  platform: PlatformId;
  expiresAtSeconds: number;
  /** Suggested save name; the resolver echoes it in Content-Disposition. */
  filename: string;
  passthrough?: PassthroughConfig | undefined;
}): Promise<string | undefined> {
  const { stream, platform, expiresAtSeconds, filename, passthrough } = options;

  if (!stream.viaResolver || !passthrough?.token) return undefined;

  const token = await signStreamToken(
    {
      u: stream.url,
      e: expiresAtSeconds,
      k: stream.kind,
      p: platform,
      ...(stream.headers?.['Referer'] ? { r: stream.headers['Referer'] } : {}),
      // googlevideo validates the UA against the InnerTube client that minted
      // the URL, so the resolver must replay yt-dlp's exact string.
      ...(stream.headers?.['User-Agent'] ? { ua: stream.headers['User-Agent'] } : {}),
      f: filename,
    },
    passthrough.token,
  );

  return `${joinResolverUrl(passthrough.baseUrl, 'fetch')}?t=${encodeURIComponent(token)}`;
}
