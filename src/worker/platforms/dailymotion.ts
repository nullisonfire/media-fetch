import { defineProvider, hostMatches, stripTracking } from './types';

/** Dailymotion ids start with x, then base36. Suffixes after `_` are slugs. */
const VIDEO_ID = /^(x[a-z0-9]{5,9})/i;

export const dailymotion = defineProvider({
  id: 'dailymotion',

  hosts: ['dailymotion.com', 'dai.ly', 'dmcdn.net'],

  cdnHosts: [
    'dmcdn.net', // proxy-*.dailymotion.com fronts this
    'dailymotion.com',
    'dm-vod-fra1.dailymotion.com',
  ],

  match(url) {
    if (!hostMatches(url.hostname, this.hosts)) return null;

    const segments = url.pathname.split('/').filter(Boolean);
    const stripped = stripTracking(url);
    const canonicalFor = (id: string) => `https://www.dailymotion.com/video/${id}`;

    // dai.ly/<id>
    if (hostMatches(url.hostname, ['dai.ly'])) {
      const m = VIDEO_ID.exec(segments[0] ?? '');
      if (m?.[1]) return { confidence: 1, mediaId: m[1].toLowerCase(), canonicalUrl: canonicalFor(m[1].toLowerCase()) };
      return { confidence: 0.5, mediaId: '', canonicalUrl: stripped.toString() };
    }

    // /video/<id>[_slug]  and  /embed/video/<id>
    const videoIdx = segments.lastIndexOf('video');
    if (videoIdx !== -1) {
      const raw = segments[videoIdx + 1] ?? '';
      const m = VIDEO_ID.exec(raw);
      if (m?.[1]) {
        const id = m[1].toLowerCase();
        return { confidence: 1, mediaId: id, canonicalUrl: canonicalFor(id) };
      }
      return { confidence: 0.6, mediaId: raw, canonicalUrl: stripped.toString() };
    }

    return { confidence: 0.4, mediaId: '', canonicalUrl: stripped.toString() };
  },

  /**
   * Dailymotion's Graph API is public and keyless for read-only video fields —
   * the cleanest metadata source of any platform here.
   */
  async enrich(match, ctx) {
    if (!match.mediaId) return {};
    const cacheKey = `dm:video:${match.mediaId}`;
    const cached = await ctx.cacheGet(cacheKey);
    if (cached) return JSON.parse(cached);

    const api = new URL(`https://api.dailymotion.com/video/${encodeURIComponent(match.mediaId)}`);
    api.searchParams.set('fields', 'title,duration,thumbnail_720_url,owner.screenname');

    const res = await ctx.fetch(api.toString(), {
      headers: { accept: 'application/json', 'user-agent': ctx.userAgent },
    });
    if (!res.ok) return {};

    const body = (await res.json()) as {
      title?: string;
      duration?: number;
      thumbnail_720_url?: string;
      'owner.screenname'?: string;
    };
    const meta = {
      title: body.title,
      author: body['owner.screenname'],
      durationSeconds: body.duration,
      thumbnailUrl: body.thumbnail_720_url,
    };
    await ctx.cachePut(cacheKey, JSON.stringify(meta), 21_600);
    return meta;
  },
});
