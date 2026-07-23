// Skool Video Downloader — service worker.
//
// Multi-platform detection: HLS masters (Skool-native Mux, Vimeo, Loom) are
// captured off the wire via webRequest; embed-based platforms (Vimeo/Loom/
// YouTube/Wistia) are reported by the content script from the page's iframes and
// Next.js props. The popup resolves qualities on demand, then hands a download
// job to the concurrent queue here, which fetches + remuxes to MP4 in-browser.

importScripts('detectors.js', 'buildConfig.js');

const WORKER_URL = 'https://skool-dl-license.aarohan567.workers.dev';

// Problem reports go to the shared tailsgate reports Worker (the same one the
// Whop downloader uses), tagged with a product field so they land in one admin
// dashboard. Primary is the tailsgate.com proxy (some ISPs/antivirus block
// *.workers.dev); the workers.dev URL is the fallback.
const REPORT_API_BASES = [
  'https://tailsgate.com/api/license',
  'https://whop-dl-license.aarohan567.workers.dev'
];

// ── Debug log ─────────────────────────────────────────────────────────────────
// Tiny rolling log of high-signal events (detections with their source scanner,
// registry clears, resolve/download failures). Deliberately sparse — it exists
// to make one-click problem reports diagnosable, not to trace every action.
// Persisted in storage.local so it survives service-worker restarts.
const DEBUG_LOG_MAX = 40;
async function svdLog(context, message) {
  try {
    const { debugLog = [] } = await chrome.storage.local.get('debugLog');
    debugLog.push({ ts: new Date().toISOString(), context, message: String(message).slice(0, 300) });
    await chrome.storage.local.set({ debugLog: debugLog.slice(-DEBUG_LOG_MAX) });
  } catch { /* logging must never break anything */ }
}

// Skool-native (Mux) masters carry a signed-playback JWT in ?token=. Decoding
// its `exp` costs nothing and turns an otherwise ambiguous 403 report into an
// answer: a stale token and a missing Referer header fail identically from the
// user's side, and only the expiry timestamp tells them apart.
function jwtExpFromUrl(url) {
  try {
    const token = new URL(url).searchParams.get('token');
    const payload = token && token.split('.')[1];
    if (!payload) return null;
    const { exp } = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return exp ? new Date(exp * 1000) : null;
  } catch { return null; }
}

// "exp 09:41Z (in 24m)" / "exp 09:41Z (EXPIRED 3m ago)" — relative to now, since
// what matters in a report is whether the token had already lapsed.
// Accepts a Date or the ISO string form, since the expiry rides along on the
// quality object through the popup and back (JSON, so Dates don't survive).
function describeExpiry(exp) {
  const d = exp instanceof Date ? exp : (exp ? new Date(exp) : null);
  if (!d || isNaN(d)) return null;
  const mins = Math.round((d - Date.now()) / 60000);
  const when = d.toISOString().slice(11, 16) + 'Z';
  return `exp ${when} (${mins >= 0 ? `in ${mins}m` : `EXPIRED ${-mins}m ago`})`;
}

// tabId -> { videos: Map(key -> videoEntry) }  captured streams / embeds per tab
const tabVideos = new Map();

// The registry must survive MV3 service-worker restarts: wire-captured native
// Skool videos exist ONLY here (nothing on the page for RESCAN to re-find), so
// losing the Map means an empty popup until a full page reload. Mirror it to
// storage.session — survives SW death, cleared on browser exit — and rehydrate
// before any registry read or write (every access path awaits registryReady).
let persistTimer = null;
function persistRegistry() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const snapshot = {};
    for (const [tabId, t] of tabVideos) snapshot[tabId] = [...t.videos.values()];
    chrome.storage.session.set({ videoRegistry: snapshot }).catch(() => {});
  }, 150);
}

const registryReady = (async () => {
  try {
    const { videoRegistry } = await chrome.storage.session.get('videoRegistry');
    if (!videoRegistry) return;
    const openTabs = new Set((await chrome.tabs.query({})).map(t => t.id));
    for (const [tabId, entries] of Object.entries(videoRegistry)) {
      const id = Number(tabId);
      if (!openTabs.has(id)) continue; // tab closed while the worker was dead
      if (entries.length) tabVideos.set(id, { videos: new Map(entries.map(e => [e.key, e])) });
    }
  } catch { /* cold start with an empty registry = pre-persistence behavior */ }
})();

// Global download queue. Runs one job at a time: several HLS jobs in parallel
// each fire their own batch of segment requests at the same video.skool.com
// Fastly edge, which is exactly the burst that rate-limits us (see the BATCH
// note in downloadRendition). Serialising costs nothing but wall-clock on a
// queue the user already expects to be a queue.
const MAX_CONCURRENT = 1;
const downloadQueue = [];        // pending job descriptors
const activeJobs = new Map();    // jobId -> { cancel, meta }
const finishedJobs = [];         // recently done/failed/cancelled, kept ~45s for the manager UI
let jobSeq = 0;

function recordFinished(meta, state) {
  finishedJobs.push({ ...meta, jobId: meta.jobId, state, finishedAt: Date.now() });
  const cutoff = Date.now() - 45000;
  while (finishedJobs.length && finishedJobs[0].finishedAt < cutoff) finishedJobs.shift();
  if (finishedJobs.length > 12) finishedJobs.splice(0, finishedJobs.length - 12);
}

// ── Video registry ───────────────────────────────────────────────────────────

function ensureTab(tabId) {
  if (!tabVideos.has(tabId)) tabVideos.set(tabId, { videos: new Map() });
  return tabVideos.get(tabId);
}

