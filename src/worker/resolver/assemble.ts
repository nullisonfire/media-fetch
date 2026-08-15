import type { ResolvedMedia, StreamVariant } from '@shared/contracts';
import type { PlatformId } from '@shared/platforms';
import { signStreamToken } from '../lib/signing';
import type { RawStream, ResolverResult } from './types';

/**
 * Turns raw backend output into the client-facing ResolvedMedia: ranks the
 * tracks, writes human labels, signs every URL, and decides what to preselect.
 *
 * This is the only place raw upstream URLs are converted into signed proxy URLs,
 * which makes it the chokepoint to audit for URL leakage.
 */

/* ----------------------------- formatting ----------------------------- */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const CODEC_LABELS: Record<string, string> = {
  avc1: 'H.264',
  hevc: 'HEVC',
  av01: 'AV1',
  vp9: 'VP9',
  vp8: 'VP8',
  mp4a: 'AAC',
  opus: 'Opus',
  vorbis: 'Vorbis',
  ac3: 'AC-3',
};

function prettyCodec(codec: string): string {
  return CODEC_LABELS[codec] ?? codec.toUpperCase();
}

function buildLabel(stream: RawStream): string {
  const parts: string[] = [];

  if (stream.kind === 'audio') {
    parts.push(stream.bitrateKbps ? `${Math.round(stream.bitrateKbps)} kbps` : 'Audio');
    parts.push(prettyCodec(stream.codec));
    if (stream.audioChannels && stream.audioChannels > 2) parts.push(`${stream.audioChannels}ch`);
  } else {
    const resolution = stream.height ? `${stream.height}p` : 'Video';
    // 60fps is worth calling out; 24/25/30 is the unremarkable default.
    const fps = stream.fps && stream.fps >= 50 ? String(Math.round(stream.fps)) : '';
    parts.push(`${resolution}${fps}`);
    if (stream.hdr) parts.push('HDR');
    parts.push(prettyCodec(stream.codec));
    if (stream.kind === 'muxed') parts.push('with audio');
    if (stream.kind === 'hls') parts.push('HLS · with audio');
  }

  if (stream.sizeBytes) parts.push(formatBytes(stream.sizeBytes));
  return parts.filter(Boolean).join(' · ');
}

/* ------------------------------- ranking ------------------------------ */

/**
 * Higher is better. Resolution dominates, then frame rate, then bitrate —
 * matching how a human would actually rank "best quality".
 */
function videoScore(s: RawStream): number {
  return (s.height ?? 0) * 1_000_000 + (s.fps ?? 30) * 1_000 + (s.bitrateKbps ?? 0);
}

function audioScore(s: RawStream): number {
  return (s.bitrateKbps ?? 0) * 10 + (s.audioChannels ?? 2);
}

