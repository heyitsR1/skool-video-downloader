// Skool Video Downloader — popup controller.
// Flow: detect videos on the active tab → pick one → resolve qualities → choose
// resolution → enqueue. A live download-manager panel renders queue state from
// background QUEUE_* broadcasts (progress, speed, cancel).

// Checkout moved off Freemius (DMCA compliance). Every buy click now hands off
// to OUR upgrade page, not straight to the checkout partner — the page owns the
// offer (checkout URL, instructions, the receipt→key step) so all of it is
// editable over the air via a website deploy, with no Chrome Web Store review.
// The actual marketplace URL (with the ?via= affiliate code) lives on that page
// now: src/pages/SkoolWelcome.tsx in the website repo.
const WELCOME_URL = 'https://skoolvideodownload.com/welcome';

// Cancel page, offered when an automatic monthly cancellation after a lifetime
// upgrade didn't go through.
const CANCEL_URL = 'https://skoolvideodownload.com/cancel-subscription';

const PLATFORM_ICON = {
  skool: '🎓', loom: '🔴', vimeo: '🎬', youtube: '▶️', wistia: '🟢', hls: '🎞️'
};

// Destination for the YouTube handoff (both builds — YouTube's server-side
// gating cuts extension-initiated streams off after a few hundred KB, so
// in-browser YouTube downloads are dead for every extension). The guide page
// reads ?v= and pre-fills a copy-paste yt-dlp command for that exact video.
// The extension links only to our own page, keeping the shipped artifact clean.
const YT_GUIDE_URL = 'https://skoolvideodownload.com/skool-video-downloader/youtube';

let activeTab = null;
let currentVideos = [];
let ytGuideVideoId = null; // sourceId of the YouTube video behind the handoff view
const jobLabels = new Map(); // jobId -> filename (for manager rows)

// Fills every [data-i18n] / [data-i18n-placeholder] / [data-i18n-aria-label]
// element from the active locale's messages.json. Chrome Web Store listing
// translations and popup UI translations are separate systems that happen to
// share the same _locales/*/messages.json files — this just consumes the UI
// keys at render time.
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const msg = chrome.i18n.getMessage(el.dataset.i18n);
    if (msg) el.textContent = msg;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const msg = chrome.i18n.getMessage(el.dataset.i18nPlaceholder);
    if (msg) el.placeholder = msg;
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const msg = chrome.i18n.getMessage(el.dataset.i18nTitle);
    if (msg) el.title = msg;
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
    const msg = chrome.i18n.getMessage(el.dataset.i18nAriaLabel);
    if (msg) el.setAttribute('aria-label', msg);
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  applyI18n();
  document.getElementById('footer-version').textContent = 'v' + chrome.runtime.getManifest().version;
  setupPricingModal();
  setupLicenseActivation();
  setupQueueListener();
  setupBulkPanel();

  document.getElementById('quality-back').addEventListener('click', showVideoList);
  document.getElementById('upgrade-btn').addEventListener('click', () => openPricingModal());
  document.getElementById('yt-policy-back').addEventListener('click', showVideoList);
  document.getElementById('yt-guide-btn').addEventListener('click', () => {
    const url = ytGuideVideoId ? `${YT_GUIDE_URL}?v=${encodeURIComponent(ytGuideVideoId)}` : YT_GUIDE_URL;
    chrome.tabs.create({ url });
  });
  initReportModal();

  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const license = await initLicenseUI();
  await refreshVideos();
  await refreshQueue();
  // Last, and not awaited: preflight is a network round trip to Skool, and the
  // one-lesson flow above must not wait on the whole-course one.
  initBulkPanel(activeTab?.url, license?.tier === 'lifetime' || license?.tier === 'monthly');
  initUpdateBanner(); // async, non-blocking — banner pops in if an update exists

  // Nudge the content script to rescan (covers already-open lessons).
  if (activeTab?.id) chrome.tabs.sendMessage(activeTab.id, { type: 'RESCAN' }).catch(() => {});
});

// Copy added after the 15 locales were translated. chrome.i18n.getMessage
// returns '' for a key a locale lacks, so English is the graceful fallback
// rather than a blank string.
function t(key, fallback) {
  return chrome.i18n.getMessage(key) || fallback;
}

// ── License UI ──────────────────────────────────────────────────────────────
// Returns the licence status so callers that need the tier (the course-backup
// panel) do not have to ask for it a second time.
async function initLicenseUI() {
  const status = await send({ type: 'GET_LICENSE_STATUS' });
  if (!status) return null;
  const badge = document.getElementById('tier-badge');
  const creditsText = document.getElementById('credits-text');
  const upgradeBtn = document.getElementById('upgrade-btn');
  const licenseSection = document.getElementById('license-section');
  const licenseLabel = document.querySelector('#license-section .label');

  upgradeBtn.classList.add('hidden');

  if (status.tier === 'lifetime') {
    badge.textContent = chrome.i18n.getMessage('planLifetimeName'); badge.className = 'badge badge--unlimited';
    creditsText.textContent = chrome.i18n.getMessage('lifetimeCredits');
    licenseSection.classList.add('hidden');
  } else if (status.tier === 'monthly') {
    badge.textContent = chrome.i18n.getMessage('badgePro'); badge.className = 'badge badge--pro';
    creditsText.textContent = chrome.i18n.getMessage('proCredits');
    licenseSection.classList.add('hidden');
  } else {
    licenseLabel.textContent = chrome.i18n.getMessage('licenseLabel');
    badge.textContent = chrome.i18n.getMessage('badgeFree'); badge.className = 'badge badge--free';
    const rem = status.remaining;
    creditsText.textContent = rem > 0
      ? chrome.i18n.getMessage('creditsRemaining', [String(rem), String(status.limit)])
      : chrome.i18n.getMessage('creditsExhausted');
    upgradeBtn.classList.remove('hidden');
    licenseSection.classList.remove('hidden');
  }
  return status;
}

