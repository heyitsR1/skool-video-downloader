// Skool Video Downloader — popup controller.
// Flow: detect videos on the active tab → pick one → resolve qualities → choose
// resolution → enqueue. A live download-manager panel renders queue state from
// background QUEUE_* broadcasts (progress, speed, cancel).

// Freemius checkout — Skool Video Downloader (product 33457, plan 54961,
// pricing 72637). MV3 popup CSP forbids loading Freemius's checkout.min.js,
// so — like the Whop downloader — we open the hosted popup-mode checkout URL
// directly. The /plan/ segment takes the plan id (not the pricing id); one
// pricing object under that plan carries the cycles ($9.99/mo, $99.99 lifetime)
// and billing_cycle preselects which it opens on. The annual cycle still exists
// on the Freemius pricing object but is deliberately not offered anywhere in the
// UI — it's monthly or one-time, nothing in between.
// NOTE: the actual charged amount lives on Freemius's pricing object (id
// 72637) — update it there too, this comment/UI text doesn't drive billing.
const FS_PRODUCT_ID = 33457;
const FS_PLAN_ID = 54961;
const CHECKOUT = `https://checkout.freemius.com/mode/popup/plugin/${FS_PRODUCT_ID}/plan/${FS_PLAN_ID}/`;
const CHECKOUT_MONTHLY = `${CHECKOUT}?billing_cycle=monthly`;
const CHECKOUT_LIFETIME = `${CHECKOUT}?billing_cycle=lifetime`;

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

  document.getElementById('quality-back').addEventListener('click', showVideoList);
  document.getElementById('upgrade-btn').addEventListener('click', () => openPricingModal());
  document.getElementById('yt-policy-back').addEventListener('click', showVideoList);
  document.getElementById('yt-guide-btn').addEventListener('click', () => {
    const url = ytGuideVideoId ? `${YT_GUIDE_URL}?v=${encodeURIComponent(ytGuideVideoId)}` : YT_GUIDE_URL;
    chrome.tabs.create({ url });
  });
  initReportModal();

  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  await initLicenseUI();
  await refreshVideos();
  await refreshQueue();
  initUpdateBanner(); // async, non-blocking — banner pops in if an update exists

  // Nudge the content script to rescan (covers already-open lessons).
  if (activeTab?.id) chrome.tabs.sendMessage(activeTab.id, { type: 'RESCAN' }).catch(() => {});
});

// ── License UI ──────────────────────────────────────────────────────────────
async function initLicenseUI() {
  const status = await send({ type: 'GET_LICENSE_STATUS' });
  if (!status) return;
  const badge = document.getElementById('tier-badge');
  const creditsText = document.getElementById('credits-text');
  const lifetimeLink = document.getElementById('lifetime-link');
  const upgradeBtn = document.getElementById('upgrade-btn');
  const licenseSection = document.getElementById('license-section');

  lifetimeLink.classList.add('hidden');
  upgradeBtn.classList.add('hidden');

  if (status.tier === 'lifetime') {
    badge.textContent = chrome.i18n.getMessage('planLifetimeName'); badge.className = 'badge badge--unlimited';
    creditsText.textContent = chrome.i18n.getMessage('lifetimeCredits');
    licenseSection.classList.add('hidden');
  } else if (status.tier === 'monthly') {
    badge.textContent = chrome.i18n.getMessage('badgePro'); badge.className = 'badge badge--pro';
    creditsText.textContent = chrome.i18n.getMessage('proCredits');
    lifetimeLink.href = CHECKOUT_LIFETIME; lifetimeLink.classList.remove('hidden');
    licenseSection.classList.add('hidden');
  } else {
    badge.textContent = chrome.i18n.getMessage('badgeFree'); badge.className = 'badge badge--free';
    const rem = status.remaining;
    creditsText.textContent = rem > 0
      ? chrome.i18n.getMessage('creditsRemaining', [String(rem), String(status.limit)])
      : chrome.i18n.getMessage('creditsExhausted');
    upgradeBtn.classList.remove('hidden');
    licenseSection.classList.remove('hidden');
  }
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
  for (const v of videos) {
    const native = v.platform === 'skool' || v.platform === 'hls';
    if (!v.title && ctx?.title && (native || single)) v.title = ctx.title;
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
  currentVideos.forEach((v, i) => {
    const row = document.createElement('button');
    row.className = 'video-row';
    const icon = PLATFORM_ICON[v.platform] || '🎞️';
    row.innerHTML =
      `<span class="video-row__thumb">${icon}</span>` +
      `<span class="video-row__meta"><span class="video-row__title">${escapeHtml(v.title || chrome.i18n.getMessage('videoDefaultTitle', [String(i + 1)]))}</span>` +
      `<span class="video-row__platform">${escapeHtml(v.label || v.platform)}</span></span>` +
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
    const sub = q.kind === 'merge' ? chrome.i18n.getMessage('qualityKindMerged')
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

  // Best rendition that carries a separate audio track (list is sorted best-first).
  const q = qualities.find((x) => x.audioUrl);
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
    case 'merging': return chrome.i18n.getMessage('phaseMerging');
    case 'saving': return chrome.i18n.getMessage('phaseSaving');
    case 'done': return chrome.i18n.getMessage('phaseDone');
    case 'error': return chrome.i18n.getMessage('phaseError');
    case 'starting': return chrome.i18n.getMessage('phaseStarting');
    default: return `${item.percent || 0}%`;
  }
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
  document.getElementById('buy-monthly').href = CHECKOUT_MONTHLY;
  document.getElementById('buy-lifetime').href = CHECKOUT_LIFETIME;
  document.querySelectorAll('#pricing-modal [data-close]').forEach(el => el.addEventListener('click', closePricingModal));
}

// ── License activation ────────────────────────────────────────────────────────
function setupLicenseActivation() {
  const btn = document.getElementById('activate-btn');
  const input = document.getElementById('license-input');
  const msg = document.getElementById('activate-msg');
  btn.addEventListener('click', async () => {
    const key = input.value.trim().toUpperCase();
    if (!key) return;
    btn.disabled = true; btn.textContent = chrome.i18n.getMessage('verifyingBtn');
    msg.textContent = ''; msg.className = 'msg';
    const result = await send({ type: 'ACTIVATE_LICENSE', licenseKey: key });
    if (result?.valid) {
      msg.textContent = chrome.i18n.getMessage('licenseActivated'); msg.className = 'msg msg--success';
      setTimeout(initLicenseUI, 1000);
    } else {
      msg.textContent = chrome.i18n.getMessage('licenseInvalid'); msg.className = 'msg msg--error';
      btn.disabled = false; btn.textContent = chrome.i18n.getMessage('activateBtn');
    }
  });
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
  document.getElementById('footer-report').addEventListener('click', () => openReportModal());

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
