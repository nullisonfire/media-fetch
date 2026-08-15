/**
 * HMAC-signed, expiring stream tokens.
 *
 * WHY: /api/stream fetches an arbitrary upstream URL and pipes it back. Without
 * signing, that endpoint is a free open proxy the entire internet can use to
 * launder traffic through your Cloudflare account. Signing means the Worker only
 * ever fetches URLs it *itself* minted moments earlier.
 *
 * Token = base64url(payload) "." base64url(HMAC-SHA256(payload))
 */
import type { TrackKind } from '@shared/contracts';
import type { PlatformId } from '@shared/platforms';

export interface StreamTokenPayload {
  /** Upstream media URL. */
  u: string;
  /** Expiry, epoch seconds. */
  e: number;
  /**
   * Track kind, used to pick a sane Content-Type / filename.
   * `thumb` reuses this same signing path for preview images — necessary because
   * COEP: require-corp blocks cross-origin <img> loads, so thumbnails must be
   * served same-origin too.
   */
  k: TrackKind | 'thumb';
  /** Platform, so the proxy can apply per-platform request headers. */
  p: PlatformId;
  /** Referer some CDNs require (bilibili). Never user-controlled. */
  r?: string;
  /**
   * User-Agent override. YouTube's video CDN validates the UA against the
   * InnerTube client that minted the URL, so the proxy must replay the exact
   * client string rather than our own.
   */
  ua?: string;
  /** Suggested download filename. */
  f?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Key material is cached per isolate — importKey is not free. */
const keyCache = new Map<string, Promise<CryptoKey>>();

function getKey(secret: string): Promise<CryptoKey> {
  let cached = keyCache.get(secret);
  if (!cached) {
    cached = crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
    keyCache.set(secret, cached);
  }
  return cached;
}

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export async function signStreamToken(
  payload: StreamTokenPayload,
  secret: string,
): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await getKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return `${body}.${toBase64Url(signature)}`;
}

export type TokenFailure = 'token_invalid' | 'token_expired';

export async function verifyStreamToken(
  token: string,
  secret: string,
): Promise<{ ok: true; payload: StreamTokenPayload } | { ok: false; reason: TokenFailure }> {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'token_invalid' };

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  let valid: boolean;
  try {
    const key = await getKey(secret);
    // crypto.subtle.verify is constant-time, so no manual comparison is needed.
    valid = await crypto.subtle.verify(
      'HMAC',
      key,
      fromBase64Url(signature),
      encoder.encode(body),
    );
  } catch {
    return { ok: false, reason: 'token_invalid' };
  }
  if (!valid) return { ok: false, reason: 'token_invalid' };

  let payload: StreamTokenPayload;
  try {
    payload = JSON.parse(decoder.decode(fromBase64Url(body)));
  } catch {
    return { ok: false, reason: 'token_invalid' };
  }

  if (typeof payload?.u !== 'string' || typeof payload?.e !== 'number') {
    return { ok: false, reason: 'token_invalid' };
  }
  // Expiry is checked AFTER signature verification so an attacker cannot use
  // timing on this branch to learn anything about the key.
  if (payload.e * 1000 <= Date.now()) return { ok: false, reason: 'token_expired' };

  return { ok: true, payload };
}