// ── Video detection list ──────────────────────────────────────────────────────
async function refreshVideos() {
  const [res, ctx] = await Promise.all([
    send({ type: 'GET_VIDEOS', tabId: activeTab?.id }),
    getPageContext()
  ]);
  currentVideos = res?.videos || [];
  decorateVideos(currentVideos, ctx);
  renderVideoList();
}

// Ask the content script for the on-screen lesson's title + a preview frame
// grabbed from the playing <video> (null on pages where nothing has played).
function getPageContext() {
  return new Promise((resolve) => {
    if (!activeTab?.id) return resolve(null);
    try {
      chrome.tabs.sendMessage(activeTab.id, { type: 'GET_PAGE_CONTEXT' }, (r) =>
        resolve(chrome.runtime.lastError ? null : r));
    } catch { resolve(null); }
  });
}

// Attach a title + preview thumbnail to each detected video. Native (wire-
// captured) entries take the current lesson's title and the live video frame;
// YouTube/Loom thumbnails are public static URLs. Vimeo/Wistia need API calls
// for artwork, so they keep the platform icon tile.
function decorateVideos(videos, ctx) {
  const single = videos.length === 1;
  // Wire capture picks up every Loom the tab requested, not just the one on
  // screen, so a module page can list six rows all reading "Loom". The lesson's
  // own video id tells us which row is the one the user is looking at; the rest
  // get their id as a suffix so they are at least distinguishable from each
  // other, instead of six identical buttons.
  const onScreen = ctx?.sourceId
    ? videos.find(v => v.sourceId && v.sourceId === ctx.sourceId)
    : null;
  for (const v of videos) {
    const native = v.platform === 'skool' || v.platform === 'hls';
    if (!v.title && ctx?.title && (native || single || v === onScreen)) v.title = ctx.title;
    if (!v.title && v.sourceId && videos.length > 1) {
      v.label = `${v.label} · ${String(v.sourceId).slice(0, 8)}`;
    }
    if (v === onScreen) v.onScreen = true;
    if (v.thumb) continue;
    if (native && ctx?.frame) v.thumb = ctx.frame;
    else if (v.platform === 'youtube' && v.sourceId) v.thumb = `https://i.ytimg.com/vi/${v.sourceId}/hqdefault.jpg`;
    else if (v.platform === 'loom' && v.sourceId) v.thumb = `https://cdn.loom.com/sessions/thumbnails/${v.sourceId}-00001.jpg`;
  }
}

function renderVideoList() {
  const statusEl = document.getElementById('status-text');
  const hintEl = document.getElementById('hint-text');
  const box = document.getElementById('videos');

  if (!activeTab?.url?.includes('skool.com')) {
    statusEl.textContent = chrome.i18n.getMessage('statusOpenLesson');
    hintEl.textContent = chrome.i18n.getMessage('hintOpenLesson');
    box.classList.add('hidden');
    return;
  }

  if (!currentVideos.length) {
    statusEl.textContent = chrome.i18n.getMessage('statusNoVideo');
    hintEl.textContent = chrome.i18n.getMessage('hintNoVideo');
    box.classList.add('hidden');
    return;
  }

  statusEl.textContent = chrome.i18n.getMessage(
    currentVideos.length > 1 ? 'statusFoundPlural' : 'statusFoundSingular',
    [String(currentVideos.length)]
  );
  statusEl.classList.add('status--ok');
  hintEl.textContent = chrome.i18n.getMessage('hintPickVideo');

  box.innerHTML = '';
  // Put the lesson on screen first — with six candidates, ordering is half the
  // answer to "which one is mine?".
  const ordered = [...currentVideos].sort((a, b) => (b.onScreen ? 1 : 0) - (a.onScreen ? 1 : 0));
  ordered.forEach((v, i) => {
    const row = document.createElement('button');
    row.className = v.onScreen ? 'video-row video-row--onscreen' : 'video-row';
    const icon = PLATFORM_ICON[v.platform] || '🎞️';
    row.innerHTML =
      `<span class="video-row__thumb">${icon}</span>` +
      `<span class="video-row__meta"><span class="video-row__title">${escapeHtml(v.title || chrome.i18n.getMessage('videoDefaultTitle', [String(i + 1)]))}</span>` +
      `<span class="video-row__platform">${escapeHtml(v.label || v.platform)}` +
      (v.onScreen ? ` <span class="video-row__badge">${escapeHtml(chrome.i18n.getMessage('videoOnThisPage'))}</span>` : '') +
      `</span></span>` +
      `<span class="video-row__go">›</span>`;
    if (v.thumb) attachThumb(row.querySelector('.video-row__thumb'), v.thumb);
    row.addEventListener('click', () => openQuality(v));
    box.appendChild(row);
  });
  box.classList.remove('hidden');
}

// Layer the preview image over the emoji tile; if it fails to load (expired /
// wrong-pattern CDN URL), remove it so the platform icon shows through.
// (MV3 CSP forbids inline onerror handlers, hence the listener.)
function attachThumb(tile, src) {
  if (!tile) return;
  const img = document.createElement('img');
  img.alt = '';
  img.addEventListener('error', () => img.remove());
  img.src = src;
  tile.appendChild(img);
}

// YouTube's server-side gating breaks in-browser downloads in both builds;
// show the handoff notice (guide page + pre-filled command) instead of
// resolving qualities.
// Plan chrome (credits bar, upgrade CTA, license box) belongs to the video list,
// not to a download in progress. See .is-picking in popup.css.
function setPicking(on) {
  document.querySelector('.popup').classList.toggle('is-picking', on);
}

function showYouTubePolicy(video) {
  ytGuideVideoId = video?.sourceId || null;
  setPicking(true);
  document.getElementById('videos').classList.add('hidden');
  document.getElementById('status-text').classList.add('hidden');
  document.getElementById('hint-text').classList.add('hidden');
  document.getElementById('yt-policy-view').classList.remove('hidden');
}

