// Skool Video Downloader — popup controller.
// Flow: detect videos on the active tab → pick one → resolve qualities → choose
// resolution → enqueue. A live download-manager panel renders queue state from
// background QUEUE_* broadcasts (progress, speed, cancel).

// Freemius checkout — Skool Video Downloader (product 33457, pricing 72637).
// MV3 popup CSP forbids loading Freemius's checkout.min.js, so — like the Whop
// downloader — we open the hosted popup-mode checkout URL directly. One pricing
// object carries all three cycles ($9.99/mo, $49.99/yr, $79.99 lifetime);
// billing_cycle preselects which the checkout opens on.
const FS_PRODUCT_ID = 33457;
const FS_PRICING_ID = 72637;
const CHECKOUT = `https://checkout.freemius.com/mode/popup/plugin/${FS_PRODUCT_ID}/plan/${FS_PRICING_ID}/`;
const CHECKOUT_MONTHLY = `${CHECKOUT}?billing_cycle=monthly`;
const CHECKOUT_ANNUAL = `${CHECKOUT}?billing_cycle=annual`;
const CHECKOUT_LIFETIME = `${CHECKOUT}?billing_cycle=lifetime`;

const PLATFORM_ICON = {
  skool: '🎓', loom: '🔴', vimeo: '🎬', youtube: '▶️', wistia: '🟢', hls: '🎞️'
};

// Build flag (buildConfig.js). Fails closed to the Chrome Web Store behaviour if
// the config is somehow absent.
const YT_DOWNLOAD_ENABLED = !!(self.SVD_CONFIG && self.SVD_CONFIG.YT_DOWNLOAD_ENABLED);
// Destination for the CWS-build YouTube policy notice. The extension links only
// to our own guide page — the guide (video walkthrough + steps) is the single
// off-extension place that points onward, keeping the shipped artifact clean.
const YT_GUIDE_URL = 'https://tailsgate.com/skool-video-downloader/youtube';

