// Skool Video Downloader — service worker.
//
// Multi-platform detection: HLS masters (Skool-native Mux, Vimeo, Loom) are
// captured off the wire via webRequest; embed-based platforms (Vimeo/Loom/
// YouTube/Wistia) are reported by the content script from the page's iframes and
// Next.js props. The popup resolves qualities on demand, then hands a download
// job to the concurrent queue here, which fetches + remuxes to MP4 in-browser.

importScripts('bulk.js', 'detectors.js', 'buildConfig.js');

const WORKER_URL = 'https://skool-dl-license.aarohan567.workers.dev';

// Problem reports go to the shared tailsgate reports Worker (the same one the
// Whop downloader uses), tagged with a product field so they land in one admin
// dashboard. Primary is this product's own domain proxy (some ISPs/antivirus
// block *.workers.dev); the workers.dev URL is the fallback.
const REPORT_API_BASES = [
  'https://skoolvideodownload.com/api/license',
  'https://whop-dl-license.aarohan567.workers.dev'
];

// ── Debug log ─────────────────────────────────────────────────────────────────
// Tiny rolling log of high-signal events (detections with their source scanner,
// registry clears, resolve/download failures). Deliberately sparse — it exists
// to make one-click problem reports diagnosable, not to trace every action.
// Persisted in storage.local so it survives service-worker restarts.
const DEBUG_LOG_MAX = 40;
// Every write is read-modify-write on one storage key, so two overlapping calls
// both read the same array and the second's set() discards the first's line.
// That is not theoretical: a failure logs its cause and then the job's catch
// logs the failure itself one tick later, and the cause — the line support
// actually needs — was the one that got dropped. Callers rarely await svdLog,
// so the ordering has to be enforced here: chain every write onto the last.
let logChain = Promise.resolve();
function svdLog(context, message) {
  const ts = new Date().toISOString();
  logChain = logChain.then(async () => {
    try {
      const { debugLog = [] } = await chrome.storage.local.get('debugLog');
      debugLog.push({ ts, context, message: String(message).slice(0, 300) });
      await chrome.storage.local.set({ debugLog: debugLog.slice(-DEBUG_LOG_MAX) });
    } catch { /* logging must never break anything */ }
  });
  return logChain;
}

// ── Bulk-run log ──────────────────────────────────────────────────────────────
// A bulk course run's own lines live in a SEPARATE key, and the reason is the
// arithmetic: a report carries only the last 10 log lines, and one 40-lesson run
// produces well over a hundred ordinary 'save' lines. In the shared rolling log
// the run's start line — which course, what shape, what was asked for — is gone
// long before the run ends, and a bulk report without it cannot be answered.
//
// So these get their own buffer and reserved slots in the report. bulk.js keeps
// the run to four or five lines total; see its "Run diagnostics" section for why
// nothing here may log per lesson.
const BULK_LOG_LINES = 8;
// How many of those slots the report guarantees. The rest of the 10 go to the
// general log, so an unrelated failure during the run is still visible.
const BULK_LOG_RESERVED = 5;
// Matches the report worker's own cap. Sending more is silently truncated there.
const REPORT_LOG_LINES = 10;

function bulkLog(message) {
  const ts = new Date().toISOString();
  logChain = logChain.then(async () => {
    try {
      const { bulkLog: lines = [] } = await chrome.storage.local.get('bulkLog');
      lines.push({ ts, context: 'bulk', message: String(message).slice(0, 300) });
      await chrome.storage.local.set({ bulkLog: lines.slice(-BULK_LOG_LINES) });
    } catch { /* logging must never break anything */ }
  });
  return logChain;
}

// Set for the duration of a bulk run. The per-download success line is genuinely
// useful for a single download and pure noise ×150 during a course backup, where
// it would evict every other line in the shared log.
let bulkRunActive = false;

// Bulk lines take reserved slots at the front rather than competing on recency,
// then the most recent general lines fill what is left.
function composeReportLog(bulkLines, generalLines, max = REPORT_LOG_LINES) {
  const bulk = (Array.isArray(bulkLines) ? bulkLines : []).slice(-Math.min(max, BULK_LOG_RESERVED));
  const room = Math.max(0, max - bulk.length);
  const general = room ? (Array.isArray(generalLines) ? generalLines : []).slice(-room) : [];
  return [...bulk, ...general];
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
//
// The date is printed whenever the expiry is not today. Skool's Mux tokens last
// 24 hours, so a time-of-day-only stamp put "exp 21:01Z" beside a 21:00 failure
// and read as a token that died one minute before the download — when it in fact
// had a full day left. The "(in Nm)" was always right; nobody reads it first.
function describeExpiry(exp) {
  const d = exp instanceof Date ? exp : (exp ? new Date(exp) : null);
  if (!d || isNaN(d)) return null;
  const mins = Math.round((d - Date.now()) / 60000);
  const iso = d.toISOString();
  const sameDay = iso.slice(0, 10) === new Date().toISOString().slice(0, 10);
  const when = (sameDay ? iso.slice(11, 16) : iso.slice(0, 16).replace('T', ' ')) + 'Z';
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
    // Vimeo's share hash decides whether this entry can be resolved at all, and
    // a report that doesn't say whether we had one can't be diagnosed.
    const hash = entry.platform === 'vimeo' && !entry.jsonPlaylist ? ` h=${entry.hParam ? 'yes' : 'no'}` : '';
    svdLog('detect', `+${entry.platform} via ${entry.src || 'wire'} (${entry.key.slice(0, 80)})${hash}${expiry ? ` ${expiry}` : ''}`);
  } else {
    // Merge — a later webRequest capture may carry headers a page-props entry lacked.
    const prev = t.videos.get(entry.key);
    const patch = { ...entry };
    // A later, hash-less sighting of the same Vimeo video must not erase a share
    // hash an earlier one carried: without it resolution 403s.
    if (patch.hParam == null && prev.hParam != null) delete patch.hParam;
    // Same rule for everything else a merge can hollow out. A wire capture and a
    // page-scan entry now share a key for Loom, and each knows things the other
    // doesn't — the capture has the signed master, the page scan has the id, the
    // title and the source. Whichever lands second must not null out the first.
    for (const k of ['title', 'sourceId', 'url', 'headers', 'src', 'pageUrl']) {
      if (patch[k] == null && prev[k] != null) delete patch[k];
    }
    Object.assign(prev, patch);
    if (patch.url) svdLog('detect', `~${prev.platform} upgraded to wire master (${prev.key.slice(0, 40)})`);
  }
  persistRegistry();
  chrome.tabs.sendMessage(tabId, { type: 'VIDEO_DETECTED' }).catch(() => {});
}

function listVideos(tabId) {
  const t = tabVideos.get(tabId);
  return t ? [...t.videos.values()].sort((a, b) => a.ts - b.ts) : [];
}

// ── Vimeo: linking a captured stream back to the embed it came from ──────────
// A played Vimeo lesson is seen twice — the page scan finds the numeric video
// id in the embed, the wire capture finds a DASH playlist signed for a clip
// uuid — and nothing in either sighting names the other. That split listed one
// video as two rows, and the row that CANNOT resolve (no share hash: Skool's
// embed builder drops it) is the one holding the lesson title, the "on this
// page" badge and the top of the list, because those are keyed off the numeric
// id only the page scan has. Customers clicked it, got a 403, and were told to
// press play — which is what produced the working row sitting underneath.
//
// The link is the frame. The player iframe's own URL carries the numeric id,
// and every request the player makes afterwards — the playlist included —
// reports that frame's id. Remember one for the other and the capture can be
// filed under the same key as the page scan, which merges them into one row
// that resolves through the captured stream.
//
// Mirrored to storage.session for the same reason the registry is: the worker
// is routinely evicted between a lesson loading and the user pressing play, and
// a forgotten link splits the rows again.
const vimeoFrames = new Map();  // `${tabId}:${frameId}` -> numeric video id
const vimeoClips = new Map();   // playlist clip uuid    -> numeric video id
const VIMEO_LINK_MAX = 200;     // bounded: a long session must not grow forever

const vimeoLinksReady = (async () => {
  try {
    const { vimeoLinks } = await chrome.storage.session.get('vimeoLinks');
    for (const [k, v] of Object.entries(vimeoLinks?.frames || {})) vimeoFrames.set(k, v);
    for (const [k, v] of Object.entries(vimeoLinks?.clips || {})) vimeoClips.set(k, v);
  } catch { /* cold start with no links = the pre-linking two-row behaviour */ }
})();

function trimMap(m) {
  while (m.size > VIMEO_LINK_MAX) m.delete(m.keys().next().value);
}

function persistVimeoLinks() {
  trimMap(vimeoFrames);
  trimMap(vimeoClips);
  chrome.storage.session.set({
    vimeoLinks: {
      frames: Object.fromEntries(vimeoFrames),
      clips: Object.fromEntries(vimeoClips)
    }
  }).catch(() => {});
}

function rememberVimeoFrame(tabId, frameId, videoId) {
  const k = `${tabId}:${frameId}`;
  if (vimeoFrames.get(k) === videoId) return;
  vimeoFrames.set(k, videoId);
  persistVimeoLinks();
}

// Once a clip uuid has been linked, remember it directly: a later replay whose
// frame we never saw (extension reloaded, iframe already open) still merges.
function vimeoIdForCapture(tabId, frameId, clipId) {
  const byFrame = vimeoFrames.get(`${tabId}:${frameId}`);
  if (byFrame) {
    if (clipId && vimeoClips.get(clipId) !== byFrame) { vimeoClips.set(clipId, byFrame); persistVimeoLinks(); }
    return byFrame;
  }
  return (clipId && vimeoClips.get(clipId)) || null;
}

// Captured Vimeo streams that could stand in for an embed row that won't
// resolve. Only ever consulted after a failure: a hash-less embed still
// resolves fine when the video is public, and that path needs no press-play.
function vimeoStandIns(video, videos) {
  if (video.platform !== 'vimeo' || video.jsonPlaylist) return [];
  return videos.filter(v => v.platform === 'vimeo' && v.jsonPlaylist && v.url && v.key !== video.key);
}

function forgetTabVimeoFrames(tabId) {
  let changed = false;
  for (const k of vimeoFrames.keys()) {
    if (k.startsWith(`${tabId}:`)) { vimeoFrames.delete(k); changed = true; }
  }
  // vimeoClips is deliberately kept: it is tab-independent and is what lets a
  // replay after a page change still be linked.
  if (changed) persistVimeoLinks();
}

// ── HLS capture (Skool-native Mux + any embedded HLS master) ──────────────────
// Master playlists carry a query token; media/rendition playlists don't. We only
// register masters so the picker shows real resolutions, not rendition fragments.
try {
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      try {
        const url = details.url;
        // Vimeo's player on Chrome never requests an m3u8 — it streams DASH from
        // a signed …/v2/playlist/av/primary/playlist.json. That JSON is the only
        // manifest a Chrome capture can ever see for Vimeo, and the only route
        // to a Vimeo video whose share hash the page doesn't expose (Skool's
        // embed builder drops it), so it is captured alongside HLS masters.
        // The player iframe loading is what tells us which numeric video id the
        // stream this frame is about to request belongs to (see the link store
        // above). Recorded before the manifest gate below, because a sub_frame
        // navigation is neither an m3u8 nor a playlist.json.
        if (details.type === 'sub_frame' && details.tabId >= 0 && details.frameId >= 0) {
          const embed = /player\.vimeo\.com\/video\/(\d{6,})/.exec(url);
          if (embed) {
            const { tabId, frameId } = details;
            vimeoLinksReady.then(() => rememberVimeoFrame(tabId, frameId, embed[1]));
          }
        }

        const isVimeoJson = /vimeocdn\.com\/.*\/playlist\.json/.test(url);
        if (!isVimeoJson) {
          if (!url.includes('.m3u8')) return;
          const isMaster = url.includes('?token=') || url.includes('/playlist') || /master/i.test(url);
          if (!isMaster) return;
        }

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

        // Every play re-signs the Vimeo playlist URL (fresh exp/psid), so keying
        // on the URL would stack a new popup entry per replay. Key on the clip
        // uuid instead: one entry per video, and addVideo's merge keeps the
        // freshest signature on it.
        const clipId = isVimeoJson
          ? (url.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//) || [])[1]
          : null;

        // A Loom master is luna.loom.com/id/<session id>/rev/…, and that id is
        // the same one the lesson's videoLink carries — so this capture and the
        // page-scan entry are the same video. Keying them the same way collapses
        // them into one row that holds both the id and the signed master, which
        // is what the user needs: the page-scan entry alone resolves through
        // Loom's API and can come back with nothing playable, and a customer
        // shown two rows has no way to know which one works.
        const loomId = platform === 'loom'
          ? (url.match(/\/id\/([0-9a-f]{20,})/i) || [])[1] || null
          : null;

        const { tabId, frameId } = details;
        Promise.all([registryReady, vimeoLinksReady]).then(() => {
          // A played Vimeo video is seen twice — once from its embed, once from
          // this capture. When the frame it came from names the embed, file it
          // under the page scan's own key so the two collapse into one row that
          // resolves through this signed stream. Unlinked, it stays a separate
          // row named for where it came from, which is still better than
          // dropping it: for a hash-less private embed it is the only route.
          const vimeoId = isVimeoJson ? vimeoIdForCapture(tabId, frameId, clipId) : null;
          addVideo(tabId, {
            key: isVimeoJson
              ? (vimeoId ? `vimeo:${vimeoId}` : `vimeo-json:${clipId || url}`)
              : (loomId ? `loom:${loomId}` : `hls:${url}`),
            platform,
            label: isVimeoJson ? 'Vimeo (from player)' : (PLATFORM_LABELS[platform] || 'Video'),
            url,
            headers,
            jsonPlaylist: isVimeoJson || undefined,
            sourceId: loomId || vimeoId,
            title: null
          });
        });
      } catch {}
    },
    { urls: ['*://*.mux.com/*', '*://*.video.skool.com/*', '*://*.vimeo.com/*', '*://*.vimeocdn.com/*', '*://*.akamaized.net/*', '*://*.loom.com/*'] },
    ['requestHeaders']
  );
} catch {}

