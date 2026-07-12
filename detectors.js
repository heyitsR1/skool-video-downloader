// Platform quality resolvers. Each takes a detected video and returns a list of
// downloadable qualities:
//   { label, height, kind, videoUrl, audioUrl?, headers?, container }
// kind:
//   'mp4'   — single progressive file, save directly
//   'hls'   — HLS media playlists; videoUrl (+ optional audioUrl rendition)
//             are downloaded segment-by-segment and remuxed to MP4 in-browser
//   'merge' — separate video + audio files that need an in-browser remux
// Resolution happens lazily, when the user opens the quality picker, so a page
// full of embeds doesn't trigger a burst of API calls on load.

const PLATFORM_LABELS = {
  skool: 'Skool',
  loom: 'Loom',
  vimeo: 'Vimeo',
  youtube: 'YouTube',
  wistia: 'Wistia',
  hls: 'Video'
};

function heightLabel(h) {
  if (!h) return 'Auto';
  return `${h}p`;
}

// ── Skool native (Mux HLS) ──────────────────────────────────────────────────
// The master playlist was captured off the wire (webRequest); parse its
// variants into per-resolution qualities. Mux masters carry a separate audio
// rendition, so every quality is an HLS video+audio pair remuxed locally.
async function resolveMuxQualities(masterUrl, headers) {
  const res = await fetch(masterUrl);
  if (!res.ok) throw new Error(`Playlist fetch failed (${res.status}) — replay the video and try again`);
  const text = await res.text();
  const baseUrl = masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1);

  if (!text.includes('#EXT-X-STREAM-INF')) {
    // Already a media playlist — single muxed rendition.
    return [{ label: 'Original', height: 0, kind: 'hls', videoUrl: masterUrl, audioUrl: null, headers }];
  }

  let audioUrl = null;
  const audioLine = text.split('\n').find(l => l.includes('TYPE=AUDIO') && l.includes('URI="'));
  if (audioLine) {
    const m = audioLine.match(/URI="([^"]+)"/);
    if (m) audioUrl = resolveUrl(m[1], baseUrl);
  }

  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.includes('#EXT-X-STREAM-INF')) continue;
    const height = parseInt(line.match(/RESOLUTION=\d+x(\d+)/)?.[1] || '0', 10);
    const bandwidth = parseInt(line.match(/BANDWIDTH=(\d+)/)?.[1] || '0', 10);
    for (let j = i + 1; j < lines.length; j++) {
      const cand = lines[j].trim();
      if (cand && !cand.startsWith('#')) {
        out.push({ label: heightLabel(height), height, bandwidth, kind: 'hls', videoUrl: resolveUrl(cand, baseUrl), audioUrl, headers });
        break;
      }
    }
  }
  out.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  // De-dupe identical heights (Mux can list multiple bitrates per resolution).
  const seen = new Set();
  return out.filter(q => (seen.has(q.label) ? false : (seen.add(q.label), true)));
}

function resolveUrl(url, baseUrl) {
  if (url.startsWith('http')) return url;
  return url.startsWith('/') ? new URL(baseUrl).origin + url : new URL(url, baseUrl).href;
}

// ── Vimeo ───────────────────────────────────────────────────────────────────
// player.vimeo.com/video/<id>/config returns progressive MP4s and an HLS
// master. Domain-restricted embeds validate the Referer, so the caller applies
// a DNR rule that re-attaches the Skool page URL before fetching.
async function resolveVimeoQualities(sourceId, pageUrl, hParam) {
  const url = `https://player.vimeo.com/video/${sourceId}/config${hParam ? `?h=${hParam}` : ''}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Vimeo config fetch failed (${res.status}) — press play on the video first`);
  const cfg = await res.json();

  const out = [];
  const prog = cfg?.request?.files?.progressive || [];
  for (const f of prog) {
    out.push({ label: f.quality || heightLabel(f.height), height: f.height || 0, kind: 'mp4', videoUrl: f.url, container: 'mp4' });
  }

  // Newer players expose only avc/hevc "streams" + HLS. Fall back to HLS: the
  // default cdn's master playlist is parseable exactly like Mux.
  if (!out.length) {
    const hls = cfg?.request?.files?.hls;
    const cdnKey = hls?.default_cdn && hls?.cdns?.[hls.default_cdn] ? hls.default_cdn : Object.keys(hls?.cdns || {})[0];
    const masterUrl = hls?.cdns?.[cdnKey]?.url;
    if (masterUrl) {
      const qualities = await resolveMuxQualities(masterUrl, { Referer: pageUrl });
      return qualities;
    }
  }
  if (!out.length) throw new Error('No downloadable Vimeo streams found');
  out.sort((a, b) => b.height - a.height);
  return out;
}