function addVideo(tabId, entry) {
  if (!tabId || tabId < 0 || !entry?.key) return;
  const t = ensureTab(tabId);
  if (!t.videos.has(entry.key)) {
    t.videos.set(entry.key, { ...entry, tabId, ts: Date.now() });
    // src names the scanner that produced the detection (dom-iframe/json-md/
    // json-text from the content script, wire for webRequest captures) — the
    // first thing to look at when a report says a phantom video was listed.
    const expiry = describeExpiry(jwtExpFromUrl(entry.url || ''));
    svdLog('detect', `+${entry.platform} via ${entry.src || 'wire'} (${entry.key.slice(0, 80)})${expiry ? ` ${expiry}` : ''}`);
  } else {
    // Merge — a later webRequest capture may carry headers a page-props entry lacked.
    Object.assign(t.videos.get(entry.key), entry);
  }
  persistRegistry();
  chrome.tabs.sendMessage(tabId, { type: 'VIDEO_DETECTED' }).catch(() => {});
}

function listVideos(tabId) {
  const t = tabVideos.get(tabId);
  return t ? [...t.videos.values()].sort((a, b) => a.ts - b.ts) : [];
}

// ── HLS capture (Skool-native Mux + any embedded HLS master) ──────────────────
// Master playlists carry a query token; media/rendition playlists don't. We only
// register masters so the picker shows real resolutions, not rendition fragments.
try {
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      try {
        const url = details.url;
        if (!url.includes('.m3u8')) return;
        const isMaster = url.includes('?token=') || url.includes('/playlist') || /master/i.test(url);
        if (!isMaster) return;

        const headers = {};
        for (const h of details.requestHeaders || []) {
          const n = h.name.toLowerCase();
          if (n === 'referer' || n === 'origin') headers[h.name] = h.value;
        }

        // Skool-native = Mux, served either from stream.mux.com (legacy) or
        // Skool's Mux custom domain stream.video.skool.com (current). Rendition
        // playlists live on *.fastly.video.skool.com but carry ?signature= (no
        // ?token=), so the master gate above already excludes them.
        const platform = /mux\.com|video\.skool\.com/.test(url) ? 'skool'
          : /vimeo/.test(url) ? 'vimeo'
          : /loom/.test(url) ? 'loom'
          : 'hls';

        registryReady.then(() => addVideo(details.tabId, {
          key: `hls:${url}`,
          platform,
          label: PLATFORM_LABELS[platform] || 'Video',
          url,
          headers,
          title: null
        }));
      } catch {}
    },
    { urls: ['*://*.mux.com/*', '*://*.video.skool.com/*', '*://*.vimeo.com/*', '*://*.vimeocdn.com/*', '*://*.akamaized.net/*', '*://*.loom.com/*'] },
    ['requestHeaders']
  );
} catch {}

chrome.tabs.onRemoved.addListener((tabId) => {
  tabVideos.delete(tabId);
  persistRegistry();
  for (const [jobId, job] of activeJobs) {
    if (job.meta.tabId === tabId) { job.cancel(); activeJobs.delete(jobId); }
  }
});

function clearTab(tabId, reason, path) {
  if (!tabId) return;
  const had = tabVideos.get(tabId)?.videos.size || 0;
  tabVideos.delete(tabId);
  persistRegistry();
  if (had) svdLog('clear', `${reason || 'clear'} dropped ${had} video(s) → ${String(path || '').slice(0, 120)}`);
}

// ── Keep-alive + license revalidation ─────────────────────────────────────────
// 0.5 is Chrome's alarm floor (shorter periods get clamped to 30s anyway).
// Best-effort only — the SW can still die between firings, which is why the
// video registry is mirrored to storage.session above.
chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });
chrome.alarms.create('revalidate', { periodInMinutes: 60 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'keepAlive') chrome.runtime.getPlatformInfo();
  if (a.name === 'revalidate') {
    revalidateLicenseIfStale();
    getVersionStatus().catch(() => {}); // self-throttles to every 12h
  }
});

chrome.runtime.onInstalled.addListener((details) => {
  purgeBlobCache();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
});
chrome.runtime.onStartup.addListener(purgeBlobCache);

// Named here rather than beside putBlobs because purgeBlobCache runs at load
// time (onInstalled/onStartup), before a const declared further down would be
// initialised.
const BLOB_CACHE = 'video-blobs';
async function purgeBlobCache() { try { await caches.delete(BLOB_CACHE); } catch {} }

(async () => {
  try {
    const installId = await getInstallId();
    const v = chrome.runtime.getManifest().version;
    chrome.runtime.setUninstallURL(`https://skoolvideodownload.com/skool-video-downloader/uninstall?v=${v}&id=${encodeURIComponent(installId)}`);
  } catch {}
})();

// ── Licensing (5 free downloads per rolling 7-day window, then Pro) ────────────
const FREE_WEEKLY_LIMIT = 5;

// Returns an ISO date (YYYY-MM-DD) `days` days from today.
function dateInDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function getInstallId() {
  const { installId } = await chrome.storage.local.get('installId');
  if (installId) return installId;
  const id = 'inst_' + crypto.randomUUID();
  await chrome.storage.local.set({ installId: id });
  return id;
}

async function canDownload() {
  const { tier, freeWeeklyCount, freeWeekResetDate } = await chrome.storage.local.get(['tier', 'freeWeeklyCount', 'freeWeekResetDate']);
  if (tier === 'lifetime' || tier === 'monthly') return { allowed: true, remaining: 'unlimited', tier };

  // Free tier — 5 downloads per rolling 7-day window (reset when the window elapses).
  const today = new Date().toISOString().slice(0, 10);
  let count = freeWeeklyCount || 0;
  if (!freeWeekResetDate || today >= freeWeekResetDate) {
    count = 0;
    await chrome.storage.local.set({ freeWeeklyCount: 0, freeWeekResetDate: dateInDays(7) });
  }
  const remaining = Math.max(0, FREE_WEEKLY_LIMIT - count);
  return { allowed: remaining > 0, remaining, reason: remaining <= 0 ? 'weekly_limit' : null, tier: null };
}

