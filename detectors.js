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
  // CDN-signed HLS (Loom's luna.loom.com, some Mux/Vimeo edges) carries the
  // CloudFront signature (Policy/Signature/Key-Pair-Id) as a query string on the
  // master URL only; the relative variant/audio/segment URIs inherit it. Carry
  // it down so signed children don't 403. resolveUrl only applies it to children
  // that have no query of their own, so already-tokenised Mux URLs are untouched.
  const parentQuery = (masterUrl.split('?')[1] || '');

  if (!text.includes('#EXT-X-STREAM-INF')) {
    // Already a media playlist — single muxed rendition.
    return [{ label: 'Original', height: 0, kind: 'hls', videoUrl: masterUrl, audioUrl: null, headers }];
  }

  let audioUrl = null;
  const audioLine = text.split('\n').find(l => l.includes('TYPE=AUDIO') && l.includes('URI="'));
  if (audioLine) {
    const m = audioLine.match(/URI="([^"]+)"/);
    if (m) audioUrl = resolveUrl(m[1], baseUrl, parentQuery);
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
        out.push({ label: heightLabel(height), height, bandwidth, kind: 'hls', videoUrl: resolveUrl(cand, baseUrl, parentQuery), audioUrl, headers });
        break;
      }
    }
  }
  out.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  // De-dupe identical heights (Mux can list multiple bitrates per resolution).
  const seen = new Set();
  return out.filter(q => (seen.has(q.label) ? false : (seen.add(q.label), true)));
}

function resolveUrl(url, baseUrl, parentQuery) {
  const abs = url.startsWith('http')
    ? url
    : (url.startsWith('/') ? new URL(baseUrl).origin + url : new URL(url, baseUrl).href);
  // Inherit the parent playlist's signing query only when the child carries
  // none of its own — this is how CDN-signed HLS (CloudFront) chains work.
  if (parentQuery && !abs.includes('?')) return `${abs}?${parentQuery}`;
  return abs;
}

// ── Vimeo ───────────────────────────────────────────────────────────────────
// player.vimeo.com/video/<id>/config returns progressive MP4s and an HLS
// master. Domain-restricted embeds validate the Referer, so the caller applies
// a DNR rule that re-attaches the Skool page URL before fetching.
//
// Any video that isn't fully public also needs its share hash (?h=), and there
// the id alone is not enough: Vimeo answers 403 `PrivacyError` — the same status
// a wrong hash gets, hence the two different messages below. Skool's own embed
// builder keeps only `pathname.split('/')[1]` of the link a creator pasted, so
// the iframe it renders carries no hash at all and this path cannot resolve
// those videos from /config alone.
//
// When /config refuses, the player PAGE is tried before giving up. Measured
// 2026-08-31 against a live course whose backup skipped all 20 Vimeo lessons:
// every video was "Hide from Vimeo" (privacy: "disable" — link-only viewing, no
// hash involved), /config answered 403 with and without a Skool Referer, yet
// player.vimeo.com/video/<id> served 200 with the full playerConfig inline —
// same JSON /config used to return, signed HLS/DASH masters included. That is
// how the video keeps playing for the member while /config dies, so the page is
// authoritative wherever the endpoint has been switched off.
async function resolveVimeoQualities(sourceId, pageUrl, hParam) {
  const url = `https://player.vimeo.com/video/${sourceId}/config${hParam ? `?h=${hParam}` : ''}`;
  const res = await fetch(url, { credentials: 'include' });
  let cfg;
  if (res.ok) {
    cfg = await res.json();
  } else {
    cfg = await fetchVimeoEmbedPageConfig(sourceId, hParam);
    // The original /config status carries the diagnosis (403 = privacy), so a
    // page that also refused reports the endpoint's error, not its own.
    if (!cfg) throw new Error(vimeoConfigError(res.status, hParam));
  }
  return await vimeoConfigQualities(cfg, pageUrl);
}