chrome.tabs.onRemoved.addListener((tabId) => {
  tabVideos.delete(tabId);
  forgetTabVimeoFrames(tabId);
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

// The Worker decides where an entitlement came from ('freemius', or 'legacy'
// for one of the nine subscriptions sold in the July 2026 Dodo window) and
// echoes it back, so the Worker never has to guess on revalidation.
async function activateLicense(licenseKey) {
  // Read the outgoing state first: a lifetime key replacing a monthly one is an
  // upgrade, and the old key is the only handle on the subscription that now
  // needs cancelling.
  const previous = await chrome.storage.local.get(['licenseKey', 'tier', 'licenseSource']);

  let result;
  try {
    const installId = await getInstallId();
    const res = await fetch(`${WORKER_URL}/activate-license`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey, installId })
    });
    result = await res.json();
  } catch {
    return { valid: false, error: 'network_error' };
  }

  if (!result.valid) return result;

  // Store the entitlement BEFORE attempting any billing change: if the cancel
  // call fails, the customer still owns what they just paid for.
  const store = {
    licenseKey: result.licenseKey || licenseKey,
    licenseValidatedAt: Date.now(),
    // Left over from the Dodo integration, removed 2026-08-01. Cleared rather
    // than ignored so an upgrading install stops carrying a dead instance id.
    dodoInstanceId: null,
  };
  if (result.tier) store.tier = result.tier;
  if (result.source) store.licenseSource = result.source;
  await chrome.storage.local.set(store);

  const upgrade = await cancelSupersededMonthly(previous, result, store.licenseKey);
  return upgrade ? { ...result, upgrade } : result;
}