async function decrementCredit() {
  const { tier, freeWeeklyCount } = await chrome.storage.local.get(['tier', 'freeWeeklyCount']);
  if (tier === 'lifetime' || tier === 'monthly') return;
  await chrome.storage.local.set({ freeWeeklyCount: (freeWeeklyCount || 0) + 1 });
}

async function getLicenseStatus() {
  const { tier, freeWeeklyCount, freeWeekResetDate, licenseKey } = await chrome.storage.local.get(['tier', 'freeWeeklyCount', 'freeWeekResetDate', 'licenseKey']);
  if (tier === 'lifetime' || tier === 'monthly') return { tier, remaining: 'unlimited', licenseKey };
  const today = new Date().toISOString().slice(0, 10);
  const expired = !freeWeekResetDate || today >= freeWeekResetDate;
  const count = expired ? 0 : (freeWeeklyCount || 0);
  return { tier: null, remaining: Math.max(0, FREE_WEEKLY_LIMIT - count), limit: FREE_WEEKLY_LIMIT, resetDate: expired ? null : freeWeekResetDate };
}

async function activateLicense(licenseKey) {
  try {
    const installId = await getInstallId();
    const res = await fetch(`${WORKER_URL}/activate-license`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey, installId })
    });
    const result = await res.json();
    if (result.valid) {
      const store = { licenseKey, licenseValidatedAt: Date.now() };
      if (result.tier) store.tier = result.tier;
      await chrome.storage.local.set(store);
    }
    return result;
  } catch {
    return { valid: false, error: 'network_error' };
  }
}

async function revalidateLicenseIfStale() {
  const { licenseKey, tier, licenseValidatedAt } = await chrome.storage.local.get(['licenseKey', 'tier', 'licenseValidatedAt']);
  // A paid tier with no license key never came from activateLicense — it was
  // hand-set in storage. Drop it so a paid tier only persists alongside a key
  // that keeps passing server revalidation.
  if (!licenseKey) {
    if (tier === 'lifetime' || tier === 'monthly') await chrome.storage.local.remove(['tier', 'licenseValidatedAt']);
    return;
  }
  if (!tier) return;
  if (Date.now() - (licenseValidatedAt || 0) < 24 * 60 * 60 * 1000) return;
  try {
    const installId = await getInstallId();
    const res = await fetch(`${WORKER_URL}/validate-license`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey, installId })
    });
    const result = await res.json();
    if (!result.valid) await chrome.storage.local.remove(['licenseKey', 'tier', 'licenseValidatedAt']);
    else await chrome.storage.local.set({ licenseValidatedAt: Date.now() });
  } catch {}
}

// ── Update check ──────────────────────────────────────────────────────────────
// Anonymous GET (no install id, no identifiers) against the shared Worker's
// /version endpoint, at most every 12h. The popup shows a slim dismissible
// banner when THIS distribution channel (cws vs full/GitHub) is behind — the
// two channels ship on different schedules, so each compares to its own latest.
const VERSION_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

// Numeric dotted-version compare: >0 when a is newer than b.
function cmpVersions(a, b) {
  const pa = String(a).split('.'), pb = String(b).split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d) return d;
  }
  return 0;
}

async function getVersionStatus() {
  const channel = (self.SVD_CONFIG && self.SVD_CONFIG.CHANNEL) === 'full' ? 'full' : 'cws';
  const current = chrome.runtime.getManifest().version;
  let { versionInfo, versionCheckedAt } = await chrome.storage.local.get(['versionInfo', 'versionCheckedAt']);

  if (!versionInfo || Date.now() - (versionCheckedAt || 0) > VERSION_CHECK_INTERVAL_MS) {
    for (const base of REPORT_API_BASES) {
      try {
        const res = await fetch(`${base}/version?product=skool-video-downloader`, { cache: 'no-store' });
        if (!res.ok) continue;
        const info = await res.json();
        if (info && (info.latestCws || info.latestFull)) {
          versionInfo = info;
          await chrome.storage.local.set({ versionInfo: info, versionCheckedAt: Date.now() });
        }
        break;
      } catch { /* try next base; a failed check just means no banner */ }
    }
  }

  const latest = versionInfo ? (channel === 'full' ? versionInfo.latestFull : versionInfo.latestCws) : null;
  return {
    current,
    channel,
    latest: latest || null,
    updateAvailable: !!(latest && cmpVersions(latest, current) > 0),
    url: versionInfo?.url || 'https://skoolvideodownload.com/skool-video-downloader/updates',
    message: versionInfo?.message || null
  };
}