function showVideoList() {
  setPicking(false);
  document.getElementById('quality-view').classList.add('hidden');
  document.getElementById('yt-policy-view').classList.add('hidden');
  document.getElementById('videos').classList.remove('hidden');
  document.getElementById('status-text').classList.remove('hidden');
  document.getElementById('hint-text').classList.remove('hidden');
}

// ── Quality picker ────────────────────────────────────────────────────────────
async function openQuality(video) {
  if (video.platform === 'youtube') { showYouTubePolicy(video); return; }
  setPicking(true);
  document.getElementById('videos').classList.add('hidden');
  document.getElementById('status-text').classList.add('hidden');
  document.getElementById('hint-text').classList.add('hidden');
  const view = document.getElementById('quality-view');
  view.classList.remove('hidden');

  const titleEl = document.getElementById('quality-title');
  const thumbEl = document.getElementById('quality-thumb');
  const listEl = document.getElementById('quality-list');
  const errEl = document.getElementById('quality-error');
  const nameInput = document.getElementById('filename-input');
  errEl.classList.add('hidden');
  // Back to the resolving state: the quality list carries the "resolving" text,
  // and the action step stays hidden until we know whether this video even has a
  // choice to offer. Otherwise the previous video's buttons linger over a
  // still-resolving list and fire against stale URLs.
  document.getElementById('quality-step-back').classList.add('hidden');
  showQualityStep(true);
  thumbEl.innerHTML = '';
  if (video.thumb) { attachThumb(thumbEl, video.thumb); thumbEl.classList.remove('hidden'); }
  else thumbEl.classList.add('hidden');
  titleEl.textContent = video.title || `${video.label || video.platform} · ${chrome.i18n.getMessage('qualityResolving')}`;
  listEl.innerHTML = `<div class="quality-loading">${escapeHtml(chrome.i18n.getMessage('qualityResolving'))}</div>`;

  const res = await send({ type: 'RESOLVE_QUALITIES', tabId: activeTab?.id, key: video.key });
  if (!res?.ok) {
    titleEl.textContent = video.title || video.label || video.platform;
    listEl.innerHTML = '';
    // Both steps off — a "Choose quality" heading over an empty list under a red
    // error is just noise.
    document.getElementById('quality-step').classList.add('hidden');
    showError(errEl, res?.error || chrome.i18n.getMessage('qualityErrorGeneric'));
    return;
  }

  const title = video.title || res.title || `${video.platform}-video`;
  titleEl.textContent = title;
  nameInput.value = sanitizeName(title);
  listEl.innerHTML = '';

  res.qualities.forEach((q) => {
    const btn = document.createElement('button');
    btn.className = 'quality-item';
    // vimeo-json is video + audio as separate segmented tracks, so it reads the
    // same to the user as any other locally merged download.
    const sub = q.kind === 'merge' || q.kind === 'vimeo-json' ? chrome.i18n.getMessage('qualityKindMerged')
      : q.kind === 'hls' ? chrome.i18n.getMessage('qualityKindHls')
      : chrome.i18n.getMessage('qualityKindMp4');
    btn.innerHTML =
      `<span class="quality-item__label">${escapeHtml(q.label)}</span>` +
      `<span class="quality-item__sub">${escapeHtml(sub)}${q.size ? ' · ' + (q.size / 1048576).toFixed(0) + ' MB' : ''}</span>` +
      `<span class="quality-item__dl">${escapeHtml(chrome.i18n.getMessage('qualityDownloadBtn'))}</span>`;
    btn.addEventListener('click', () => startDownload(q, nameInput.value.trim() || sanitizeName(title), video));
    listEl.appendChild(btn);
  });

  renderActionStep(res.qualities, video, () => nameInput.value.trim() || sanitizeName(title));
}

// The picker is two steps: pick *what kind of file* you want, then pick the
// quality for it. Quality is a detail of the combined download, so asking for it
// up front — next to two buttons that don't use it — was the confusing part.
function showQualityStep(show) {
  document.getElementById('action-step').classList.toggle('hidden', show);
  document.getElementById('quality-step').classList.toggle('hidden', !show);
}

// Step 1. Only meaningful when the stream ships video and audio as separate
// renditions: a muxed MP4 has nothing to split, so "combined" and "video only"
// would be the same download under two names. In that case skip straight to the
// quality list, which is then the entire decision.
function renderActionStep(qualities, video, getFilename) {
  const stepBack = document.getElementById('quality-step-back');
  const btnVideo = document.getElementById('btn-video-only');
  const btnAudio = document.getElementById('btn-audio-only');

  // Best rendition that carries a separate audio track (list is sorted
  // best-first). vimeo-json names its tracks by id, not URL.
  const q = qualities.find((x) => x.audioUrl || x.audioTrackId);
  if (!q) { stepBack.classList.add('hidden'); showQualityStep(true); return; }

  // Every quality with a separate audio track has to be merged, so if the
  // engine can't merge, the combined button above is dead on this machine.
  const note = document.getElementById('no-simd-note');
  note.textContent = chrome.i18n.getMessage('noSimdNote');
  note.classList.toggle('hidden', wasmSimdSupported());

  btnVideo.innerHTML = escapeHtml(chrome.i18n.getMessage('videoOnlyBtn')) +
    (q.label ? `<span class="btn__meta">${escapeHtml(q.label)}</span>` : '');
  btnAudio.textContent = chrome.i18n.getMessage('audioOnlyBtn');
  btnVideo.onclick = () => startDownload(q, getFilename(), video, 'video');
  btnAudio.onclick = () => startDownload(q, getFilename(), video, 'audio');

  document.getElementById('btn-combined').onclick = () => {
    stepBack.classList.remove('hidden');
    showQualityStep(true);
  };
  stepBack.onclick = () => { showQualityStep(false); };
  showQualityStep(false);
}

