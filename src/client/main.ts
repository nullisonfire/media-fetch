import './styles.css';

import { CONFIDENCE_THRESHOLD, type ResolvedMedia, type StreamVariant } from '@shared/contracts';
import { PLATFORM_LIST, PLATFORMS, isPlatformId, type PlatformId } from '@shared/platforms';
import { ApiRequestError, detectPlatform, resolveMedia } from './lib/api';
import { downloadUrl, SaveCancelled, saveBlob } from './lib/download';
import { formatBytes, formatDuration } from './lib/format';
import { isCrossOriginIsolated, isMuxSupported } from './lib/capabilities';
// Type-only import: erased at compile time, so it does NOT pull the muxer into
// the initial chunk. The implementation is loaded on demand in handleMux().
import type { MuxProgress } from './lib/muxer';

/* ==================================================================== *
 * DOM references
 * -------------------------------------------------------------------- *
 * Queried once, at startup, and asserted non-null. A missing element is a
 * build error, not a runtime condition to branch on — so fail loudly here
 * rather than with a null deref halfway through a user flow.
 * ==================================================================== */

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`[MediaFetch] missing element #${id}`);
  return node as T;
}

const ui = {
  liveRegion: el('live-region'),

  form: el<HTMLFormElement>('paste-form'),
  urlInput: el<HTMLInputElement>('url-input'),
  clearButton: el<HTMLButtonElement>('clear-button'),
  fetchButton: el<HTMLButtonElement>('fetch-button'),

  detectChip: el('detect-chip'),
  detectGlyph: el('detect-glyph'),
  detectName: el('detect-name'),
  detectConfidence: el('detect-confidence'),
  detectManual: el('detect-manual'),
  platformSelect: el<HTMLSelectElement>('platform-select'),
  platformHint: el('platform-hint'),

  errorBanner: el('error-banner'),

  result: el('result'),
  resultThumb: el<HTMLImageElement>('result-thumb'),
  resultDuration: el('result-duration'),
  resultPlatform: el('result-platform'),
  resultTitle: el('result-title'),
  resultAuthor: el('result-author'),

  tabBest: el<HTMLButtonElement>('tab-best'),
  tabSingle: el<HTMLButtonElement>('tab-single'),
  tabAudio: el<HTMLButtonElement>('tab-audio'),
  panelBest: el('panel-best'),
  panelSingle: el('panel-single'),
  panelAudio: el('panel-audio'),

  muxLede: el('mux-lede'),
  videoSelect: el<HTMLSelectElement>('video-select'),
  audioSelect: el<HTMLSelectElement>('audio-select'),
  muxSummary: el('mux-summary'),
  muxButton: el<HTMLButtonElement>('mux-button'),
  muxSupportNote: el('mux-support-note'),

  muxedList: el<HTMLUListElement>('muxed-list'),
  audioList: el<HTMLUListElement>('audio-list'),

  progress: el('progress'),
  progressTitle: el('progress-title'),
  progressBar: el('progress-bar'),
  progressFill: el('progress-fill'),
  progressMessage: el('progress-message'),
  progressDetail: el('progress-detail'),
  progressSteps: el<HTMLOListElement>('progress-steps'),
  cancelButton: el<HTMLButtonElement>('cancel-button'),

  platformsGrid: el<HTMLUListElement>('platforms-grid'),
  platformGallery: el('platform-gallery'),
};

/* ==================================================================== *
 * State
 * ==================================================================== */

type Tab = 'best' | 'single' | 'audio';

interface State {
  media: ResolvedMedia | null;
  tab: Tab;
  /** Explicit platform override from the dropdown, or null for auto. */
  override: PlatformId | null;
  busy: boolean;
  /** Aborts the in-flight resolve or mux. */
  controller: AbortController | null;
}

const state: State = {
  media: null,
  tab: 'best',
  override: null,
  busy: false,
  controller: null,
};

/** Announce async changes to assistive tech, which cannot see the visual churn. */
function announce(message: string): void {
  ui.liveRegion.textContent = message;
}

/* ==================================================================== *
 * Startup: populate platform-derived UI
 * ==================================================================== */

function glyphSvg(pathData: string): string {
  // pathData comes from our own bundled constant, never from the network.
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${pathData}"></path></svg>`;
}

