/**
 * EDGE PROBE — what can YOUR Cloudflare Worker actually reach?
 * ============================================================
 *
 * Every platform verdict in the README was measured from a normal datacenter
 * host. That is NOT the same vantage point as a Cloudflare Worker:
 *
 *   - Cloudflare egresses from its own IP ranges, with their own reputation.
 *   - Dailymotion sits BEHIND Cloudflare, so a Worker -> Dailymotion request may
 *     never leave Cloudflare's network at all.
 *   - The TLS/HTTP2 fingerprint of workerd differs from curl and from Node.
 *
 * Any of those can flip a 403 into a 200 or the reverse, so the only trustworthy
 * measurement is one taken from the edge itself. This file is that measurement.
 *
 * RUN IT (about 30 seconds, deploys nothing permanent):
 *
 *   npx wrangler dev --remote scripts/edge-probe.js --compatibility-date 2025-01-01
 *   curl -s http://localhost:8787 | npx json 2>/dev/null || curl -s http://localhost:8787
 *
 * `--remote` is the important flag: it runs the code on Cloudflare's network
 * rather than locally, so the results reflect production. Without it you are just
 * measuring your own laptop's IP again.
 *
 * Nothing here is part of the app. It is a diagnostic you can delete.
 */

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0';

/**
 * The exact header set a real Chrome tab sends for a top-level navigation to a
 * dailymotion.com subdomain. Reproduced verbatim so that a difference in the
 * result can only be the network, never the headers.
 */
const BROWSER_NAV = {
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'no-cache',
  dnt: '1',
  pragma: 'no-cache',
  priority: 'u=0, i',
  'sec-ch-ua': '"Not=A?Brand";v="99", "Microsoft Edge";v="151", "Chromium";v="151"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'same-site',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'user-agent': CHROME_UA,
};

const ANDROID_VR_UA =
  'com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12; GB) gzip';

/** Runs a probe, never throws, always returns a row. */
async function probe(name, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    return { name, ...result, ms: Date.now() - started };
  } catch (err) {
    return { name, ok: false, note: `threw: ${String(err).slice(0, 120)}`, ms: Date.now() - started };
  }
}

/* ------------------------------------------------------------------ */

/** Where is this Worker, and what IP does it egress from? */
async function egressInfo() {
  const res = await fetch('https://www.cloudflare.com/cdn-cgi/trace');
  const text = await res.text();
  const get = (k) => new RegExp(`^${k}=(.*)$`, 'm').exec(text)?.[1] ?? '?';
  return { ip: get('ip'), colo: get('colo'), loc: get('loc'), warp: get('warp') };
}

/** THE Dailymotion question: does the CDN serve a manifest from the edge? */
async function dailymotion() {
  const meta = await fetch('https://geo.dailymotion.com/video/xaxvs5m.json?legacy=true', {
    headers: { 'user-agent': CHROME_UA },
  });
  if (!meta.ok) return { ok: false, note: `geo metadata HTTP ${meta.status}` };

  const json = await meta.json();
  const master = json?.qualities?.auto?.[0]?.url;
  if (!master) return { ok: false, note: 'no master playlist in metadata' };

  const manifest = await fetch(master, { headers: BROWSER_NAV });
  if (!manifest.ok) {
    return {
      ok: false,
      note: `metadata OK, but cdndirector manifest HTTP ${manifest.status} — same block as a plain datacenter host`,
    };
  }

  const body = await manifest.text();
  const variants = (body.match(/#EXT-X-STREAM-INF/g) || []).length;

  // If the manifest works, go one level deeper: can we get real bytes?
  const variantPath = body.split('\n').find((line) => line && !line.startsWith('#'));
  let segmentNote = 'no variant line found';
  if (variantPath) {
    const variantUrl = new URL(variantPath, master).toString();
    const variantRes = await fetch(variantUrl, { headers: BROWSER_NAV });
    if (!variantRes.ok) {
      segmentNote = `variant playlist HTTP ${variantRes.status}`;
    } else {
      const variantBody = await variantRes.text();
      const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(variantBody)?.[1];
      const first = variantBody.split('\n').find((l) => l && !l.startsWith('#'));
      const target = new URL(init ?? first, variantUrl).toString();
      const seg = await fetch(target, { headers: BROWSER_NAV });
      const bytes = seg.ok ? (await seg.arrayBuffer()).byteLength : 0;
      segmentNote = bytes > 100 ? `SEGMENT BYTES OK (${bytes})` : `segment HTTP ${seg.status}`;
    }
  }

  return {
    ok: true,
    note: `MANIFEST SERVED — ${variants} variants, separate audio: ${/TYPE=AUDIO/.test(body)}. ${segmentNote}`,
  };
}

/** YouTube, re-measured from the edge rather than from a random datacenter. */
async function youtube() {
  const ids = ['dQw4w9WgXcQ', '9bZkp7q19f0', 'kJQP7kiw5Fk'];
  const results = [];

  for (const videoId of ids) {
    const res = await fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': ANDROID_VR_UA,
        'x-youtube-client-name': '28',
        'x-youtube-client-version': '1.62.27',
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'ANDROID_VR',
            clientVersion: '1.62.27',
            deviceMake: 'Oculus',
            deviceModel: 'Quest 3',
            osName: 'Android',
            osVersion: '12',
            androidSdkVersion: 32,
            hl: 'en',
            gl: 'US',
            userAgent: ANDROID_VR_UA,
          },
        },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    });
    const body = await res.json();
    const status = body?.playabilityStatus?.status;
    results.push(`${videoId}=${status}`);
  }

  const passed = results.filter((r) => r.endsWith('=OK')).length;
  return {
    ok: passed > 0,
    note: `${passed}/${ids.length} passed the bot check — ${results.join(' ')}`,
  };
}

