#!/usr/bin/env node
// Smoke test for the two Vimeo resolution paths in the extension.
//
// Both exist because Vimeo needs a video's share hash (?h=) for anything that
// isn't fully public, and Skool's embed builder throws that hash away:
//   vimeo.com/<id>/<hash>  →  player.vimeo.com/video/<id>?autoplay=0&playsinline=1
// So this test pins down (a) that we recover the hash from every shape it can
// reach us in, and (b) that the wire-captured DASH playlist — the only route
// that needs no hash at all — parses and resolves its segment URLs correctly.
//
//   node scripts/vimeo-smoke.mjs
//
// Exit 0: every assertion holds and Vimeo's config endpoint still answers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ✓ ${label}`); return; }
  console.error(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`);
  failures++;
}

// Pull the real declarations out of the shipping sources so the test exercises
// what actually runs. Brace-counting from the declaration keeps this honest
// without a bundler.
function extract(file, names) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  let out = '';
  for (const name of names) {
    const decl = src.search(new RegExp(`^\\s*(?:async )?function ${name}\\(|^\\s*const ${name} = `, 'm'));
    if (decl === -1) { console.error(`✗ could not find ${name} in ${file} — source drifted`); process.exit(1); }
    if (/^\s*const /.test(src.slice(decl, src.indexOf('\n', decl)))) {
      out += src.slice(decl, src.indexOf('\n', decl)) + '\n';
      continue;
    }
    let i = src.indexOf('{', decl), depth = 0, j = i;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) break;
    }
    out += src.slice(decl, j + 1) + '\n';
  }
  return out;
}

// ── 1. Share-hash extraction (content.js) ───────────────────────────────────
console.log('\nvimeoId / vimeoHash — every shape the hash reaches us in:');
const { vimeoId, vimeoHashFromPage } = (() => {
  const code = extract('content.js', ['VIMEO_PATH_WORDS', 'vimeoHash', 'vimeoId', 'vimeoHashFromPage']);
  // vimeoHashFromPage reads inline <script> text; feed it one blob at a time.
  const factory = new Function(`
    let __blobs = [];
    const document = { querySelectorAll: () => __blobs.map(t => ({ textContent: t })) };
    ${code}
    return { vimeoId, vimeoHashFromPage: (id, blobs) => { __blobs = blobs; return vimeoHashFromPage(id); } };
  `);
  return factory();
})();

// The exact iframe Skool renders for a pasted unlisted link: id survives, hash
// is gone. This is the report's failure, and it must stay visible as "no hash".
check('Skool-built iframe (hash dropped by Skool)',
  vimeoId('https://player.vimeo.com/video/1210721388?autoplay=0&playsinline=1'),
  { id: '1210721388', h: null });
// What Vimeo's "Copy link" gives for an unlisted video — and what a creator
// pastes into Skool, so it's what the lesson metadata holds.
check('copy-link path form',
  vimeoId('https://vimeo.com/1210721388/abcdef1234'), { id: '1210721388', h: 'abcdef1234' });
check('embed-code query form',
  vimeoId('https://player.vimeo.com/video/1210721388?h=abc123def4&app_id=122963'),
  { id: '1210721388', h: 'abc123def4' });
// A hash truncated at its first non-hex character is a *wrong* hash, and Vimeo
// rejects it exactly like a missing one — the old [0-9a-f]+ pattern did that.
check('non-hex hash is not truncated',
  vimeoId('https://player.vimeo.com/video/1210721388?h=8272103f6ez'),
  { id: '1210721388', h: '8272103f6ez' });
check('route segment is not mistaken for a hash',
  vimeoId('https://vimeo.com/1210721388/videos'), { id: '1210721388', h: null });
check('plain public link', vimeoId('https://vimeo.com/76979871'), { id: '76979871', h: null });
check('non-vimeo url', vimeoId('https://www.loom.com/share/abc'), null);

console.log('\nvimeoHashFromPage — recovering the hash Skool dropped:');
// Lesson metadata inside __NEXT_DATA__: JSON escapes its slashes.
check('escaped-slash JSON videoLink',
  vimeoHashFromPage('1210721388', ['{"videoLink":"https:\\/\\/vimeo.com\\/1210721388\\/abcdef1234"}']),
  'abcdef1234');
check('unescaped JSON videoLink',
  vimeoHashFromPage('1210721388', ['{"videoLink":"https://vimeo.com/1210721388/abcdef1234"}']),
  'abcdef1234');
check('query form in page data',
  vimeoHashFromPage('1210721388', ['{"url":"https://player.vimeo.com/video/1210721388?h=deadbeef01"}']),
  'deadbeef01');
check('id present but no hash anywhere',
  vimeoHashFromPage('1210721388', ['{"videoLink":"https://player.vimeo.com/video/1210721388?autoplay=0"}']),
  null);
check('hash of a different video is not borrowed',
  vimeoHashFromPage('1210721388', ['{"a":"https://vimeo.com/999888777/aaaaaaaaaa","b":"vimeo.com/1210721388"}']),
  null);

// ── 1b. vimeoLinkHash (background.js) — the bulk path's extractor ───────────
// A course run never runs content.js, so the bulk resolver has its own copy.
// 2026-08-31 report: 12 Vimeo lessons skipped 'needs-playback' because the
// bulk path pulled only the numeric id out of the lesson's videoLink and
// fetched /config bare — every unlisted video 403'd with its hash in hand.
console.log('\nvimeoLinkHash (background.js) — the bulk path keeps the hash:');
const { vimeoLinkHash } = (() => {
  const code = extract('background.js', ['VIMEO_PATH_WORDS', 'vimeoLinkHash']);
  return new Function(`${code}\nreturn { vimeoLinkHash };`)();
})();
check('copy-link path form (what creators paste)',
  vimeoLinkHash('https://vimeo.com/1219892144/abcdef1234'), 'abcdef1234');
check('embed-code query form',
  vimeoLinkHash('https://player.vimeo.com/video/1219892144?h=abc123def4&app_id=1'), 'abc123def4');
check('hash-less link stays hash-less (the h=no case)',
  vimeoLinkHash('https://vimeo.com/1219892144'), null);
check('route segment is not mistaken for a hash',
  vimeoLinkHash('https://vimeo.com/1219892144/videos'), null);
check('non-hex hash is not truncated',
  vimeoLinkHash('https://vimeo.com/1219892144?h=8272103f6ez'), '8272103f6ez');
check('null link', vimeoLinkHash(null), null);

// ── 2. Wire-captured DASH playlist (detectors.js) ───────────────────────────
// Fixture mirrors a real capture: base_url values are relative and chain three
// deep, and every segment shares one path with a distinct signing query — so
// resolution has to keep each segment's own query.
console.log('\nresolveVimeoJsonQualities — wire-captured playlist:');
const PLAYLIST_URL = 'https://vod-adaptive-ak.vimeocdn.com/exp=1/acl/CLIP/psid=PS/v2/playlist/av/primary/playlist.json?pathsig=root';
const FIXTURE = {
  clip_id: 'ccfaa6de-0af0-44cb-a61a-8ecebadb6ad1',
  base_url: '../../../remux/avf/',
  video: [
    { id: 'v540', base_url: 'v540/', width: 960, height: 540, bitrate: 1000, init_segment: 'AAAA',
      segments: [{ url: 'segment.m4s?pathsig=a&st=0', size: 10 }, { url: 'segment.m4s?pathsig=b&st=6', size: 10 }] },
    { id: 'v720', base_url: 'v720/', width: 1280, height: 720, bitrate: 2495, init_segment: 'BBBB',
      segments: [{ url: 'segment.m4s?pathsig=c&st=0', size: 100 }] },
    // Same height, lower bitrate — must be de-duped away, keeping the better one.
    { id: 'v720lo', base_url: 'v720lo/', width: 1280, height: 720, bitrate: 900, init_segment: 'CCCC',
      segments: [{ url: 'segment.m4s?pathsig=d&st=0', size: 50 }] },
    // No segments — nothing to download, must not be offered.
    { id: 'vempty', base_url: 'vempty/', width: 640, height: 360, bitrate: 500, init_segment: 'DDDD', segments: [] }
  ],
  audio: [
    { id: 'a149', base_url: 'a149/', bitrate: 149000, audio_primary: true, init_segment: 'EEEE',
      segments: [{ url: 'segment.m4s?pathsig=e&st=0', size: 7 }] },
    { id: 'a105', base_url: 'a105/', bitrate: 105000, audio_primary: true, init_segment: 'FFFF',
      segments: [{ url: 'segment.m4s?pathsig=f&st=0', size: 5 }] },
    // A dub/description track: higher bitrate, but not primary.
    { id: 'adub', base_url: 'adub/', bitrate: 300000, audio_primary: false, init_segment: 'GGGG',
      segments: [{ url: 'segment.m4s?pathsig=g&st=0', size: 9 }] }
  ]
};

const vimeoJson = await (async () => {
  const code = extract('detectors.js', [
    'heightLabel', 'resolveVimeoJsonQualities', 'fetchVimeoPlaylist', 'bestVimeoAudio', 'vimeoTrackSegments'
  ]);
  const factory = new Function('fetch', `
    ${code}
    return { resolveVimeoJsonQualities, vimeoTrackSegments, bestVimeoAudio };
  `);
  return factory(async () => ({ ok: true, status: 200, json: async () => FIXTURE }));
})();

const qualities = await vimeoJson.resolveVimeoJsonQualities(PLAYLIST_URL);
check('one quality per distinct height, best-first',
  qualities.map(q => q.label), ['720p', '540p']);
check('all vimeo-json kind', [...new Set(qualities.map(q => q.kind))], ['vimeo-json']);
check('best bitrate wins within a height', qualities[0].videoTrackId, 'v720');
check('empty rendition dropped', qualities.some(q => q.videoTrackId === 'vempty'), false);
check('primary audio beats a higher-bitrate dub', qualities[0].audioTrackId, 'a149');
check('size is video + audio bytes', qualities[0].size, 107);
check('segment lists are NOT carried on the quality',
  Object.keys(qualities[0]).filter(k => /segments|urls/.test(k)), []);
check('playlist url carried for the download step', qualities[0].playlistUrl, PLAYLIST_URL);

console.log('\nvimeoTrackSegments — relative base_url chain:');
const vTrack = vimeoJson.vimeoTrackSegments(FIXTURE, PLAYLIST_URL, 'video', 'v540');
check('three-deep relative chain resolves, per-segment query kept', vTrack.urls, [
  'https://vod-adaptive-ak.vimeocdn.com/exp=1/acl/CLIP/psid=PS/v2/remux/avf/v540/segment.m4s?pathsig=a&st=0',
  'https://vod-adaptive-ak.vimeocdn.com/exp=1/acl/CLIP/psid=PS/v2/remux/avf/v540/segment.m4s?pathsig=b&st=6'
]);
check('base64 init segment leads', vTrack.init, 'AAAA');
check('no init request when base64 is present', vTrack.initUrl, null);
check('byte total from segment sizes', vTrack.bytes, 20);
const aTrack = vimeoJson.vimeoTrackSegments(FIXTURE, PLAYLIST_URL, 'audio', 'a149');
check('audio track resolves against its own base', aTrack.urls, [
  'https://vod-adaptive-ak.vimeocdn.com/exp=1/acl/CLIP/psid=PS/v2/remux/avf/a149/segment.m4s?pathsig=e&st=0'
]);
check('a rendition that vanished from a re-read playlist throws', (() => {
  try { vimeoJson.vimeoTrackSegments(FIXTURE, PLAYLIST_URL, 'video', 'gone'); return 'no throw'; }
  catch (e) { return /no longer in the stream/.test(e.message) ? 'throws' : e.message; }
})(), 'throws');

// init_segment_url is the documented alternative and has been empty on every
// real stream so far, so the fallback only has this test to keep it working.
const noB64 = { ...FIXTURE, video: [{ ...FIXTURE.video[0], init_segment: null, init_segment_url: 'v540/init.mp4?pathsig=i' }] };
check('init_segment_url fallback resolves',
  vimeoJson.vimeoTrackSegments(noB64, PLAYLIST_URL, 'video', 'v540').initUrl,
  'https://vod-adaptive-ak.vimeocdn.com/exp=1/acl/CLIP/psid=PS/v2/remux/avf/v540/v540/init.mp4?pathsig=i');

// ── 3. Live: Vimeo's config endpoint still answers ──────────────────────────
// The embed path is still the only one that works without pressing play, so a
// silent change to /config should fail this test rather than a user's download.
console.log('\nlive — player.vimeo.com config endpoint:');
try {
  const res = await fetch('https://player.vimeo.com/video/76979871/config?h=8272103f6e');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const cfg = await res.json();
  const files = cfg?.request?.files || {};
  const hasStreams = !!(files.progressive?.length || files.hls?.cdns);
  check('public video config returns streams', hasStreams, true);
  console.log(`  · progressive: ${files.progressive?.length || 0}, hls cdns: ${Object.keys(files.hls?.cdns || {}).length}`);
} catch (e) {
  console.error(`  ✗ config fetch failed: ${e.message}`);
  failures++;
}

console.log(failures ? `\n✗ ${failures} check(s) failed\n` : '\n✓ all checks passed\n');
process.exit(failures ? 1 : 0);
