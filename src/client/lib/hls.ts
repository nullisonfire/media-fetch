/**
 * CLIENT-SIDE HLS DOWNLOADER
 * ==========================
 *
 * An HLS variant is not a file — it is a playlist naming hundreds of segments.
 * To save it, the browser must fetch every segment and join them in order.
 *
 * TWO ROUTES, tried in order:
 *
 *  1. DIRECT from the CDN. Preferred for Dailymotion, because what its WAF blocks
 *     is datacenter IPs — not the visitor's residential connection. Fetching from
 *     the browser sidesteps the block entirely, and measurements showed the
 *     server-side route is a coin flip (4/6, later 0/8, from the same host).
 *  2. THROUGH THE PROXY. The Worker rewrites every URI into a signed same-origin
 *     link, so this works wherever CORS refuses a direct read — at the cost of
 *     going through the IP the CDN may be blocking.
 *
 * Whichever answers first wins, per request, with no configuration.
 *
 * Dailymotion's variants interleave audio and video, so unlike the adaptive
 * YouTube/Bilibili path there is nothing to mux — the joined bytes are already a
 * complete programme. They still get one `-c copy` pass through ffmpeg to turn a
 * segment stream into a seekable MP4 with a proper index.
 */

export interface HlsProgress {
  /** Segments finished so far. */
  completed: number;
  total: number;
  bytes: number;
}

export class HlsError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'HlsError';
  }
}

/**
 * How many segments to fetch at once.
 *
 * Segments are small and latency-dominated, so serial fetching is needlessly
 * slow; but too much parallelism buries the proxy and risks upstream rate
 * limits. Six matches a browser's own per-host connection budget.
 */
const CONCURRENCY = 6;

/** Playlists nest (master -> variant); refuse to recurse forever. */
const MAX_PLAYLIST_DEPTH = 3;

interface ParsedPlaylist {
  /** #EXT-X-MAP init segment, present for fMP4. Must come first. */
  initSegment?: string;
  segments: string[];
  /** Set when this was a master playlist rather than a media playlist. */
  variants: string[];
  encrypted: boolean;
}

function parsePlaylist(body: string): ParsedPlaylist {
  const lines = body.split('\n').map((l) => l.trim());
  const segments: string[] = [];
  const variants: string[] = [];
  let initSegment: string | undefined;
  let encrypted = false;
  let isMaster = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line) continue;

    if (line.startsWith('#EXT-X-STREAM-INF')) {
      isMaster = true;
      const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
      if (uri) variants.push(uri);
      continue;
    }
    if (line.startsWith('#EXT-X-MAP')) {
      initSegment = /URI="([^"]+)"/.exec(line)?.[1];
      continue;
    }
    // METHOD=NONE is the explicit "not encrypted" form and must not trip this.
    if (line.startsWith('#EXT-X-KEY') && !/METHOD=NONE/.test(line)) {
      encrypted = true;
      continue;
    }
    if (!line.startsWith('#') && !isMaster) segments.push(line);
  }

  return { ...(initSegment ? { initSegment } : {}), segments, variants, encrypted };
}

/**
 * A URL pair: the real CDN address, and our proxy as a fallback.
 *
 * Direct is preferred for Dailymotion because the visitor's residential IP is
 * not what the CDN blocks — the Worker's datacenter IP is. Fetching from the
 * browser sidesteps the WAF entirely. It can still fail (the CDN may not send
 * CORS headers for a third-party origin), so the proxy stays as the backstop.
 */
export interface SourceUrls {
  direct?: string;
  proxy: string;
}

/**
 * Fetches from `direct` when present, falling back to `proxy`.
 *
 * A CORS refusal surfaces as a thrown TypeError with no status — indistinguishable
 * from a network drop — so ANY direct failure falls through rather than trying to
 * classify it.
 */
async function fetchWithFallback(
  urls: SourceUrls,
  signal?: AbortSignal,
): Promise<{ response: Response; usedDirect: boolean; base: string }> {
  if (urls.direct) {
    try {
      const response = await fetch(urls.direct, { signal, mode: 'cors' });
      if (response.ok) return { response, usedDirect: true, base: urls.direct };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      /* CORS or network — fall through to the proxy */
    }
  }

  const response = await fetch(urls.proxy, { signal, credentials: 'same-origin' });
  if (!response.ok) {
    throw new HlsError(
      response.status === 410
        ? 'This download link expired. Resolve the link again.'
        : `Could not load the playlist (HTTP ${response.status}).`,
    );
  }
  return { response, usedDirect: false, base: urls.proxy };
}