// Same probe the service worker runs (background.js). ffmpeg-core.wasm requires
// +simd128, so an engine without it can never merge — say so before the user
// spends a download finding out.
let simdSupported = null;
function wasmSimdSupported() {
  if (simdSupported === null) {
    try {
      simdSupported = WebAssembly.validate(new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123,
        3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11
      ]));
    } catch { simdSupported = false; }
  }
  return simdSupported;
}

async function startDownload(quality, filename, video, mode) {
  const errEl = document.getElementById('quality-error');
  errEl.classList.add('hidden');

  const res = await send({ type: 'START_DOWNLOAD', tabId: activeTab?.id, quality, filename, label: video.label, mode });
  if (!res?.ok) {
    if (res?.reason === 'weekly_limit') {
      openPricingModal(chrome.i18n.getMessage('weeklyLimitMsg'));
    } else {
      showError(errEl, chrome.i18n.getMessage('downloadStartError'));
    }
    return;
  }
  jobLabels.set(res.jobId, filename);
  showVideoList();
  await refreshQueue();
  await initLicenseUI();
}

// ── Download manager ──────────────────────────────────────────────────────────
async function refreshQueue() {
  const res = await send({ type: 'GET_QUEUE' });
  const items = res?.items || [];
  items.forEach(i => { if (i.filename) jobLabels.set(i.jobId, i.filename); });
  renderManager(items);
}

function renderManager(items) {
  const box = document.getElementById('manager');
  const list = document.getElementById('manager__list');
  const count = document.getElementById('manager__count');
  if (!items.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');

  const running = items.filter(i => i.state === 'running').length;
  const queued = items.filter(i => i.state === 'queued').length;
  count.textContent = queued
    ? chrome.i18n.getMessage('managerActiveQueued', [String(running), String(queued)])
    : chrome.i18n.getMessage('managerActive', [String(running)]);

  list.innerHTML = '';
  items.forEach(i => list.appendChild(managerRow(i)));
}

function managerRow(item) {
  const row = document.createElement('div');
  row.className = 'dl-row';
  row.dataset.jobId = item.jobId;
  const name = jobLabels.get(item.jobId) || item.filename || chrome.i18n.getMessage('defaultDownloadName');
  const phase = phaseLabel(item);
  row.innerHTML =
    `<div class="dl-row__top">` +
      `<span class="dl-row__name">${escapeHtml(name)}</span>` +
      `<span class="dl-row__phase">${escapeHtml(phase)}</span>` +
    `</div>` +
    `<div class="dl-row__barwrap"><div class="dl-row__bar" style="width:${item.percent || 0}%"></div></div>` +
    `<div class="dl-row__foot">` +
      `<span class="dl-row__speed">${item.speed || ''}</span>` +
      (item.state === 'done' ? `<span class="dl-row__done">${escapeHtml(chrome.i18n.getMessage('dlSaved'))}</span>`
        : item.state === 'error' || item.phase === 'error' ? `<span class="dl-row__err">${escapeHtml(chrome.i18n.getMessage('dlFailed'))}</span> <button class="dl-row__report" data-report>${escapeHtml(chrome.i18n.getMessage('dlReportBtn'))}</button>`
        : item.state === 'cancelled' ? `<span class="dl-row__err">${escapeHtml(chrome.i18n.getMessage('dlCancelled'))}</span>`
        : `<button class="dl-row__cancel" data-cancel="${item.jobId}">${escapeHtml(chrome.i18n.getMessage('dlCancelBtn'))}</button>`) +
    `</div>`;
  const cancel = row.querySelector('[data-cancel]');
  if (cancel) cancel.addEventListener('click', () => send({ type: 'CANCEL_JOB', jobId: item.jobId }));
  const report = row.querySelector('[data-report]');
  if (report) report.addEventListener('click', () => openReportModal(item.error || chrome.i18n.getMessage('downloadFailedLabel', [name])));
  return row;
}

function phaseLabel(item) {
  if (item.state === 'queued') return chrome.i18n.getMessage('phaseQueued');
  if (item.state === 'cancelled') return chrome.i18n.getMessage('phaseCancelled');
  switch (item.phase) {
    // The percent is kept in the label: this state exists to show that the
    // partial download is still held, not thrown away, while a throttle passes.
    case 'waiting': return chrome.i18n.getMessage('phaseWaiting',
      [formatWait(item.waitSeconds), String(item.percent || 0)]);
    case 'merging': return chrome.i18n.getMessage('phaseMerging');
    case 'saving': return chrome.i18n.getMessage('phaseSaving');
    case 'done': return chrome.i18n.getMessage('phaseDone');
    case 'error': return chrome.i18n.getMessage('phaseError');
    case 'starting': return chrome.i18n.getMessage('phaseStarting');
    default: return `${item.percent || 0}%`;
  }
}

// m:ss, or plain seconds under a minute.
function formatWait(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
}

function updateRow(jobId, patch) {
  const row = document.querySelector(`.dl-row[data-job-id="${jobId}"]`);
  if (!row) { refreshQueue(); return; }
  if (patch.percent != null) row.querySelector('.dl-row__bar').style.width = patch.percent + '%';
  if (patch.phase || patch.percent != null) {
    row.querySelector('.dl-row__phase').textContent = phaseLabel({ ...patch, state: 'running' });
  }
  if (patch.speed != null) row.querySelector('.dl-row__speed').textContent = patch.speed || '';
}

function setupQueueListener() {
  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'QUEUE_ADD':
      case 'QUEUE_CANCELLED':
        refreshQueue();
        break;
      case 'QUEUE_UPDATE':
        updateRow(msg.jobId, msg.patch);
        break;
      case 'QUEUE_DONE':
        updateRow(msg.jobId, { percent: 100, phase: 'done', speed: '' });
        refreshQueue();
        initLicenseUI();
        break;
      case 'QUEUE_ERROR':
        refreshQueue();
        break;
    }
  });
}