// ── Wistia ──────────────────────────────────────────────────────────────────
// fast.wistia.net/embed/medias/<id>.json lists every transcoded asset with a
// direct URL (served as .bin but the bytes are the MP4).
async function resolveWistiaQualities(sourceId) {
  const res = await fetch(`https://fast.wistia.net/embed/medias/${sourceId}.json`);
  if (!res.ok) throw new Error(`Wistia media fetch failed (${res.status})`);
  const data = await res.json();
  const assets = data?.media?.assets || [];
  const out = [];
  for (const a of assets) {
    if (!a.url || !/mp4/.test(a.type || '') && a.type !== 'original') continue;
    if (a.type && /audio|caption|storyboard|still/i.test(a.type)) continue;
    out.push({
      label: a.display_name || heightLabel(a.height),
      height: a.height || 0,
      kind: 'mp4',
      videoUrl: a.url,
      container: 'mp4',
      size: a.size || 0
    });
  }
  if (!out.length) throw new Error('No downloadable Wistia assets found');
  out.sort((a, b) => b.height - a.height);
  const seen = new Set();
  return out.filter(q => (seen.has(q.label) ? false : (seen.add(q.label), true)));
}

// ── Loom ────────────────────────────────────────────────────────────────────
// The transcoded-url endpoint hands back a direct MP4 (CDN-signed). Session
// cookies ride along via credentials:'include', so member-only videos the user
// can watch resolve too. Loom serves one transcode; quality choice is Loom's.
async function resolveLoomQualities(sourceId) {
  const endpoints = [
    `https://www.loom.com/api/campaigns/sessions/${sourceId}/transcoded-url`,
    `https://www.loom.com/api/campaigns/sessions/${sourceId}/raw-url`
  ];
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ anonID: crypto.randomUUID(), deviceID: null, force_original: false, password: null })
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.url) {
        const isHls = data.url.includes('.m3u8');
        if (isHls) return await resolveMuxQualities(data.url, { Referer: `https://www.loom.com/share/${sourceId}` });
        return [{ label: 'Original', height: 0, kind: 'mp4', videoUrl: data.url, container: 'mp4' }];
      }
    } catch { /* try next endpoint */ }
  }
  throw new Error('Could not resolve this Loom video — open it on loom.com once, then retry');
}

// ── YouTube ─────────────────────────────────────────────────────────────────
// Innertube player API with a non-web client returns un-ciphered stream URLs.
// Progressive formats (video+audio muxed, ≤720p) download directly; adaptive
// pairs (1080p+) are fetched separately and remuxed in-browser.
// Client choice matters: most clients (web, android) now demand a PO token for
// playable stream URLs. IOS still hands back un-ciphered, PO-token-free URLs;
// ANDROID_VR is kept as a fallback but is bot-checked ("sign in to confirm")
// from many IPs as of 2026-07 (versions/ids mirror yt-dlp's INNERTUBE_CLIENTS).
// The player POST must NOT carry Chrome's automatic
// "Origin: chrome-extension://…" header — Google's edge hard-403s it (the
// "Sorry…" anti-abuse page) before Innertube ever sees the request. fetch()
// can't unset Origin (forbidden header), so a temporary DNR session rule
// scoped to this extension's own player-API requests strips it.
// >>> SVD_YT_BLOCK_START — Innertube YouTube resolver.
// The build script (scripts/build.mjs) replaces everything from this marker up to
// SVD_YT_BLOCK_END with a stub in the Chrome Web Store build, so that artifact
// ships no YouTube-download code and no youtubei/googlevideo references.
const YT_PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const YT_CLIENTS = [
  { clientId: 5, clientName: 'IOS', clientVersion: '21.02.3', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.5.0.22F76', userAgent: 'com.google.ios.youtube/21.02.3 (iPhone16,2; U; CPU iOS 18_5 like Mac OS X;)' },
  { clientId: 28, clientName: 'ANDROID_VR', clientVersion: '1.65.10', deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L', userAgent: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip' }
];

// Session (not dynamic) rule: never persisted, so a crash mid-resolve can't
// leave a stale header rule behind after browser restart.
const YT_ORIGIN_RULE_ID = 990001;
async function withoutExtensionOrigin(fn) {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [YT_ORIGIN_RULE_ID],
      addRules: [{
        id: YT_ORIGIN_RULE_ID,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Origin', operation: 'remove' }] },
        condition: { urlFilter: '||youtube.com/youtubei/', resourceTypes: ['xmlhttprequest', 'other'], initiatorDomains: [chrome.runtime.id] }
      }]
    });
  } catch { /* rule install failed — attempt the fetch anyway */ }
  try {
    return await fn();
  } finally {
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [YT_ORIGIN_RULE_ID] }).catch(() => {});
  }
}