/**
 * Builds a Worker-proxy URL for a child of a directly-fetched playlist.
 *
 * The parent's proxy URL carries a signed token for the PARENT resource, so it
 * cannot be reused for a child. `/api/stream` accepts a `u` parameter alongside
 * the parent token: the Worker verifies the token, checks the child shares the
 * parent's host, and only then fetches it. That keeps the endpoint closed
 * without minting a token per segment in the browser.
 */
function proxyFallbackFor(childUrl: string, parentProxyUrl: string): string {
  const url = new URL(parentProxyUrl, location.href);
  url.searchParams.set('u', childUrl);
  return url.toString();
}

/**
 * Downloads an HLS variant and returns the concatenated segment bytes.
 *
 * The result is a raw segment stream (MPEG-TS, or fMP4 when an init segment was
 * present) — playable by ffmpeg but not yet a well-formed MP4. Pass it to
 * `remuxToMp4` in the muxer to finish the job.
 */
export async function downloadHlsVariant(
  urls: SourceUrls,
  onProgress: (progress: HlsProgress) => void,
  signal?: AbortSignal,
  depth = 0,
): Promise<Uint8Array> {
  if (depth > MAX_PLAYLIST_DEPTH) {
    throw new HlsError('The playlist nests too deeply to follow.');
  }

  const { response, usedDirect, base } = await fetchWithFallback(urls, signal);
  const playlist = parsePlaylist(await response.text());

  /**
   * How child URIs resolve depends on which route answered.
   *
   * Proxy route: the Worker already rewrote every URI into an absolute
   *   same-origin link, so it is used verbatim.
   * Direct route: URIs are relative to the CDN. They are tried directly first,
   *   but they MUST keep a genuine proxy fallback — an earlier version pointed
   *   `proxy` back at the same CDN URL, which meant a failing segment simply
   *   retried the identical request and the fallback did nothing.
   */
  const childUrls = (uri: string): SourceUrls => {
    if (!usedDirect) return { proxy: new URL(uri, base).toString() };
    const absolute = new URL(uri, base).toString();
    return { direct: absolute, proxy: proxyFallbackFor(absolute, urls.proxy) };
  };

  // A master playlist slipped through: follow its best (first) variant, which
  // the Worker already sorted highest-quality-first.
  if (playlist.variants.length > 0 && playlist.segments.length === 0) {
    // A master playlist. Follow the highest-bandwidth variant.
    return downloadHlsVariant(childUrls(playlist.variants[0]!), onProgress, signal, depth + 1);
  }

  if (playlist.encrypted) {
    /**
     * AES-128 HLS could be decrypted here with Web Crypto, but the key URI is
     * usually access-controlled and, more importantly, encryption on a
     * commercial stream signals content this tool has no business unwrapping.
     */
    throw new HlsError('This stream is encrypted, so it cannot be saved.');
  }

  if (playlist.segments.length === 0) {
    throw new HlsError('The playlist contained no segments.');
  }

  // The init segment must be byte zero of the output; everything else follows in
  // playlist order, so results are indexed rather than pushed as they land.
  const segmentUris = playlist.initSegment
    ? [playlist.initSegment, ...playlist.segments]
    : playlist.segments;

  const chunks = new Array<Uint8Array | undefined>(segmentUris.length);
  let completed = 0;
  let bytes = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= segmentUris.length) return;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const { response: segment } = await fetchWithFallback(
        childUrls(segmentUris[index]!),
        signal,
      );
      const buffer = new Uint8Array(await segment.arrayBuffer());
      chunks[index] = buffer;

      completed += 1;
      bytes += buffer.byteLength;
      onProgress({ completed, total: segmentUris.length, bytes });
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, segmentUris.length) }, worker));

  // Single allocation, then one pass — concatenating incrementally would copy
  // the whole buffer on every segment.
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    if (!chunk) throw new HlsError('A segment was lost during download.');
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
