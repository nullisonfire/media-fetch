/* MediaFetch — interactive preview.
   Mirrors src/client/main.ts behaviour with in-memory fixtures. No network. */
(function () {
  'use strict';

  var CONFIDENCE_THRESHOLD = 0.75;

  var PLATFORMS = {
    youtube: { id: 'youtube', name: 'YouTube', accent: '#ff0033', hint: 'watch, youtu.be, shorts, live', hosts: ['youtube.com', 'youtu.be'],
      glyph: 'M21.6 7.2a2.8 2.8 0 0 0-2-2C17.9 4.8 12 4.8 12 4.8s-5.9 0-7.6.4a2.8 2.8 0 0 0-2 2A29 29 0 0 0 2 12a29 29 0 0 0 .4 4.8 2.8 2.8 0 0 0 2 2c1.7.4 7.6.4 7.6.4s5.9 0 7.6-.4a2.8 2.8 0 0 0 2-2A29 29 0 0 0 22 12a29 29 0 0 0-.4-4.8ZM10 15.5v-7l6 3.5-6 3.5Z' },
    bilibili: { id: 'bilibili', name: 'Bilibili', accent: '#00a1d6', hint: 'video/BV…, /bangumi, b23.tv', hosts: ['bilibili.com', 'b23.tv'],
      glyph: 'M18.2 5.6h-1.6l1.1-1.1a1 1 0 0 0-1.4-1.4L14 5.6h-4L7.7 3.1a1 1 0 0 0-1.4 1.4l1.1 1.1H5.8A3.8 3.8 0 0 0 2 9.4v6.8a3.8 3.8 0 0 0 3.8 3.8h12.4a3.8 3.8 0 0 0 3.8-3.8V9.4a3.8 3.8 0 0 0-3.8-3.8Zm-9 6.1v1.9a1 1 0 0 1-2 0v-1.9a1 1 0 0 1 2 0Zm7.6 0v1.9a1 1 0 0 1-2 0v-1.9a1 1 0 0 1 2 0Z' },
    facebook: { id: 'facebook', name: 'Facebook', accent: '#0866ff', hint: 'watch, /videos/, reel, fb.watch', hosts: ['facebook.com', 'fb.watch'],
      glyph: 'M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06C2 17.08 5.66 21.24 10.44 22v-7.02H7.9v-2.92h2.54V9.85c0-2.52 1.49-3.91 3.77-3.91 1.1 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.78-1.63 1.57v1.89h2.78l-.45 2.92h-2.33V22C18.34 21.24 22 17.08 22 12.06Z' },
    instagram: { id: 'instagram', name: 'Instagram', accent: '#e1306c', hint: '/p/, /reel/, /tv/', hosts: ['instagram.com'],
      glyph: 'M12 2c2.72 0 3.06.01 4.12.06 1.07.05 1.79.22 2.43.47.66.25 1.22.6 1.77 1.15.55.55.9 1.11 1.15 1.77.25.64.42 1.36.47 2.43.05 1.06.06 1.4.06 4.12s-.01 3.06-.06 4.12c-.05 1.07-.22 1.79-.47 2.43a4.9 4.9 0 0 1-1.15 1.77c-.55.55-1.11.9-1.77 1.15-.64.25-1.36.42-2.43.47-1.06.05-1.4.06-4.12.06s-3.06-.01-4.12-.06c-1.07-.05-1.79-.22-2.43-.47a4.9 4.9 0 0 1-1.77-1.15 4.9 4.9 0 0 1-1.15-1.77c-.25-.64-.42-1.36-.47-2.43C2.01 15.06 2 14.72 2 12s.01-3.06.06-4.12c.05-1.07.22-1.79.47-2.43.25-.66.6-1.22 1.15-1.77.55-.55 1.11-.9 1.77-1.15.64-.25 1.36-.42 2.43-.47C8.94 2.01 9.28 2 12 2Zm0 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 8.25a3.25 3.25 0 1 1 0-6.5 3.25 3.25 0 0 1 0 6.5ZM18.4 6.75a1.15 1.15 0 1 1-2.3 0 1.15 1.15 0 0 1 2.3 0Z' },
    dailymotion: { id: 'dailymotion', name: 'Dailymotion', accent: '#0af', hint: 'video/x…, dai.ly', hosts: ['dailymotion.com', 'dai.ly'],
      glyph: 'M19 3v18h-3.3v-1.7a5.9 5.9 0 0 1-4.2 1.9A6.2 6.2 0 0 1 5 14.9a6.1 6.1 0 0 1 6.3-6.3c1.6 0 3 .6 4 1.6V3.7L19 3Zm-7.6 8.8a3.1 3.1 0 1 0 0 6.2 3.1 3.1 0 0 0 0-6.2Z' }
  };
  var ORDER = ['youtube', 'bilibili', 'facebook', 'instagram', 'dailymotion'];

  function el(id) {
    var n = document.getElementById(id);
    if (!n) throw new Error('missing #' + id);
    return n;
  }
  var ui = {
    liveRegion: el('live-region'), form: el('paste-form'), urlInput: el('url-input'),
    clearButton: el('clear-button'), fetchButton: el('fetch-button'),
    detectChip: el('detect-chip'), detectGlyph: el('detect-glyph'), detectName: el('detect-name'),
    detectConfidence: el('detect-confidence'), detectManual: el('detect-manual'),
    platformSelect: el('platform-select'), platformHint: el('platform-hint'),
    errorBanner: el('error-banner'), result: el('result'), resultThumb: el('result-thumb'),
    resultDuration: el('result-duration'), resultPlatform: el('result-platform'),
    resultTitle: el('result-title'), resultAuthor: el('result-author'),
    tabBest: el('tab-best'), tabSingle: el('tab-single'), tabAudio: el('tab-audio'),
    panelBest: el('panel-best'), panelSingle: el('panel-single'), panelAudio: el('panel-audio'),
    muxLede: el('mux-lede'), videoSelect: el('video-select'), audioSelect: el('audio-select'),
    muxSummary: el('mux-summary'), muxButton: el('mux-button'), muxSupportNote: el('mux-support-note'),
    muxedList: el('muxed-list'), audioList: el('audio-list'),
    progress: el('progress'), progressTitle: el('progress-title'), progressBar: el('progress-bar'),
    progressFill: el('progress-fill'), progressMessage: el('progress-message'),
    progressDetail: el('progress-detail'), progressSteps: el('progress-steps'),
    cancelButton: el('cancel-button'), platformsGrid: el('platforms-grid'), platformGallery: el('platform-gallery')
  };

  var state = { media: null, override: null, busy: false, cancelled: false };

  function glyphSvg(d) { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '"></path></svg>'; }
  function announce(m) { ui.liveRegion.textContent = m; }

  function formatBytes(b) {
    if (!b) return '—';
    var u = ['B', 'KB', 'MB', 'GB'], v = b, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)) + ' ' + u[i];
  }
  function formatDuration(s) {
    if (!s) return '—';
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    var p = function (n) { return String(n).padStart(2, '0'); };
    return h ? h + ':' + p(m) + ':' + p(x) : m + ':' + p(x);
  }

  /* ---------------- platform gallery + dropdown ---------------- */
  ORDER.forEach(function (id) {
    var p = PLATFORMS[id];
    var o = document.createElement('option');
    o.value = p.id; o.textContent = p.name;
    ui.platformSelect.appendChild(o);

    var card = document.createElement('li');
    card.className = 'platform-card';
    card.style.setProperty('--chip-accent', p.accent);
    var g = document.createElement('span');
    g.className = 'platform-card__glyph'; g.innerHTML = glyphSvg(p.glyph);
    var body = document.createElement('div'); body.style.minWidth = '0';
    var n = document.createElement('div'); n.className = 'platform-card__name'; n.textContent = p.name;
    var hint = document.createElement('div'); hint.className = 'platform-card__hint'; hint.textContent = p.hint;
    body.appendChild(n); body.appendChild(hint);
    card.appendChild(g); card.appendChild(body);
    ui.platformsGrid.appendChild(card);
  });

  /* ---------------- detection (mirrors registry.detect) ---------------- */
  function detect(input) {
    var raw = (input || '').trim();
    var m = /(?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/i.exec(raw);
    if (!m) return { platform: null, confidence: 0 };
    var url;
    try { url = new URL(/^https?:/i.test(m[0]) ? m[0] : 'https://' + m[0]); } catch (e) { return { platform: null, confidence: 0 }; }

    var host = url.hostname.toLowerCase().replace(/^www\./, '');
    var path = url.pathname;

    for (var i = 0; i < ORDER.length; i++) {
      var p = PLATFORMS[ORDER[i]];
      var owns = p.hosts.some(function (h) { return host === h || host.endsWith('.' + h); });
      if (!owns) continue;

      var confidence = 0.4;
      if (p.id === 'youtube') {
        var v = url.searchParams.get('v');
        if ((v && /^[A-Za-z0-9_-]{11}$/.test(v)) || /^\/(shorts|live|embed)\/[A-Za-z0-9_-]{11}/.test(path)) confidence = 1;
        else if (host === 'youtu.be' && /^\/[A-Za-z0-9_-]{11}/.test(path)) confidence = 1;
        else if (/^\/(playlist|channel|@)/.test(path)) confidence = 0.35;
      } else if (p.id === 'bilibili') {
        if (/^\/video\/BV[A-Za-z0-9]{10}/.test(path)) confidence = 1;
        else if (host === 'b23.tv' && path.length > 2) confidence = 0.9;
        else if (/^\/bangumi\/play\/(ep|ss)\d+/.test(path)) confidence = 1;
      } else if (p.id === 'facebook') {
        var fv = url.searchParams.get('v');
        if (fv && /^\d{6,}$/.test(fv)) confidence = 1;
        else if (/\/videos\/\d{6,}/.test(path) || /^\/reel\/\d+/.test(path)) confidence = 1;
        else if (host === 'fb.watch') confidence = 0.9;
      } else if (p.id === 'instagram') {
        if (/\/(p|reel|reels|tv)\/[A-Za-z0-9_-]{5,}/.test(path)) confidence = 1;
        else if (/^\/stories\//.test(path)) confidence = 0.5;
      } else if (p.id === 'dailymotion') {
        if (/\/video\/x[a-z0-9]{5,}/.test(path)) confidence = 1;
        else if (host === 'dai.ly' && /^\/x[a-z0-9]{5,}/.test(path)) confidence = 1;
      }
      return { platform: p.id, confidence: confidence };
    }
    return { platform: null, confidence: 0 };
  }

  function showDetection(platform, confidence, forced) {
    var uncertain = !platform || confidence < CONFIDENCE_THRESHOLD;
    if (platform) {
      var d = PLATFORMS[platform];
      ui.detectChip.hidden = false;
      ui.detectChip.style.setProperty('--chip-accent', d.accent);
      ui.detectGlyph.innerHTML = glyphSvg(d.glyph);
      ui.detectName.textContent = d.name;
      ui.detectConfidence.textContent = forced ? 'chosen by you'
        : confidence >= 0.99 ? 'exact match' : Math.round(confidence * 100) + '% match';
      ui.platformHint.textContent = 'Links like: ' + d.hint;
    } else {
      ui.detectChip.hidden = true;
      ui.platformHint.textContent = ui.urlInput.value.trim()
        ? 'We could not tell which platform this is — pick one.'
        : 'Supported link shapes appear here.';
    }
    var already = ui.detectManual.dataset.visible === 'true';
    ui.detectManual.dataset.visible = String(uncertain || already || !!state.override);
  }

  var timer;
  function scheduleDetection() {
    clearTimeout(timer);
    timer = setTimeout(runDetection, 250);
  }
  function runDetection() {
    var url = ui.urlInput.value.trim();
    ui.clearButton.hidden = url.length === 0;
    if (url.length < 8) { showDetection(null, 0); return; }
    if (state.override) { showDetection(state.override, 1, true); return; }
    var d = detect(url);
    showDetection(d.platform, d.confidence);
  }

  /* ---------------- mock resolve ---------------- */
  var FIXTURES = {
    youtube: { title: 'Chasing the Northern Lights — 4K Timelapse', author: 'Aurora Field Notes', duration: 764, split: true, thumb: '#0b1220' },
    bilibili: { title: '【4K】城市夜景航拍合集 · Cyberpunk Shanghai', author: '航拍中国', duration: 512, split: true, thumb: '#0a1a22' },
    facebook: { title: 'Behind the scenes at the workshop', author: 'Maker Collective', duration: 189, split: true, thumb: '#0a1220' },
    instagram: { title: 'Sunset reel — shot on the old 50mm', author: '@fieldnotes', duration: 34, split: false, thumb: '#1a0e16' },
    dailymotion: { title: 'Alpine descent, full run', author: 'Ride Journal', duration: 421, split: true, thumb: '#0a1620' }
  };

  function buildMedia(platform) {
    var f = FIXTURES[platform];
    var variants = [];
    if (f.split) {
      variants.push(
        { id: 'video-0', kind: 'video', container: 'mp4', codec: 'av01', height: 2160, fps: 60, sizeBytes: 1180000000, label: '2160p60 · AV1 · 1.1 GB' },
        { id: 'video-1', kind: 'video', container: 'mp4', codec: 'avc1', height: 1080, fps: 60, sizeBytes: 268000000, label: '1080p60 · H.264 · 256 MB' },
        { id: 'video-2', kind: 'video', container: 'webm', codec: 'vp9', height: 1080, fps: 30, sizeBytes: 194000000, label: '1080p · VP9 · 185 MB' },
        { id: 'video-3', kind: 'video', container: 'mp4', codec: 'avc1', height: 720, fps: 30, sizeBytes: 96000000, label: '720p · H.264 · 92 MB' },
        { id: 'audio-0', kind: 'audio', container: 'm4a', codec: 'mp4a', bitrateKbps: 256, sizeBytes: 24500000, label: '256 kbps · AAC · 23.4 MB' },
        { id: 'audio-1', kind: 'audio', container: 'webm', codec: 'opus', bitrateKbps: 160, sizeBytes: 15300000, label: '160 kbps · Opus · 14.6 MB' },
        { id: 'muxed-0', kind: 'muxed', container: 'mp4', codec: 'avc1', height: 720, fps: 30, sizeBytes: 108000000, label: '720p · H.264 · with audio · 103 MB' },
        { id: 'muxed-1', kind: 'muxed', container: 'mp4', codec: 'avc1', height: 360, fps: 30, sizeBytes: 41000000, label: '360p · H.264 · with audio · 39 MB' }
      );
    } else {
      variants.push(
        { id: 'muxed-0', kind: 'muxed', container: 'mp4', codec: 'avc1', height: 1080, fps: 30, sizeBytes: 18400000, label: '1080p · H.264 · with audio · 17.5 MB' },
        { id: 'audio-0', kind: 'audio', container: 'm4a', codec: 'mp4a', bitrateKbps: 128, sizeBytes: 1200000, label: '128 kbps · AAC · 1.1 MB' }
      );
    }
    // Order: muxed, then video, then audio — same as the server's assemble step.
    var order = { muxed: 0, video: 1, audio: 2 };
    variants.sort(function (a, b) { return order[a.kind] - order[b.kind]; });
    return {
      platform: platform, title: f.title, author: f.author, durationSeconds: f.duration,
      thumbColor: f.thumb, variants: variants, bestRequiresMux: f.split,
      recommended: { muxed: 'muxed-0', video: f.split ? 'video-0' : undefined, audio: 'audio-0' }
    };
  }

  ui.form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (state.busy) return;
    var url = ui.urlInput.value.trim();
    if (!url) { showError('Paste a link first.'); return; }

    var d = state.override ? { platform: state.override, confidence: 1 } : detect(url);
    if (!d.platform) {
      showError('That link is not from a platform we support. Pick a platform manually if you think it should work.');
      ui.detectManual.dataset.visible = 'true';
      return;
    }
    if (!state.override && d.confidence < CONFIDENCE_THRESHOLD) {
      showError('That link could not be matched to a platform with confidence. Choose one from the dropdown.');
      ui.detectManual.dataset.visible = 'true';
      ui.platformSelect.focus();
      return;
    }

    clearError();
    setBusy(true, ui.fetchButton);
    announce('Fetching available downloads…');

    setTimeout(function () {
      state.media = buildMedia(d.platform);
      renderResult(state.media);
      setBusy(false, ui.fetchButton);
      announce('Found ' + state.media.variants.length + ' download options');
    }, 900);
  });

  /* ---------------- rendering ---------------- */
  function renderResult(media) {
    ui.result.hidden = false;
    ui.platformGallery.hidden = true;

    // Preview has no real thumbnails; use a tinted placeholder.
    ui.resultThumb.removeAttribute('src');
    ui.resultThumb.style.background =
      'linear-gradient(135deg,' + media.thumbColor + ',rgba(109,139,255,.35))';
    ui.resultThumb.alt = '';
    ui.resultDuration.textContent = formatDuration(media.durationSeconds);
    ui.resultPlatform.textContent = PLATFORMS[media.platform].name;
    ui.resultTitle.textContent = media.title;
    ui.resultAuthor.textContent = media.author;

    var videos = media.variants.filter(function (v) { return v.kind === 'video'; });
    var audios = media.variants.filter(function (v) { return v.kind === 'audio'; });
    var muxed = media.variants.filter(function (v) { return v.kind === 'muxed'; });
    var canMux = videos.length > 0 && audios.length > 0;

    ui.tabBest.disabled = !canMux;
    ui.tabSingle.disabled = muxed.length === 0;
    ui.tabAudio.disabled = audios.length === 0;

    fillSelect(ui.videoSelect, videos, media.recommended.video);
    fillSelect(ui.audioSelect, audios, media.recommended.audio);
    fillList(ui.muxedList, muxed, media.recommended.muxed, 'No single-file version exists for this media.');
    fillList(ui.audioList, audios, media.recommended.audio, 'No separate audio track is available.');

    ui.muxLede.textContent = media.bestRequiresMux
      ? 'This platform serves the highest quality as separate video and audio streams. Pick a pair and they will be combined on your device — no re-encoding, so no quality is lost.'
      : 'Combine any video track with any audio track. Useful for taking the best video with a higher-bitrate audio track than the packaged file provides.';
    ui.muxSupportNote.textContent = 'Combining runs locally with multithreaded WebAssembly. Nothing is uploaded.';

    updateSummary();
    setTab(canMux && media.bestRequiresMux ? 'best' : muxed.length ? 'single' : 'best');
  }

  function fillSelect(select, variants, recommended) {
    select.replaceChildren();
    if (!variants.length) {
      var o = document.createElement('option');
      o.textContent = 'None available'; o.disabled = true;
      select.appendChild(o); select.disabled = true; return;
    }
    select.disabled = false;
    variants.forEach(function (v) {
      var opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.id === recommended ? v.label + '  ·  recommended' : v.label;
      select.appendChild(opt);
    });
    select.value = recommended || variants[0].id;
  }

  function fillList(list, variants, recommended, emptyMessage) {
    list.replaceChildren();
    if (!variants.length) {
      var e = document.createElement('li');
      e.className = 'empty'; e.textContent = emptyMessage;
      list.appendChild(e); return;
    }
    variants.forEach(function (v) {
      var row = document.createElement('li'); row.className = 'variant';
      var main = document.createElement('div'); main.className = 'variant__main';
      var label = document.createElement('div'); label.className = 'variant__label'; label.textContent = v.label;
      var sub = document.createElement('div'); sub.className = 'variant__sub';
      sub.textContent = [v.container.toUpperCase(), v.codec, formatBytes(v.sizeBytes)].join(' · ');
      main.appendChild(label); main.appendChild(sub); row.appendChild(main);
      if (v.id === recommended) {
        var tag = document.createElement('span'); tag.className = 'variant__tag'; tag.textContent = 'Best';
        row.appendChild(tag);
      }
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'btn btn--ghost btn--sm'; b.textContent = 'Download';
      b.addEventListener('click', function () {
        b.textContent = 'Preview only';
        setTimeout(function () { b.textContent = 'Download'; }, 1400);
      });
      row.appendChild(b);
      list.appendChild(row);
    });
  }

  function selectedPair() {
    if (!state.media) return {};
    var find = function (id) {
      return state.media.variants.filter(function (v) { return v.id === id; })[0];
    };
    return { video: find(ui.videoSelect.value), audio: find(ui.audioSelect.value) };
  }

  function updateSummary() {
    var pair = selectedPair();
    ui.muxSummary.replaceChildren();
    if (!pair.video || !pair.audio) return;
    var total = pair.video.sizeBytes + pair.audio.sizeBytes;
    var container = pair.video.container === 'webm' || pair.audio.codec === 'opus' ? 'MP4 or MKV, chosen automatically' : 'MP4';
    var items = [
      ['Output', container],
      ['Resolution', pair.video.height + 'p' + (pair.video.fps >= 50 ? pair.video.fps : '')],
      ['Estimated size', formatBytes(total)],
      ['Re-encoding', 'none — stream copy']
    ];
    items.forEach(function (pairItem) {
      var span = document.createElement('span'); span.className = 'summary__item';
      var strong = document.createElement('strong'); strong.textContent = pairItem[1];
      span.appendChild(document.createTextNode(pairItem[0] + ': ')); span.appendChild(strong);
      ui.muxSummary.appendChild(span);
    });
  }

  /* ---------------- tabs ---------------- */
  function setTab(tab) {
    var map = { best: [ui.tabBest, ui.panelBest], single: [ui.tabSingle, ui.panelSingle], audio: [ui.tabAudio, ui.panelAudio] };
    Object.keys(map).forEach(function (name) {
      var active = name === tab;
      map[name][0].setAttribute('aria-selected', String(active));
      map[name][0].tabIndex = active ? 0 : -1;
      map[name][1].hidden = !active;
    });
  }
  ui.tabBest.addEventListener('click', function () { setTab('best'); });
  ui.tabSingle.addEventListener('click', function () { setTab('single'); });
  ui.tabAudio.addEventListener('click', function () { setTab('audio'); });

  /* ---------------- simulated mux ---------------- */
  var PHASES = ['download', 'mux', 'finalize'];

  ui.muxButton.addEventListener('click', function () {
    var pair = selectedPair();
    if (!pair.video || !pair.audio || state.busy) return;

    clearError();
    setBusy(true, ui.muxButton);
    ui.progress.hidden = false;
    state.cancelled = false;

    var total = pair.video.sizeBytes + pair.audio.sizeBytes;
    var t = 0;
    // Compresses ~90s of real work into ~6s so the interaction can be judged.
    var tick = setInterval(function () {
      if (state.cancelled) { clearInterval(tick); return; }
      t += 0.022;
      if (t < 0.62) {
        render('download', t / 0.62, 'Downloading video and audio tracks…', (t / 0.62) * total, total);
      } else if (t < 0.94) {
        render('mux', (t - 0.62) / 0.32, 'Combining tracks…');
      } else if (t < 1) {
        render('finalize', 1, 'Preparing your file…');
      } else {
        clearInterval(tick);
        render('finalize', 1, 'Done — in the real app your browser now asks where to save.');
        setBusy(false, ui.muxButton);
        announce('Combining finished.');
      }
    }, 90);

    function render(phase, ratio, message, done, all) {
      ui.progressTitle.textContent = phase === 'download' ? 'Downloading' : phase === 'mux' ? 'Combining' : 'Saving';
      ui.progressMessage.textContent = message;
      ui.progressBar.dataset.indeterminate = 'false';
      var pct = Math.round(Math.min(1, ratio) * 100);
      ui.progressFill.style.width = pct + '%';
      ui.progressBar.setAttribute('aria-valuenow', String(pct));
      ui.progressDetail.textContent = done ? formatBytes(done) + ' / ' + formatBytes(all) : pct + '%';
      var current = PHASES.indexOf(phase);
      Array.prototype.forEach.call(ui.progressSteps.children, function (step) {
        var i = PHASES.indexOf(step.dataset.phase);
        step.dataset.state = i < current ? 'done' : i === current ? 'active' : '';
      });
    }
  });

  ui.cancelButton.addEventListener('click', function () {
    state.cancelled = true;
    ui.progress.hidden = true;
    ui.progressFill.style.width = '0%';
    setBusy(false, ui.muxButton);
    announce('Cancelled.');
  });

  /* ---------------- shared helpers + wiring ---------------- */
  function setBusy(busy, button) {
    state.busy = busy;
    button.dataset.busy = String(busy);
    button.disabled = busy;
    ui.fetchButton.disabled = busy;
  }
  function showError(m) { ui.errorBanner.textContent = m; ui.errorBanner.hidden = false; announce(m); }
  function clearError() { ui.errorBanner.hidden = true; ui.errorBanner.textContent = ''; }

  ui.urlInput.addEventListener('input', scheduleDetection);
  ui.urlInput.addEventListener('paste', function () { setTimeout(runDetection, 0); });
  ui.clearButton.addEventListener('click', function () {
    ui.urlInput.value = ''; ui.clearButton.hidden = true;
    state.media = null; ui.result.hidden = true; ui.platformGallery.hidden = false;
    clearError(); showDetection(null, 0); ui.urlInput.focus();
  });
  ui.platformSelect.addEventListener('change', function () {
    var v = ui.platformSelect.value;
    state.override = PLATFORMS[v] ? v : null;
    if (state.override) showDetection(state.override, 1, true); else runDetection();
  });
  ui.videoSelect.addEventListener('change', updateSummary);
  ui.audioSelect.addEventListener('change', updateSummary);

  // Seed a link so the preview is immediately explorable.
  ui.urlInput.value = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  runDetection();
})();