// ── Problem reports ───────────────────────────────────────────────────────────
// Collect diagnostics (version, tier, currently detected videos with their
// scanner source, recent debug log) and POST them to the shared reports Worker.
// Always returns the payload too, so the popup can fall back to copy-for-email
// when the network path is blocked.
async function sendErrorReport(note, email, tabId) {
  await registryReady; // 'detected' must reflect the restored registry, not a cold Map
  const { debugLog = [] } = await chrome.storage.local.get('debugLog');
  const [license, installId] = await Promise.all([
    getLicenseStatus().catch(() => null),
    getInstallId().catch(() => undefined),
  ]);
  const detected = listVideos(tabId)
    .map(v => `${v.platform}/${v.src || 'wire'}${v.title ? `:${v.title.slice(0, 40)}` : ''}`)
    .slice(0, 8);
  const payload = {
    product: 'skool-video-downloader',
    note: typeof note === 'string' ? note.slice(0, 500) : undefined,
    email: typeof email === 'string' && email.includes('@') ? email.slice(0, 120) : undefined,
    version: chrome.runtime.getManifest().version,
    ua: navigator.userAgent,
    // Free tier: fold the weekly-allowance state into the tier string so the
    // report worker shows it without needing a new column/redeploy.
    tier: license?.tier
      || (Number.isFinite(license?.remaining) ? `free (${license.remaining}/${license.limit} left)` : 'free'),
    detected: detected.length ? detected.join(', ').slice(0, 300) : 'none',
    installId,
    log: debugLog.slice(-10),
  };
  for (const base of REPORT_API_BASES) {
    try {
      const res = await fetch(`${base}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      if (data?.ok) return { ok: true, payload };
    } catch { /* try next base */ }
  }
  return { ok: false, payload };
}

// ── Offscreen ffmpeg.wasm merge engine ────────────────────────────────────────
// The offscreen document holds a single in-flight job (one currentJob, one
// ffmpeg instance), so concurrent downloads must NOT use it simultaneously — a
// second merge/save would clobber the first's blob URL. We serialize every
// offscreen-using critical section behind this promise-chain mutex. Downloading
// segments (the slow part) still runs fully in parallel; only the final
// merge/save step queues, which is brief.
let offscreenLock = Promise.resolve();
function withOffscreen(fn) {
  const run = offscreenLock.then(fn, fn);
  // Keep the chain alive even if fn throws, without swallowing the error.
  offscreenLock = run.then(() => {}, () => {});
  return run;
}

const OFFSCREEN_URL = 'lib/ffmpeg-bundle/offscreen.html';
let offscreenCreating = null;

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL, reasons: ['WORKERS', 'BLOBS'],
      justification: 'Merge downloaded video and audio tracks into one MP4 with ffmpeg.wasm'
    }).finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
  for (let i = 0; i < 20; i++) {
    const pong = await sendToOffscreen({ type: 'MERGE_PING' });
    if (pong?.ready) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Merge engine failed to start');
}

async function closeOffscreenDocument() {
  if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument().catch(() => {});
}

function sendToOffscreen(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) =>
      resolve(chrome.runtime.lastError ? { success: false, error: chrome.runtime.lastError.message } : res));
  });
}

// ── DNR header rules (re-attach Referer/Origin for token-gated CDNs) ──────────
// Rule IDs must be unique per *concurrent holder*, not per tab. Downloads used
// to key off tabId, which was safe only while one download could exist per tab;
// once the queue could run several, two jobs in one tab shared an ID and the
// first to finish removed the rule out from under the other — its next segment
// went out with no Referer and the CDN 403'd it mid-download. Jobs key off the
// unique jobId now; resolution keeps its own range so a picker opened during a
// download can't clobber the running job either.
const RULE_RANGE_RESOLVE = 900000;   // 900000–989999
const RULE_RANGE_DOWNLOAD = 1000000; // 1000000–1099999
const downloadRuleId = (jobId) => RULE_RANGE_DOWNLOAD + (jobId % 100000);
const resolveRuleId = (tabId) =>
  RULE_RANGE_RESOLVE + (tabId > 0 ? tabId % 90000 : Math.floor(Math.random() * 90000));

async function applyHeaderRules(ruleId, sampleUrl, headers) {
  if (!headers || (!headers.Referer && !headers.Origin)) return false;
  const domain = new URL(sampleUrl).hostname;
  // Skool native spreads one video across sibling hosts (master on
  // stream.video.skool.com, renditions/segments on *-vop*.fastly.video.skool.com),
  // so match the whole video.skool.com family, not just the sample's hostname.
  const urlFilter = /(^|\.)video\.skool\.com$/.test(domain) ? '||video.skool.com^' : `*://${domain}/*`;
  const requestHeaders = [];
  if (headers.Referer) requestHeaders.push({ header: 'Referer', operation: 'set', value: headers.Referer });
  if (headers.Origin) requestHeaders.push({ header: 'Origin', operation: 'set', value: headers.Origin });
  const rule = {
    id: ruleId, priority: 1, action: { type: 'modifyHeaders', requestHeaders },
    condition: { urlFilter, resourceTypes: ['xmlhttprequest', 'other'], initiatorDomains: [chrome.runtime.id] }
  };
  try { await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId], addRules: [rule] }); return true; } catch { return false; }
}
async function removeHeaderRules(ruleId) {
  try { await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] }); } catch {}
}

// ── HLS rendition download ────────────────────────────────────────────────────
function resolvePlaylistUrl(url, baseUrl, parentQuery) {
  const abs = url.startsWith('http')
    ? url
    : (url.startsWith('/') ? new URL(baseUrl).origin + url : new URL(url, baseUrl).href);
  // CDN-signed HLS (Loom) keeps the CloudFront signature as a query string on
  // the playlist URL; relative segment/map URIs inherit it. Only apply it to
  // children with no query of their own (Mux/Skool segments carry own tokens).
  if (parentQuery && !abs.includes('?')) return `${abs}?${parentQuery}`;
  return abs;
}

// Mux/Fastly (stream.video.skool.com) rate-limits bursts of concurrent segment
// requests with 429/503; those are "slow down," not permanent failures, so
// retry with backoff (honoring Retry-After if the CDN sends one) instead of
// letting one throttled segment kill the whole download.
//
// The same goes for the rest of the transient CDN family — Loom's CloudFront
// front-end returns 504 (and occasionally 500/502) when its origin is slow on
// a cold segment. Treating those as fatal throws away every segment already
// downloaded over one blip, so they retry too. 4xx other than 408/429 stay
// fatal: those mean expired signature or wrong URL, and retrying can't help.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

async function fetchWithRetry(url, { maxRetries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await fetch(url);
    } catch (e) {
      // A dropped connection mid-download rejects rather than returning a
      // response; it's just as transient as a 504, so give it the same budget.
      if (attempt >= maxRetries) throw e;
      await backoff(attempt);
      continue;
    }
    if (r.ok || attempt >= maxRetries || !RETRYABLE_STATUS.has(r.status)) return r;
    await backoff(attempt, parseFloat(r.headers.get('Retry-After')));
  }
}

function backoff(attempt, retryAfterSec) {
  const delay = Number.isFinite(retryAfterSec)
    ? retryAfterSec * 1000
    : Math.min(500 * 2 ** attempt, 8000) + Math.random() * 300;
  return new Promise(resolve => setTimeout(resolve, delay));
}