let activeTab = null;
let currentVideos = [];
const jobLabels = new Map(); // jobId -> filename (for manager rows)

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('footer-version').textContent = 'v' + chrome.runtime.getManifest().version;
  setupPricingModal();
  setupLicenseActivation();
  setupQueueListener();

  document.getElementById('quality-back').addEventListener('click', showVideoList);
  document.getElementById('upgrade-btn').addEventListener('click', () => openPricingModal());
  document.getElementById('yt-policy-back').addEventListener('click', showVideoList);
  document.getElementById('yt-guide-btn').addEventListener('click', () => chrome.tabs.create({ url: YT_GUIDE_URL }));
  initReportModal();

  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  await initLicenseUI();
  await refreshVideos();
  await refreshQueue();

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
    badge.textContent = 'Lifetime'; badge.className = 'badge badge--unlimited';
    creditsText.textContent = 'Unlimited downloads — forever';
    licenseSection.classList.add('hidden');
  } else if (status.tier === 'monthly') {
    badge.textContent = 'Pro'; badge.className = 'badge badge--pro';
    creditsText.textContent = 'Unlimited downloads';
    lifetimeLink.href = CHECKOUT_LIFETIME; lifetimeLink.classList.remove('hidden');
    licenseSection.classList.add('hidden');
  } else {
    badge.textContent = 'Free'; badge.className = 'badge badge--free';
    const rem = status.remaining;
    creditsText.innerHTML = rem > 0
      ? `<strong>${rem}</strong> of ${status.limit} free downloads left this week`
      : 'Weekly free downloads used up — resets in a few days';
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
    statusEl.textContent = 'Open a Skool lesson to start';
    hintEl.textContent = 'Go to your Skool classroom or community, then open a video.';
    box.classList.add('hidden');
    return;
  }

  if (!currentVideos.length) {
    statusEl.textContent = 'No video detected yet';
    hintEl.textContent = 'Press play on the lesson video, then reopen this popup.';
    box.classList.add('hidden');
    return;
  }

  statusEl.textContent = `${currentVideos.length} video${currentVideos.length > 1 ? 's' : ''} found`;
  statusEl.classList.add('status--ok');
  hintEl.textContent = 'Pick a video to choose quality and download.';

  box.innerHTML = '';
  currentVideos.forEach((v, i) => {
    const row = document.createElement('button');
    row.className = 'video-row';
    const icon = PLATFORM_ICON[v.platform] || '🎞️';
    row.innerHTML =
      `<span class="video-row__thumb">${icon}</span>` +
      `<span class="video-row__meta"><span class="video-row__title">${escapeHtml(v.title || `Video ${i + 1}`)}</span>` +
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

// Chrome Web Store build cannot download YouTube; show the policy notice with
// off-store options instead of resolving qualities.
function showYouTubePolicy() {
  document.getElementById('videos').classList.add('hidden');
  document.getElementById('status-text').classList.add('hidden');
  document.getElementById('hint-text').classList.add('hidden');
  document.getElementById('yt-policy-view').classList.remove('hidden');
}

function showVideoList() {
  document.getElementById('quality-view').classList.add('hidden');
  document.getElementById('yt-policy-view').classList.add('hidden');
  document.getElementById('videos').classList.remove('hidden');
  document.getElementById('status-text').classList.remove('hidden');
  document.getElementById('hint-text').classList.remove('hidden');
}

// ── Quality picker ────────────────────────────────────────────────────────────
async function openQuality(video) {
  if (!YT_DOWNLOAD_ENABLED && video.platform === 'youtube') { showYouTubePolicy(); return; }
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
  thumbEl.innerHTML = '';
  if (video.thumb) { attachThumb(thumbEl, video.thumb); thumbEl.classList.remove('hidden'); }
  else thumbEl.classList.add('hidden');
  titleEl.textContent = video.title || `${video.label || video.platform} · loading qualities…`;
  listEl.innerHTML = '<div class="quality-loading">Resolving available resolutions…</div>';

  const res = await send({ type: 'RESOLVE_QUALITIES', tabId: activeTab?.id, key: video.key });
  if (!res?.ok) {
    titleEl.textContent = video.title || video.label || video.platform;
    listEl.innerHTML = '';
    showError(errEl, res?.error || 'Could not resolve this video.');
    return;
  }

  const title = video.title || res.title || `${video.platform}-video`;
  titleEl.textContent = title;
  nameInput.value = sanitizeName(title);
  listEl.innerHTML = '';

  res.qualities.forEach((q) => {
    const btn = document.createElement('button');
    btn.className = 'quality-item';
    const sub = q.kind === 'merge' ? 'video + audio · merged in browser'
      : q.kind === 'hls' ? 'HLS → MP4'
      : 'MP4';
    btn.innerHTML =
      `<span class="quality-item__label">${escapeHtml(q.label)}</span>` +
      `<span class="quality-item__sub">${sub}${q.size ? ' · ' + (q.size / 1048576).toFixed(0) + ' MB' : ''}</span>` +
      `<span class="quality-item__dl">Download</span>`;
    btn.addEventListener('click', () => startDownload(q, nameInput.value.trim() || sanitizeName(title), video));
    listEl.appendChild(btn);
  });
}

async function startDownload(quality, filename, video) {
  const errEl = document.getElementById('quality-error');
  errEl.classList.add('hidden');

  const res = await send({ type: 'START_DOWNLOAD', tabId: activeTab?.id, quality, filename, label: video.label });
  if (!res?.ok) {
    if (res?.reason === 'weekly_limit') {
      openPricingModal('You\'ve used your 3 free downloads this week — go unlimited to keep saving.');
    } else {
      showError(errEl, 'Could not start the download. Try again.');
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
  count.textContent = `${running} active${queued ? ` · ${queued} queued` : ''}`;

  list.innerHTML = '';
  items.forEach(i => list.appendChild(managerRow(i)));
}

function managerRow(item) {
  const row = document.createElement('div');
  row.className = 'dl-row';
  row.dataset.jobId = item.jobId;
  const name = jobLabels.get(item.jobId) || item.filename || 'download';
  const phase = phaseLabel(item);
  row.innerHTML =
    `<div class="dl-row__top">` +
      `<span class="dl-row__name">${escapeHtml(name)}</span>` +
      `<span class="dl-row__phase">${phase}</span>` +
    `</div>` +
    `<div class="dl-row__barwrap"><div class="dl-row__bar" style="width:${item.percent || 0}%"></div></div>` +
    `<div class="dl-row__foot">` +
      `<span class="dl-row__speed">${item.speed || ''}</span>` +
      (item.state === 'done' ? `<span class="dl-row__done">✓ Saved</span>`
        : item.state === 'error' || item.phase === 'error' ? `<span class="dl-row__err">Failed</span> <button class="dl-row__report" data-report>🚩 Report</button>`
        : item.state === 'cancelled' ? `<span class="dl-row__err">Cancelled</span>`
        : `<button class="dl-row__cancel" data-cancel="${item.jobId}">Cancel</button>`) +
    `</div>`;
  const cancel = row.querySelector('[data-cancel]');
  if (cancel) cancel.addEventListener('click', () => send({ type: 'CANCEL_JOB', jobId: item.jobId }));
  const report = row.querySelector('[data-report]');
  if (report) report.addEventListener('click', () => openReportModal(item.error || `Download failed: ${name}`));
  return row;
}

function phaseLabel(item) {
  if (item.state === 'queued') return 'Queued';
  if (item.state === 'cancelled') return 'Cancelled';
  switch (item.phase) {
    case 'merging': return 'Merging…';
    case 'saving': return 'Saving…';
    case 'done': return 'Done';
    case 'error': return 'Error';
    case 'starting': return 'Starting…';
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
  document.getElementById('buy-annual').href = CHECKOUT_ANNUAL;
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
    btn.disabled = true; btn.textContent = 'Verifying…';
    msg.textContent = ''; msg.className = 'msg';
    const result = await send({ type: 'ACTIVATE_LICENSE', licenseKey: key });
    if (result?.valid) {
      msg.textContent = 'License activated!'; msg.className = 'msg msg--success';
      setTimeout(initLicenseUI, 1000);
    } else {
      msg.textContent = 'Invalid or expired license key.'; msg.className = 'msg msg--error';
      btn.disabled = false; btn.textContent = 'Activate license';
    }
  });
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
  btn.textContent = '🚩 Report this error';
  btn.addEventListener('click', () => openReportModal(message));
  errEl.append(text, btn);
  errEl.classList.remove('hidden');
}

function openReportModal(errorText) {
  reportErrorContext = errorText || null;
  const modal = document.getElementById('report-modal');
  const ctx = document.getElementById('report-context');
  if (errorText) {
    ctx.textContent = 'Error being reported: ' + errorText;
    ctx.classList.remove('hidden');
  } else {
    ctx.classList.add('hidden');
  }
  document.getElementById('report-msg').textContent = '';
  const sendBtn = document.getElementById('report-send');
  sendBtn.disabled = false;
  sendBtn.textContent = 'Send report';
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
    sendBtn.textContent = 'Sending…';
    if (email) chrome.storage.local.set({ reportEmail: email }).catch(() => {});

    const res = await send({ type: 'REPORT_PROBLEM', tabId: activeTab?.id, note, email });
    if (res?.ok) {
      sendBtn.textContent = '✓ Sent — thank you!';
      msg.textContent = email ? "We'll email you when it's fixed." : '';
      msg.className = 'msg msg--success';
      setTimeout(() => modal.classList.add('hidden'), 1800);
      return;
    }
    sendBtn.textContent = 'Send report';
    sendBtn.disabled = false;
    try {
      await navigator.clipboard.writeText(
        'Skool Video Downloader problem report\n' + JSON.stringify(res?.payload ?? {}, null, 2)
      );
      msg.textContent = "Couldn't reach our server — report copied to your clipboard. Please paste it into an email to support@tailsgate.com.";
    } catch {
      msg.textContent = "Couldn't reach our server — please email support@tailsgate.com.";
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