// Buying lifetime does not stop an existing monthly subscription charging, so
// ask the shared Worker (the only one holding the Freemius secret key) to cancel
// it. Best-effort: the popup tells the customer to cancel manually if this
// fails, which is far better than a subscription they believe is gone.
//
// This used to require result.source === 'dodo', which made it dead code the
// moment Dodo was removed — and silently stopped cancelling the subscriptions of
// customers who upgrade. The gate is now on the upgrade itself: a monthly key
// being replaced by a lifetime one, whichever processor issued either.
// -> { cancelled: boolean } when an upgrade was detected, else null
async function cancelSupersededMonthly(previous, result, newKey) {
  const isUpgrade = previous.tier === 'monthly'
    && previous.licenseKey
    && previous.licenseKey !== newKey
    && result.tier === 'lifetime';
  if (!isUpgrade) return null;

  for (const base of REPORT_API_BASES) {
    try {
      const res = await fetch(`${base}/upgrade-cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product: 'skool-video-downloader',
          oldLicenseKey: previous.licenseKey,
          oldLicenseSource: previous.licenseSource || 'freemius',
          newLicenseKey: newKey,
        })
      });
      if (!res.ok) continue;
      const body = await res.json();
      await svdLog('license', `upgrade-cancel: ${body.ok ? 'cancelled' : `failed (${body.error})`}`);
      return { cancelled: !!body.ok };
    } catch { /* try the next base */ }
  }
  await svdLog('license', 'upgrade-cancel: unreachable');
  return { cancelled: false };
}

async function revalidateLicenseIfStale() {
  const { licenseKey, tier, licenseValidatedAt, licenseSource } =
    await chrome.storage.local.get(['licenseKey', 'tier', 'licenseValidatedAt', 'licenseSource']);
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
      body: JSON.stringify({ licenseKey, installId, source: licenseSource })
    });
    const result = await res.json();
    // A provider we couldn't reach is not a verdict. Leave licenseValidatedAt
    // alone so the next hourly alarm retries instead of resting for 24h — and
    // never revoke on it, which is what used to happen during an outage.
    if (result.indeterminate) {
      await svdLog('license', `revalidation inconclusive (${result.error || 'unknown'}) — keeping tier`);
      return;
    }
    if (!result.valid) {
      await svdLog('license', `licence revoked by ${licenseSource || 'freemius'}: ${result.error || 'invalid'}`);
      await chrome.storage.local.remove(['licenseKey', 'tier', 'licenseValidatedAt', 'licenseSource', 'dodoInstanceId']);
    } else {
      await chrome.storage.local.set({ licenseValidatedAt: Date.now() });
    }
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
        // Bounded: this is now on the problem-report path too, and a report
        // submitted from a half-broken network must not hang on a check whose
        // only job is to add a line of context.
        const res = await fetch(`${base}/version?product=skool-video-downloader`,
          { cache: 'no-store', signal: AbortSignal.timeout(4000) });
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

// "1.3.9 full" when current, "1.1.6 full · latest 1.3.9" when behind. Stays
// under the report worker's 32-character cap for this field.
function describeVersion(status) {
  const version = chrome.runtime.getManifest().version;
  const channel = status?.channel || ((self.SVD_CONFIG && self.SVD_CONFIG.CHANNEL) === 'full' ? 'full' : 'cws');
  return status?.updateAvailable
    ? `${version} ${channel} · latest ${status.latest}`
    : `${version} ${channel}`;
}

// ── Problem reports ───────────────────────────────────────────────────────────
// Collect diagnostics (version, tier, currently detected videos with their
// scanner source, recent debug log) and POST them to the shared reports Worker.
// Always returns the payload too, so the popup can fall back to copy-for-email
// when the network path is blocked.
async function sendErrorReport(note, email, tabId) {
  await registryReady; // 'detected' must reflect the restored registry, not a cold Map
  await logChain;      // and the log must include the failure the user is reporting
  const { debugLog = [], bulkLog: bulkLines = [] } = await chrome.storage.local.get(['debugLog', 'bulkLog']);
  const [license, installId, versionStatus] = await Promise.all([
    getLicenseStatus().catch(() => null),
    getInstallId().catch(() => undefined),
    getVersionStatus().catch(() => null),
  ]);
  const detected = listVideos(tabId)
    // Vimeo entries note whether we hold the share hash: without it the embed
    // path can only 403, so it's the difference between a bug and a private
    // video. `+stream` means the player's own stream is attached, which beats
    // both — and says the capture↔embed link worked on this page.
    .map(v => `${v.platform}/${v.src || 'wire'}`
      + (v.platform !== 'vimeo' ? '' : v.jsonPlaylist ? '+stream' : v.hParam ? '+h' : '-h')
      + (v.title ? `:${v.title.slice(0, 40)}` : ''))
    .slice(0, 8);
  const payload = {
    product: 'skool-video-downloader',
    note: typeof note === 'string' ? note.slice(0, 500) : undefined,
    email: typeof email === 'string' && email.includes('@') ? email.slice(0, 120) : undefined,
    // Which build, and whether it is current. The store build auto-updates and
    // the GitHub one does not, so "is this already fixed, and did they have any
    // way of knowing" is the first question every report raises — and most of
    // them turn out to be stale sideloads. Folded into the version string
    // rather than sent as its own field for the same reason the free-tier
    // allowance is folded into `tier`: the report worker renders a fixed set of
    // columns, and this needs no deploy to show up. (Capped at 32 there.)
    version: describeVersion(versionStatus),
    ua: navigator.userAgent,
    // Free tier: fold the weekly-allowance state into the tier string so the
    // report worker shows it without needing a new column/redeploy.
    tier: license?.tier
      || (Number.isFinite(license?.remaining) ? `free (${license.remaining}/${license.limit} left)` : 'free'),
    detected: detected.length ? detected.join(', ').slice(0, 300) : 'none',
    installId,
    // Bulk lines first with reserved slots — without that a course backup's own
    // diagnosis loses every slot to its own successful downloads.
    log: composeReportLog(bulkLines, debugLog),
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

// A throttled edge does not always answer 429. Often it accepts the connection
// and then drops or starves it, which rejects fetch() with a bare TypeError
// instead of returning a status — same cause, same fix, but it used to escape
// the status-shaped handling entirely and reach the user as "Failed to fetch".
//
// Two separate budgets, because the two failures need different patience. A 429
// is answered instantly and its Retry-After is usually seconds. A connection
// reset is the edge refusing this IP for as long as the throttle lasts, so five
// tries across 7.5s never stood a chance — it needs about a minute.
const NET_MAX_RETRIES = 7;
const NET_BACKOFF_CAP_MS = 16000;

// Every attempt covers headers AND body under one abort signal. fetch() resolves
// the moment headers arrive, so a timeout wrapped around fetch() alone sails
// straight past the case that actually happens — a socket that connects, answers
// 200, and then delivers nothing — and hangs forever in r.blob(). Since a batch
// waits on its slowest member, one starved socket freezes ten. Reading the body
// in here is what gives the timeout something to bite on.
//
// 45s is deliberately generous: a ~6s HLS segment is a few MB, which is a real
// 30+ seconds on a genuinely slow line. This is a stall detector, not an SLA.
const ATTEMPT_TIMEOUT_MS = 45000;

// Marks the errors that must not be swallowed by the network-retry branch below
// (they're thrown from inside the same try block). `throttle` further marks the
// ones worth waiting out rather than failing on — see withThrottleCooldown.
function fatal(message, { throttle = false } = {}) {
  const e = new Error(message);
  e.svdFatal = true;
  if (throttle) e.svdThrottle = true;
  return e;
}

// Returns the body, not the Response: reading it in here is what keeps it inside
// the abort signal, and every caller wanted the body anyway. It also means the
// status check happens once, here, instead of at five call sites.
// isCancelled is checked between attempts because the network budget is now
// nearly a minute: without it, pressing Cancel on a throttled download would sit
// there backing off long after the user gave up.
async function fetchWithRetry(url, { maxRetries = 4, read = 'blob', isCancelled } = {}) {
  let netFailures = 0;
  for (let attempt = 0; ; attempt++) {
    if (isCancelled?.()) throw fatal('Cancelled');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ATTEMPT_TIMEOUT_MS);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) {
        if (attempt >= maxRetries || !RETRYABLE_STATUS.has(r.status)) {
          // A retryable status that outlived the budget is a throttle that is
          // answering, rather than one that is dropping connections. Same wait.
          throw fatal(segmentFailureMessage(r.status), { throttle: RETRYABLE_STATUS.has(r.status) });
        }
        await backoff(attempt, parseFloat(r.headers.get('Retry-After')));
        continue;
      }
      return read === 'text' ? await r.text() : await r.blob();
    } catch (e) {
      if (e?.svdFatal) throw e;
      // AbortError (our timeout) and TypeError (reset/refused/DNS) are the
      // network family. Anything else is a bug in here and should surface.
      if (e?.name !== 'AbortError' && e?.name !== 'TypeError') throw e;
      if (++netFailures > NET_MAX_RETRIES) throw fatal(NETWORK_FAILURE_MESSAGE, { throttle: true });
      await backoff(netFailures - 1, undefined, NET_BACKOFF_CAP_MS);
    } finally {
      clearTimeout(timer);
    }
  }
}

function backoff(attempt, retryAfterSec, capMs = 8000) {
  const delay = Number.isFinite(retryAfterSec)
    ? retryAfterSec * 1000
    : Math.min(500 * 2 ** attempt, capMs) + Math.random() * 300;
  return new Promise(resolve => setTimeout(resolve, delay));
}

// fetchWithRetry's ~50s budget answers a blip. A throttle that outlasts it used
// to end the job — and with it, everything already downloaded: seven minutes of
// transfer discarded at 8%, in the reports that prompted this. Nothing about the
// partial is unusable. The caller's blob array is a local that simply never
// unwinds if we don't throw, so the cheapest resume is not to unwind: wait the
// throttle out in place, then retry the same batch.
//
// Escalating waits, capped at three rounds — past ~13 minutes it isn't a burst
// throttle any more and the user is better served by an error they can act on.
const COOLDOWNS_MS = [60000, 120000, 240000];

async function withThrottleCooldown(run, { isCancelled, onWait, onCooldown } = {}) {
  for (let round = 0; ; round++) {
    try {
      return await run();
    } catch (e) {
      if (!e?.svdThrottle || round >= COOLDOWNS_MS.length) throw e;
      onCooldown?.(COOLDOWNS_MS[round], round);
      await cooldownSleep(COOLDOWNS_MS[round], { isCancelled, onWait });
    }
  }
}

// Ticks every second so Cancel stays responsive, but only reports every fifth so
// the popup isn't repainted 240 times over a four-minute wait. A silent progress
// bar sitting at 8% is indistinguishable from a hang, so the countdown is the
// whole point: it says the download is still coming back.
function cooldownSleep(ms, { isCancelled, onWait }) {
  return new Promise((resolve, reject) => {
    const until = Date.now() + ms;
    const tick = () => {
      if (isCancelled?.()) { clearInterval(timer); reject(new Error('Cancelled')); return; }
      const left = Math.ceil((until - Date.now()) / 1000);
      if (left <= 0) { clearInterval(timer); onWait?.(0); resolve(); return; }
      if (left % 5 === 0 || left < 5) onWait?.(left);
    };
    const timer = setInterval(tick, 1000);
    tick();
  });
}

// The connection-level twin of the rate-limit message below. Chrome's own
// wording for this is "Failed to fetch", which went into the popup, the queue
// row and the problem report verbatim — accurate, and useless to everyone who
// read it.
//
// Both messages are only ever seen after withThrottleCooldown has already waited
// out three rounds, so neither may say "wait a few minutes and try again" as if
// that hadn't been tried: by this point the extension has been waiting for about
// thirteen. Saying so is also the honest signal that retrying now is pointless.
const NETWORK_FAILURE_MESSAGE = 'Lost the connection to Skool\'s video server. The download waited and retried for about 13 minutes and it never recovered, so it has been stopped and the part already downloaded isn\'t kept. This is usually heavy rate-limiting after several downloads in a row — leave it a while longer before trying again, and check your internet connection if it keeps happening.';

// The same failure reached from a path that has no cool-down behind it (a
// progressive download, a Vimeo playlist read). It must not claim a wait that
// never happened, so it gives the advice without the duration.
const NETWORK_LOST_MESSAGE = 'Lost the connection to Skool\'s video server. This is usually rate-limiting after several downloads in a row — wait a few minutes and start the download again, and check your internet connection if it keeps happening.';

// Reaching here means the retry budget AND the cool-downs are spent, so a 429
// isn't a blip — the CDN is throttling this IP hard, usually after several
// downloads back to back. "HTTP 429" told the user nothing actionable; waiting
// is the actual fix, so say that. Expired signatures (403) are the other status
// that shows up in reports and have their own fix: reload and press play again.
function segmentFailureMessage(status) {
  if (status === 429 || status === 503) {
    return 'Skool\'s video server is rate-limiting this connection. The download waited and retried for about 13 minutes and was still being refused, so it has been stopped and the part already downloaded isn\'t kept. Leave it a while longer before starting again.';
  }
  if (status === 403 || status === 401) {
    return 'The video link expired mid-download. Reload the lesson page, press play, and download again.';
  }
  return `Segment fetch failed: HTTP ${status}`;
}

async function downloadRendition(playlistUrl, { onProgress, isCancelled, mimeType, onWait, onCooldown }) {
  const text = await withThrottleCooldown(
    () => fetchWithRetry(playlistUrl, { read: 'text', isCancelled }),
    { isCancelled, onWait, onCooldown });
  const baseUrl = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);
  const parentQuery = (playlistUrl.split('?')[1] || '');

  const blobs = [];
  const mapMatch = text.match(/#EXT-X-MAP:URI="([^"]+)"/);
  if (mapMatch) {
    blobs.push(await withThrottleCooldown(
      () => fetchWithRetry(resolvePlaylistUrl(mapMatch[1], baseUrl, parentQuery), { read: 'blob', isCancelled }),
      { isCancelled, onWait, onCooldown }));
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
    const parts = await withThrottleCooldown(
      () => Promise.all(batch.map(u => fetchWithRetry(u, { read: 'blob', isCancelled }))),
      { isCancelled, onWait, onCooldown });
    blobs.push(...parts);
    bytes += parts.reduce((n, b) => n + b.size, 0);
    onProgress?.(Math.min(i + batch.length, segments.length), segments.length, bytes);
  }
  return new Blob(blobs, { type: mimeType || 'video/mp4' });
}

// One track (video or audio) of a wire-captured Vimeo DASH playlist. The
// playlist is re-read here rather than carried on the quality: it holds a signed
// URL per segment — thousands on a long lesson — and those signatures expire, so
// a fresh read is both smaller and more likely to still be valid. The init
// segment arrives base64-inline (no request of its own) and must lead, since it
// carries the fMP4 moov the concatenated media segments are useless without.
async function downloadVimeoTrack(playlistUrl, kind, trackId, { onProgress, isCancelled, onWait, onCooldown }) {
  const pl = await fetchVimeoPlaylist(playlistUrl);
  const track = vimeoTrackSegments(pl, playlistUrl, kind, trackId);
  const blobs = [];
  if (track.init) blobs.push(base64ToBlob(track.init));
  else if (track.initUrl) {
    blobs.push(await withThrottleCooldown(
      () => fetchWithRetry(track.initUrl, { read: 'blob', isCancelled }),
      { isCancelled, onWait, onCooldown }));
  }
  if (!track.urls.length) throw new Error('No segments in Vimeo playlist');

  // Same batch size as HLS — big enough to saturate a link, small enough not to
  // look like a burst worth throttling.
  const BATCH = 10;
  let bytes = blobs.reduce((n, b) => n + b.size, 0);
  for (let i = 0; i < track.urls.length; i += BATCH) {
    if (isCancelled?.()) throw new Error('Cancelled');
    const batch = track.urls.slice(i, i + BATCH);
    const parts = await withThrottleCooldown(
      () => Promise.all(batch.map(u => fetchWithRetry(u, { read: 'blob', isCancelled }))),
      { isCancelled, onWait, onCooldown });
    blobs.push(...parts);
    bytes += parts.reduce((n, b) => n + b.size, 0);
    onProgress?.(Math.min(i + batch.length, track.urls.length), track.urls.length, bytes);
  }
  return new Blob(blobs, { type: kind === 'audio' ? 'audio/mp4' : 'video/mp4' });
}

function base64ToBlob(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes]);
}

// Resolves a quality + track to a function that fetches that track and returns a
// Blob, so the free single-track path and the combined path share one place that
// knows how each kind is fetched. Null means this quality has no such track.
function trackDownloader(quality, which) {
  if (quality.kind === 'vimeo-json') {
    const trackId = which === 'audio' ? quality.audioTrackId : quality.videoTrackId;
    if (!trackId) return null;
    return (opts) => downloadVimeoTrack(quality.playlistUrl, which, trackId, opts);
  }
  const url = which === 'audio' ? quality.audioUrl : quality.videoUrl;
  if (!url) return null;
  const fetchOne = quality.kind === 'hls' ? downloadRendition : downloadDirect;
  return (opts) => fetchOne(url, opts);
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
  // A stream that ends early is not a success. content-length was previously
  // read only to drive the progress bar, so a transfer that died at 2% produced
  // a truncated file, reported no error, and the user discovered it in their
  // video player. If the server told us how many bytes to expect, hold it to it.
  if (total > 0 && received < total) {
    throw new Error(`Download stopped early — got ${formatGB(received)} of ${formatGB(total)}. Try again.`);
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
// Purge-and-retry-once targets (1) — it's safe because offscreenLock serialises
// every caller, so no other job has live entries here.
//
// What the retry failing does NOT establish is (2). This code used to assume it
// did and told the user their disk was full no matter what had actually gone
// wrong; reports came back stating the extension needed 530 MB and Chrome had
// 10.7 GB free, in the same sentence. So the retry's own error is now logged and
// inspected, and "out of space" is claimed only when the error or the numbers
// say so. Anything else is reported as itself.
async function putBlobs(entries) {
  let cache = await caches.open(BLOB_CACHE);
  try {
    await Promise.all(entries.map(([key, blob]) => cache.put(key, new Response(blob))));
    return cache;
  } catch (first) {
    // Chrome defers reclaiming a deleted cache while a Cache handle is still
    // live, so purging with `cache` still referenced can free nothing and leave
    // the retry running against unchanged storage. Dropping the reference first
    // doesn't force the reclaim — GC timing isn't ours — but it's what makes it
    // possible at all.
    cache = null;
    await purgeBlobCache();
    cache = await caches.open(BLOB_CACHE);
    try {
      await Promise.all(entries.map(([key, blob]) => cache.put(key, new Response(blob))));
      return cache;
    } catch (second) {
      const err = new Error(await blobPutFailureMessage(entries, second));
      err.cause = second;
      // Both attempts, named and sized: the retry's error is the one that
      // survived a purge, and it is what tells disk pressure apart from
      // everything else that can break a 500 MB CacheStorage write.
      await svdLog('cache', `blob put failed (${describeEntries(entries)})`
        + ` first=${describeError(first)} second=${describeError(second)}`
        + ` ${await describeStorage()}`);
      throw err;
    }
  }
}

function describeError(e) {
  if (!e) return 'unknown';
  return `${e.name || 'Error'}: ${String(e.message || e).slice(0, 120)}`;
}

function describeEntries(entries) {
  return entries.map(([, blob]) => formatGB(blob.size)).join('+');
}

async function describeStorage() {
  try {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    return `quota=${formatGB(quota)} usage=${formatGB(usage)}`;
  } catch { return 'quota=unavailable'; }
}

// Only say "out of space" when the numbers actually support it. The previous
// version said it unconditionally, which produced reports whose own message
// disproved itself — "needs about 530 MB and Chrome currently has 10.7 GB
// available" — and buried the real error in an unread `cause`. A wrong
// diagnosis is worse than an unhelpful one: it sends the user off to delete
// files while the actual fault goes unreported.
async function blobPutFailureMessage(entries, error) {
  const needed = entries.reduce((n, [, blob]) => n + blob.size, 0);
  let free = null;
  try {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    free = Math.max(0, quota - usage);
  } catch { /* estimate() is best-effort */ }

  const quotaError = error?.name === 'QuotaExceededError';
  if (quotaError || (free !== null && free < needed)) {
    const detail = free === null ? ''
      : ` It needs about ${formatGB(needed)} of free space and Chrome currently has ${formatGB(free)} available.`;
    return `Couldn't save the video — your disk is out of space.${detail} Free up some room and download again.`;
  }

  // Not a space problem. Say so plainly, give the one step that is known to
  // clear stale leftovers (the startup purge does what an in-session purge
  // cannot), and carry the real error so the report is diagnosable.
  return 'Couldn’t hand the finished video to Chrome for saving — this is not a disk-space problem, '
    + 'your disk has room. Fully quit Chrome and reopen it, then download this lesson again. '
    + `If it fails a second time, use “Report this error” so we can see what happened. (${describeError(error)})`;
}

function formatGB(bytes) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

// ── Refuse to save something that isn't a video ───────────────────────────────
//
// The pipeline had no size check anywhere, so any 200 response became a file:
// a CDN error page, a placeholder, a resolver handing back a URL with no media
// behind it. Those saved without complaint and the user found out when their
// player showed a 00:00:00 track with no picture — which is exactly what was
// reported. Nothing legitimate lands under this floor: the smallest real
// audio-only lesson is comfortably above it, so a file below it is a failure
// wearing a success's clothes.
const MIN_USABLE_BYTES = 64 * 1024;
function assertUsableVideo(blob) {
  if (blob.size >= MIN_USABLE_BYTES) return;
  svdLog('save', `refused empty file (${blob.size} bytes)`);
  throw new Error(
    `The download came back empty (${blob.size} bytes), so there is no video to save. `
    + 'This usually means the lesson’s video could not be reached directly. '
    + 'Press play on the video in Skool, let it run for a few seconds, then download it again.'
  );
}

// ── Blob saving via offscreen anchor ──────────────────────────────────────────
function saveBlob(blob, filename) {
  assertUsableVideo(blob);
  return withOffscreen(async () => {
    const key = `https://skool-merge.local/save/${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const cache = await putBlobs([[key, blob]]);
    try {
      await ensureOffscreenDocument();
      const result = await sendToOffscreen({ type: 'CREATE_BLOB_URL', key });
      if (!result?.success) throw new Error(result?.error || 'Failed to prepare file');
      const downloadId = await saveViaOffscreenAnchor(filename, blob.size);
      const { state, error } = await waitForDownloadEnd(downloadId);
      if (state !== 'complete') throw new Error(saveFailureMessage(state, error));
      // Returned so a bulk run can record it: the downloads API is the only way
      // to ask whether a file is still on disk, and it answers by id.
      return downloadId;
    } finally {
      await cache.delete(key);
      await sendToOffscreen({ type: 'MERGE_CLEANUP' });
      await closeOffscreenDocument();
    }
  });
}

// Clicking the anchor does not create the DownloadItem synchronously: Chrome has
// to pull the whole blob across to the browser process first, which on a merged
// multi-GB MP4 — right after ffmpeg.wasm held video+audio+output in one wasm heap
// — can take far longer than it does for a small file. This used to give up after
// 8s, and the caller's `finally` then revoked the blob URL and tore down the
// offscreen document, killing a save that was still on its way and throwing away
// ten minutes of downloading. Wait long enough that slow is never mistaken for
// refused. Poll downloads.search() as well as listening for onCreated, because a
// service worker that was evicted mid-wait misses the event entirely but the
// DownloadItem is still there when it wakes.
const SAVE_START_TIMEOUT_MS = 90000;
const SAVE_START_POLL_MS = 5000;

function saveViaOffscreenAnchor(filename, size) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let done = false;
    let poll = null;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      chrome.downloads.onCreated.removeListener(onCreated);
      clearTimeout(timer); clearInterval(poll);
      fn(arg);
    };
    const succeed = (item, how) => {
      // Size matters more than latency here: the two are proportional (Chrome
      // copies the whole blob before creating the item), and a report that says
      // how many bytes were handed over answers "the file won't open" outright.
      // Suppressed during a bulk run: see BULK_LOG_RESERVED. One course backup
      // fires this a hundred-plus times and would leave the report holding
      // nothing else.
      if (!bulkRunActive) {
        svdLog('save', `download started after ${Date.now() - startedAt}ms via ${how}`
          + ` (id ${item.id}${size ? `, ${formatGB(size)}` : ''})`);
      }
      finish(resolve, item.id);
    };
    const onCreated = (item) => {
      if (item.byExtensionId && item.byExtensionId !== chrome.runtime.id) return;
      succeed(item, 'onCreated');
    };
    chrome.downloads.onCreated.addListener(onCreated);

    poll = setInterval(async () => {
      const item = await findRecentBlobDownload(startedAt);
      if (item && !done) succeed(item, 'search');
    }, SAVE_START_POLL_MS);

    const timer = setTimeout(async () => {
      const item = await findRecentBlobDownload(startedAt);
      if (item) { succeed(item, 'search-final'); return; }
      svdLog('save', `no download appeared in ${Math.round(SAVE_START_TIMEOUT_MS / 1000)}s for "${filename}"`);
      finish(reject, new Error(SAVE_BLOCKED_MESSAGE));
    }, SAVE_START_TIMEOUT_MS);

    sendToOffscreen({ type: 'SAVE_CLICK', filename }).then((res) => {
      if (!res?.success) finish(reject, new Error(res?.error || 'Save failed'));
    });
  });
}

// Our own blob saves are the only downloads this extension starts, so "began
// after we clicked, and is a blob: URL from us" identifies ours without having to
// guess how Chrome sanitised the filename.
async function findRecentBlobDownload(since) {
  try {
    const items = await chrome.downloads.search({ limit: 25, orderBy: ['-startTime'] });
    return items.find((i) => {
      const started = Date.parse(i.startTime || '');
      if (!Number.isFinite(started) || started < since - 2000) return false;
      if (i.byExtensionId && i.byExtensionId !== chrome.runtime.id) return false;
      return (i.url || '').startsWith('blob:') || (i.finalUrl || '').startsWith('blob:');
    }) || null;
  } catch { return null; }
}

// The video and audio are already on disk and the merge already succeeded by the
// time this fires, so the only thing left to blame is whatever sits between
// Chrome and the file system. Name the real suspects and point at the free
// buttons, which take a different path and are the fastest thing the user can try.
const SAVE_BLOCKED_MESSAGE =
  'The video finished downloading and merged fine, but Chrome never started the save. ' +
  'Something is blocking it — usually a download manager (IDM, Free Download Manager) ' +
  'with browser integration on, antivirus web protection, or Chrome’s “automatic downloads” ' +
  'setting being blocked for this site. Turn those off and try again, or use the free ' +
  '“Video only” button, which saves a different way.';

// Resolving here is what lets the caller revoke the blob URL and close the
// offscreen document, so a premature "timeout" destroys a save that is still
// running. Before giving up, ask Chrome what the item is actually doing: while it
// is still in_progress we keep waiting (bounded), and only a genuinely stuck
// download reports 'timeout'.
function waitForDownloadEnd(downloadId, timeoutMs = 10 * 60 * 1000, maxExtensions = 3) {
  return new Promise((resolve) => {
    let reason = null;
    let extensions = 0;
    const stop = (state) => {
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      resolve({ state, error: reason });
    };
    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.error?.current) reason = delta.error.current;
      if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
        stop(delta.state.current);
      }
    };
    const onTimeout = async () => {
      let item = null;
      try { [item] = await chrome.downloads.search({ id: downloadId }); } catch { /* fall through to timeout */ }
      if (item?.state === 'complete' || item?.state === 'interrupted') { stop(item.state); return; }
      if (item?.state === 'in_progress' && extensions < maxExtensions) {
        extensions += 1;
        svdLog('save', `download ${downloadId} still in progress after ${Math.round(timeoutMs * extensions / 60000)}m — waiting`);
        timer = setTimeout(onTimeout, timeoutMs);
        return;
      }
      stop('timeout');
    };
    let timer = setTimeout(onTimeout, timeoutMs);
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

// By the time any of these fire the video is downloaded and merged; only the
// hand-off to Chrome failed. Chrome tells us why in `error`, and every one of
// these reasons used to be reported as "a download manager is intercepting
// downloads" — including the reason that has nothing to do with one. The save
// goes out as an anchor click from the offscreen document, so with Chrome's
// "Ask where to save each file" setting on, a dismissed file picker lands here
// as USER_CANCELED and the old message sent people hunting for an IDM install
// they don't have.
const DOWNLOAD_MANAGER_HINT =
  'Could not save the file. A download manager (e.g. Free Download Manager or IDM) may be intercepting downloads — turn off its browser integration, then try again.';
const SAVE_FAILURE_HINTS = {
  USER_CANCELED:
    'The video downloaded and merged fine, but the save was cancelled. If a “Save as” window '
    + 'appeared, closing or cancelling it does this — check Chrome ▸ Settings ▸ Downloads ▸ '
    + '“Ask where to save each file”. A download manager extension (IDM, Free Download Manager) '
    + 'can also cancel Chrome’s own downloads; turn off its browser integration.',
  USER_SHUTDOWN:
    'The save was interrupted by Chrome closing. The video downloaded and merged fine — '
    + 'try again and leave the browser open until the file appears.',
  FILE_ACCESS_DENIED:
    'The video downloaded and merged fine, but Chrome was not allowed to write the file. '
    + 'Check that your Downloads folder still exists and is writable, then try again.',
  FILE_NO_SPACE:
    'The video downloaded and merged fine, but there is not enough free disk space to save it.',
  FILE_NAME_TOO_LONG:
    'The video downloaded and merged fine, but the filename is too long for your system. '
    + 'Shorten it in the download dialog, or rename the lesson, then try again.',
  FILE_BLOCKED:
    'The video downloaded and merged fine, but something blocked the save — usually antivirus '
    + 'web protection or a Chrome policy. Turn that off for this download and try again.',
  FILE_SECURITY_CHECK_FAILED:
    'The video downloaded and merged fine, but a security check blocked the save — usually '
    + 'antivirus web protection. Turn that off for this download and try again.',
  FILE_VIRUS_INFECTED:
    'The video downloaded and merged fine, but your antivirus refused the file. Exclude your '
    + 'Downloads folder or the extension, then try again.',
};
function saveFailureMessage(state, error) {
  const detail = error || (state === 'timeout' ? 'timed out' : state);
  const hint = SAVE_FAILURE_HINTS[error] || DOWNLOAD_MANAGER_HINT;
  // The raw reason stays in the message: it is what a problem report is read
  // for, and it is how this table gets another row.
  return `${hint}${detail ? ` [${detail}]` : ''}`;
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
  return quality.kind === 'merge'
    || (quality.kind === 'hls' && !!quality.audioUrl)
    || (quality.kind === 'vimeo-json' && !!quality.audioTrackId);
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

function mergeAndSave(videoBlob, audioBlob, filename, tabId, onSaving) {
  assertUsableVideo(videoBlob);
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
      // The merge is done; handing a multi-GB blob to Chrome can take a while on
      // its own, so move the bar off "merging" rather than looking frozen at 82%.
      onSaving?.();
      const downloadId = await saveViaOffscreenAnchor(`${filename}.mp4`, result.size);
      const { state, error } = await waitForDownloadEnd(downloadId);
      if (state !== 'complete') throw new Error(saveFailureMessage(state, error));
      return downloadId;   // see saveBlob — the manifest's disk check needs it
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
function enqueueDownload({ quality, filename, tabId, platform, label, mode, onSettled }) {
  const jobId = ++jobSeq;
  const meta = { filename, platform, label, mode, percent: 0, phase: 'queued', speed: '' };
  downloadQueue.push({ jobId, quality, filename, tabId, mode, meta, onSettled });
  broadcast({ type: 'QUEUE_ADD', item: { jobId, ...meta, state: 'queued' } });
  pump();
  return jobId;
}

// Promise form for callers that must wait for a job to finish — the bulk
// orchestrator downloads one lesson at a time and needs to know the outcome
// before it records the manifest entry and moves on.
//
// It resolves rather than rejects on failure: a bulk run turns one lesson's
// failure into a named record and carries on, and an unhandled rejection
// escaping into the queue would take the whole course down with it.
function enqueueDownloadAwaited(opts) {
  return new Promise((resolve) => {
    const jobId = enqueueDownload({ ...opts, onSettled: resolve });
    // The caller awaits the outcome, so it never sees the job id otherwise —
    // and without it a cancel cannot reach the download that is in flight.
    opts.onJobId?.(jobId);
  });
}

// Settling is what a bulk run is blocked on, so it must happen exactly once per
// job and on EVERY path a job can leave by — including the two that never reach
// runJob at all (see cancelJob and forgetTabVideos). A job that ends without
// settling does not fail the run; it hangs it, with no error and no progress.
function settleJob(job, outcome) {
  const fn = job?.onSettled;
  if (!fn) return;
  job.onSettled = null;   // once, whichever path gets here first
  try { fn(outcome); } catch { /* a caller's handler must not break the queue */ }
}

function pump() {
  while (activeJobs.size < MAX_CONCURRENT && downloadQueue.length) {
    const next = downloadQueue.shift();
    runJob(next);
  }
}

async function runJob(job) {
  const { jobId, quality, filename, tabId, mode } = job;
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

  // Waiting out a throttle. The percent deliberately does not move — it is the
  // proof that the partial download is still held, which is the entire reason
  // this state exists instead of an error.
  const onWait = (secondsLeft) => {
    if (secondsLeft > 0) {
      meta.phase = 'waiting'; meta.waitSeconds = secondsLeft; meta.speed = '';
      updateJob(jobId, { percent: meta.percent, phase: 'waiting', waitSeconds: secondsLeft, speed: '' });
    } else {
      meta.phase = 'downloading'; meta.waitSeconds = 0;
      lastBytes = 0; lastTs = Date.now();   // don't bill the wait as zero throughput
      updateJob(jobId, { percent: meta.percent, phase: 'downloading', waitSeconds: 0 });
    }
  };
  const onCooldown = (ms, round) => svdLog('download',
    `throttled at ${meta.percent}% — holding progress, retrying in ${Math.round(ms / 1000)}s (round ${round + 1}/${COOLDOWNS_MS.length})`);
  const netOpts = { onWait, onCooldown };

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
    // A vimeo-json quality addresses its tracks by id rather than URL and needs
    // no headers at all, so there is nothing to scope a rule to — hence the
    // sample-URL guard rather than a headers check alone.
    const ruleSampleUrl = (mode === 'audio' && quality.audioUrl) || quality.videoUrl;
    if (ruleSampleUrl && quality.headers && (quality.headers.Referer || quality.headers.Origin)) {
      ruleId = downloadRuleId(jobId);
      await applyHeaderRules(ruleId, ruleSampleUrl, quality.headers);
    }

    // Free single-track path: fetch only the requested rendition and save it as
    // is. Never touches ffmpeg, so it works on CPUs without Wasm SIMD and on
    // videos too long for the in-browser merger. HLS renditions are playlists
    // (segment-by-segment); merge-kind ones are plain files.
    if (mode === 'video' || mode === 'audio') {
      const fetchTrack = trackDownloader(quality, mode);
      if (!fetchTrack) {
        throw new Error(mode === 'audio'
          ? "This video's audio is inside the video file — use “Video only”, it already has sound."
          : 'No separate video track for this quality.');
      }
      const blob = await fetchTrack({
        isCancelled, ...netOpts, mimeType: mode === 'audio' ? 'audio/mp4' : 'video/mp4',
        onProgress: (d, t, b) => setPct(t ? (d / t) * 95 : 50, 'downloading', b)
      });
      if (isCancelled()) throw new Error('Cancelled');
      setPct(97, 'saving');
      meta.downloadId = await saveBlob(blob, mode === 'audio' ? `${filename}.m4a` : `${filename}.mp4`);

    } else if (quality.kind === 'mp4') {
      const blob = await downloadDirect(quality.videoUrl, {
        isCancelled, mimeType: 'video/mp4',
        onProgress: (done, total, bytes) => setPct(total ? (done / total) * 95 : 50, 'downloading', bytes)
      });
      setPct(97, 'saving');
      meta.downloadId = await saveBlob(blob, `${filename}.mp4`);

    } else if (quality.kind === 'hls') {
      const videoBlob = await downloadRendition(quality.videoUrl, {
        isCancelled, ...netOpts, mimeType: 'video/mp4',
        onProgress: (d, t, b) => setPct(quality.audioUrl ? (d / t) * 55 : (d / t) * 92, 'downloading', b)
      });
      if (!quality.audioUrl) {
        setPct(96, 'saving');
        meta.downloadId = await saveBlob(videoBlob, `${filename}.mp4`);
      } else {
        const audioBlob = await downloadRendition(quality.audioUrl, {
          isCancelled, ...netOpts, mimeType: 'audio/mp4',
          onProgress: (d, t, b) => setPct(55 + (d / t) * 25, 'downloading', b)
        });
        if (isCancelled()) throw new Error('Cancelled');
        setPct(82, 'merging');
        meta.downloadId = await mergeAndSave(videoBlob, audioBlob, filename, tabId, () => setPct(97, 'saving'));
      }

    } else if (quality.kind === 'vimeo-json') {
      const videoBlob = await downloadVimeoTrack(quality.playlistUrl, 'video', quality.videoTrackId, {
        isCancelled, ...netOpts,
        onProgress: (d, t, b) => setPct(quality.audioTrackId ? (d / t) * 55 : (d / t) * 92, 'downloading', b)
      });
      if (!quality.audioTrackId) {
        setPct(96, 'saving');
        meta.downloadId = await saveBlob(videoBlob, `${filename}.mp4`);
      } else {
        const audioBlob = await downloadVimeoTrack(quality.playlistUrl, 'audio', quality.audioTrackId, {
          isCancelled, ...netOpts,
          onProgress: (d, t, b) => setPct(55 + (d / t) * 25, 'downloading', b)
        });
        if (isCancelled()) throw new Error('Cancelled');
        setPct(82, 'merging');
        meta.downloadId = await mergeAndSave(videoBlob, audioBlob, filename, tabId, () => setPct(97, 'saving'));
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
      meta.downloadId = await mergeAndSave(videoBlob, audioBlob, filename, tabId, () => setPct(97, 'saving'));
    }

    meta.percent = 100; meta.phase = 'done'; meta.speed = '';
    updateJob(jobId, { percent: 100, phase: 'done', speed: '' });
    // Video-only / audio-only are free forever — they never spend a credit.
    if (!mode) await decrementCredit();
    recordFinished(meta, 'done');
    broadcast({ type: 'QUEUE_DONE', jobId });

  } catch (e) {
    if (e.message === 'Cancelled') {
      // Mutated, not just spread into recordFinished: the finally below reads
      // meta.phase to decide the outcome, and a cancelled job left reading
      // 'downloading' would settle as a success — which a bulk run would record
      // in the manifest as saved and never retry.
      meta.phase = 'cancelled';
      recordFinished(meta, 'cancelled');
      broadcast({ type: 'QUEUE_CANCELLED', jobId });
    } else {
      // Not every fetch in a job runs through fetchWithRetry — progressive
      // downloads and playlist reads call fetch() directly — so translate the
      // raw browser wording here too rather than leaving one path that can still
      // put "Failed to fetch" in front of a user. The original is kept in the
      // log line: support needs to know which of the two produced it.
      const raw = e.name === 'TypeError' || e.name === 'AbortError' ? e.message : null;
      meta.phase = 'error'; meta.error = raw ? NETWORK_LOST_MESSAGE : e.message;
      const expiry = describeExpiry(quality.tokenExp);
      svdLog('download', `${quality.platform || 'video'} "${String(filename).slice(0, 60)}": ${raw ? `network (${raw})` : e.message}`
        + ` @${meta.percent}%${expiry ? ` ${expiry}` : ''}`);
      recordFinished(meta, 'error');
      updateJob(jobId, { phase: 'error', error: meta.error });
      broadcast({ type: 'QUEUE_ERROR', jobId, error: meta.error });
    }
  } finally {
    if (ruleId != null) await removeHeaderRules(ruleId);
    activeJobs.delete(jobId);
    // Settle BEFORE pump(), so an awaiting bulk run resumes before the next job
    // starts. Settling after would let the two interleave, which is exactly what
    // downloading a course one lesson at a time exists to prevent.
    settleJob(job, meta.phase === 'error' ? { ok: false, error: meta.error }
      : meta.phase === 'cancelled' ? { ok: false, cancelled: true }
      : { ok: true, downloadId: meta.downloadId ?? null });
    pump();
  }
}

function cancelJob(jobId) {
  const active = activeJobs.get(jobId);
  if (active) { active.cancel(); return; }
  const idx = downloadQueue.findIndex(q => q.jobId === jobId);
  if (idx >= 0) {
    const [dropped] = downloadQueue.splice(idx, 1);
    // A job cancelled while still queued never reaches runJob, so runJob's
    // finally never runs and nothing else would ever settle it. An awaiting
    // bulk run would then wait forever — no error, no progress, no way out.
    settleJob(dropped, { ok: false, cancelled: true });
    broadcast({ type: 'QUEUE_CANCELLED', jobId });
  }
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
        // Vimeo's captured DASH playlist and its segments are signed for
        // playback and verified to serve with no Referer and no cookies, so it
        // gets no header rule — the request stays exactly what was tested.
        if (video.jsonPlaylist) {
          /* no header rule needed */
        } else if (host && video.pageUrl && !video.url) {
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

        // Stamp platform + carry the page Referer onto each quality so the
        // download step re-injects it for token/domain-gated CDN fetches.
        const stamp = (qualities, from) => {
          const tokenExp = jwtExpFromUrl(from.url || '');
          qualities.forEach(q => {
            q.platform = from.platform;
            // Carried so a download failure can report whether the playback
            // token had already lapsed by the time we hit the CDN.
            if (tokenExp) q.tokenExp = tokenExp.toISOString();
            if (!q.headers && from.pageUrl && from.platform !== 'youtube' && q.kind !== 'vimeo-json') {
              q.headers = { Referer: from.pageUrl };
            }
          });
          return qualities;
        };

        try {
          const { qualities, title } = await resolveQualities(video);
          if (title && !video.title) video.title = title;
          sendResponse({ ok: true, qualities: stamp(qualities, video), title: video.title });
        } catch (e) {
          // Hash presence is the first thing to check on a Vimeo failure.
          const hash = video.platform === 'vimeo' && !video.jsonPlaylist ? ` (h=${video.hParam ? 'yes' : 'no'})` : '';
          // A Vimeo embed we can't read is not the end of it when the player's
          // own stream was captured: that capture is signed for playback and is
          // the whole reason the error tells people to press play. Normally the
          // frame link has already merged the two, so this only fires when the
          // iframe loaded unseen — but that is exactly the case where the row
          // the customer clicks is the one that cannot work.
          const captures = vimeoStandIns(video, listVideos(tabId));
          if (captures.length === 1) {
            try {
              const rescue = await resolveVimeoJsonQualities(captures[0].url);
              svdLog('resolve', `vimeo${hash}: ${e.message} — resolved from the captured stream instead`);
              sendResponse({ ok: true, qualities: stamp(rescue, captures[0]), title: video.title });
              return;
            } catch (e2) {
              svdLog('resolve', `vimeo fallback to captured stream failed: ${e2.message}`);
            }
          }
          svdLog('resolve', `${video.platform}${hash}: ${e.message}`);
          // With several captured streams on the page there is no safe way to
          // pick one, so name the row that works rather than repeating advice
          // the customer has already followed.
          const error = captures.length > 1
            ? `${e.message} This lesson's stream was captured — pick the “Vimeo (from player)” entry in the list instead.`
            : e.message;
          sendResponse({ ok: false, error });
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

    case 'BULK_PREFLIGHT':
      (async () => {
        try {
          const { group, courseSlug } = parseClassroomUrl(req.url);
          if (!courseSlug) { sendResponse({ ok: false, code: 'not-a-course' }); return; }
          const scan = await scanCourse(group, courseSlug);
          const manifest = await loadManifest(group, courseSlug);
          const merged = mergeManifest(manifest, scan.lessons);
          const want = { video: true, notes: true, files: true };
          const remaining = merged.filter(l =>
            lessonNeedsWork(l.priorAssets, want, parseResources(l.resourcesRaw).files.map(f => f.fileId))).length;
          sendResponse({ ok: true, group, courseSlug, courseTitle: scan.courseTitle,
            shape: scan.shape, moduleCount: scan.moduleCount, total: scan.lessons.length,
            alreadySaved: scan.lessons.length - remaining, remaining });
        } catch (e) {
          sendResponse({ ok: false, code: e instanceof BulkError ? e.code : 'network', message: e.message });
        }
      })();
      return true;

    case 'START_BULK':
    case 'RESUME_BULK':
      (async () => {
        // Gated here as well as in the popup: a UI-only check is not a gate.
        const { tier } = await getLicenseStatus();
        if (tier !== 'lifetime' && tier !== 'monthly') { sendResponse({ ok: false, code: 'pro-required' }); return; }
        // Two popups (or two windows) can each send a start. Without this the
        // second orchestrator races the first over the same manifest and
        // downloads every remaining lesson twice.
        if (bulkRunActive) { sendResponse({ ok: false, code: 'already-running' }); return; }
        sendResponse({ ok: true, started: true });
        try {
          // START and RESUME are the same call: the skip decision comes from the
          // manifest, so resuming is running again. Both cases exist only so the
          // popup can label the button honestly.
          await runBulkCourse({
            group: req.group, courseSlug: req.courseSlug,
            want: req.want || { video: true, notes: true, files: true },
          });
        } catch (e) {
          const code = e instanceof BulkError ? e.code : 'network';
          await setBulkState({ phase: 'error', code, message: e.message });
          bulkBroadcast({ type: 'BULK_DONE', error: code, message: e.message });
        }
      })();
      return true;

    case 'PAUSE_BULK':
      bulkAbort.pause = true;
      sendResponse({ ok: true });
      return false;

    case 'CANCEL_BULK':
      bulkAbort.cancel = true;
      // Cancelling stops the run but keeps the manifest — it means "stop", not
      // "throw away what I already downloaded". The in-flight download is
      // cancelled too: the loop only checks the abort flags between lessons, so
      // without this a cancel would sit through the rest of a long video.
      if (bulkCurrentJobId !== null) cancelJob(bulkCurrentJobId);
      sendResponse({ ok: true });
      return false;

    case 'GET_BULK_STATE':
      getBulkState().then(state => sendResponse({ ok: true, state }));
      return true;

    case 'CLEAR_MANIFEST':
      clearManifest(req.group, req.courseSlug).then(() => sendResponse({ ok: true }));
      return true;
  }
  return true;
});

// ── Bulk course backup ────────────────────────────────────────────────────────
// One authenticated fetch of a classroom course page enumerates every lesson, so
// this runs entirely here — no tab to drive, no page to keep focused. Each
// lesson's media is resolved immediately before it downloads, never in a
// preflight sweep: a lesson page is around half a megabyte, and playback tokens
// expire in about a day.

const BULK_FETCH_TIMEOUT_MS = 30000;

// Every network call carries a timeout. A probe with no deadline is worse than
// the guess it replaced, because it can hang a run with no way out.
async function bulkFetch(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs || BULK_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { credentials: 'include', ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

class BulkError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Fetches a Skool page and returns its server props, plus the URL we ended up on.
// The final URL matters: a signed-out request for a classroom page is answered
// with a redirect to the community's about page rather than an error.
async function fetchPageProps(url) {
  const res = await bulkFetch(url);
  const html = await res.text();
  return {
    finalUrl: res.url, status: res.status, pageProps: extractPageProps(html),
    // Kept for diagnostics only. Every scan failure below tells the user to send
    // a problem report, and "the page format changed" is unactionable without
    // some evidence of what actually arrived — an error page, a login wall and a
    // genuine schema change are three different fixes and look identical here.
    bytes: html.length,
  };
}

// Where a redirect landed, minus the query string. A scan failure is almost
// always a redirect somewhere unexpected, and the path is what identifies it.
function bulkPathOf(url) {
  try { return new URL(url).pathname.slice(0, 80); } catch { return String(url).slice(0, 80); }
}

// Enumerate a course. Distinguishes four outcomes that all look like "no
// lessons" if you only count them.
async function scanCourse(group, courseSlug) {
  let probe;
  try {
    probe = await fetchPageProps(courseUrlFor(group, courseSlug));
  } catch (e) {
    // A timeout and a dropped connection are both AbortError-ish here; the
    // message is the only thing that tells them apart in a report.
    bulkLog(`scan fetch failed: ${e.name}: ${String(e.message).slice(0, 120)}`);
    throw new BulkError('network', 'Could not reach Skool. Check your connection and try again.');
  }

  const { finalUrl, status, pageProps, bytes } = probe;
  // One line describing what came back, logged only when the scan fails. On a
  // healthy run the start line in runBulkCourse says everything this would.
  const shape = () => `HTTP ${status} ${bulkPathOf(finalUrl)} ${bytes}b props=${pageProps ? 'yes' : 'no'}`;

  if (!finalUrl.includes('/classroom/')) {
    // Signed out: Skool answers a classroom URL with the community about page.
    bulkLog(`scan redirected off /classroom/ — ${shape()}`);
    throw new BulkError('not-signed-in', 'Sign in to Skool in this browser, then try again.');
  }
  if (status === 429) {
    bulkLog(`scan rate-limited — ${shape()}`);
    throw new BulkError('rate-limited', 'Skool is rate-limiting this browser. Wait a few minutes and try again.');
  }
  if (!pageProps) {
    // No __NEXT_DATA__ at all: an error page, an interstitial, or a real change.
    bulkLog(`scan found no page data — ${shape()}`);
    throw new BulkError('schema-drift', 'Skool\'s page format changed. Please send a problem report.');
  }
  if (pageProps.self == null) {
    bulkLog(`scan has page data but no signed-in user — ${shape()}`);
    throw new BulkError('not-signed-in', 'Sign in to Skool in this browser, then try again.');
  }

  const tree = courseTreeFromPageProps(pageProps, group, courseSlug);
  if (!tree.ok) {
    // tree.detail is the whole reason the walk reports a code rather than
    // throwing: it names which of the two indistinguishable cases this is, and
    // for drift, what the walk actually saw.
    bulkLog(`scan ${tree.code}: ${tree.detail || 'no detail'} — ${shape()}`);
    if (tree.code === 'empty-course') throw new BulkError('empty-course', 'This course has no lessons yet.');
    throw new BulkError('schema-drift', 'Skool\'s page format changed. Please send a problem report.');
  }

  return { ...tree, group, courseSlug };
}

// Resolve one lesson to something downloadable, called immediately before the
// download itself rather than in a preflight sweep — a lesson page is around
// half a megabyte and a playback token expires in about a day.
//
// Embed platforms go through the existing resolvers, so a bulk download and a
// single-lesson download of the same video cannot drift apart.
//
// → { kind: 'qualities', qualities, platform }
//   { kind: 'link', url }        YouTube — handed off, not downloaded
//   { kind: 'notes-only' }       a text lesson
//   { kind: 'skip', reason, detail? }
//
// Every skip carries a reason that survives into the run tally, and `detail`
// carries the one worked example the report shows for that reason. A skip whose
// reason is 'unknown' settles permanently (SETTLED_SKIP_KINDS); every other
// reason here stays retryable, because access, network and Skool's own schema
// can all change between runs.
async function resolveBulkLesson(lesson) {
  switch (lesson.sourceKind) {
    case SOURCE.NATIVE: {
      const { pageProps, status, finalUrl } = await fetchPageProps(lesson.lessonUrl);
      if (!pageProps) {
        return { kind: 'skip', reason: 'schema-drift',
          detail: `lesson page had no data (HTTP ${status} ${bulkPathOf(finalUrl)})` };
      }
      const play = nativePlaybackFrom(pageProps);
      // §2.5: on a locked lesson playbackId, status:"ready" and duration are all
      // still present and only the token is missing. Not settling means a later
      // run retries it once the user gains access.
      if (!play.ok) return { kind: 'skip', reason: 'locked' };

      // Both hosts serve the same signed playlist; the fallback covers one of
      // them going away. Neither needs a Referer.
      //
      // Resolving IS the probe: the plan fetched the master once to test it and
      // then let the resolver fetch it again. On a 40-lesson course that is 40
      // wasted round trips against a token that is already ticking.
      let qualities = null, firstError = null;
      for (const url of [play.masterUrl, play.fallbackUrl]) {
        try {
          const resolved = await resolveQualities({ platform: 'skool', url });
          qualities = resolved?.qualities || [];
          if (qualities.length) break;
        } catch (e) {
          firstError = firstError || e;
          qualities = null;
        }
      }
      if (!qualities || !qualities.length) {
        return { kind: 'skip', reason: 'no-qualities',
          detail: firstError ? `both playback hosts failed: ${String(firstError.message).slice(0, 90)}`
                             : 'playlist listed no renditions' };
      }
      // The description comes back on this same page, so a native lesson never
      // needs the extra fetch the notes step would otherwise make.
      const meta = findLessonMeta(pageProps, lesson.lessonId);
      return { kind: 'qualities', qualities, platform: 'skool',
        desc: typeof meta?.desc === 'string' ? meta.desc : null };
    }

    case SOURCE.LOOM:
    case SOURCE.VIMEO:
    case SOURCE.WISTIA: {
      if (!lesson.sourceRef) return { kind: 'skip', reason: 'missing-source' };
      const sourceId = embedSourceId(lesson.sourceKind, lesson.sourceRef);
      if (!sourceId) {
        // The host was recognised but the id was not. That is a URL shape we
        // have not seen, and the link itself is the only useful thing to report.
        return { kind: 'skip', reason: 'missing-source',
          detail: `no ${lesson.sourceKind} id in ${String(lesson.sourceRef).slice(0, 90)}` };
      }
      let resolved;
      try {
        resolved = await resolveQualities({
          platform: lesson.sourceKind, sourceId, pageUrl: lesson.lessonUrl,
        });
      } catch (e) {
        return { kind: 'skip', reason: 'no-qualities',
          detail: `${lesson.sourceKind}: ${String(e.message).slice(0, 90)}` };
      }
      const qualities = resolved?.qualities || [];
      if (!qualities.length) {
        return { kind: 'skip', reason: 'no-qualities', detail: `${lesson.sourceKind} returned no renditions` };
      }
      return { kind: 'qualities', qualities, platform: lesson.sourceKind };
    }

    case SOURCE.YOUTUBE:
      return lesson.sourceRef ? { kind: 'link', url: lesson.sourceRef } : { kind: 'skip', reason: 'missing-source' };

    case SOURCE.TEXT:
      return { kind: 'notes-only' };

    default:
      // An embed host the course tree could not name. Nothing can download it,
      // so this is one of the few skips that settles for good.
      return { kind: 'skip', reason: 'unknown',
        detail: `unrecognised source ${String(lesson.sourceKind).slice(0, 40)}` };
  }
}

// The description of one lesson, read from that lesson's own page.
//
// The classroom tree carries `desc` only for the lesson Skool has selected, so
// the scan sees no description for every other lesson in the course. Reading it
// from the scan means a course backup saves notes for one lesson and silently
// none for the rest — no error, no empty file, just absent notes that look like
// lessons that never had any.
//
// Returns null when the page genuinely has no description, and throws only on a
// transport failure, so a caller can tell "no notes" from "could not check".
async function fetchLessonDesc(lesson) {
  const { pageProps } = await fetchPageProps(lesson.lessonUrl);
  if (!pageProps) return null;
  const meta = findLessonMeta(pageProps, lesson.lessonId);
  return typeof meta?.desc === 'string' ? meta.desc : null;
}

// The embed resolvers take a platform id, not a URL, so pull the id back out of
// the link the course tree gave us. Returning null rather than guessing is the
// point: a wrong id resolves to someone else's video, which is far worse than a
// named skip.
function embedSourceId(platform, url) {
  const s = String(url || '');
  let m;
  if (platform === SOURCE.LOOM) { m = /(?:share|embed)\/([0-9a-f]{20,})/i.exec(s); return m ? m[1] : null; }
  if (platform === SOURCE.VIMEO) { m = /vimeo\.com\/(?:video\/)?(\d{6,})/i.exec(s); return m ? m[1] : null; }
  if (platform === SOURCE.WISTIA) { m = /(?:medias|iframe)\/([A-Za-z0-9]{8,})/i.exec(s); return m ? m[1] : null; }
  return null;
}

// ── Asset writers ─────────────────────────────────────────────────────────────
// Everything here is small: notes, an attachment, a pointer file. The videos go
// through the download queue instead.
//
// Every writer WAITS for the download to reach 'complete' before returning. The
// caller records the asset in the manifest the moment the writer resolves, and a
// manifest entry means "this is on disk, never fetch it again" — so returning on
// the download id alone would record a file that a disk-full or interrupted save
// never actually wrote, and no later run would ever retry it.

// A small text file goes to disk as a data URL: a service worker has no
// URL.createObjectURL, and these are kilobytes.
function textDataUrl(text, mime) {
  // UTF-8 safe (btoa alone chokes on non-Latin1), and chunked so
  // String.fromCharCode never sees an argument list it cannot take.
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

// Promise form with an explicit lastError check: chrome.downloads.download
// reports a refused download through lastError, and reading it is what stops a
// refusal being mistaken for a successful save.
function startDownload(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (id) => {
      if (chrome.runtime.lastError || id === undefined) {
        reject(new BulkError('save-failed', chrome.runtime.lastError?.message || 'download rejected'));
      } else resolve(id);
    });
  });
}

// 'overwrite', not 'uniquify'. Paths are already unique within a run (see
// bulkLessonBase), so a conflict here means a file from an earlier run — and we
// only reach this line when the manifest says that asset is NOT settled, i.e.
// the earlier file is missing or stale. Uniquify would leave the stale copy and
// quietly accumulate "notes (1).md", "notes (2).md" beside it, while the
// manifest recorded the path we asked for rather than the one Chrome wrote.
const BULK_CONFLICT_ACTION = 'overwrite';

async function saveTextFile(path, text, mime) {
  const downloadId = await startDownload({
    url: textDataUrl(text, mime),
    filename: path,
    conflictAction: BULK_CONFLICT_ACTION,
    saveAs: false,
  });
  const { state, error } = await waitForDownloadEnd(downloadId);
  if (state !== 'complete') throw new BulkError('save-failed', saveFailureMessage(state, error));
  return downloadId;
}

// Mint a signed URL for one attachment. 403 and 423 both mean the account cannot
// have this file right now.
//
// That is recorded as a skip, not a failure — but it deliberately does NOT
// settle (see SETTLED_SKIP_KINDS): 423 is Locked, and both it and 403 can turn
// into a granted file once the user's access changes. Retrying one attachment on
// a later run costs one request; settling it wrongly costs the file for good.
async function fetchAttachmentUrl(fileId) {
  if (!FILE_ID_RE.test(fileId)) throw new BulkError('attachment-forbidden', 'Malformed attachment id.');
  const res = await bulkFetch(`https://api2.skool.com/files/${fileId}/download-url?expire=28800`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  if (res.status === 403 || res.status === 423) {
    throw new BulkError('attachment-forbidden', `This attachment is not available to your account (${res.status}).`);
  }
  if (!res.ok) throw new BulkError('network', `Attachment link failed (${res.status}).`);

  const body = (await res.text()).trim();
  // The endpoint answers with the bare URL, but a JSON envelope is the obvious
  // way for it to change, and quietly downloading "{"url":..." as a filename is
  // worse than either. Accept both shapes, and put what did arrive in the error
  // when it is neither — otherwise the report says only "could not be read".
  let url = body;
  if (body.startsWith('{') || body.startsWith('"')) {
    try {
      const parsed = JSON.parse(body);
      url = typeof parsed === 'string' ? parsed : (parsed?.url || parsed?.downloadUrl || '');
    } catch { url = ''; }
  }
  if (!/^https:\/\/\S+$/i.test(url)) {
    throw new BulkError('network', `The attachment link could not be read (got ${JSON.stringify(body.slice(0, 60))}).`);
  }
  return url;
}

async function saveAttachment(fileId, path) {
  const url = await fetchAttachmentUrl(fileId);
  const downloadId = await startDownload({
    url, filename: path, conflictAction: BULK_CONFLICT_ACTION, saveAs: false,
  });
  const { state, error } = await waitForDownloadEnd(downloadId);
  if (state !== 'complete') throw new BulkError('save-failed', saveFailureMessage(state, error));
  return downloadId;
}

// A YouTube-hosted lesson cannot be downloaded in the browser, so record where it
// lives instead of failing. Windows opens a .url file directly; elsewhere it is
// still readable text naming the URL.
function youtubeShortcut(url) {
  return `[InternetShortcut]\r\nURL=${url}\r\n`;
}

function saveYoutubeStub(base, url) {
  return saveTextFile(`${base}.url`, youtubeShortcut(url), 'text/plain');
}

// ── Manifest store (G1/G2) ────────────────────────────────────────────────────
// storage.local, so the record of completed work survives a browser restart. The
// live progress lives in storage.session and is disposable; this is not.

function manifestKey(group, courseSlug) { return `bulk:${group}/${courseSlug}`; }

// Always returns a usable shape. A record that survived a partial write, or an
// older layout, must not crash every later read — the manifest IS the record of
// completed work, and a throw here would look like "nothing was ever saved".
function normalizeManifest(m) {
  const lessons = (m && typeof m === 'object' && m.lessons && typeof m.lessons === 'object') ? m.lessons : {};
  return { ...(m && typeof m === 'object' ? m : {}), lessons };
}

async function loadManifest(group, courseSlug) {
  const key = manifestKey(group, courseSlug);
  try {
    const got = await chrome.storage.local.get(key);
    return normalizeManifest(got[key]);
  } catch (e) {
    // Reporting an empty manifest here would re-download the whole course, so
    // the failure has to be visible rather than absorbed.
    bulkLog(`manifest read failed for ${courseSlug}: ${String(e.message).slice(0, 80)}`);
    return { lessons: {} };
  }
}

async function saveManifest(group, courseSlug, manifest) {
  await chrome.storage.local.set({
    [manifestKey(group, courseSlug)]: { ...normalizeManifest(manifest), updatedAt: Date.now() },
  });
}

async function clearManifest(group, courseSlug) {
  await chrome.storage.local.remove(manifestKey(group, courseSlug));
}

// Every manifest write is read-modify-write on one storage key, so two
// overlapping calls both read the same object and the second's set() discards
// the first's asset. The debug log above was bitten by exactly this, and here it
// would cost a file the user believes is saved. Chain every write onto the last.
let manifestChain = Promise.resolve();
function withManifestWrite(fn) {
  const run = manifestChain.then(fn, fn);
  manifestChain = run.then(() => {}, () => {});
  return run;
}

// Record one asset immediately. Written per asset rather than per lesson so a run
// killed mid-lesson does not lose the attachment it just saved.
function recordAsset(group, courseSlug, lessonId, patch) {
  return withManifestWrite(async () => {
    const manifest = await loadManifest(group, courseSlug);
    const prev = manifest.lessons[lessonId] || { assets: {} };
    const assets = { ...normalizeAssets(prev) };
    if (patch.video) assets.video = patch.video;
    if (patch.notes) assets.notes = patch.notes;
    if (patch.file) assets.files = { ...assets.files, [patch.file.fileId]: patch.file.slot };
    manifest.lessons[lessonId] = {
      ...prev,
      assets,
      status: patch.status ?? prev.status ?? null,
      reason: patch.reason ?? prev.reason ?? null,
    };
    await saveManifest(group, courseSlug, manifest);
  });
}

// Drop manifest entries whose file the user has since deleted, so a resume redoes
// them. Three cases, and the third is the one that matters:
//
//   record found, exists true  → the file is there, skip it
//   record found, exists false → the user deleted it, redo that asset
//   no record at all           → the download history was cleared. That is
//                                UNKNOWN, not missing. Trust the manifest.
//
// Getting the third wrong turns "I cleared my downloads list" into a full
// re-download of a multi-gigabyte course. Reading `exists` any other way is
// meaningless: the browser does not watch for file removal, and calling search()
// is what triggers the check.
async function pruneDeletedAssets(group, courseSlug) {
  const manifest = await loadManifest(group, courseSlug);
  const ids = [];
  for (const rec of Object.values(manifest.lessons)) {
    const a = normalizeAssets(rec);
    for (const slot of [a.video, a.notes, ...Object.values(a.files)]) {
      if (slot && typeof slot.downloadId === 'number') ids.push(slot.downloadId);
    }
  }
  if (!ids.length) return manifest;

  const missing = new Set();
  let unknown = 0, failed = 0;
  for (const id of ids) {
    let items = [];
    try { items = await chrome.downloads.search({ id }); }
    catch { failed++; continue; }               // a failed check is not a deletion
    if (!items.length) { unknown++; continue; } // history cleared — trust the manifest
    if (items[0].exists === false) missing.add(id);
  }

  // Always logged, never conditionally: "it re-downloaded everything" and "it
  // skipped everything" are both explained by these counts, and a silent check
  // is indistinguishable from one that never ran.
  //
  // Measured 2026-08-04: Chrome does not revalidate DownloadItem.exists for
  // files removed outside the browser. Deleting three saved files and re-running
  // reported 0 deleted, and calling search() — which the API docs say triggers
  // an existence check — produced no onChanged and no change after 12 seconds,
  // in a freshly started browser. So this check finds a deleted file only when
  // Chrome has already noticed one, which in practice is rarely. It is kept
  // because a true `exists: false` is still worth acting on, but nothing may
  // promise the user that deleting a file gets it back: "Re-download everything"
  // is the path that actually works.
  bulkLog(`disk check: ${ids.length} recorded, ${missing.size} deleted, ${unknown} not in history, ${failed} unreadable`);
  if (!missing.size) return manifest;

  const drop = slot => (slot && missing.has(slot.downloadId)) ? null : slot;
  for (const [lessonId, rec] of Object.entries(manifest.lessons)) {
    const a = normalizeAssets(rec);
    const files = {};
    for (const [fid, slot] of Object.entries(a.files)) { const kept = drop(slot); if (kept) files[fid] = kept; }
    manifest.lessons[lessonId] = { ...rec, assets: { video: drop(a.video), notes: drop(a.notes), files } };
  }
  await withManifestWrite(() => saveManifest(group, courseSlug, manifest));
  return manifest;
}

// ── Run state (G2) ────────────────────────────────────────────────────────────
// Live progress only. It is fine to lose this — resumability is rebuilt from the
// manifest, never from here, which is what lets a run survive a browser restart.

const BULK_STATE_KEY = 'bulk_run';
let bulkAbort = { pause: false, cancel: false };
// The queue job the run is currently waiting on, or null. A course run holds at
// most one at a time, and CANCEL_BULK needs it to stop a download mid-file.
let bulkCurrentJobId = null;

async function getBulkState() {
  const got = await chrome.storage.session.get(BULK_STATE_KEY);
  return got[BULK_STATE_KEY] || null;
}
async function setBulkState(patch) {
  const prev = await getBulkState();
  const next = { ...(prev || {}), ...patch };
  await chrome.storage.session.set({ [BULK_STATE_KEY]: next });
  bulkBroadcast({ type: 'BULK_STATE', state: next });
  return next;
}
function bulkBroadcast(msg) { chrome.runtime.sendMessage(msg).catch(() => {}); }

// A run marked active with no orchestrator behind it is an interrupted run, not a
// live one. Called on worker startup so the popup can never show a progress bar
// that will not move again.
async function reconcileBulkStateOnStartup() {
  const state = await getBulkState();
  if (state && state.phase === 'running') {
    await setBulkState({ phase: 'interrupted' });
    // The user sees "interrupted" and can press Resume; the report needs to know
    // the worker died mid-run, which is otherwise indistinguishable from a run
    // that was never started.
    bulkLog(`run interrupted by a worker restart at ${state.done || 0}/${state.total || 0}`);
  }
}
reconcileBulkStateOnStartup();

// ── Orchestrator ──────────────────────────────────────────────────────────────

// Starting and resuming are the same operation. Because the skip decision is
// derived from the manifest rather than from a stored work list, "resume" is just
// "run again" — which is also why a resume picks up lessons the instructor added
// while the run was paused. There is deliberately no separate resume path to keep
// in sync.
async function runBulkCourse({ group, courseSlug, want }) {
  bulkAbort = { pause: false, cancel: false };
  const wanted = { video: !!want?.video, notes: !!want?.notes, files: !!want?.files };

  // Suppresses the per-download success line for the whole run. Cleared in the
  // finally below, including when the scan throws — leaving it set would silence
  // ordinary downloads for the rest of the browser session.
  bulkRunActive = true;
  try {
    return await runBulkCourseInner({ group, courseSlug, want: wanted });
  } catch (e) {
    // scanCourse already logged what it saw; this names the run that died and is
    // the only line saying a run ended without ever reaching its end line.
    bulkLog(`run aborted: ${e instanceof BulkError ? e.code : 'error'} — ${String(e.message).slice(0, 120)}`);
    await setBulkState({ phase: 'error', error: e.message });
    throw e;
  } finally {
    bulkRunActive = false;
    // A lesson that threw mid-download would otherwise leave a stale id here,
    // and the next cancel would kill an unrelated download.
    bulkCurrentJobId = null;
  }
}

async function runBulkCourseInner({ group, courseSlug, want }) {
  // Before the scan, not after: the scan is part of the run, and a log claiming
  // a 9-lesson backup took five milliseconds is not a log anyone can trust.
  const runStartedAt = Date.now();
  const scan = await scanCourse(group, courseSlug);
  // Prune before every run, not only on resume: a plain second run over the same
  // course is exactly when a user who deleted files expects them back.
  const manifest = await pruneDeletedAssets(group, courseSlug);
  const merged = mergeManifest(manifest, scan.lessons);

  const total = merged.length;
  const usedBases = new Set();
  const records = [];
  // Accumulates every failure reason for the whole run. Flushed to the debug log
  // once, at the end — see the logging rule.
  const runTally = reasonTally();

  // The run's fingerprint, logged before any work: which course, what shape, how
  // much of it, what was asked for, and how much a previous run had already
  // finished. Almost every report is unanswerable without this line, and it is
  // the one a per-lesson log would evict.
  bulkLog(bulkRunStartLine({
    courseTitle: scan.courseTitle, shape: scan.shape,
    moduleCount: scan.moduleCount, lessonCount: total, want,
    resumed: merged.filter(l => !lessonNeedsWork(l.priorAssets, want, [])).length,
  }));

  await setBulkState({
    phase: 'running', group, courseSlug, courseTitle: scan.courseTitle,
    total, done: 0, currentTitle: null, want, startedAt: runStartedAt,
  });

  // Reserve every base path up front so numbering and collision handling do not
  // depend on which lessons happen to be skipped this run.
  const lessonCountByModule = new Map();
  for (const l of merged) {
    const k = l.moduleIdx ?? 'root';
    lessonCountByModule.set(k, (lessonCountByModule.get(k) || 0) + 1);
  }
  // Most real courses give every module exactly one lesson. Keeping the module
  // folders there produces one folder per file, named after the file inside it.
  const flatten = shouldFlattenModules(merged);
  let ordinal = 0;
  for (const l of merged) {
    ordinal++;
    l.base = bulkLessonBase(flatten
      // Numbered across the whole course, since the module order that used to
      // carry the sequence is no longer in the path.
      //
      // Named after the module, not the lesson: the module title is what the
      // classroom sidebar shows and what the user recognises, and where a module
      // holds one lesson that lesson is very often called something generic like
      // "All files" or "New page". Dropping the folder must not drop the only
      // name that identified the thing.
      ? { courseTitle: scan.courseTitle, moduleIdx: null, moduleTitle: null, moduleCount: 0,
          lessonIdx: ordinal, lessonTitle: l.moduleTitle || l.title, lessonCount: merged.length }
      : { courseTitle: scan.courseTitle,
          moduleIdx: l.moduleIdx, moduleTitle: l.moduleTitle, moduleCount: scan.moduleCount,
          lessonIdx: l.lessonIdx, lessonTitle: l.title,
          lessonCount: lessonCountByModule.get(l.moduleIdx ?? 'root') || 1 },
      usedBases);
  }

  const youtubeIndex = [];
  let done = 0;

  for (const lesson of merged) {
    if (bulkAbort.cancel) break;
    if (bulkAbort.pause) {
      await setBulkState({ phase: 'paused', done });
      // A paused run never reaches the end line, so without this a report shows
      // a start line and nothing else, which reads exactly like a run that hung.
      bulkLog(`paused at ${done}/${total}`);
      return { paused: true };
    }

    const resources = parseResources(lesson.resourcesRaw);
    const wantedFileIds = resources.files.map(f => f.fileId);
    // A resource list that parsed to nothing usable is worth knowing about: the
    // lesson looks attachment-free and no failure is ever recorded for it.
    if (resources.dropped) tallyReason(runTally, 'resources-unreadable', `lesson "${String(lesson.title).slice(0, 40)}": ${resources.dropped} entr(ies) dropped`);

    if (!lessonNeedsWork(lesson.priorAssets, want, wantedFileIds)) {
      done++;
      records.push({
        status: lesson.priorStatus === 'skipped' ? 'skipped' : 'saved',
        reason: lesson.priorAssets.video?.skipped || null,
        title: lesson.title,
      });
      await setBulkState({ done, currentTitle: lesson.title, phase: 'running', lastLine: 'already saved — skipping' });
      continue;
    }

    await setBulkState({ done, currentTitle: lesson.title, phase: 'running', lastLine: 'resolving…' });

    // One lesson can never abort the course. Anything unhandled here becomes a
    // named failure on that lesson and the run continues.
    let record = { status: 'failed', reason: 'network' };
    try {
      record = await runBulkLesson({ group, courseSlug, lesson, want, resources, youtubeIndex, runTally });
    } catch (e) {
      record = { status: 'failed', reason: e instanceof BulkError ? e.code : 'network' };
      // Tallied, not logged: see the logging rule. One line per failing lesson
      // would push this run's start line out of the user's report.
      tallyReason(runTally, record.reason, `lesson "${String(lesson.title).slice(0, 60)}": ${e.message}`);
      await recordAsset(group, courseSlug, lesson.lessonId, { status: 'failed', reason: record.reason });
    }

    records.push({ ...record, title: lesson.title });
    done++;
    await setBulkState({ done, currentTitle: lesson.title, phase: 'running' });
  }

  const course = capSegment(scan.courseTitle, 100, 'skool-course');
  if (youtubeIndex.length) {
    try {
      await saveTextFile(`${course}/_youtube-lessons.txt`,
        youtubeIndex.map(y => `${y.title}\n${y.url}\n`).join('\n'), 'text/plain');
    } catch (e) {
      // Swallowing this would lose the only record of every YouTube lesson in the
      // course. The per-lesson .url stubs still exist, so it is not fatal.
      tallyReason(runTally, 'youtube-index', `index of ${youtubeIndex.length} lesson(s): ${e.message}`);
    }
  }

  const summary = runSummary(records);
  const cancelled = bulkAbort.cancel;

  // Two or three lines, whatever the course size: the counts, then the reasons
  // ranked by how many lessons each cost, then one worked example of each so a
  // reason like 'network' is not just a word. Logged even on a clean run — a
  // report that says "done 40les: 40 saved" answers its own question.
  bulkLog(`${bulkRunEndLine(summary)}${cancelled ? ' (cancelled)' : ''}`);
  // Skips already break out by reason in the end line above, so the tally is for
  // failures — plus anything tallied that never became a lesson-level failure at
  // all (an unreadable resource list, a missing YouTube index), which would
  // otherwise leave no trace anywhere.
  const tallied = describeTally(runTally);
  const examples = tallyExamples(runTally);
  if (tallied !== 'none') {
    bulkLog(`fail reasons: ${tallied}`);
    if (examples) bulkLog(`e.g. ${examples}`);
  }

  // A per-lesson log in the course folder. The debug log a report carries is ten
  // lines for the whole browser session, which cannot describe a 40-lesson run —
  // and "it missed a section" is unanswerable without knowing what the run
  // decided for each lesson. Written from the manifest, so it describes what is
  // actually on disk rather than what this run happened to touch.
  try {
    await saveTextFile(`${course}/_download-log.txt`, runLogDocument({
      courseTitle: scan.courseTitle, group, courseSlug,
      version: chrome.runtime.getManifest().version,
      startedAt: runStartedAt, finishedAt: Date.now(), want,
      lessons: merged, manifest: await loadManifest(group, courseSlug),
      summary, reasons: tallied, examples, cancelled,
    }), 'text/plain');
  } catch (e) {
    // Never fatal: the run's real output is already on disk. But a run that
    // could not write its own log is worth one line, because the next question
    // asked will be "where is the log".
    bulkLog(`run log not written: ${String(e.message).slice(0, 100)}`);
  }

  await setBulkState({ phase: cancelled ? 'cancelled' : 'completed', done, summary });
  bulkBroadcast({ type: 'BULK_DONE', cancelled, summary, courseTitle: scan.courseTitle,
    failedDetail: records.filter(r => r.status === 'failed').map(r => ({ title: r.title, reason: r.reason })) });
  return { summary, cancelled };
}

// One lesson: video, then notes, then attachments. Each asset is recorded the
// moment it lands.
async function runBulkLesson({ group, courseSlug, lesson, want, resources, youtubeIndex, runTally }) {
  const base = lesson.base;
  let status = 'saved', reason = null;
  // A description picked up while resolving the video, so the notes step below
  // does not fetch the same page a second time.
  let resolvedDesc = null;

  if (want.video && !isSettled(lesson.priorAssets.video)) {
    const resolved = await resolveBulkLesson(lesson);

    if (resolved.kind === 'skip') {
      // Kinds that can never succeed settle so they are not retried forever;
      // 'locked' stays open, because access can change.
      const settle = SETTLED_SKIP_KINDS.includes(resolved.reason);
      await recordAsset(group, courseSlug, lesson.lessonId, {
        status: 'skipped', reason: resolved.reason,
        video: settle ? { skipped: resolved.reason } : undefined,
      });
      // The reason alone is a word; resolveBulkLesson's detail is the worked
      // example that makes it actionable in a report.
      tallyReason(runTally, resolved.reason, resolved.detail || `lesson "${String(lesson.title).slice(0, 60)}"`);
      status = 'skipped'; reason = resolved.reason;

    } else if (resolved.kind === 'link') {
      youtubeIndex.push({ title: lesson.title, url: resolved.url });
      await saveYoutubeStub(base, resolved.url);
      await recordAsset(group, courseSlug, lesson.lessonId, {
        status: 'skipped', reason: 'youtube', video: { skipped: 'youtube' },
      });
      status = 'skipped'; reason = 'youtube';

    } else if (resolved.kind === 'notes-only') {
      await recordAsset(group, courseSlug, lesson.lessonId, { video: { skipped: 'text' } });

    } else {
      resolvedDesc = resolved.desc ?? null;
      const quality = pickBestQuality(resolved.qualities);
      await setBulkState({ lastLine: 'downloading video…' });
      const out = await enqueueDownloadAwaited({
        // The STEM, with no extension: runJob appends .mp4 itself, so passing
        // "<base>.mp4" here writes "<base>.mp4.mp4".
        quality, filename: base,
        // tabId null: chrome.tabs.onRemoved cancels active jobs by matching
        // meta.tabId, and a headless course run must not die with a tab.
        //
        // mode is deliberately omitted rather than set to a bulk-specific value.
        // The queue reads it as "single-rendition, free" — a truthy unknown value
        // silently skips the pre-merge SIMD check (background.js, runJob), which
        // is the guard that turns an unsupported CPU into a clear message instead
        // of a failure deep inside ffmpeg. decrementCredit already no-ops for the
        // paid tiers this feature requires, so omitting it costs nothing.
        tabId: null, platform: resolved.platform, label: lesson.title,
        onJobId: (id) => { bulkCurrentJobId = id; },
      });
      bulkCurrentJobId = null;
      if (out.ok) {
        await recordAsset(group, courseSlug, lesson.lessonId, {
          status: 'saved', video: { path: `${base}.mp4`, downloadId: out.downloadId, savedAt: Date.now() },
        });
      } else if (out.cancelled) {
        return { status: 'failed', reason: 'cancelled' };
      } else {
        await recordAsset(group, courseSlug, lesson.lessonId, { status: 'failed', reason: 'download' });
        tallyReason(runTally, 'download', `lesson "${String(lesson.title).slice(0, 60)}": ${out.error || 'download failed'}`);
        status = 'failed'; reason = 'download';
      }
    }
  }

  if (bulkAbort.pause || bulkAbort.cancel) return { status, reason };

  if (want.notes && !isSettled(lesson.priorAssets.notes)) {
    // The scan's copy is only trustworthy when it is non-empty: the classroom
    // tree omits `desc` for every lesson except the selected one, so an absent
    // description there means "not included", not "none". Fetching the lesson's
    // own page is the only way to tell those apart.
    let descRaw = lesson.descRaw || resolvedDesc;
    if (!descRaw) {
      try {
        descRaw = await fetchLessonDesc(lesson);
      } catch (e) {
        // Not a lesson-level failure — the video and attachments may well have
        // saved. Tallied so a run that lost notes says so somewhere.
        tallyReason(runTally, 'notes-unreachable', `lesson "${String(lesson.title).slice(0, 40)}": ${e.message}`);
      }
    }
    const markdown = descToMarkdown(descRaw);
    if (markdown || resources.links.length) {
      const doc = notesDocument({ title: lesson.title, lessonUrl: lesson.lessonUrl, markdown, links: resources.links });
      const id = await saveTextFile(`${base}.md`, doc, 'text/markdown');
      await recordAsset(group, courseSlug, lesson.lessonId, { notes: { path: `${base}.md`, downloadId: id, savedAt: Date.now() } });
    } else {
      await recordAsset(group, courseSlug, lesson.lessonId, { notes: { skipped: 'none' } });
    }
  }

  if (want.files) {
    // Two attachments on one lesson may share a label; without this set the
    // second silently overwrites the first. Scoped per lesson, and seeded with
    // what a previous run already wrote: a settled attachment is skipped below,
    // so without seeding a resume would hand its name to the next same-labelled
    // file and overwrite it on disk.
    // Seeded with the filesystem's idea of each name, matching how claimUnique
    // stores them — seeding raw paths would leave a previously written file
    // invisible to the collision check and let this run overwrite it.
    const usedAttachmentNames = new Set(
      Object.values(lesson.priorAssets.files || {}).map(s => s?.path).filter(Boolean).map(fsKey));
    for (const file of resources.files) {
      if (bulkAbort.cancel) break;
      if (isSettled(lesson.priorAssets.files[file.fileId])) continue;
      const path = attachmentFilename(base, file, usedAttachmentNames);
      try {
        await setBulkState({ lastLine: `attachment: ${file.label}` });
        const id = await saveAttachment(file.fileId, path);
        await recordAsset(group, courseSlug, lesson.lessonId, { file: { fileId: file.fileId, slot: { path, downloadId: id, savedAt: Date.now() } } });
      } catch (e) {
        const code = e instanceof BulkError ? e.code : 'network';
        // Forbidden is recorded as a skip, but deliberately does not settle:
        // 403/423 can become a granted file when the user's access changes.
        await recordAsset(group, courseSlug, lesson.lessonId, {
          file: { fileId: file.fileId, slot: code === 'attachment-forbidden' ? { skipped: code } : null },
        });
        // Tallied under its own reason key so an attachment problem is never
        // mistaken for the lesson's video failing.
        tallyReason(runTally, `attachment-${code}`, `attachment "${String(file.label).slice(0, 40)}": ${e.message}`);
      }
    }
  }

  return { status, reason };
}

// Highest resolution available, matching what a user picking manually would want
// from a course backup.
function pickBestQuality(qualities) {
  return [...qualities].sort((a, b) => (b.height || 0) - (a.height || 0))[0];
}