// Reaching here means fetchWithRetry already spent its whole backoff budget, so
// a 429 isn't a blip — the CDN is throttling this IP hard, usually after several
// downloads back to back. "HTTP 429" told the user nothing actionable; waiting
// is the actual fix, so say that. Expired signatures (403) are the other status
// that shows up in reports and have their own fix: reload and press play again.
function segmentFailureMessage(status) {
  if (status === 429 || status === 503) {
    return 'Skool\'s video server is rate-limiting this connection. Wait a few minutes and start the download again — the part already downloaded isn\'t kept, so it will restart from the beginning.';
  }
  if (status === 403 || status === 401) {
    return 'The video link expired mid-download. Reload the lesson page, press play, and download again.';
  }
  return `Segment fetch failed: HTTP ${status}`;
}

async function downloadRendition(playlistUrl, { onProgress, isCancelled, mimeType }) {
  const res = await fetchWithRetry(playlistUrl);
  if (!res.ok) throw new Error(segmentFailureMessage(res.status));
  const text = await res.text();
  const baseUrl = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);
  const parentQuery = (playlistUrl.split('?')[1] || '');

  const blobs = [];
  const mapMatch = text.match(/#EXT-X-MAP:URI="([^"]+)"/);
  if (mapMatch) {
    const r = await fetchWithRetry(resolvePlaylistUrl(mapMatch[1], baseUrl, parentQuery));
    if (!r.ok) throw new Error(segmentFailureMessage(r.status));
    blobs.push(await r.blob());
  }

  const segments = [];
  for (let line of text.split('\n')) {
    line = line.trim();
    if (line && !line.startsWith('#')) segments.push(resolvePlaylistUrl(line, baseUrl, parentQuery));
  }
  if (!segments.length) throw new Error('No segments in playlist');

  // Smaller than the old BATCH=20 — a burst that size is what triggered the
  // CDN's rate limit in the first place.
  const BATCH = 10;
  let bytes = blobs.reduce((n, b) => n + b.size, 0);
  for (let i = 0; i < segments.length; i += BATCH) {
    if (isCancelled?.()) throw new Error('Cancelled');
    const batch = segments.slice(i, i + BATCH);
    const parts = await Promise.all(batch.map(u => fetchWithRetry(u).then(r => {
      if (!r.ok) throw new Error(segmentFailureMessage(r.status));
      return r.blob();
    })));
    blobs.push(...parts);
    bytes += parts.reduce((n, b) => n + b.size, 0);
    onProgress?.(Math.min(i + batch.length, segments.length), segments.length, bytes);
  }
  return new Blob(blobs, { type: mimeType || 'video/mp4' });
}

// Direct progressive download (Vimeo/Wistia/Loom/YouTube muxed MP4) with byte
// progress from the streamed response body.
async function downloadDirect(url, { onProgress, isCancelled, mimeType }) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`File fetch failed: ${res.status}`);
  const total = parseInt(res.headers.get('content-length') || '0', 10);
  if (!res.body) return await res.blob();
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    if (isCancelled?.()) throw new Error('Cancelled');
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(received, total || received, received);
  }
  return new Blob(chunks, { type: mimeType || 'video/mp4' });
}

// ── Blob handoff to the offscreen document ────────────────────────────────────
//
// The finished video crosses into the offscreen document through CacheStorage,
// which means every save is a multi-hundred-megabyte disk write. When that
// write can't land, Chrome does NOT throw the spec'd QuotaExceededError — it
// throws "Failed to execute 'put' on 'Cache': Unexpected internal error", which
// is what users were reporting. Two things cause it:
//
//   1. Orphaned entries. A cancelled job, a crashed service worker, or a merge
//      that threw leaves its blobs behind; purgeBlobCache only runs on install
//      and browser startup, so a browser left open for days accumulates them
//      until the origin's share of the quota is gone.
//   2. A genuinely full disk.
//
// Purge-and-retry-once clears (1) — it's safe because offscreenLock serialises
// every caller, so no other job has live entries here. If the retry also fails
// it's (2), and the user needs to hear about disk space, not Chrome internals.
async function putBlobs(entries) {
  let cache = await caches.open(BLOB_CACHE);
  try {
    await Promise.all(entries.map(([key, blob]) => cache.put(key, new Response(blob))));
    return cache;
  } catch (first) {
    await purgeBlobCache();
    cache = await caches.open(BLOB_CACHE);
    try {
      await Promise.all(entries.map(([key, blob]) => cache.put(key, new Response(blob))));
      return cache;
    } catch (second) {
      const err = new Error(await outOfSpaceMessage(entries));
      err.cause = second;
      svdLog('cache', `blob put failed after purge: ${first?.message || first}`);
      throw err;
    }
  }
}

async function outOfSpaceMessage(entries) {
  const needed = entries.reduce((n, [, blob]) => n + blob.size, 0);
  let detail = '';
  try {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    const free = Math.max(0, quota - usage);
    detail = ` It needs about ${formatGB(needed)} of free space and Chrome currently has ${formatGB(free)} available.`;
  } catch { /* estimate() is best-effort; the advice below stands without it */ }
  return `Couldn't save the video — your disk is out of space.${detail} Free up some room and download again.`;
}

function formatGB(bytes) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

