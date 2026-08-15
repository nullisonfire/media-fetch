/**
 * SSRF guards for the stream proxy.
 *
 * The proxy is the single most dangerous surface in this app: it takes a URL and
 * makes the Worker fetch it. Even with HMAC signing (which stops outsiders
 * minting URLs), a compromised or buggy resolver could hand back a URL pointing
 * at internal infrastructure or a Cloudflare-internal address. These checks are
 * the second layer of that defence.
 */
import { isAllowedCdnHost } from '../platforms/registry';

export type SsrfVerdict = { ok: true; url: URL } | { ok: false; reason: string };

/** Literal IP forms that must never be fetched. */
const BLOCKED_IPV4 = [
  /^0\./, // "this" network
  /^10\./, // RFC1918
  /^127\./, // loopback
  /^169\.254\./, // link-local, incl. cloud metadata 169.254.169.254
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918
  /^192\.168\./, // RFC1918
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
  /^198\.(1[89])\./, // benchmarking
  /^2(2[4-9]|3\d)\./, // multicast
  /^255\./,
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isBlockedIpv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true; // link-local / ULA
  // IPv4-mapped (::ffff:127.0.0.1) — re-check the embedded v4 address.
  const mapped = /::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (mapped?.[1]) return BLOCKED_IPV4.some((re) => re.test(mapped[1]!));
  return false;
}

/**
 * Validates an upstream URL before the Worker fetches it.
 *
 * @param requireAllowlist when true (the default) the host must belong to a
 *   registered platform CDN. This is what prevents the proxy being repurposed as
 *   a general-purpose relay.
 */
export function assertSafeUpstream(raw: string, requireAllowlist = true): SsrfVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'malformed_url' };
  }

  // 1. HTTPS only. http:// upstreams would downgrade the user's transport and
  //    are never legitimately needed by these CDNs.
  if (url.protocol !== 'https:') return { ok: false, reason: 'protocol_not_allowed' };

  // 2. Credentials in the URL are always a red flag.
  if (url.username || url.password) return { ok: false, reason: 'credentials_in_url' };

  const host = url.hostname.toLowerCase();

  // 3. Named localhost-ish and cloud-metadata hosts.
  if (BLOCKED_HOSTNAMES.has(host)) return { ok: false, reason: 'blocked_hostname' };
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    return { ok: false, reason: 'blocked_hostname' };
  }

  // 4. Raw IP literals. A legitimate CDN URL is always a hostname, so rejecting
  //    every literal IP is both safe and simpler than trying to allow some.
  if (isIpv4(host)) return { ok: false, reason: 'ip_literal_not_allowed' };
  if (host.includes(':') || raw.includes('[')) {
    if (isBlockedIpv6(host)) return { ok: false, reason: 'blocked_ipv6' };
    return { ok: false, reason: 'ip_literal_not_allowed' };
  }

  // 5. Non-standard ports — CDN media is always on 443.
  if (url.port && url.port !== '443') return { ok: false, reason: 'port_not_allowed' };

  // 6. Platform CDN allowlist.
  if (requireAllowlist && !isAllowedCdnHost(host)) {
    return { ok: false, reason: 'host_not_allowlisted' };
  }

  return { ok: true, url };
}

/**
 * Fetches with redirects handled MANUALLY, re-validating every hop.
 *
 * `redirect: 'follow'` would let an allowlisted host bounce us to
 * 169.254.169.254 in a single unchecked jump — the classic SSRF bypass.
 * Shortlink hosts (b23.tv, fb.watch) legitimately redirect, so we cannot simply
 * forbid redirects either.
 */
export async function safeFetch(
  input: string,
  init: RequestInit,
  options: { maxRedirects?: number; requireAllowlist?: boolean } = {},
): Promise<Response> {
  const { maxRedirects = 4, requireAllowlist = true } = options;

  let current = input;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const verdict = assertSafeUpstream(current, requireAllowlist);
    if (!verdict.ok) throw new UpstreamRejected(verdict.reason, current);

    const response = await fetch(verdict.url.toString(), { ...init, redirect: 'manual' });

    const isRedirect = response.status >= 300 && response.status < 400;
    if (!isRedirect) return response;

    const location = response.headers.get('location');
    if (!location) return response;

    // Resolve relative Location headers against the current URL.
    current = new URL(location, verdict.url).toString();
    // Body must be drained/cancelled or the subrequest leaks.
    await response.body?.cancel();
  }

  throw new UpstreamRejected('too_many_redirects', current);
}

export class UpstreamRejected extends Error {
  constructor(
    readonly reason: string,
    readonly url: string,
  ) {
    // Deliberately does NOT include the URL in the message: these strings can
    // reach logs, and upstream URLs carry session tokens.
    super(`Upstream rejected: ${reason}`);
    this.name = 'UpstreamRejected';
  }
}