/** Bilibili is the known-good control: if this fails, the probe itself is wrong. */
async function bilibili() {
  const headers = {
    'user-agent': CHROME_UA,
    accept: 'application/json, text/plain, */*',
    referer: 'https://www.bilibili.com/',
    origin: 'https://www.bilibili.com',
  };
  const popular = await (
    await fetch('https://api.bilibili.com/x/web-interface/popular?ps=5&pn=1', { headers })
  ).json();
  const candidates = (popular?.data?.list ?? []).map((v) => v.bvid).filter(Boolean);
  if (candidates.length === 0) return { ok: false, note: `popular API code ${popular?.code}` };

  // Try several: any single video can legitimately lack a DASH ladder (bangumi,
  // interactive, region-limited), and one bad pick would wrongly fail the control.
  const attempts = [];
  for (const bvid of candidates.slice(0, 3)) {
    const view = await (
      await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers })
    ).json();
    const cid = view?.data?.cid;
    if (!cid) {
      attempts.push(`${bvid}:view=${view?.code}`);
      continue;
    }
    const play = await (
      await fetch(
        `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=4048&fourk=1`,
        { headers },
      )
    ).json();
    const video = play?.data?.dash?.video?.length ?? 0;
    const audio = play?.data?.dash?.audio?.length ?? 0;
    if (video > 0) return { ok: true, note: `${bvid}: ${video} video + ${audio} audio DASH reps` };
    attempts.push(`${bvid}:playurl=${play?.code}`);
  }
  return { ok: false, note: `no DASH from ${attempts.join(' ')}` };
}

/** Meta's endpoints, which the app already relies on. */
async function meta() {
  const fb = await fetch(
    'https://www.facebook.com/plugins/video.php?href=' +
      encodeURIComponent('https://www.facebook.com/watch/?v=10153231379946729'),
    { headers: { 'user-agent': CHROME_UA, accept: BROWSER_NAV.accept } },
  );
  const fbBody = fb.ok ? await fb.text() : '';
  const fbHasSrc = /"(hd|sd)_src"/.test(fbBody);

  const ig = await fetch('https://www.instagram.com/', {
    headers: { 'user-agent': CHROME_UA, accept: BROWSER_NAV.accept },
  });
  const igBody = ig.ok ? await ig.text() : '';
  const igHasLsd = /"(LSD|lsd)"/.test(igBody);

  return {
    ok: fbHasSrc || igHasLsd,
    note: `facebook plugin HTTP ${fb.status} (video src found: ${fbHasSrc}); instagram guest page HTTP ${ig.status} (lsd token found: ${igHasLsd})`,
  };
}

export default {
  async fetch() {
    const [egress, ...rows] = await Promise.all([
      egressInfo().catch(() => ({ ip: '?', colo: '?' })),
      probe('dailymotion  (the open question)', dailymotion),
      probe('youtube      (re-measure from edge)', youtube),
      probe('bilibili     (known-good control)', bilibili),
      probe('facebook + instagram', meta),
    ]);

    const report = {
      measuredFrom: {
        ...egress,
        note: 'This is the IP and colo your Worker egresses from. Compare with a plain datacenter host.',
      },
      results: rows,
      howToRead: {
        'bilibili ok:false': 'The probe or the network is broken — that one should always pass.',
        'dailymotion ok:true': 'Dailymotion CAN be native in the Worker. Tell the assistant.',
        'youtube 3/3': 'YouTube works from Cloudflare and needs no external resolver.',
        'youtube 0/3': 'Confirms the bot check. A residential resolver is required.',
      },
    };

    return new Response(JSON.stringify(report, null, 2), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  },
};