// The player iframe page, when /config has refused. Returns the parsed inline
// playerConfig, or null so the caller can fall back to the /config error — a
// genuinely private video refuses both, and the wire capture stays its only
// route.
async function fetchVimeoEmbedPageConfig(sourceId, hParam) {
  try {
    const res = await fetch(
      `https://player.vimeo.com/video/${sourceId}${hParam ? `?h=${hParam}` : ''}`,
      { credentials: 'include' }
    );
    if (!res.ok) return null;
    return vimeoInlinePlayerConfig(await res.text());
  } catch {
    return null;
  }
}

// `window.playerConfig = {…}` sits in its own inline <script>, the JSON object
// running to the closing tag (no trailing semicolon as served, but one is
// tolerated). Anything that doesn't parse is null, never a throw — the caller
// owns the error message.
function vimeoInlinePlayerConfig(html) {
  const at = String(html || '').indexOf('window.playerConfig');
  if (at === -1) return null;
  const eq = html.indexOf('=', at);
  const end = html.indexOf('</script>', at);
  if (eq === -1 || end === -1 || eq > end) return null;
  const raw = html.slice(eq + 1, end).trim().replace(/;$/, '');
  try { return JSON.parse(raw); } catch { return null; }
}

// Qualities out of a player config, wherever it came from (/config endpoint or
// the inline copy on the player page — same shape).
async function vimeoConfigQualities(cfg, pageUrl) {
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

// "Press play first" is the right advice here — but only because the wire
// capture below gives pressing play something to catch. Never say it for a
// status that playing the video can't change.
function vimeoConfigError(status, hParam) {
  if (status !== 403) return `Vimeo config fetch failed (${status})`;
  if (hParam) {
    return 'Vimeo rejected this video’s share link (403) — it may be restricted to '
      + 'certain sites. Press play on the video, let it start, then reopen this menu.';
  }
  return 'This Vimeo video is private, and the page embeds it without the share link '
    + 'needed to read it. Press play on the video, let it start playing, then reopen '
    + 'this menu — the player’s own stream is picked up automatically.';
}

// ── Vimeo (wire-captured DASH playlist) ─────────────────────────────────────
// Vimeo's player on Chrome streams DASH from a signed
// vimeocdn.com/…/v2/playlist/av/primary/playlist.json and never requests HLS, so
// this JSON is the only Vimeo manifest a Chrome capture can ever see (Safari
// would get the .m3u8 the config advertises). It is also the only route that
// works when the page hides the video's share hash: the URL is already signed
// for playback, and its segments serve 200 with no Referer and no cookies.
//
// Shape: { clip_id, base_url, video: [...], audio: [...] }, each rendition
// carrying { id, width, height, bitrate, base_url, init_segment (base64),
// segments: [{ url, size }] }. Every base_url is relative and they chain:
// playlist URL → top-level base_url → rendition base_url → segment url (whose
// own query string carries its signature, so relative resolution must keep it).
// Segments are fMP4, so init + segments concatenated is a playable track and
// video+audio go through the same ffmpeg remux as HLS.
async function resolveVimeoJsonQualities(playlistUrl) {
  const pl = await fetchVimeoPlaylist(playlistUrl);
  const audio = bestVimeoAudio(pl);
  const out = (pl.video || [])
    .filter(v => (v.segments || []).length)
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0))
    .map(v => ({
      label: heightLabel(v.height),
      height: v.height || 0,
      kind: 'vimeo-json',
      // Only identifiers travel on the quality — the segment lists are re-read
      // at download time. They can run to thousands of signed URLs per
      // rendition, and the playlist is signed with an expiry anyway, so a fresh
      // read beats shipping a stale copy through the popup and back.
      playlistUrl,
      videoTrackId: v.id,
      audioTrackId: audio ? audio.id : null,
      size: (v.segments || []).reduce((n, s) => n + (s.size || 0), 0)
        + (audio ? (audio.segments || []).reduce((n, s) => n + (s.size || 0), 0) : 0),
      container: 'mp4'
    }));
  if (!out.length) throw new Error('No downloadable Vimeo renditions in this stream');
  // De-dupe identical heights (Vimeo lists several bitrates per resolution).
  const seen = new Set();
  return out.filter(q => (seen.has(q.label) ? false : (seen.add(q.label), true)));
}