async function ytPlayerResponse(videoId) {
  return withoutExtensionOrigin(() => ytPlayerResponseInner(videoId));
}

async function ytPlayerResponseInner(videoId) {
  let lastErr = 'unavailable';
  for (const client of YT_CLIENTS) {
    try {
      const { clientId, userAgent, ...ctx } = client;
      const body = {
        videoId,
        context: { client: { ...ctx, hl: 'en', gl: 'US' } },
        contentCheckOk: true,
        racyCheckOk: true
      };
      const res = await fetch(YT_PLAYER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent, 'X-Youtube-Client-Name': String(clientId), 'X-Youtube-Client-Version': client.clientVersion },
        body: JSON.stringify(body)
      });
      if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
      const data = await res.json();
      const status = data?.playabilityStatus?.status;
      if (status === 'OK' && data.streamingData) return data;
      lastErr = data?.playabilityStatus?.reason || status || 'unavailable';
    } catch (e) {
      lastErr = e.message;
    }
  }
  throw new Error(`YouTube refused playback (${lastErr})`);
}

async function resolveYouTubeQualities(sourceId) {
  const data = await ytPlayerResponse(sourceId);
  const sd = data.streamingData;
  const out = [];

  // Progressive: muxed video+audio, one fetch, no merge.
  for (const f of sd.formats || []) {
    if (!f.url || !/mp4/.test(f.mimeType || '')) continue;
    out.push({ label: `${f.qualityLabel || heightLabel(f.height)}`, height: f.height || 0, kind: 'mp4', videoUrl: f.url, container: 'mp4' });
  }

  // Adaptive: pick the best m4a audio, pair it with each mp4 video track.
  const adaptive = sd.adaptiveFormats || [];
  const audio = adaptive
    .filter(f => f.url && /^audio\/mp4/.test(f.mimeType || ''))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
  if (audio) {
    const seenH = new Set(out.map(q => q.height));
    const vids = adaptive
      .filter(f => f.url && /^video\/mp4/.test(f.mimeType || '') && f.height && !seenH.has(f.height))
      .sort((a, b) => b.height - a.height);
    const seen = new Set();
    for (const v of vids) {
      if (seen.has(v.height)) continue;
      seen.add(v.height);
      out.push({ label: `${v.qualityLabel || heightLabel(v.height)}`, height: v.height, kind: 'merge', videoUrl: v.url, audioUrl: audio.url, container: 'mp4' });
    }
  }

  if (!out.length) throw new Error('No downloadable YouTube streams (video may be DRM/age-restricted)');
  out.sort((a, b) => b.height - a.height);
  const title = data?.videoDetails?.title;
  return { qualities: out, title };
}
// <<< SVD_YT_BLOCK_END

// ── Dispatcher ──────────────────────────────────────────────────────────────
// Central entry: takes a registry video entry, returns { qualities, title? }.
async function resolveQualities(video) {
  switch (video.platform) {
    case 'skool':
    case 'hls':
      return { qualities: await resolveMuxQualities(video.url, video.headers) };
    case 'vimeo':
      return { qualities: await resolveVimeoQualities(video.sourceId, video.pageUrl, video.hParam) };
    case 'wistia':
      return { qualities: await resolveWistiaQualities(video.sourceId) };
    case 'loom':
      return { qualities: await resolveLoomQualities(video.sourceId) };
    case 'youtube':
      return await resolveYouTubeQualities(video.sourceId);
    default:
      throw new Error(`Unsupported platform: ${video.platform}`);
  }
}