// ── Blob saving via offscreen anchor ──────────────────────────────────────────
function saveBlob(blob, filename) {
  return withOffscreen(async () => {
    const key = `https://skool-merge.local/save/${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const cache = await putBlobs([[key, blob]]);
    try {
      await ensureOffscreenDocument();
      const result = await sendToOffscreen({ type: 'CREATE_BLOB_URL', key });
      if (!result?.success) throw new Error(result?.error || 'Failed to prepare file');
      const downloadId = await saveViaOffscreenAnchor(filename);
      const { state, error } = await waitForDownloadEnd(downloadId);
      if (state !== 'complete') throw new Error(saveFailureMessage(state, error));
    } finally {
      await cache.delete(key);
      await sendToOffscreen({ type: 'MERGE_CLEANUP' });
      await closeOffscreenDocument();
    }
  });
}

function saveViaOffscreenAnchor(filename) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => { if (done) return; done = true; chrome.downloads.onCreated.removeListener(onCreated); clearTimeout(timer); fn(arg); };
    const onCreated = (item) => {
      if (item.byExtensionId && item.byExtensionId !== chrome.runtime.id) return;
      finish(resolve, item.id);
    };
    const timer = setTimeout(() => finish(reject, new Error('Save did not start')), 8000);
    chrome.downloads.onCreated.addListener(onCreated);
    sendToOffscreen({ type: 'SAVE_CLICK', filename }).then((res) => {
      if (!res?.success) finish(reject, new Error(res?.error || 'Save failed'));
    });
  });
}

function waitForDownloadEnd(downloadId, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve) => {
    let reason = null;
    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.error?.current) reason = delta.error.current;
      if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
        chrome.downloads.onChanged.removeListener(onChanged);
        clearTimeout(timer);
        resolve({ state: delta.state.current, error: reason });
      }
    };
    const timer = setTimeout(() => { chrome.downloads.onChanged.removeListener(onChanged); resolve({ state: 'timeout', error: reason }); }, timeoutMs);
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

const DOWNLOAD_MANAGER_HINT =
  'Could not save the file. A download manager (e.g. Free Download Manager or IDM) may be intercepting downloads — turn off its browser integration, then try again.';
function saveFailureMessage(state, error) {
  const detail = error || (state === 'timeout' ? 'timed out' : state);
  return `${DOWNLOAD_MANAGER_HINT}${detail ? ` [${detail}]` : ''}`;
}

// ── Offscreen merge of two blobs ──────────────────────────────────────────────
// ffmpeg-core.wasm declares +simd128 as a *required* target feature, so an
// engine without Wasm SIMD rejects the whole module at compile time — the merge
// can never succeed on that machine, no matter the video. V8 only enables SIMD
// on x86 when the CPU reports SSE4.1, so this trips on pre-2008 Intel/pre-2011
// AMD and, more often, on VMs and remote desktops whose hypervisor masks the
// CPU feature bits. Detect it up front instead of downloading the whole video
// and dying at 82% with a raw emscripten abort.
// The module below is a minimal valid one whose body is `v128.const 0; i8x16.popcnt`.
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

// Whether a quality has to be merged to produce one playable file.
function needsMerge(quality) {
  return quality.kind === 'merge' || (quality.kind === 'hls' && !!quality.audioUrl);
}

// Deliberately plain-English and action-shaped: the user who hits this can't fix
// their CPU, so the message's only job is to point them at the buttons that work.
const NO_SIMD_MESSAGE =
  "This computer can't merge video and audio in the browser — its processor is missing an " +
  'instruction set Chrome needs (common on older CPUs and on virtual machines). ' +
  'Use the free “Video only” and “Audio only” buttons instead — they always work.';

const MERGE_TIMEOUT_MS = 5 * 60 * 1000;
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function mergeAndSave(videoBlob, audioBlob, filename, tabId) {
  return withOffscreen(async () => {
    const jobId = Date.now();
    const videoKey = `https://skool-merge.local/${jobId}/video`;
    const audioKey = `https://skool-merge.local/${jobId}/audio`;
    const cache = await putBlobs([[videoKey, videoBlob], [audioKey, audioBlob]]);
    try {
      await ensureOffscreenDocument();
      const result = await withTimeout(
        sendToOffscreen({ type: 'MERGE_AV', videoKey, audioKey, tabId }),
        MERGE_TIMEOUT_MS,
        'Merge timed out — this video may be too large for the in-browser merger.'
      );
      if (!result?.success) throw new Error(result?.error || 'Merge failed');
      const downloadId = await saveViaOffscreenAnchor(`${filename}.mp4`);
      const { state, error } = await waitForDownloadEnd(downloadId);
      if (state !== 'complete') throw new Error(saveFailureMessage(state, error));
    } finally {
      await Promise.all([cache.delete(videoKey), cache.delete(audioKey)]).catch(() => {});
      await sendToOffscreen({ type: 'MERGE_CLEANUP' }).catch(() => {});
      await closeOffscreenDocument();
    }
  });
}

// ── Download queue ─────────────────────────────────────────────────────────────
// Each job: { jobId, quality, filename, tabId, platform }. Up to MAX_CONCURRENT
// run at once; others wait. The popup renders a manager panel from queue state.

function broadcast(msg) { chrome.runtime.sendMessage(msg).catch(() => {}); }

function queueSnapshot() {
  const items = [];
  for (const [jobId, job] of activeJobs) items.push({ jobId, ...job.meta, state: 'running' });
  for (const q of downloadQueue) items.push({ jobId: q.jobId, ...q.meta, state: 'queued' });
  const cutoff = Date.now() - 45000;
  for (const f of finishedJobs) if (f.finishedAt >= cutoff) items.push(f);
  return items.sort((a, b) => a.jobId - b.jobId);
}

function updateJob(jobId, patch) {
  const job = activeJobs.get(jobId);
  if (job) Object.assign(job.meta, patch);
  broadcast({ type: 'QUEUE_UPDATE', jobId, patch });
}

// mode: undefined = normal combined download (merged, costs a credit);
// 'video' | 'audio' = single-rendition free download (no merge, no credit).
function enqueueDownload({ quality, filename, tabId, platform, label, mode }) {
  const jobId = ++jobSeq;
  const meta = { filename, platform, label, mode, percent: 0, phase: 'queued', speed: '' };
  downloadQueue.push({ jobId, quality, filename, tabId, mode, meta });
  broadcast({ type: 'QUEUE_ADD', item: { jobId, ...meta, state: 'queued' } });
  pump();
  return jobId;
}

function pump() {
  while (activeJobs.size < MAX_CONCURRENT && downloadQueue.length) {
    const next = downloadQueue.shift();
    runJob(next);
  }
}