// ── Pricing modal ─────────────────────────────────────────────────────────────
function openPricingModal(subtitle) {
  const sub = document.querySelector('#pricing-modal .modal__sub');
  if (sub && typeof subtitle === 'string') sub.textContent = subtitle;
  document.getElementById('pricing-modal').classList.remove('hidden');
}
function closePricingModal() { document.getElementById('pricing-modal').classList.add('hidden'); }
function setupPricingModal() {
  document.getElementById('buy-monthly').href = WELCOME_URL;
  document.querySelectorAll('#pricing-modal [data-close]').forEach(el => el.addEventListener('click', closePricingModal));
}

// ── License activation ────────────────────────────────────────────────────────
// A definite reason beats "invalid license" wherever the Worker gives us one:
// "your subscription lapsed" and "you typo'd the key" need different actions
// from the customer, and the old single message left them guessing.
function activationErrorMessage(code) {
  switch (code) {
    case 'license_inactive':
      return t('licenseInactive', 'That license is inactive — the subscription may have been cancelled or expired.');
    // Freemius's wording for "all activation slots used". Reported as "it says
    // my key is expired" by a real customer in July 2026, because this fell
    // through to the generic invalid-or-expired message — the key was fine, it
    // had simply run out of slots. Note a slot is consumed per INSTALL, so
    // reinstalling the extension uses a fresh one.
    case 'license_utilized':
      return t('licenseUtilized', 'This license is already active on all of its allowed installs. Reinstalling the extension uses up a slot — email support@skoolvideodownload.com and we\'ll free one for you right away.');
    case 'license_expired':
      return t('licenseExpired', 'That license has expired. If you believe it should still be active, email support@skoolvideodownload.com.');
    case 'activation_limit':
      return t('licenseLimit', 'That license has reached its activation limit. Contact support and we\'ll free up a slot.');
    case 'wrong_product':
      return t('licenseWrongProduct', 'That key belongs to a different one of our extensions, not this one.');
    case 'network_error':
      return t('licenseNetwork', 'Couldn\'t reach the license server. Check your connection and try again.');
    default:
      return chrome.i18n.getMessage('licenseInvalid');
  }
}

function setupLicenseActivation() {
  const btn = document.getElementById('activate-btn');
  const input = document.getElementById('license-input');
  const msgEl = document.getElementById('activate-msg');
  btn.addEventListener('click', async () => {
    // Sent as typed. The Worker uppercases for Freemius (which is the only
    // path that needs it) and lowercases to match a legacy grant, so neither
    // depends on what the customer's clipboard did to the casing.
    const key = input.value.trim();
    if (!key) return;
    btn.disabled = true; btn.textContent = chrome.i18n.getMessage('verifyingBtn');
    msgEl.textContent = ''; msgEl.className = 'msg';
    const result = await send({ type: 'ACTIVATE_LICENSE', licenseKey: key });
    if (result?.valid) {
      renderActivationSuccess(msgEl, result);
      setTimeout(initLicenseUI, 1000);
    } else {
      msgEl.textContent = activationErrorMessage(result?.error); msgEl.className = 'msg msg--error';
      btn.disabled = false; btn.textContent = chrome.i18n.getMessage('activateBtn');
    }
  });
}

// Plain activation just confirms. A monthly→lifetime upgrade also reports what
// happened to the old subscription, because the one thing a customer must never
// have to wonder is whether they're still being charged.
function renderActivationSuccess(msgEl, result) {
  msgEl.className = 'msg msg--success';
  if (!result.upgrade) {
    msgEl.textContent = chrome.i18n.getMessage('licenseActivated');
    return;
  }
  if (result.upgrade.cancelled) {
    msgEl.textContent = t('upgradeCancelled', 'Lifetime activated — your monthly subscription has been cancelled.');
    return;
  }
  msgEl.className = 'msg msg--error';
  msgEl.textContent = t(
    'upgradeCancelFailed',
    'Lifetime activated. We couldn\'t cancel your monthly automatically — please cancel it so you\'re not billed again: '
  );
  const link = document.createElement('a');
  link.href = CANCEL_URL;
  link.target = '_blank';
  link.className = 'footer-link';
  link.textContent = t('upgradeCancelLink', 'Cancel monthly →');
  msgEl.appendChild(link);
}

// ── Update banner ─────────────────────────────────────────────────────────────
// Shown only when this build's channel (cws vs full) is behind its own latest
// version. Dismissing remembers the version, so the banner stays gone until the
// NEXT release — informative once, never nagging.
async function initUpdateBanner() {
  const status = await send({ type: 'GET_VERSION_STATUS' });
  if (!status?.updateAvailable) return;
  const { dismissedUpdateVersion } = await chrome.storage.local.get('dismissedUpdateVersion');
  if (dismissedUpdateVersion === status.latest) return;

  const banner = document.getElementById('update-banner');
  document.getElementById('update-banner-text').textContent =
    status.message || chrome.i18n.getMessage('updateFallback', [String(status.latest), String(status.current)]);
  document.getElementById('update-open').addEventListener('click', () =>
    chrome.tabs.create({ url: status.url }));
  document.getElementById('update-dismiss').addEventListener('click', () => {
    chrome.storage.local.set({ dismissedUpdateVersion: status.latest }).catch(() => {});
    banner.classList.add('hidden');
  });
  banner.classList.remove('hidden');
}

// ── Problem reporting ─────────────────────────────────────────────────────────
// One-click error reports, mirroring the Whop downloader: the error box grows a
// "Report this error" button, the footer has a standing "Report a problem"
// link, and nothing is sent until the user reviews the consent modal and hits
// Send. The background collects diagnostics and POSTs to the reports Worker;
// if that's blocked, the payload is copied for a support email instead.
let reportErrorContext = null;