function populatePlatforms(): void {
  for (const platform of PLATFORM_LIST) {
    const option = document.createElement('option');
    option.value = platform.id;
    option.textContent = platform.name;
    ui.platformSelect.append(option);

    const card = document.createElement('li');
    card.className = 'platform-card';
    card.style.setProperty('--chip-accent', platform.accent);

    const glyph = document.createElement('span');
    glyph.className = 'platform-card__glyph';
    glyph.innerHTML = glyphSvg(platform.glyph);

    const body = document.createElement('div');
    body.style.minWidth = '0';
    const name = document.createElement('div');
    name.className = 'platform-card__name';
    name.textContent = platform.name;
    const hint = document.createElement('div');
    hint.className = 'platform-card__hint';
    hint.textContent = platform.hint;
    body.append(name, hint);

    card.append(glyph, body);
    ui.platformsGrid.append(card);
  }
}

/* ==================================================================== *
 * Smart detection (debounced, runs while typing)
 * ==================================================================== */

let detectTimer: number | undefined;
let detectController: AbortController | null = null;

function scheduleDetection(): void {
  window.clearTimeout(detectTimer);
  // 250ms: long enough to coalesce a paste + trailing keystrokes, short enough
  // that the chip appears to react instantly.
  detectTimer = window.setTimeout(runDetection, 250);
}

async function runDetection(): Promise<void> {
  const url = ui.urlInput.value.trim();
  ui.clearButton.hidden = url.length === 0;

  if (url.length < 8) {
    showDetection(null, 0);
    return;
  }

  detectController?.abort();
  detectController = new AbortController();

  try {
    const detection = await detectPlatform(url, detectController.signal);
    // A manual override always wins over whatever detection concluded.
    if (state.override) {
      showDetection(state.override, 1, true);
      return;
    }
    showDetection(detection.platform, detection.confidence);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    // Detection is a convenience; its failure must not block the flow. Reveal the
    // dropdown so the user can proceed manually.
    showDetection(null, 0);
  }
}

/**
 * Renders the detection chip and decides whether the manual dropdown is needed.
 * The dropdown is revealed — not hidden — when we are unsure, which is the whole
 * point of tracking confidence.
 */
function showDetection(platform: PlatformId | null, confidence: number, forced = false): void {
  const uncertain = platform === null || confidence < CONFIDENCE_THRESHOLD;

  if (platform) {
    const descriptor = PLATFORMS[platform];
    ui.detectChip.hidden = false;
    ui.detectChip.style.setProperty('--chip-accent', descriptor.accent);
    ui.detectGlyph.innerHTML = glyphSvg(descriptor.glyph);
    ui.detectName.textContent = descriptor.name;
    ui.detectConfidence.textContent = forced
      ? 'chosen by you'
      : confidence >= 0.99
        ? 'exact match'
        : `${Math.round(confidence * 100)}% match`;
    ui.platformHint.textContent = `Links like: ${descriptor.hint}`;
  } else {
    ui.detectChip.hidden = true;
    ui.platformHint.textContent = ui.urlInput.value.trim()
      ? 'We could not tell which platform this is — pick one.'
      : 'Supported link shapes appear here.';
  }

  // Once shown, the dropdown stays visible: hiding a control the user just
  // interacted with is disorienting.
  const alreadyVisible = ui.detectManual.dataset['visible'] === 'true';
  ui.detectManual.dataset['visible'] = String(uncertain || alreadyVisible || Boolean(state.override));

  if (uncertain && ui.urlInput.value.trim().length > 8 && !state.override) {
    announce('Platform not detected. Choose one from the dropdown.');
  }
}

/* ==================================================================== *
 * Resolve
 * ==================================================================== */

async function handleSubmit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (state.busy) return;

  const url = ui.urlInput.value.trim();
  if (!url) {
    showError('Paste a link first.');
    ui.urlInput.focus();
    return;
  }

  clearError();
  setBusy(true, ui.fetchButton);
  announce('Fetching available downloads…');

  state.controller = new AbortController();

  try {
    const media = await resolveMedia(url, state.override ?? undefined, state.controller.signal);
    state.media = media;
    renderResult(media);
    announce(`Found ${media.variants.length} download options for ${media.title}`);
    ui.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;

    if (err instanceof ApiRequestError) {
      showError(err.message);
      // These two codes mean "the user must choose" — so surface the control.
      if (err.code === 'ambiguous_url' || err.code === 'unsupported_url') {
        ui.detectManual.dataset['visible'] = 'true';
        ui.platformSelect.focus();
      }
    } else {
      showError('Something went wrong. Try again.');
    }
  } finally {
    setBusy(false, ui.fetchButton);
    state.controller = null;
  }
}