/** Filenames must be safe on every OS and must not enable path traversal. */
function safeFilename(title: string, suffix: string, container: string): string {
  const base =
    title
      .normalize('NFKD')
      // Written out explicitly, NOT as a range: `[ -<]` looks harmless but is
      // the range 0x20..0x3C, which silently eats every digit in the title.
      .replace(/[<>:"'/\\|?*]/g, '')
      .replace(/\s+/g, ' ')
      // Trailing dots and spaces are illegal in Windows filenames.
      .replace(/[. ]+$/, '')
      .trim()
      .slice(0, 120) || 'download';
  return `${base}${suffix}.${container}`;
}

/* ------------------------------ assembly ------------------------------ */

export async function assembleResolvedMedia(params: {
  platform: PlatformId;
  canonicalUrl: string;
  mediaId: string;
  result: ResolverResult;
  metadata: { title?: string; author?: string; thumbnailUrl?: string; durationSeconds?: number };
  signingKey: string;
  ttlSeconds: number;
  origin: string;
}): Promise<ResolvedMedia> {
  const { platform, canonicalUrl, mediaId, result, metadata, signingKey, ttlSeconds, origin } =
    params;

  const expiresAtSeconds = Math.floor(Date.now() / 1000) + ttlSeconds;
  // Provider metadata wins over resolver metadata: it comes from the platform's
  // own documented API and is generally cleaner.
  const title = metadata.title?.trim() || result.title;

  const sign = async (stream: RawStream, index: number): Promise<StreamVariant> => {
    const suffix =
      stream.kind === 'audio'
        ? ' (audio)'
        : stream.kind === 'video'
          ? ` (${stream.height ?? 0}p video)`
          : '';
    // An HLS variant is assembled into MP4 in the browser, so name it that way.
    const container = stream.kind === 'hls' ? 'mp4' : stream.container;

    const token = await signStreamToken(
      {
        u: stream.url,
        e: expiresAtSeconds,
        k: stream.kind,
        p: platform,
        ...(stream.headers?.['Referer'] ? { r: stream.headers['Referer'] } : {}),
        ...(stream.headers?.['User-Agent'] ? { ua: stream.headers['User-Agent'] } : {}),
        f: safeFilename(title, suffix, container),
      },
      signingKey,
    );

    return {
      id: `${stream.kind}-${index}`,
      kind: stream.kind,
      container: stream.container,
      codec: stream.codec,
      ...(stream.width ? { width: stream.width } : {}),
      ...(stream.height ? { height: stream.height } : {}),
      ...(stream.fps ? { fps: stream.fps } : {}),
      ...(stream.hdr ? { hdr: stream.hdr } : {}),
      ...(stream.audioChannels ? { audioChannels: stream.audioChannels } : {}),
      ...(stream.audioSampleRate ? { audioSampleRate: stream.audioSampleRate } : {}),
      ...(stream.bitrateKbps ? { bitrateKbps: stream.bitrateKbps } : {}),
      ...(stream.sizeBytes ? { sizeBytes: stream.sizeBytes } : {}),
      label: buildLabel(stream),
      // Relative URL: keeps the payload small and avoids hardcoding the origin
      // into cached responses. `origin` is still accepted for absolute needs.
      proxyUrl: `${origin}/api/stream?t=${encodeURIComponent(token)}`,
    };
  };

  // Sort each family best-first so the UI can render the list as-is.
  const videos = result.streams.filter((s) => s.kind === 'video').sort((a, b) => videoScore(b) - videoScore(a));
  const audios = result.streams.filter((s) => s.kind === 'audio').sort((a, b) => audioScore(b) - audioScore(a));
  // HLS variants are self-contained, so they rank alongside progressive files.
  const muxed = result.streams
    .filter((s) => s.kind === 'muxed' || s.kind === 'hls')
    .sort((a, b) => videoScore(b) - videoScore(a));

  const ordered = [...muxed, ...videos, ...audios];
  const variants = await Promise.all(ordered.map(sign));

  const findId = (source: RawStream | undefined): string | undefined => {
    if (!source) return undefined;
    const index = ordered.indexOf(source);
    return index === -1 ? undefined : variants[index]?.id;
  };

  /**
   * Thumbnails are proxied too — not for secrecy, but because
   * `COEP: require-corp` blocks any cross-origin subresource that does not send
   * CORP headers, and none of these image CDNs do. Serving the preview
   * same-origin is the only way to keep cross-origin isolation (and therefore
   * the multithreaded muxer) AND still render a preview image.
   */
  const rawThumbnail = metadata.thumbnailUrl ?? result.thumbnailUrl;
  const thumbnailUrl = rawThumbnail
    ? `${origin}/api/stream?t=${encodeURIComponent(
        await signStreamToken(
          { u: rawThumbnail, e: expiresAtSeconds, k: 'thumb', p: platform },
          signingKey,
        ),
      )}`
    : undefined;

  const bestMuxed = muxed[0];
  const bestVideo = videos[0];
  const bestAudio = audios[0];

  /**
   * The core UX decision: is the best available quality only reachable by
   * combining separate tracks? True whenever there is no progressive file at
   * all, or the best video-only track outranks the best progressive one — which
   * on YouTube is anything above 720p.
   */
  const bestRequiresMux = Boolean(
    bestVideo && bestAudio && (!bestMuxed || videoScore(bestVideo) > videoScore(bestMuxed)),
  );

  return {
    platform,
    canonicalUrl,
    mediaId: mediaId || canonicalUrl,
    title,
    ...(metadata.author ?? result.author ? { author: metadata.author ?? result.author } : {}),
    ...(metadata.durationSeconds ?? result.durationSeconds
      ? { durationSeconds: metadata.durationSeconds ?? result.durationSeconds }
      : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    isLive: result.isLive,
    variants,
    recommended: {
      ...(findId(bestMuxed) ? { muxed: findId(bestMuxed) } : {}),
      ...(findId(bestVideo) ? { video: findId(bestVideo) } : {}),
      ...(findId(bestAudio) ? { audio: findId(bestAudio) } : {}),
    },
    bestRequiresMux,
    expiresAt: expiresAtSeconds * 1000,
  };
}