async function fetchVimeoPlaylist(playlistUrl) {
  const res = await fetch(playlistUrl);
  if (!res.ok) {
    throw new Error(res.status === 403 || res.status === 401
      ? 'This Vimeo stream link has expired. Reload the lesson page, press play again, then retry.'
      : `Vimeo playlist fetch failed (${res.status})`);
  }
  return await res.json();
}

// Vimeo flags every listenable track `audio_primary` (dubs and descriptions are
// the ones that aren't), so the flag narrows the field and bitrate picks within it.
function bestVimeoAudio(pl) {
  const tracks = (pl.audio || []).filter(a => (a.segments || []).length);
  const primary = tracks.filter(a => a.audio_primary);
  return (primary.length ? primary : tracks).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0] || null;
}

// Absolute, still-signed URLs for one track: the base64 init segment (fMP4
// moov, no request of its own) plus every media segment in order.
function vimeoTrackSegments(pl, playlistUrl, kind, trackId) {
  const track = (pl[kind] || []).find(t => t.id === trackId);
  if (!track) {
    throw new Error('This Vimeo rendition is no longer in the stream. Reload the lesson page, press play, then retry.');
  }
  const base = new URL(track.base_url || './', new URL(pl.base_url || './', playlistUrl).href).href;
  // init_segment (base64, saves a request) is what the player uses and what
  // Vimeo has always sent; init_segment_url is the documented alternative and
  // has been empty on every stream seen so far, so it stays a fallback.
  const init = track.init_segment || null;
  return {
    init,
    initUrl: !init && track.init_segment_url ? new URL(track.init_segment_url, base).href : null,
    urls: (track.segments || []).map(s => new URL(s.url, base).href),
    bytes: (track.segments || []).reduce((n, s) => n + (s.size || 0), 0)
  };
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
// raw-url returns a signed HLS master (the CloudFront signature is a query
// string on that URL; resolveMuxQualities propagates it down to the variant and
// segments). transcoded-url used to hand back a direct MP4 but Loom now answers
// it with 204 No Content for most videos, so raw-url is tried first. Session
// cookies ride along via credentials:'include', so member-only videos the user
// can watch resolve too — an anonymous request for a private video 404s, hence
// the "open it on loom.com once" hint.
// Cheap "is there really a video behind this URL?" probe. HEAD first; some CDNs
// don't answer it, so fall back to a 1-byte ranged GET, which still returns the
// full length in Content-Range.
//
// A URL we can't measure is allowed through. This check is an optimisation — it
// moves a known failure ahead of a long download — not the safety net; the size
// guard at save time is, and it sees the actual bytes. Refusing what we merely
// failed to measure would trade a rare bad file for blocking working downloads
// on any CDN that answers neither probe, which is the worse deal.
//
// 1MB, up from 64KB: Loom's DASH manifest for a 5-minute lesson measured 68KB —
// past the old floor — so "smaller than any real lesson video" has to clear
// manifests and stubs by a margin, not by 3%. A genuinely tiny real video is
// refused too, but its failure path is the press-play message, and the wire
// capture that pressing play arms is the route that always works.
const MIN_PLAUSIBLE_VIDEO_BYTES = 1024 * 1024;
async function isPlausiblyVideo(url) {
  const sizeOf = (res) => {
    if (!res.ok && res.status !== 206) return null;
    const range = res.headers.get('content-range');
    const fromRange = range && Number(range.split('/')[1]);
    if (Number.isFinite(fromRange) && fromRange > 0) return fromRange;
    const len = Number(res.headers.get('content-length'));
    return Number.isFinite(len) && len > 0 ? len : null;
  };
  for (const init of [{ method: 'HEAD' }, { method: 'GET', headers: { Range: 'bytes=0-0' } }]) {
    try {
      const size = sizeOf(await fetch(url, { ...init, credentials: 'include' }));
      if (size != null) return size >= MIN_PLAUSIBLE_VIDEO_BYTES;
    } catch { /* try the next probe */ }
  }
  return true; // unmeasurable — let it run; assertUsableVideo still has the last word
}

async function resolveLoomQualities(sourceId) {
  const endpoints = [
    `https://www.loom.com/api/campaigns/sessions/${sourceId}/raw-url`,
    `https://www.loom.com/api/campaigns/sessions/${sourceId}/transcoded-url`
  ];
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ anonID: crypto.randomUUID(), deviceID: null, force_original: false, password: null })
      });
      // 204 (transcoded-url's usual answer now) and other empty/non-OK bodies:
      // move on to the next endpoint rather than JSON-parsing an empty string.
      if (!res.ok || res.status === 204) continue;
      const text = await res.text();
      if (!text) continue;
      const data = JSON.parse(text);
      if (data?.url) {
        const isHls = data.url.includes('.m3u8');
        if (isHls) return await resolveMuxQualities(data.url, { Referer: `https://www.loom.com/share/${sourceId}` });
        // raw-url answers newer videos with a DASH manifest (…/dash/
        // playlistmultibitrate.mpd) instead of an HLS master. It is not a
        // video file, and it is not small either — a 5-minute lesson's
        // manifest measured 68,348 bytes of XML, which sails past the size
        // probe below and got saved as a broken 66.7KB ".mp4" (customer
        // report, 2026-08-25). Skip to transcoded-url, which serves the full
        // MP4 for these sessions.
        if (/\.mpd(\?|$)/.test(data.url)) continue;
        // Loom answers this endpoint for videos it won't actually serve us with
        // a token-sized stub — one customer got 24,877 bytes. Downloading it
        // takes a while and yields an unplayable file, so the size check that
        // used to happen at save time (after the wait) happens here instead: ask
        // the CDN how big it is before offering it as a download.
        if (!await isPlausiblyVideo(data.url)) continue;
        return [{ label: 'Original', height: 0, kind: 'mp4', videoUrl: data.url, container: 'mp4' }];
      }
    } catch { /* try next endpoint */ }
  }
  // Both endpoints refused, or answered with something that isn't a video. For
  // a Skool lesson the fix is almost always the player, not loom.com: pressing
  // play makes the extension capture the signed master the player itself is
  // handed, which is the only thing that works for private embeds.
  throw new Error(
    'This Loom video can’t be fetched directly — it’s private to the classroom. '
    + 'Press play on it in Skool, let it run for a few seconds, then open this extension again '
    + 'and download it. (If it still fails, open the video on loom.com once, logged in, and retry.)'
  );
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
  // Vimeo's wire capture is a DASH playlist.json, not an HLS master, so it has
  // to be claimed before the generic wire branch below would hand it to the
  // m3u8 parser.
  if (video.jsonPlaylist && video.url) {
    return { qualities: await resolveVimeoJsonQualities(video.url) };
  }
  // A captured progressive file (Loom's shorter sessions are one signed MP4, not
  // an HLS ladder). There is nothing to parse and no rendition to choose: the
  // URL the player streamed IS the download. Claimed before the wire branch
  // below, which would otherwise hand an MP4 to the m3u8 parser.
  if (video.progressive && video.url) {
    return { qualities: [{
      label: 'Original', height: 0, kind: 'mp4',
      videoUrl: video.url, container: 'mp4', headers: video.headers,
    }] };
  }
  // Wire captures (webRequest) carry the already-signed master playlist URL.
  // For private embeds that URL is the ONLY thing that works: it rides the
  // signature the player itself was granted, where the platform API returns
  // nothing usable. So a captured master always wins over an API lookup.
  //
  // This used to be gated on `!video.sourceId`, on the assumption that wire
  // entries never carry one. v1.3.4 broke that assumption — it started
  // recording the Loom session id on wire captures so the popup could name the
  // row — and silently routed every captured Loom back through the API path
  // this branch exists to avoid. Gate on what actually matters: whether we hold
  // a signed master. (jsonPlaylist captures were claimed above; anything still
  // carrying a `url` here is an HLS master off the wire, since the page-scan
  // detectors only ever produce a sourceId.)
  if (video.url) {
    return { qualities: await resolveMuxQualities(video.url, video.headers) };
  }
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
