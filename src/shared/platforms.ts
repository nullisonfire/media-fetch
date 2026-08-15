/**
 * Platform identity + presentation metadata.
 *
 * This module is imported by BOTH the Worker and the browser bundle, so it must
 * stay free of any runtime-specific API. It is deliberately data-only: the
 * matching logic and extraction behaviour live in src/worker/platforms/*.
 *
 * ADDING A PLATFORM
 * -----------------
 * 1. Add an entry to PLATFORMS below.
 * 2. Create src/worker/platforms/<id>.ts (copy _template.ts).
 * 3. Register it in src/worker/platforms/registry.ts.
 * The dropdown, the icons, and the smart detector all pick it up automatically.
 */

export const PLATFORM_IDS = [
  'youtube',
  'bilibili',
  'facebook',
  'instagram',
  'dailymotion',
] as const;

export type PlatformId = (typeof PLATFORM_IDS)[number];

/** A platform the UI can offer even before a worker-side provider exists. */
export interface PlatformDescriptor {
  readonly id: PlatformId;
  /** Human label for the dropdown. */
  readonly name: string;
  /** Brand colour, used for the accent ring on the detected-platform chip. */
  readonly accent: string;
  /** Inline SVG path data (24x24 viewBox) — avoids shipping an icon font. */
  readonly glyph: string;
  /** Shown as dropdown hint text, e.g. supported link shapes. */
  readonly hint: string;
  /**
   * True when the platform commonly serves video and audio as SEPARATE streams,
   * meaning the best quality requires an in-browser mux. Drives UI copy.
   */
  readonly splitStreamsCommon: boolean;
}

export const PLATFORMS: Readonly<Record<PlatformId, PlatformDescriptor>> = {
  youtube: {
    id: 'youtube',
    name: 'YouTube',
    accent: '#ff0033',
    glyph:
      'M21.6 7.2a2.8 2.8 0 0 0-2-2C17.9 4.8 12 4.8 12 4.8s-5.9 0-7.6.4a2.8 2.8 0 0 0-2 2A29 29 0 0 0 2 12a29 29 0 0 0 .4 4.8 2.8 2.8 0 0 0 2 2c1.7.4 7.6.4 7.6.4s5.9 0 7.6-.4a2.8 2.8 0 0 0 2-2A29 29 0 0 0 22 12a29 29 0 0 0-.4-4.8ZM10 15.5v-7l6 3.5-6 3.5Z',
    hint: 'watch, youtu.be, shorts, live',
    splitStreamsCommon: true,
  },
  bilibili: {
    id: 'bilibili',
    name: 'Bilibili',
    accent: '#00a1d6',
    glyph:
      'M18.2 5.6h-1.6l1.1-1.1a1 1 0 0 0-1.4-1.4L14 5.6h-4L7.7 3.1a1 1 0 0 0-1.4 1.4l1.1 1.1H5.8A3.8 3.8 0 0 0 2 9.4v6.8a3.8 3.8 0 0 0 3.8 3.8h12.4a3.8 3.8 0 0 0 3.8-3.8V9.4a3.8 3.8 0 0 0-3.8-3.8Zm-9 6.1v1.9a1 1 0 0 1-2 0v-1.9a1 1 0 0 1 2 0Zm7.6 0v1.9a1 1 0 0 1-2 0v-1.9a1 1 0 0 1 2 0Z',
    hint: 'video/BV…, /bangumi, b23.tv',
    splitStreamsCommon: true,
  },
  facebook: {
    id: 'facebook',
    name: 'Facebook',
    accent: '#0866ff',
    glyph:
      'M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06C2 17.08 5.66 21.24 10.44 22v-7.02H7.9v-2.92h2.54V9.85c0-2.52 1.49-3.91 3.77-3.91 1.1 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.78-1.63 1.57v1.89h2.78l-.45 2.92h-2.33V22C18.34 21.24 22 17.08 22 12.06Z',
    hint: 'watch, /videos/, reel, fb.watch',
    splitStreamsCommon: true,
  },
  instagram: {
    id: 'instagram',
    name: 'Instagram',
    accent: '#e1306c',
    glyph:
      'M12 2c2.72 0 3.06.01 4.12.06 1.07.05 1.79.22 2.43.47.66.25 1.22.6 1.77 1.15.55.55.9 1.11 1.15 1.77.25.64.42 1.36.47 2.43.05 1.06.06 1.4.06 4.12s-.01 3.06-.06 4.12c-.05 1.07-.22 1.79-.47 2.43a4.9 4.9 0 0 1-1.15 1.77c-.55.55-1.11.9-1.77 1.15-.64.25-1.36.42-2.43.47-1.06.05-1.4.06-4.12.06s-3.06-.01-4.12-.06c-1.07-.05-1.79-.22-2.43-.47a4.9 4.9 0 0 1-1.77-1.15 4.9 4.9 0 0 1-1.15-1.77c-.25-.64-.42-1.36-.47-2.43C2.01 15.06 2 14.72 2 12s.01-3.06.06-4.12c.05-1.07.22-1.79.47-2.43.25-.66.6-1.22 1.15-1.77.55-.55 1.11-.9 1.77-1.15.64-.25 1.36-.42 2.43-.47C8.94 2.01 9.28 2 12 2Zm0 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 8.25a3.25 3.25 0 1 1 0-6.5 3.25 3.25 0 0 1 0 6.5ZM18.4 6.75a1.15 1.15 0 1 1-2.3 0 1.15 1.15 0 0 1 2.3 0Z',
    hint: '/p/, /reel/, /tv/',
    splitStreamsCommon: false,
  },
  dailymotion: {
    id: 'dailymotion',
    name: 'Dailymotion',
    accent: '#0af',
    glyph:
      'M19 3v18h-3.3v-1.7a5.9 5.9 0 0 1-4.2 1.9A6.2 6.2 0 0 1 5 14.9a6.1 6.1 0 0 1 6.3-6.3c1.6 0 3 .6 4 1.6V3.7L19 3Zm-7.6 8.8a3.1 3.1 0 1 0 0 6.2 3.1 3.1 0 0 0 0-6.2Z',
    hint: 'video/x…, dai.ly',
    splitStreamsCommon: true,
  },
};

export const PLATFORM_LIST: readonly PlatformDescriptor[] = PLATFORM_IDS.map(
  (id) => PLATFORMS[id],
);

export function isPlatformId(value: unknown): value is PlatformId {
  return typeof value === 'string' && (PLATFORM_IDS as readonly string[]).includes(value);
}

export function platformName(id: PlatformId | string): string {
  return isPlatformId(id) ? PLATFORMS[id].name : 'Unknown';
}
