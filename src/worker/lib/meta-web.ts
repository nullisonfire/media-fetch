/**
 * Shared helpers for reading Meta's public web surface (Instagram + Facebook).
 *
 * Every technique here was verified live against Meta's servers. The non-obvious
 * findings are documented at the point of use, because they are the difference
 * between JSON and a 600 kB HTML shell.
 *
 * Credit: the approach — particularly the `Sec-Fetch-Site` discovery and the
 * logged-out GraphQL doc_id — comes from a working implementation supplied by
 * the project owner, ported here into the provider architecture.
 */

/* ------------------------------------------------------------------ *
 * Cookies
 * ------------------------------------------------------------------ */

/**
 * Collapses every Set-Cookie on a response into one `Cookie` request header.
 *
 * `getSetCookie()` is the correct API and is what workerd implements; the
 * split-on-comma fallback covers runtimes that only expose the joined string.
 * A naive `.split(',')` would corrupt Expires dates, hence the lookahead.
 */
export function harvestCookies(response: Response, into = new Map<string, string>()) {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const raw =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : (response.headers.get('set-cookie') ?? '').split(/,(?=[^;]+=[^;]+)/);

  for (const line of raw) {
    const [pair] = String(line).split(';');
    if (!pair) continue;
    const index = pair.indexOf('=');
    if (index > 0) into.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  return into;
}

export const cookieHeader = (jar: Map<string, string>): string =>
  [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');

/* ------------------------------------------------------------------ *
 * HTML / embedded-JSON scraping
 * ------------------------------------------------------------------ */

export function decodeHtmlEntities(input: string): string {
  return String(input)
    .replace(/&(?:amp|#38);/g, '&')
    .replace(/&(?:lt|#60);/g, '<')
    .replace(/&(?:gt|#62);/g, '>')
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&(?:apos|#39);/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
}

/**
 * Pulls a JSON string value out of raw HTML/JS by key, honouring escapes.
 *
 * Meta embeds config as JSON inside <script> tags, so a naive
 * /"key":"([^"]*)"/ breaks on every escaped quote or \/ sequence. This walks to
 * the value's real end and hands the slice to JSON.parse for correct unescaping.
 */
export function extractJsonString(text: string, key: string): string | null {
  const needle = `"${key}":"`;
  let from = 0;

  for (;;) {
    const start = text.indexOf(needle, from);
    if (start === -1) return null;

    let i = start + needle.length;
    for (; i < text.length; i += 1) {
      if (text[i] === '\\') {
        i += 1;
        continue;
      }
      if (text[i] === '"') break;
    }

    try {
      const parsed = JSON.parse(text.slice(start + needle.length - 1, i + 1)) as unknown;
      if (typeof parsed === 'string' && parsed) return parsed;
    } catch {
      /* malformed occurrence — try the next one */
    }
    from = i + 1;
  }
}

export function extractJsonNumber(text: string, key: string): number | null {
  const match = new RegExp(`"${key}":\\s*(-?\\d+(?:\\.\\d+)?)`).exec(text);
  return match?.[1] ? Number(match[1]) : null;
}

/** Reads an og:* / name=* meta tag, tolerating either attribute order. */
export function extractMetaTag(html: string, property: string): string | null {
  const forward = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)["']`,
    'i',
  ).exec(html);
  const reverse = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${property}["']`,
    'i',
  ).exec(html);
  const value = forward?.[1] ?? reverse?.[1];
  return value ? decodeHtmlEntities(value) : null;
}

/** "12.3K" / "4.5M" / "1,234" -> number. Facebook renders counts this way. */
export function parseCompactCount(input: string | null | undefined): number | null {
  if (input == null) return null;
  const match = /(\d[\d.,]*)\s*([KMB])?/i.exec(String(input));
  if (!match?.[1]) return null;
  const value = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  const scale = { k: 1e3, m: 1e6, b: 1e9 }[(match[2] ?? '').toLowerCase()] ?? 1;
  return Math.round(value * scale);
}

/* ------------------------------------------------------------------ *
 * Meta CDN URL self-description
 * ------------------------------------------------------------------ */

/**
 * Every Meta CDN URL carries an `efg` query param: base64url-encoded JSON that
 * self-describes the rendition. Verified example:
 *   {"vencode_tag":"ig-xpvds.clips.igwww-C3.dash_ln_heaac_vbr3_audio",
 *    "duration_s":12,"bitrate":59805,...}
 *
 * `vencode_tag` is authoritative about what the URL actually contains, which
 * makes it a better signal than inferring from the manifest alone.
 */
export function decodeEfg(url: string): { vencode_tag?: string; duration_s?: number; bitrate?: number } | null {
  try {
    const raw = /[?&]efg=([^&]+)/.exec(url)?.[1];
    if (!raw) return null;
    let b64 = decodeURIComponent(raw).replace(/-/g, '+').replace(/_/g, '/');
    b64 += '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(atob(b64)) as { vencode_tag?: string; duration_s?: number; bitrate?: number };
  } catch {
    return null;
  }
}

const isProgressiveTag = (tag: string | undefined): boolean => /progressive/i.test(tag ?? '');
const isAudioTag = (tag: string | undefined): boolean => /_audio\b|heaac|\baudio$/i.test(tag ?? '');

/* ------------------------------------------------------------------ *
 * DASH manifests
 * ------------------------------------------------------------------ */

/** ISO-8601 duration ("PT10.8S") -> seconds. */
export function parseIsoDuration(iso: string | undefined): number | null {
  const match =
    /^P(?:(\d+(?:\.\d+)?)D)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(
      String(iso ?? ''),
    );
  if (!match) return null;
  const [, d, h, m, s] = match.map((v) => (v ? Number(v) : 0));
  const total = (d ?? 0) * 86400 + (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0);
  return total > 0 ? Number(total.toFixed(3)) : null;
}

export interface DashRendition {
  url: string;
  kind: 'progressive' | 'video_only' | 'audio_only';
  hasAudio: boolean;
  width?: number;
  height?: number;
  bitrateKbps?: number;
  codec?: string;
  mimeType: string;
}

export interface ParsedDash {
  durationSeconds: number | null;
  video: DashRendition[];
  audio: DashRendition[];
}

/**
 * Parses Meta's inline DASH manifest.
 *
 * Instagram's manifest carries the full ladder up to 1080p, but those renditions
 * are ADAPTIVE — video and audio arrive as separate streams. Confirmed with
 * ffprobe against live URLs:
 *
 *   video_versions[0]   h264 716x1274 + aac   (muxed, plays as-is)
 *   DASH 1080p BaseURL  vp9  1076x1914        (VIDEO ONLY, silent)
 *   DASH audio BaseURL  aac stereo            (AUDIO ONLY)
 *
 * So the highest resolution Instagram offers is silent on its own — which is
 * exactly the case the in-browser muxer exists to repair.
 */
export function parseDashManifest(xml: string | null | undefined): ParsedDash {
  const empty: ParsedDash = { durationSeconds: null, video: [], audio: [] };
  if (!xml || typeof xml !== 'string') return empty;

  const durationSeconds = parseIsoDuration(
    /mediaPresentationDuration="([^"]+)"/.exec(xml)?.[1],
  );

  const video: DashRendition[] = [];
  const audio: DashRendition[] = [];

  for (const rep of xml.matchAll(/<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/g)) {
    const attrs = rep[1] ?? '';
    const baseUrl = /<BaseURL>([\s\S]*?)<\/BaseURL>/.exec(rep[2] ?? '')?.[1];
    if (!baseUrl) continue;

    /**
     * The leading boundary matters: a bare /width="/ also matches the tail of
     * bandwidth="828641", which silently produced absurd dimensions.
     */
    const attr = (name: string): string | null =>
      new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
    const num = (name: string): number | undefined => {
      const raw = attr(name);
      return raw ? Number(raw) : undefined;
    };

    const url = decodeHtmlEntities(baseUrl.trim());
    const mimeType = attr('mimeType') ?? '';
    const tag = decodeEfg(url)?.vencode_tag;
    const bandwidth = num('bandwidth');

    if (mimeType.startsWith('audio') || isAudioTag(tag)) {
      audio.push({
        url,
        kind: 'audio_only',
        hasAudio: true,
        mimeType: mimeType || 'audio/mp4',
        ...(bandwidth ? { bitrateKbps: Math.round(bandwidth / 1000) } : {}),
        ...(attr('codecs') ? { codec: attr('codecs')! } : {}),
      });
    } else if (mimeType.startsWith('video')) {
      const progressive = isProgressiveTag(tag);
      video.push({
        url,
        kind: progressive ? 'progressive' : 'video_only',
        hasAudio: progressive,
        mimeType,
        ...(num('width') ? { width: num('width') } : {}),
        ...(num('height') ? { height: num('height') } : {}),
        ...(bandwidth ? { bitrateKbps: Math.round(bandwidth / 1000) } : {}),
        ...(attr('codecs') ? { codec: attr('codecs')! } : {}),
      });
    }
  }

  // A manifest containing standalone audio is adaptive by definition, so every
  // video rendition in it is silent regardless of what its tag implied.
  if (audio.length > 0) {
    for (const rendition of video) {
      rendition.kind = 'video_only';
      rendition.hasAudio = false;
    }
  }

  video.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bitrateKbps ?? 0) - (a.bitrateKbps ?? 0));
  audio.sort((a, b) => (b.bitrateKbps ?? 0) - (a.bitrateKbps ?? 0));

  return { durationSeconds, video, audio };
}

/** Normalises a DASH `codecs` attribute to our short families. */
export function shortCodec(codecs: string | undefined, fallback: string): string {
  const c = (codecs ?? '').toLowerCase();
  if (!c) return fallback;
  if (c.startsWith('avc1') || c.startsWith('h264')) return 'avc1';
  if (c.startsWith('hev1') || c.startsWith('hvc1')) return 'hevc';
  if (c.startsWith('av01')) return 'av01';
  if (c.startsWith('vp9') || c.startsWith('vp09')) return 'vp9';
  if (c.startsWith('vp8')) return 'vp8';
  if (c.startsWith('mp4a')) return 'mp4a';
  if (c.startsWith('opus')) return 'opus';
  return c.split('.')[0] || fallback;
}

/** Shared desktop UA. Meta's endpoints reject empty or exotic UAs. */
export const META_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Browser-shaped headers for a top-level document GET. */
export const META_DOCUMENT_HEADERS: Record<string, string> = {
  'user-agent': META_UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-fetch-site': 'none',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
  'upgrade-insecure-requests': '1',
};