/* ==================================================================== *
 * Rendering the result
 * ==================================================================== */

function renderResult(media: ResolvedMedia): void {
  ui.result.hidden = false;
  ui.platformGallery.hidden = true;

  if (media.thumbnailUrl) {
    ui.resultThumb.src = media.thumbnailUrl;
    ui.resultThumb.alt = `Thumbnail for ${media.title}`;
    ui.resultThumb.hidden = false;
  } else {
    ui.resultThumb.hidden = true;
  }

  ui.resultDuration.textContent = media.durationSeconds
    ? formatDuration(media.durationSeconds)
    : '';
  ui.resultPlatform.textContent = PLATFORMS[media.platform].name;
  // textContent, not innerHTML: titles are attacker-controlled.
  ui.resultTitle.textContent = media.title;
  ui.resultAuthor.textContent = media.author ?? '';

  const videos = media.variants.filter((v) => v.kind === 'video');
  const audios = media.variants.filter((v) => v.kind === 'audio');
  // HLS variants already contain audio, so they belong with the progressive
  // files rather than in the combine tab — there is nothing to combine them with.
  const muxed = media.variants.filter((v) => v.kind === 'muxed' || v.kind === 'hls');

  const canMux = videos.length > 0 && audios.length > 0;

  ui.tabBest.disabled = !canMux;
  ui.tabSingle.disabled = muxed.length === 0;
  ui.tabAudio.disabled = audios.length === 0;

  populateTrackSelect(ui.videoSelect, videos, media.recommended.video);
  populateTrackSelect(ui.audioSelect, audios, media.recommended.audio);
  renderVariantList(ui.muxedList, muxed, media.recommended.muxed, 'No single-file version exists for this media.');
  renderVariantList(ui.audioList, audios, media.recommended.audio, 'No separate audio track is available.');

  ui.muxLede.textContent = media.bestRequiresMux
    ? 'This platform serves the highest quality as separate video and audio streams. Pick a pair and they will be combined on your device — no re-encoding, so no quality is lost.'
    : 'Combine any video track with any audio track. Useful for taking the best video with a higher-bitrate audio track than the packaged file provides.';

  renderMuxSupportNote();
  updateMuxSummary();

  // Land the user on the mode that actually makes sense for this media.
  const initial: Tab = canMux && media.bestRequiresMux ? 'best' : muxed.length > 0 ? 'single' : canMux ? 'best' : 'audio';
  setTab(initial);
}

function populateTrackSelect(
  select: HTMLSelectElement,
  variants: StreamVariant[],
  recommendedId: string | undefined,
): void {
  select.replaceChildren();

  if (variants.length === 0) {
    const option = document.createElement('option');
    option.textContent = 'None available';
    option.disabled = true;
    select.append(option);
    select.disabled = true;
    return;
  }

  select.disabled = false;
  for (const variant of variants) {
    const option = document.createElement('option');
    option.value = variant.id;
    option.textContent =
      variant.id === recommendedId ? `${variant.label}  ·  recommended` : variant.label;
    select.append(option);
  }
  select.value = recommendedId ?? variants[0]!.id;
}