async function runJob({ jobId, quality, filename, tabId, mode }) {
  const cancelled = [false];
  const meta = { jobId, filename, platform: quality.platform, mode, percent: 0, phase: 'starting', speed: '' };
  activeJobs.set(jobId, { cancel: () => { cancelled[0] = true; }, meta });
  const isCancelled = () => cancelled[0];

  // Speed tracker.
  let lastBytes = 0, lastTs = Date.now();
  const speedFrom = (bytes) => {
    const now = Date.now();
    const dt = (now - lastTs) / 1000;
    if (dt >= 0.5) {
      const bps = (bytes - lastBytes) / dt;
      lastBytes = bytes; lastTs = now;
      meta.speed = bps > 0 ? `${(bps / (1024 * 1024)).toFixed(1)} MB/s` : '';
    }
  };
  const setPct = (pct, phase, bytes) => {
    meta.percent = Math.min(100, Math.max(meta.percent, Math.round(pct)));
    if (phase) meta.phase = phase;
    if (bytes != null) speedFrom(bytes);
    updateJob(jobId, { percent: meta.percent, phase: meta.phase, speed: meta.speed });
  };

  let ruleId = null;
  try {
    updateJob(jobId, { phase: 'downloading' });

    // Bail before spending bandwidth on a merge this machine can't perform.
    if (!mode && needsMerge(quality) && !wasmSimdSupported()) throw new Error(NO_SIMD_MESSAGE);

    // Re-attach Referer/Origin for token-gated HLS/CDN fetches. The rule's URL
    // filter is derived from the sample URL's host, so it has to be a URL this
    // job will actually fetch — an audio-only job on a merge-kind quality can
    // have its audio on a different host than the video, and scoping the rule
    // to videoUrl there would leave the real fetch unauthenticated (403).
    if (quality.headers && (quality.headers.Referer || quality.headers.Origin)) {
      ruleId = downloadRuleId(jobId);
      await applyHeaderRules(ruleId, (mode === 'audio' && quality.audioUrl) || quality.videoUrl, quality.headers);
    }

    // Free single-track path: fetch only the requested rendition and save it as
    // is. Never touches ffmpeg, so it works on CPUs without Wasm SIMD and on
    // videos too long for the in-browser merger. HLS renditions are playlists
    // (segment-by-segment); merge-kind ones are plain files.
    if (mode === 'video' || mode === 'audio') {
      const url = mode === 'audio' ? quality.audioUrl : quality.videoUrl;
      if (!url) {
        throw new Error(mode === 'audio'
          ? "This video's audio is inside the video file — use “Video only”, it already has sound."
          : 'No separate video track for this quality.');
      }
      const fetchOne = quality.kind === 'hls' ? downloadRendition : downloadDirect;
      const blob = await fetchOne(url, {
        isCancelled, mimeType: mode === 'audio' ? 'audio/mp4' : 'video/mp4',
        onProgress: (d, t, b) => setPct(t ? (d / t) * 95 : 50, 'downloading', b)
      });
      if (isCancelled()) throw new Error('Cancelled');
      setPct(97, 'saving');
      await saveBlob(blob, mode === 'audio' ? `${filename}.m4a` : `${filename}.mp4`);

    } else if (quality.kind === 'mp4') {
      const blob = await downloadDirect(quality.videoUrl, {
        isCancelled, mimeType: 'video/mp4',
        onProgress: (done, total, bytes) => setPct(total ? (done / total) * 95 : 50, 'downloading', bytes)
      });
      setPct(97, 'saving');
      await saveBlob(blob, `${filename}.mp4`);

    } else if (quality.kind === 'hls') {
      const videoBlob = await downloadRendition(quality.videoUrl, {
        isCancelled, mimeType: 'video/mp4',
        onProgress: (d, t, b) => setPct(quality.audioUrl ? (d / t) * 55 : (d / t) * 92, 'downloading', b)
      });
      if (!quality.audioUrl) {
        setPct(96, 'saving');
        await saveBlob(videoBlob, `${filename}.mp4`);
      } else {
        const audioBlob = await downloadRendition(quality.audioUrl, {
          isCancelled, mimeType: 'audio/mp4',
          onProgress: (d, t, b) => setPct(55 + (d / t) * 25, 'downloading', b)
        });
        if (isCancelled()) throw new Error('Cancelled');
        setPct(82, 'merging');
        await mergeAndSave(videoBlob, audioBlob, filename, tabId);
      }

    } else if (quality.kind === 'merge') {
      const videoBlob = await downloadDirect(quality.videoUrl, {
        isCancelled, mimeType: 'video/mp4',
        onProgress: (d, t, b) => setPct(t ? (d / t) * 55 : 40, 'downloading', b)
      });
      const audioBlob = await downloadDirect(quality.audioUrl, {
        isCancelled, mimeType: 'audio/mp4',
        onProgress: (d, t, b) => setPct(t ? 55 + (d / t) * 25 : 70, 'downloading', b)
      });
      if (isCancelled()) throw new Error('Cancelled');
      setPct(82, 'merging');
      await mergeAndSave(videoBlob, audioBlob, filename, tabId);
    }

    meta.percent = 100; meta.phase = 'done'; meta.speed = '';
    updateJob(jobId, { percent: 100, phase: 'done', speed: '' });
    // Video-only / audio-only are free forever — they never spend a credit.
    if (!mode) await decrementCredit();
    recordFinished(meta, 'done');
    broadcast({ type: 'QUEUE_DONE', jobId });

  } catch (e) {
    if (e.message === 'Cancelled') {
      recordFinished({ ...meta, phase: 'cancelled' }, 'cancelled');
      broadcast({ type: 'QUEUE_CANCELLED', jobId });
    } else {
      meta.phase = 'error'; meta.error = e.message;
      const expiry = describeExpiry(quality.tokenExp);
      svdLog('download', `${quality.platform || 'video'} "${String(filename).slice(0, 60)}": ${e.message}`
        + ` @${meta.percent}%${expiry ? ` ${expiry}` : ''}`);
      recordFinished(meta, 'error');
      updateJob(jobId, { phase: 'error', error: e.message });
      broadcast({ type: 'QUEUE_ERROR', jobId, error: e.message });
    }
  } finally {
    if (ruleId != null) await removeHeaderRules(ruleId);
    activeJobs.delete(jobId);
    pump();
  }
}

