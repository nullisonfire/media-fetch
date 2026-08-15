import { signStreamToken, type StreamTokenPayload } from './signing';

/**
 * HLS playlist rewriting.
 *
 * A playlist is a list of URLs pointing at the origin CDN. Handing it to the
 * browser unchanged would fail twice over: the segment hosts send no CORS
 * headers (so JS could not read the bytes), and it would leak signed upstream
 * URLs into the page.
 *
 * So the Worker rewrites every URI in the playlist into a signed same-origin
 * proxy URL. The client then treats segments exactly like any other proxied
 * stream, and never learns the real CDN addresses.
 *
 * Only the URI lines change; every tag, duration and byte-range is preserved
 * verbatim, so the playlist stays byte-compatible with any HLS parser.
 */

/** Tags whose URI="..." attribute also needs rewriting. */
const URI_ATTRIBUTE_TAGS = ['#EXT-X-MAP', '#EXT-X-KEY', '#EXT-X-MEDIA', '#EXT-X-I-FRAME-STREAM-INF'];

export interface RewriteOptions {
  /** Absolute URL the playlist was fetched from — resolves relative URIs. */
  playlistUrl: string;
  /** Origin of this Worker, e.g. https://media-fetch.example.workers.dev */
  origin: string;
  signingKey: string;
  /** Epoch seconds; inherited from the parent token so nothing outlives it. */
  expiresAt: number;
  /** Copied onto every child token so segments carry the same headers. */
  base: Pick<StreamTokenPayload, 'p' | 'r' | 'ua'>;
}

async function proxyUrlFor(
  rawUrl: string,
  kind: 'hls' | 'muxed',
  options: RewriteOptions,
): Promise<string> {
  const absolute = new URL(rawUrl, options.playlistUrl).toString();
  const token = await signStreamToken(
    { u: absolute, e: options.expiresAt, k: kind, ...options.base },
    options.signingKey,
  );
  return `${options.origin}/api/stream?t=${encodeURIComponent(token)}`;
}

/**
 * Rewrites a playlist so every URI points back at this Worker.
 *
 * Nested playlists (a master pointing at variants) are signed as `hls` so that
 * fetching them rewrites them in turn; media segments are signed as `muxed`
 * because they are opaque byte ranges.
 */
export async function rewritePlaylist(body: string, options: RewriteOptions): Promise<string> {
  const lines = body.split('\n');
  const isMaster = /#EXT-X-STREAM-INF/.test(body);

  const rewritten = await Promise.all(
    lines.map(async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith('#')) {
        // Rewrite URI="..." attributes (init segments, encryption keys, audio
        // renditions). Leaving these alone would break playback and decryption.
        const tag = URI_ATTRIBUTE_TAGS.find((t) => trimmed.startsWith(t));
        if (!tag) return line;

        const match = /URI="([^"]+)"/.exec(trimmed);
        if (!match?.[1]) return line;

        // An EXT-X-MEDIA URI is another playlist; MAP and KEY are raw bytes.
        const kind = tag === '#EXT-X-MEDIA' ? 'hls' : 'muxed';
        const proxied = await proxyUrlFor(match[1], kind, options);
        return line.replace(match[0], `URI="${proxied}"`);
      }

      // A bare line is a URI: a variant playlist in a master, else a segment.
      return proxyUrlFor(trimmed, isMaster ? 'hls' : 'muxed', options);
    }),
  );

  return rewritten.join('\n');
}

/* ------------------------------------------------------------------ *
 * Parsing (used by providers to enumerate qualities)
 * ------------------------------------------------------------------ */

export interface HlsVariant {
  url: string;
  bandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  name?: string;
}

/** Reads the variant list out of a master playlist. */
export function parseMasterPlaylist(body: string, baseUrl: string): HlsVariant[] {
  const variants: HlsVariant[] = [];
  const lines = body.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim() ?? '';
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;

    // The URI is the next non-comment line.
    let uri = '';
    for (let j = i + 1; j < lines.length; j += 1) {
      const candidate = lines[j]?.trim() ?? '';
      if (candidate && !candidate.startsWith('#')) {
        uri = candidate;
        break;
      }
    }
    if (!uri) continue;

    const attr = (name: string): string | undefined =>
      new RegExp(`${name}=("([^"]*)"|([^,]*))`).exec(line)?.[2] ??
      new RegExp(`${name}=("([^"]*)"|([^,]*))`).exec(line)?.[3];

    const resolution = attr('RESOLUTION');
    const [width, height] = resolution
      ? resolution.split('x').map((n) => Number(n) || undefined)
      : [undefined, undefined];
    const bandwidth = Number(attr('BANDWIDTH')) || undefined;

    variants.push({
      url: new URL(uri, baseUrl).toString(),
      ...(bandwidth ? { bandwidth } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(attr('CODECS') ? { codecs: attr('CODECS')! } : {}),
      ...(attr('NAME') ? { name: attr('NAME')! } : {}),
    });
  }

  // Best first.
  return variants.sort(
    (a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0),
  );
}