// Render an inline error with a report button attached.
function showError(errEl, message) {
  errEl.innerHTML = '';
  const text = document.createElement('span');
  text.textContent = message;
  const btn = document.createElement('button');
  btn.className = 'msg__report';
  btn.textContent = chrome.i18n.getMessage('reportThisError');
  btn.addEventListener('click', () => openReportModal(message));
  errEl.append(text, btn);
  errEl.classList.remove('hidden');
}

function openReportModal(errorText) {
  reportErrorContext = errorText || null;
  const modal = document.getElementById('report-modal');
  const ctx = document.getElementById('report-context');
  if (errorText) {
    ctx.textContent = chrome.i18n.getMessage('reportErrorPrefix', [errorText]);
    ctx.classList.remove('hidden');
  } else {
    ctx.classList.add('hidden');
  }
  document.getElementById('report-msg').textContent = '';
  const sendBtn = document.getElementById('report-send');
  sendBtn.disabled = false;
  sendBtn.textContent = chrome.i18n.getMessage('reportSendBtn');
  // Prefill the email from the last report so repeat reporters type it once.
  chrome.storage.local.get('reportEmail').then(({ reportEmail }) => {
    if (reportEmail && !document.getElementById('report-email').value) {
      document.getElementById('report-email').value = reportEmail;
    }
  });
  modal.classList.remove('hidden');
}