function renderVariantList(
  list: HTMLUListElement,
  variants: StreamVariant[],
  recommendedId: string | undefined,
  emptyMessage: string,
): void {
  list.replaceChildren();

  if (variants.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = emptyMessage;
    list.append(empty);
    return;
  }

  for (const variant of variants) {
    const row = document.createElement('li');
    row.className = 'variant';

    const main = document.createElement('div');
    main.className = 'variant__main';

    const label = document.createElement('div');
    label.className = 'variant__label';
    label.textContent = variant.label;

    const sub = document.createElement('div');
    sub.className = 'variant__sub';
    sub.textContent = [variant.container.toUpperCase(), variant.codec, formatBytes(variant.sizeBytes)]
      .filter((part) => part && part !== '—')
      .join(' · ');

    main.append(label, sub);
    row.append(main);

    if (variant.id === recommendedId) {
      const tag = document.createElement('span');
      tag.className = 'variant__tag';
      tag.textContent = 'Best';
      row.append(tag);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn--ghost btn--sm';
    button.textContent = variant.kind === 'hls' ? 'Build & save' : 'Download';
    button.addEventListener('click', () => {
      if (variant.kind === 'hls') {
        // HLS is a playlist, not a file: it must be assembled in the browser.
        void handleHlsDownload(variant);
        return;
      }
      /**
       * A real single file: hand it to the browser's download manager, which is
       * resumable and uses no page memory.
       *
       * directUrl wins when present. For resolver-extracted media it is not an
       * optimisation but the only route that works — the CDN signature pins the
       * resolver's IP, so the Worker proxy is guaranteed a 403.
       */
      downloadUrl(variant.directUrl ?? variant.proxyUrl);
      announce(`Started downloading ${variant.label}`);
    });
    row.append(button);

    list.append(row);
  }
}

function renderMuxSupportNote(): void {
  if (!isMuxSupported()) {
    ui.muxSupportNote.textContent =
      'This browser cannot combine tracks (WebAssembly unavailable). Use the single-file tab instead.';
    ui.muxButton.disabled = true;
    return;
  }
  ui.muxButton.disabled = false;
  ui.muxSupportNote.textContent = isCrossOriginIsolated()
    ? 'Combining runs locally with multithreaded WebAssembly. Nothing is uploaded.'
    : 'Running the single-threaded muxer — slower, because this page is not cross-origin isolated.';
}

function updateMuxSummary(): void {
  const { video, audio } = selectedPair();
  ui.muxSummary.replaceChildren();
  if (!video || !audio) return;

  const totalBytes =
    video.sizeBytes && audio.sizeBytes ? video.sizeBytes + audio.sizeBytes : undefined;

  const items: Array<[string, string]> = [
    ['Output', video.container === 'webm' || audio.codec === 'opus' ? 'MP4 or MKV, chosen automatically' : 'MP4'],
    ['Resolution', video.height ? `${video.height}p${video.fps && video.fps >= 50 ? Math.round(video.fps) : ''}` : 'unknown'],
    ['Estimated size', totalBytes ? formatBytes(totalBytes) : 'unknown'],
    ['Re-encoding', 'none — stream copy'],
  ];

  for (const [key, value] of items) {
    const item = document.createElement('span');
    item.className = 'summary__item';
    const strong = document.createElement('strong');
    strong.textContent = value;
    item.append(`${key}: `, strong);
    ui.muxSummary.append(item);
  }
}

function selectedPair(): { video?: StreamVariant; audio?: StreamVariant } {
  const media = state.media;
  if (!media) return {};
  return {
    video: media.variants.find((v) => v.id === ui.videoSelect.value),
    audio: media.variants.find((v) => v.id === ui.audioSelect.value),
  };
}

/* ==================================================================== *
 * Tabs
 * ==================================================================== */

function setTab(tab: Tab): void {
  state.tab = tab;
  const map: Record<Tab, [HTMLButtonElement, HTMLElement]> = {
    best: [ui.tabBest, ui.panelBest],
    single: [ui.tabSingle, ui.panelSingle],
    audio: [ui.tabAudio, ui.panelAudio],
  };

  for (const [name, [button, panel]] of Object.entries(map) as Array<[Tab, [HTMLButtonElement, HTMLElement]]>) {
    const active = name === tab;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    panel.hidden = !active;
  }
}

/* ==================================================================== *
 * The mux flow
 * ==================================================================== */

async function handleMux(): Promise<void> {
  const media = state.media;
  const { video, audio } = selectedPair();
  if (!media || !video || !audio || state.busy) return;

  clearError();
  setBusy(true, ui.muxButton);
  showProgress(true);
  state.controller = new AbortController();

  // Loaded on demand: the ffmpeg core is ~30 MB and most sessions never need it.
  const { muxTracks, MuxError } = await import('./lib/muxer');

  try {
    const result = await muxTracks({
      // Same rule as the single-file path: an IP-pinned URL can only be read
      // from the machine that minted it.
      videoUrl: video.directUrl ?? video.proxyUrl,
      audioUrl: audio.directUrl ?? audio.proxyUrl,
      videoCodec: video.codec,
      audioCodec: audio.codec,
      videoContainer: video.container,
      audioContainer: audio.container,
      filename: media.title.replace(/[<>:"'/\\|?*]/g, '').slice(0, 100) || 'download',
      signal: state.controller.signal,
      onProgress: renderProgress,
    });

    announce('Combining finished. Choose where to save the file.');
    await saveBlob(result.blob, result.filename);
    announce(`Saved ${result.filename}`);
    showProgress(false);
  } catch (err) {
    if (err instanceof SaveCancelled) {
      showProgress(false);
      return;
    }
    if (err instanceof DOMException && err.name === 'AbortError') {
      showProgress(false);
      announce('Cancelled.');
      return;
    }
    showProgress(false);
    showError(err instanceof MuxError ? err.message : 'Combining the tracks failed. Try a different pair.');
  } finally {
    setBusy(false, ui.muxButton);
    state.controller = null;
  }
}

/**
 * Downloads an HLS variant: fetch every segment through the proxy, join them,
 * then one `-c copy` pass to produce a seekable MP4.
 *
 * Kept separate from handleMux() because nothing is being combined here — the
 * variant already carries audio. This is assembly, not muxing.
 */
async function handleHlsDownload(variant: StreamVariant): Promise<void> {
  const media = state.media;
  if (!media || state.busy) return;

  clearError();
  state.busy = true;
  ui.fetchButton.disabled = true;
  showProgress(true);
  state.controller = new AbortController();

  const filename =
    media.title.replace(/[<>:"'/\\|?*]/g, '').slice(0, 100) || 'download';

  try {
    // Both modules carry their own Error subclasses, but the catch below only
    // needs the message, so they are not imported.
    const [{ downloadHlsVariant }, { remuxToMp4 }] = await Promise.all([
      import('./lib/hls'),
      import('./lib/muxer'),
    ]);

    announce('Downloading segments…');
    const data = await downloadHlsVariant(
      // Direct first: the visitor's residential IP is not what the CDN blocks.
      { ...(variant.directUrl ? { direct: variant.directUrl } : {}), proxy: variant.proxyUrl },
      ({ completed, total, bytes }) =>
        renderProgress({
          phase: 'download',
          ratio: total ? completed / total : null,
          message: `Downloading segments (${completed} of ${total})…`,
          bytesProcessed: bytes,
        }),
      state.controller.signal,
    );

    // An fMP4 stream starts with an ftyp/styp box; MPEG-TS starts with 0x47.
    const isFragmentedMp4 =
      data.length > 8 && String.fromCharCode(data[4]!, data[5]!, data[6]!, data[7]!).match(/typ$/);

    const result = await remuxToMp4({
      data,
      sourceContainer: isFragmentedMp4 ? 'mp4' : 'ts',
      filename,
      onProgress: renderProgress,
    });

    announce('Finished. Choose where to save the file.');
    await saveBlob(result.blob, result.filename);
    announce(`Saved ${result.filename}`);
    showProgress(false);
  } catch (err) {
    showProgress(false);
    if (err instanceof SaveCancelled) return;
    if (err instanceof DOMException && err.name === 'AbortError') {
      announce('Cancelled.');
      return;
    }
    showError(err instanceof Error ? err.message : 'Could not build that download.');
  } finally {
    state.busy = false;
    ui.fetchButton.disabled = false;
    state.controller = null;
  }
}

/* ==================================================================== *
 * Progress UI
 * ==================================================================== */

const PHASE_ORDER = ['download', 'mux', 'finalize'] as const;

function showProgress(visible: boolean): void {
  ui.progress.hidden = !visible;
  if (!visible) {
    ui.progressFill.style.width = '0%';
    for (const step of ui.progressSteps.children) step.removeAttribute('data-state');
  }
}

function renderProgress(progress: MuxProgress): void {
  ui.progressTitle.textContent =
    progress.phase === 'load'
      ? 'Preparing'
      : progress.phase === 'download'
        ? 'Downloading'
        : progress.phase === 'mux'
          ? 'Combining'
          : 'Saving';

  ui.progressMessage.textContent = progress.message;

  const indeterminate = progress.ratio === null;
  ui.progressBar.dataset['indeterminate'] = String(indeterminate);

  if (!indeterminate) {
    const percent = Math.round(progress.ratio! * 100);
    ui.progressFill.style.width = `${percent}%`;
    ui.progressBar.setAttribute('aria-valuenow', String(percent));
  } else {
    ui.progressBar.removeAttribute('aria-valuenow');
  }

  ui.progressDetail.textContent =
    progress.bytesProcessed !== undefined
      ? progress.bytesTotal
        ? `${formatBytes(progress.bytesProcessed)} / ${formatBytes(progress.bytesTotal)}`
        : formatBytes(progress.bytesProcessed)
      : indeterminate
        ? ''
        : `${Math.round(progress.ratio! * 100)}%`;

  // Mark earlier phases done and the current one active.
  const currentIndex = PHASE_ORDER.indexOf(progress.phase as (typeof PHASE_ORDER)[number]);
  for (const step of ui.progressSteps.children) {
    const phase = (step as HTMLElement).dataset['phase'] as (typeof PHASE_ORDER)[number];
    const index = PHASE_ORDER.indexOf(phase);
    if (currentIndex === -1) continue;
    (step as HTMLElement).dataset['state'] =
      index < currentIndex ? 'done' : index === currentIndex ? 'active' : '';
  }
}

/* ==================================================================== *
 * Shared UI helpers
 * ==================================================================== */

function setBusy(busy: boolean, button: HTMLButtonElement): void {
  state.busy = busy;
  button.dataset['busy'] = String(busy);
  button.disabled = busy;
  ui.fetchButton.disabled = busy;
}

function showError(message: string): void {
  ui.errorBanner.textContent = message;
  ui.errorBanner.hidden = false;
  announce(message);
}

function clearError(): void {
  ui.errorBanner.hidden = true;
  ui.errorBanner.textContent = '';
}

/* ==================================================================== *
 * Event wiring
 * ==================================================================== */

function bindEvents(): void {
  ui.form.addEventListener('submit', handleSubmit);

  ui.urlInput.addEventListener('input', scheduleDetection);
  // `paste` fires before the value updates, so detection is deferred a tick.
  ui.urlInput.addEventListener('paste', () => window.setTimeout(runDetection, 0));

  ui.clearButton.addEventListener('click', () => {
    ui.urlInput.value = '';
    ui.clearButton.hidden = true;
    state.media = null;
    ui.result.hidden = true;
    ui.platformGallery.hidden = false;
    clearError();
    showDetection(null, 0);
    ui.urlInput.focus();
  });

  ui.platformSelect.addEventListener('change', () => {
    const value = ui.platformSelect.value;
    state.override = isPlatformId(value) ? value : null;
    if (state.override) {
      showDetection(state.override, 1, true);
    } else {
      void runDetection();
    }
  });

  ui.tabBest.addEventListener('click', () => setTab('best'));
  ui.tabSingle.addEventListener('click', () => setTab('single'));
  ui.tabAudio.addEventListener('click', () => setTab('audio'));

  // Arrow-key navigation between tabs, per WAI-ARIA tabs pattern.
  const tabs = [ui.tabBest, ui.tabSingle, ui.tabAudio];
  const tabNames: Tab[] = ['best', 'single', 'audio'];
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('keydown', (event) => {
      const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (delta === 0) return;
      event.preventDefault();
      for (let step = 1; step <= tabs.length; step += 1) {
        const next = (index + delta * step + tabs.length * step) % tabs.length;
        if (!tabs[next]!.disabled) {
          setTab(tabNames[next]!);
          tabs[next]!.focus();
          return;
        }
      }
    });
  }

  ui.videoSelect.addEventListener('change', updateMuxSummary);
  ui.audioSelect.addEventListener('change', updateMuxSummary);
  ui.muxButton.addEventListener('click', handleMux);

  ui.cancelButton.addEventListener('click', () => {
    state.controller?.abort();
    showProgress(false);
  });

  // Warn before losing an in-flight mux to a stray refresh.
  window.addEventListener('beforeunload', (event) => {
    if (state.busy) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

/* ==================================================================== *
 * Boot
 * ==================================================================== */

function init(): void {
  populatePlatforms();
  bindEvents();

  // Support deep links: /?url=… prefills and immediately resolves.
  const shared = new URLSearchParams(location.search).get('url');
  if (shared) {
    ui.urlInput.value = shared;
    void runDetection();
    ui.form.requestSubmit();
  }
}

init();