function cancelJob(jobId) {
  const active = activeJobs.get(jobId);
  if (active) { active.cancel(); return; }
  const idx = downloadQueue.findIndex(q => q.jobId === jobId);
  if (idx >= 0) { downloadQueue.splice(idx, 1); broadcast({ type: 'QUEUE_CANCELLED', jobId }); }
}

// ── Message router ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  const tabId = req.tabId || sender?.tab?.id || null;

  switch (req.type) {
    case 'CLEAR_TAB':
      // Content script signals a fresh full page load OR an SPA route change —
      // drop the prior page's captured videos so stale entries don't linger
      // across lesson navigation (the "phantom sibling-lesson video" bug).
      // Awaits rehydration so the clear lands on (and re-persists over) the
      // restored registry rather than being overwritten by it.
      registryReady.then(() => { clearTab(tabId, req.reason, req.path); sendResponse({ ok: true }); });
      return true;

    case 'REGISTER_VIDEOS':
      // Content script reports embeds it found (Vimeo/Loom/YouTube/Wistia/etc).
      registryReady.then(() => { (req.videos || []).forEach(v => addVideo(tabId, v)); sendResponse({ ok: true }); });
      return true;

    case 'GET_VIDEOS':
      registryReady.then(() => sendResponse({ videos: listVideos(tabId) }));
      return true;

    case 'RESOLVE_QUALITIES':
      (async () => {
        await registryReady;
        const video = listVideos(tabId).find(v => v.key === req.key);
        if (!video) { sendResponse({ ok: false, error: 'Video no longer detected — replay it and reopen.' }); return; }

        // Domain-restricted Vimeo (very common on Skool) and some Loom/Wistia
        // embeds validate the Referer on the resolution fetch. A service-worker
        // fetch sends none, so inject the Skool page URL as Referer via a DNR
        // rule for the platform's API host while we resolve.
        const refererHosts = {
          vimeo: 'player.vimeo.com',
          loom: 'www.loom.com',
          wistia: 'fast.wistia.net'
        };
        const host = refererHosts[video.platform];
        let ruleId = null;
        if (host && video.pageUrl && !video.url) {
          ruleId = resolveRuleId(tabId);
          await applyHeaderRules(ruleId, `https://${host}/`, { Referer: video.pageUrl });
        } else if (video.url) {
          // Wire-captured HLS (Skool-native Mux, or a loom/vimeo master caught
          // off webRequest): the CDN 403s any playlist fetch whose Referer
          // doesn't match the player's. Re-attach the headers captured off the
          // wire (fall back to a bare skool.com Referer) for the
          // service-worker master fetch, same as the download step does.
          const headers = (video.headers && (video.headers.Referer || video.headers.Origin))
            ? video.headers
            : { Referer: video.pageUrl || 'https://www.skool.com/', Origin: 'https://www.skool.com' };
          video.headers = headers; // ride onto resolved qualities → download step re-applies
          ruleId = resolveRuleId(tabId);
          await applyHeaderRules(ruleId, video.url, headers);
        }

        try {
          const { qualities, title } = await resolveQualities(video);
          if (title && !video.title) video.title = title;
          // Stamp platform + carry the page Referer onto each quality so the
          // download step re-injects it for token/domain-gated CDN fetches.
          const tokenExp = jwtExpFromUrl(video.url || '');
          qualities.forEach(q => {
            q.platform = video.platform;
            // Carried so a download failure can report whether the playback
            // token had already lapsed by the time we hit the CDN.
            if (tokenExp) q.tokenExp = tokenExp.toISOString();
            if (!q.headers && video.pageUrl && video.platform !== 'youtube') q.headers = { Referer: video.pageUrl };
          });
          sendResponse({ ok: true, qualities, title: video.title });
        } catch (e) {
          svdLog('resolve', `${video.platform}: ${e.message}`);
          sendResponse({ ok: false, error: e.message });
        } finally {
          if (ruleId != null) await removeHeaderRules(ruleId);
        }
      })();
      return true;

    case 'START_DOWNLOAD':
      (async () => {
        // Video-only / audio-only bypass the weekly limit entirely — they're the
        // free-forever offer, and gating them would make the claim a lie.
        const free = req.mode === 'video' || req.mode === 'audio';
        if (!free) {
          const { allowed, reason } = await canDownload();
          // Log the denial — a free user hitting the paywall then filing a "no
          // details" problem report is otherwise indistinguishable from a bug.
          if (!allowed) { svdLog('license', `download blocked: ${reason}`); sendResponse({ ok: false, reason }); return; }
        }
        const jobId = enqueueDownload({
          quality: req.quality, filename: req.filename, tabId, platform: req.quality.platform, label: req.label,
          mode: free ? req.mode : undefined
        });
        sendResponse({ ok: true, jobId });
      })();
      return true;

    case 'GET_QUEUE':
      sendResponse({ items: queueSnapshot() });
      return true;

    case 'CANCEL_JOB':
      cancelJob(req.jobId);
      sendResponse({ ok: true });
      return true;

    case 'GET_LICENSE_STATUS':
      getLicenseStatus().then(sendResponse);
      return true;

    case 'ACTIVATE_LICENSE':
      activateLicense(req.licenseKey).then(sendResponse);
      return true;

    case 'REPORT_PROBLEM':
      sendErrorReport(req.note, req.email, tabId).then(sendResponse);
      return true;

    case 'GET_VERSION_STATUS':
      getVersionStatus().then(sendResponse).catch(() => sendResponse(null));
      return true;
  }
  return true;
});
