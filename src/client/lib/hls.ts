/**
 * CLIENT-SIDE HLS DOWNLOADER
 * ==========================
 *
 * An HLS variant is not a file — it is a playlist naming hundreds of segments.
 * To save it, the browser must fetch every segment and join them in order.
 *
 * The Worker has already rewritten the playlist so every URI is a signed
 * same-origin proxy URL, which means two problems are already solved before this
 * code runs: the segment CDNs send no CORS headers (so a direct fetch could
 * never read the bytes), and no upstream URL is exposed to the page.
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

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal, credentials: 'same-origin' });
  if (!response.ok) {
    throw new HlsError(
      response.status === 410
        ? 'This download link expired. Resolve the link again.'
        : `Could not load the playlist (HTTP ${response.status}).`,
    );
  }
  return response.text();
}

/**
 * Downloads an HLS variant and returns the concatenated segment bytes.
 *
 * The result is a raw segment stream (MPEG-TS, or fMP4 when an init segment was
 * present) — playable by ffmpeg but not yet a well-formed MP4. Pass it to
 * `remuxToMp4` in the muxer to finish the job.
 */
export async function downloadHlsVariant(
  playlistUrl: string,
  onProgress: (progress: HlsProgress) => void,
  signal?: AbortSignal,
  depth = 0,
): Promise<Uint8Array> {
  if (depth > MAX_PLAYLIST_DEPTH) {
    throw new HlsError('The playlist nests too deeply to follow.');
  }

  const playlist = parsePlaylist(await fetchText(playlistUrl, signal));

  // A master playlist slipped through: follow its best (first) variant, which
  // the Worker already sorted highest-quality-first.
  if (playlist.variants.length > 0 && playlist.segments.length === 0) {
    const first = playlist.variants[0]!;
    return downloadHlsVariant(first, onProgress, signal, depth + 1);
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
  const urls = playlist.initSegment
    ? [playlist.initSegment, ...playlist.segments]
    : playlist.segments;

  const chunks = new Array<Uint8Array | undefined>(urls.length);
  let completed = 0;
  let bytes = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= urls.length) return;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const response = await fetch(urls[index]!, { signal, credentials: 'same-origin' });
      if (!response.ok) {
        throw new HlsError(`Segment ${index + 1} of ${urls.length} failed (HTTP ${response.status}).`);
      }
      const buffer = new Uint8Array(await response.arrayBuffer());
      chunks[index] = buffer;

      completed += 1;
      bytes += buffer.byteLength;
      onProgress({ completed, total: urls.length, bytes });
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));

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