function initReportModal() {
  const modal = document.getElementById('report-modal');
  modal.querySelectorAll('[data-close-report]').forEach((el) =>
    el.addEventListener('click', () => modal.classList.add('hidden')));
  // Two entry points, one modal: the header chip is the visible one, the footer
  // link stays for anyone who already knows where it was.
  for (const id of ['footer-report', 'header-report']) {
    document.getElementById(id).addEventListener('click', () => openReportModal());
  }

  document.getElementById('report-send').addEventListener('click', async () => {
    const sendBtn = document.getElementById('report-send');
    const msg = document.getElementById('report-msg');
    const email = document.getElementById('report-email').value.trim().slice(0, 120);
    const userNote = document.getElementById('report-note').value.trim().slice(0, 300);
    const note = [reportErrorContext, userNote].filter(Boolean).join(' — ') || 'no details given';

    sendBtn.disabled = true;
    sendBtn.textContent = chrome.i18n.getMessage('reportSending');
    if (email) chrome.storage.local.set({ reportEmail: email }).catch(() => {});

    const res = await send({ type: 'REPORT_PROBLEM', tabId: activeTab?.id, note, email });
    if (res?.ok) {
      sendBtn.textContent = chrome.i18n.getMessage('reportSentBtn');
      msg.textContent = email ? chrome.i18n.getMessage('reportSentEmailNote') : '';
      msg.className = 'msg msg--success';
      setTimeout(() => modal.classList.add('hidden'), 1800);
      return;
    }
    sendBtn.textContent = chrome.i18n.getMessage('reportSendBtn');
    sendBtn.disabled = false;
    try {
      await navigator.clipboard.writeText(
        'Skool Video Downloader problem report\n' + JSON.stringify(res?.payload ?? {}, null, 2)
      );
      msg.textContent = chrome.i18n.getMessage('reportClipboardFallback');
    } catch {
      msg.textContent = chrome.i18n.getMessage('reportServerError');
    }
    msg.className = 'msg msg--error';
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function sanitizeName(s) {
  return (s || 'skool-video').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'skool-video';
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function send(message) {
  return new Promise((resolve) => {
    try { chrome.runtime.sendMessage(message, (r) => resolve(chrome.runtime.lastError ? null : r)); }
    catch { resolve(null); }
  });
}

// ── Whole-course backup ───────────────────────────────────────────────────────
// The popup is a view over background state: it renders from GET_BULK_STATE when
// it opens and from BULK_STATE pushes while it is open. Closing it, or closing
// the browser, never affects a run.

const BULK_PANES = ['bulk-idle', 'bulk-resume', 'bulk-running', 'bulk-paused', 'bulk-done'];
const bulkEl = (id) => document.getElementById(id);
const bulkT = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String));
let bulkCtx = null;      // preflight result: { group, courseSlug, courseTitle, total, … }
let bulkRestartArmed = false;
let bulkIsPro = false;   // remembered from the last init, so the panel can rebuild itself

function bulkShow(which) {
  for (const pane of BULK_PANES) bulkEl(pane).classList.toggle('hidden', pane !== which);
  bulkEl('bulk').classList.remove('hidden');
  bulkDisarmRestart();
}

function bulkWant() {
  return {
    video: bulkEl('bulk-want-video').checked,
    notes: bulkEl('bulk-want-notes').checked,
    files: bulkEl('bulk-want-files').checked,
  };
}

async function initBulkPanel(tabUrl, isPro) {
  if (!tabUrl?.includes('/classroom')) return;
  // Kept so the panel can rebuild itself later — cancelling a paused run ends it
  // without producing a summary, and the only honest thing to show next is a
  // fresh preflight of what is on disk.
  bulkIsPro = isPro;

  // A live or interrupted run wins over preflight, so reopening mid-run shows the
  // run rather than an invitation to start a second one.
  const live = await send({ type: 'GET_BULK_STATE' });
  const state = live?.state || null;
  if (state?.phase === 'running') { bulkCtx = state; bulkRenderRunning(state); return; }
  if (state?.phase === 'paused') { bulkCtx = state; bulkRenderPaused(state); return; }

  const pre = await send({ type: 'BULK_PREFLIGHT', url: tabUrl });
  if (!pre) return;
  if (!pre.ok) {
    // Not a course page at all — no panel, no explanation needed.
    if (pre.code === 'not-a-course') return;
    bulkShow('bulk-idle');
    bulkEl('bulk-course-title').textContent = '';
    bulkEl('bulk-course-meta').textContent = bulkT({
      'not-signed-in': 'bulkErrNotSignedIn', 'schema-drift': 'bulkErrSchemaDrift',
      'empty-course': 'bulkErrEmptyCourse', 'no-access': 'bulkErrNoAccess',
      'rate-limited': 'bulkErrRateLimited',
    }[pre.code] || 'bulkErrSchemaDrift');
    bulkEl('bulk-start').classList.add('hidden');
    for (const el of document.querySelectorAll('#bulk-idle .bulk__opt, #bulk-idle .bulk__note')) {
      el.classList.add('hidden');
    }
    return;
  }

  bulkCtx = pre;
  const meta = [bulkT('bulkLessonCount', pre.total)];
  if (pre.shape !== 'flat') meta.push(bulkT('bulkModuleCount', pre.moduleCount));
  bulkEl('bulk-course-title').textContent = pre.courseTitle;
  bulkEl('bulk-course-meta').textContent = meta.join(' · ');
  bulkEl('bulk-pro-note').classList.toggle('hidden', !!isPro);

  // A run that ended while the popup was closed has no other way to report
  // itself: the BULK_DONE broadcast went nowhere. Only for this course, so a
  // different course's result never shows up here.
  if ((state?.phase === 'completed' || state?.phase === 'cancelled')
      && state.group === pre.group && state.courseSlug === pre.courseSlug) {
    bulkRenderDone({ summary: state.summary, cancelled: state.phase === 'cancelled' });
    return;
  }

  // Interrupted, or a previous run left work outstanding: lead with what is
  // already done — "Resume" without a number reads like "start over".
  if (state?.phase === 'interrupted' && state.group === pre.group && state.courseSlug === pre.courseSlug) {
    bulkRenderResume(pre.alreadySaved, pre.total);
  } else if (pre.alreadySaved > 0 && pre.remaining > 0) {
    bulkRenderResume(pre.alreadySaved, pre.total);
  } else if (pre.remaining === 0 && pre.total > 0) {
    // Nothing left to do. Without this the panel shows "Download entire course",
    // which does nothing at all when pressed — and a user who deleted files has
    // no way to ask for them back, because Chrome does not tell the extension a
    // saved file is gone. "Re-download everything" is that way.
    bulkRenderComplete(pre.total);
  } else {
    bulkShow('bulk-idle');
  }
}

// Every lesson is already saved. The resume pane, minus the resume.
function bulkRenderComplete(total) {
  bulkEl('bulk-resume-title').textContent = bulkCtx?.courseTitle || '';
  bulkEl('bulk-resume-meta').textContent = bulkT('bulkAllSaved', total);
  bulkEl('bulk-resume-go').classList.add('hidden');
  bulkShow('bulk-resume');
}

function bulkRenderResume(saved, total) {
  bulkEl('bulk-resume-go').classList.remove('hidden');
  bulkEl('bulk-resume-title').textContent = bulkCtx?.courseTitle || bulkT('bulkResumeTitle');
  bulkEl('bulk-resume-meta').textContent = bulkT('bulkResumeMeta', saved, total);
  bulkShow('bulk-resume');
}

function bulkRenderRunning(state) {
  const done = state.done || 0, total = state.total || 0;
  bulkEl('bulk-run-title').textContent = state.courseTitle || bulkCtx?.courseTitle || '';
  bulkEl('bulk-bar-fill').style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  bulkEl('bulk-count').textContent = bulkT('bulkProgress', done, total);
  bulkEl('bulk-current').textContent = state.currentTitle || '';
  // Stopping takes as long as the current file needs to unwind, and every
  // progress broadcast during that window used to repaint the run as if the
  // click had never happened — which is what made Cancel read as broken. The
  // flag is carried on the state itself, so a popup reopened mid-cancel shows
  // this too, and the buttons go dead rather than inviting a second click.
  const cancelling = !!state.cancelling;
  bulkEl('bulk-line').textContent = cancelling ? bulkT('bulkCancelling') : (state.lastLine || '');
  bulkEl('bulk-line').classList.toggle('bulk__line--busy', cancelling);
  bulkEl('bulk-pause').disabled = cancelling;
  bulkEl('bulk-cancel').disabled = cancelling;
  bulkShow('bulk-running');
}

function bulkRenderPaused(state) {
  bulkEl('bulk-paused-title').textContent = state.courseTitle || bulkCtx?.courseTitle || '';
  bulkEl('bulk-paused-meta').textContent = bulkT('bulkPausedMeta', state.done || 0, state.total || 0);
  bulkShow('bulk-paused');
}

function bulkRenderDone(msg) {
  const list = bulkEl('bulk-detail');
  // A run that died before its first lesson has no counts. Showing the zeroed
  // summary would read as "nothing to do" instead of "this failed".
  if (msg.error) {
    bulkEl('bulk-summary').textContent = bulkT({
      'not-signed-in': 'bulkErrNotSignedIn', 'schema-drift': 'bulkErrSchemaDrift',
      'empty-course': 'bulkErrEmptyCourse', 'no-access': 'bulkErrNoAccess',
      'rate-limited': 'bulkErrRateLimited',
    }[msg.error] || 'bulkErrSchemaDrift');
    list.textContent = '';
    bulkShow('bulk-done');
    return;
  }
  const s = msg.summary || { saved: 0, skipped: 0, failed: 0 };
  bulkEl('bulk-summary').textContent = bulkT('bulkSummary', s.saved, s.skipped, s.failed)
    + (msg.cancelled ? ` · ${bulkT('bulkCancelled')}` : '');
  list.textContent = '';
  const add = (text) => { const li = document.createElement('li'); li.textContent = text; list.appendChild(li); };
  // Listed first, because it is the largest number on a cancelled run and the
  // only one that says the backup is incomplete. Without it the panel showed
  // "Saved 3 · skipped 0 · failed 0" for a 40-lesson course stopped at lesson 3,
  // which the run log now contradicts.
  if (s.notAttempted) add(bulkT('bulkNotAttempted', s.notAttempted));
  if (s.skippedByReason?.locked) add(bulkT('bulkSkipLocked', s.skippedByReason.locked));
  // Without a line of its own this was a bare number in "skipped", which reads
  // as an incomplete run with no explanation — the exact report that prompted
  // it. These lessons ARE gettable, one at a time, so say how.
  if (s.skippedByReason?.['needs-playback']) {
    add(bulkT('bulkSkipNeedsPlayback', s.skippedByReason['needs-playback']));
  }
  if (s.skippedByReason?.youtube) add(bulkT('bulkSkipYoutube', s.skippedByReason.youtube));
  for (const f of msg.failedDetail || []) add(`${f.title} — ${f.reason}`);
  bulkShow('bulk-done');
}

async function bulkStart(type) {
  if (!bulkCtx) return;
  const res = await send({
    type, group: bulkCtx.group, courseSlug: bulkCtx.courseSlug, want: bulkWant(),
  });
  // The tier check lives in the background as well as here; this is the free
  // user's first sight of the paywall, so it opens the plans rather than an error.
  if (res?.code === 'pro-required') { openPricingModal(); return; }
  // Another popup already started this run — show the run, not a second start.
  if (res?.code === 'already-running') {
    const live = await send({ type: 'GET_BULK_STATE' });
    if (live?.state) bulkRenderRunning(live.state);
    return;
  }
  if (!res?.ok) return;
  bulkRenderRunning({ done: 0, total: bulkCtx.total, currentTitle: '', lastLine: '' });
}

// Shown before every backup, not once. The notice is not really a warning — it
// is where the user learns how to report a bad run, and the run that goes wrong
// is as likely to be their fourth as their first.
function bulkConfirmBeta(type) {
  if (!bulkCtx) return;
  const modal = bulkEl('bulk-beta-modal');
  const go = bulkEl('bulk-beta-go');
  const close = () => {
    modal.classList.add('hidden');
    go.removeEventListener('click', accept);
    for (const el of modal.querySelectorAll('[data-close-beta]')) el.removeEventListener('click', close);
  };
  // Named so it can be removed again: the sheet is reopened on every run, and
  // listeners left behind would start one extra backup per previous opening.
  const accept = () => { close(); bulkStart(type); };
  go.addEventListener('click', accept);
  for (const el of modal.querySelectorAll('[data-close-beta]')) el.addEventListener('click', close);
  modal.classList.remove('hidden');
}

// Two-step rather than confirm(): a modal dialog can close the popup out from
// under the run, and this discards a record of work already on disk.
const BULK_RESTART_BUTTONS = ['bulk-restart', 'bulk-restart-done'];

function bulkDisarmRestart() {
  if (!bulkRestartArmed) return;
  bulkRestartArmed = false;
  for (const id of BULK_RESTART_BUTTONS) bulkEl(id).textContent = bulkT('bulkRestart');
}

function setupBulkPanel() {
  // Both of these begin a long run, so both go through the Beta notice. Unpause
  // does not: it is the same run the user already accepted.
  bulkEl('bulk-start').addEventListener('click', () => bulkConfirmBeta('START_BULK'));
  bulkEl('bulk-resume-go').addEventListener('click', () => bulkConfirmBeta('RESUME_BULK'));
  bulkEl('bulk-unpause').addEventListener('click', () => bulkStart('RESUME_BULK'));
  bulkEl('bulk-pause').addEventListener('click', () => send({ type: 'PAUSE_BULK' }));
  bulkEl('bulk-again').addEventListener('click', () => bulkShow('bulk-idle'));

  // Cancelling a running backup: paint the stopping state now rather than
  // waiting for the background to answer. The click has to land visibly even
  // though the run needs a moment to unwind, or it reads as a dead button.
  bulkEl('bulk-cancel').addEventListener('click', () => {
    bulkEl('bulk-cancel').disabled = true;
    bulkEl('bulk-pause').disabled = true;
    bulkEl('bulk-line').textContent = bulkT('bulkCancelling');
    bulkEl('bulk-line').classList.add('bulk__line--busy');
    send({ type: 'CANCEL_BULK' });
  });

  // Cancelling a paused backup ends a run that is not executing, so there is no
  // progress to stop and no summary to show — rebuild the panel from a fresh
  // preflight instead.
  // The rebuild is driven by the BULK_ENDED broadcast below rather than from
  // here, so a second open popup follows along instead of being left on a pane
  // for a run that no longer exists.
  bulkEl('bulk-cancel-2').addEventListener('click', () => {
    bulkEl('bulk-cancel-2').disabled = true;
    send({ type: 'CANCEL_BULK' });
  });
  // On both the resume pane and the finished pane. A run that just completed is
  // exactly when a user notices something is missing, and leaving them only
  // "Back" drops them on a start button that does nothing, because every lesson
  // is already recorded as saved.
  for (const id of BULK_RESTART_BUTTONS) {
    bulkEl(id).addEventListener('click', async () => {
      if (!bulkCtx) return;
      if (!bulkRestartArmed) {
        bulkRestartArmed = true;
        bulkEl(id).textContent = bulkT('bulkRestartConfirm');
        return;
      }
      await send({ type: 'CLEAR_MANIFEST', group: bulkCtx.group, courseSlug: bulkCtx.courseSlug });
      bulkShow('bulk-idle');
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'BULK_STATE') {
      if (msg.state.phase === 'running') bulkRenderRunning(msg.state);
      else if (msg.state.phase === 'paused') bulkRenderPaused(msg.state);
    } else if (msg?.type === 'BULK_DONE') {
      bulkRenderDone(msg);
    } else if (msg?.type === 'BULK_ENDED') {
      // A paused run was cancelled. It produced no summary, so the honest next
      // screen is a fresh preflight of what is actually on disk.
      bulkEl('bulk-cancel-2').disabled = false;
      initBulkPanel(activeTab?.url, bulkIsPro);
    }
  });
}
