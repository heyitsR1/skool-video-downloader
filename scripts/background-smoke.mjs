#!/usr/bin/env node
// Smoke test for the background-worker logic that has no other way to be
// checked: the Vimeo capture↔embed link, the registry merge that link feeds,
// the save-failure wording, and the version string reports carry.
//
// Each of these exists because of a specific problem report — see
// docs/BUG-LOG.md. The point of pinning them here is that all four are silent
// failures: nothing crashes when a link is lost, a merge hollows out an entry,
// a message blames the wrong thing, or a report stops saying which build it
// came from. They just cost a customer a download and a triage session.
//
//   node scripts/background-smoke.mjs
//
// Exit 0: every assertion holds.
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
function ok(label, cond) { check(label, !!cond, true); }

// Pull the real declarations out of the shipping source so the test exercises
// what actually runs. Unlike the extractor in vimeo-smoke.mjs this one handles
// multi-line `const` initialisers (the save-hint table is one), by scanning to
// the first `;` at bracket depth zero with string literals skipped.
function extract(file, names) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  let out = '';
  for (const name of names) {
    let decl = src.search(new RegExp(`^\\s*(?:async )?function ${name}\\(|^\\s*(?:const|let) ${name} =[\\s]`, 'm'));
    if (decl === -1) { console.error(`✗ could not find ${name} in ${file} — source drifted`); process.exit(1); }
    while (/\s/.test(src[decl])) decl++;   // `^\s*` can start the match a line early
    out += src.slice(decl, endOfDeclaration(src, decl, name)) + '\n';
  }
  return out;
}

function endOfDeclaration(src, from, name) {
  const isFn = /^(?:async )?function /.test(src.slice(from, src.indexOf('\n', from) + 1));
  let depth = 0, quote = null;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    // Comments first: this codebase explains itself in prose, and prose is full
    // of apostrophes and `backticks` that would otherwise open a string literal
    // and swallow the rest of the file.
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i === -1) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; if (i === 0) break; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      depth--;
      if (isFn && depth === 0 && c === '}') return i + 1;
    } else if (c === ';' && depth === 0 && !isFn) return i + 1;
  }
  console.error(`✗ unterminated declaration for ${name} — extractor needs work`);
  process.exit(1);
}

// ── 1. Vimeo capture ↔ embed link ───────────────────────────────────────────
// The 2026-07-31 report: four resolve attempts, every one a 403, with the
// working captured stream listed underneath as a second row the whole time.
console.log('\nvimeo frame link — one video, one row:');
const link = (() => {
  const code = extract('background.js', [
    'vimeoFrames', 'vimeoClips', 'VIMEO_LINK_MAX', 'trimMap', 'persistVimeoLinks',
    'rememberVimeoFrame', 'vimeoIdForCapture', 'vimeoStandIns', 'forgetTabVimeoFrames'
  ]);
  const factory = new Function('chrome', `
    ${code}
    return { rememberVimeoFrame, vimeoIdForCapture, vimeoStandIns, forgetTabVimeoFrames,
             vimeoFrames, vimeoClips, VIMEO_LINK_MAX };
  `);
  return factory({ storage: { session: { set: async () => {} } } });
})();

link.rememberVimeoFrame(7, 3, '942500510');
check('the playlist from the player frame is the embed in that frame',
  link.vimeoIdForCapture(7, 3, 'clip-a'), '942500510');
check('a replay whose frame we never saw is linked by clip uuid',
  link.vimeoIdForCapture(7, 99, 'clip-a'), '942500510');
check('an unseen frame with an unseen clip stays unlinked',
  link.vimeoIdForCapture(7, 99, 'clip-new'), null);
check('frames are per tab', link.vimeoIdForCapture(8, 3, 'clip-other'), null);
// An SPA nav swaps the lesson without tearing the tab down; the new player
// iframe re-navigates, and that navigation must win.
link.rememberVimeoFrame(7, 3, '111222333');
check('an iframe reused by the next lesson relinks to the new video',
  link.vimeoIdForCapture(7, 3, 'clip-b'), '111222333');
link.forgetTabVimeoFrames(7);
check('closing the tab drops its frames', link.vimeoIdForCapture(7, 3, 'clip-c'), null);
check('…but not the clip links, which are tab-independent',
  link.vimeoIdForCapture(7, 99, 'clip-a'), '942500510');

for (let i = 0; i < 300; i++) link.rememberVimeoFrame(1, i, `id${i}`);
ok('frame links are bounded', link.vimeoFrames.size <= link.VIMEO_LINK_MAX);
check('…keeping the most recent', link.vimeoIdForCapture(1, 299, null), 'id299');

// ── 2. Registry merge ───────────────────────────────────────────────────────
// Linking is only worth anything if the merge keeps what each sighting knows:
// the page scan has the id, the title and the share hash; the capture has the
// signed stream that actually downloads.
console.log('\naddVideo — the two sightings become one usable entry:');
const registry = (() => {
  const code = extract('background.js', ['tabVideos', 'ensureTab', 'addVideo', 'listVideos']);
  const factory = new Function('chrome', 'svdLog', 'persistRegistry', 'describeExpiry', 'jwtExpFromUrl', `
    ${code}
    return { addVideo, listVideos, tabVideos };
  `);
  return factory(
    { tabs: { sendMessage: () => Promise.resolve() } },
    () => {}, () => {}, () => '', () => null
  );
})();

const PAGE_SCAN = {
  key: 'vimeo:942500510', platform: 'vimeo', label: 'Vimeo', sourceId: '942500510',
  src: 'json-md', hParam: 'abcdef1234', pageUrl: 'https://www.skool.com/lesson'
};
const CAPTURE = {
  key: 'vimeo:942500510', platform: 'vimeo', label: 'Vimeo (from player)',
  url: 'https://vod-adaptive-ak.vimeocdn.com/…/playlist.json?pathsig=x',
  headers: { Referer: 'https://player.vimeo.com/' }, jsonPlaylist: true,
  sourceId: '942500510', title: null
};

registry.addVideo(1, { ...PAGE_SCAN });
registry.addVideo(1, { ...CAPTURE });
let [merged] = registry.listVideos(1);
check('page scan then capture → one row', registry.listVideos(1).length, 1);
ok('the row carries the signed stream', merged.jsonPlaylist === true && !!merged.url);
check('…and still the share hash', merged.hParam, 'abcdef1234');
check('…and the id the on-screen match needs', merged.sourceId, '942500510');
check('…and the page it belongs to', merged.pageUrl, 'https://www.skool.com/lesson');

// Order is not ours to choose: the capture lands first whenever the lesson was
// already playing when the popup's scan ran.
registry.tabVideos.clear();
registry.addVideo(2, { ...CAPTURE });
registry.addVideo(2, { ...PAGE_SCAN });
[merged] = registry.listVideos(2);
check('capture then page scan → one row', registry.listVideos(2).length, 1);
ok('the signed stream survives the later sighting', merged.jsonPlaylist === true && !!merged.url);
check('…and the hash arrives with it', merged.hParam, 'abcdef1234');

// Unlinked is the case the resolve-time fallback exists for.
registry.tabVideos.clear();
registry.addVideo(3, { ...PAGE_SCAN });
registry.addVideo(3, { ...CAPTURE, key: 'vimeo-json:ccfaa6de-0af0-44cb-a61a-8ecebadb6ad1', sourceId: null });
check('an unlinked capture is still listed, as its own row', registry.listVideos(3).length, 2);

console.log('\nvimeoStandIns — what the failed embed row can fall back to:');
const unlinked = registry.listVideos(3);
check('the captured stream stands in for the embed that 403d',
  link.vimeoStandIns(unlinked[0], unlinked).map(v => v.key),
  ['vimeo-json:ccfaa6de-0af0-44cb-a61a-8ecebadb6ad1']);
check('a capture never stands in for itself',
  link.vimeoStandIns(unlinked[1], unlinked).length, 0);
check('nothing to fall back to when nothing was captured',
  link.vimeoStandIns(PAGE_SCAN, [PAGE_SCAN]).length, 0);
// Two captured streams and no link is ambiguous — picking one at random would
// hand the customer someone else's lesson. The message names the row instead.
check('two captures are reported, not guessed between',
  link.vimeoStandIns(unlinked[0], [...unlinked, { ...CAPTURE, key: 'vimeo-json:other' }]).length, 2);
check('a Loom capture is not a Vimeo stand-in',
  link.vimeoStandIns(PAGE_SCAN, [PAGE_SCAN, { key: 'loom:x', platform: 'loom', jsonPlaylist: true, url: 'u' }]).length, 0);

// ── 3. Save failures ────────────────────────────────────────────────────────
// Every one of these used to read "a download manager may be intercepting
// downloads", including a dismissed Save-as dialog.
console.log('\nsaveFailureMessage — the reason Chrome actually gave:');
const save = (() => {
  const code = extract('background.js', ['DOWNLOAD_MANAGER_HINT', 'SAVE_FAILURE_HINTS', 'saveFailureMessage']);
  return new Function(`${code} return saveFailureMessage;`)();
})();

const cancelled = save('interrupted', 'USER_CANCELED');
ok('USER_CANCELED names the Save-as dialog', /Save as/i.test(cancelled));
ok('…and still mentions download managers, which also cancel', /download manager/i.test(cancelled));
ok('…and says the download itself was fine', /downloaded and merged fine/i.test(cancelled));
ok('…and keeps the raw reason for triage', cancelled.includes('[USER_CANCELED]'));
ok('out of space says out of space', /disk space/i.test(save('interrupted', 'FILE_NO_SPACE')));
ok('a blocked file blames antivirus, not a download manager',
  /antivirus/i.test(save('interrupted', 'FILE_BLOCKED')) && !/Free Download Manager/.test(save('interrupted', 'FILE_BLOCKED')));
ok('an unknown reason keeps the old hint', /Free Download Manager/.test(save('interrupted', 'NETWORK_FAILED')));
ok('…with the reason attached', save('interrupted', 'NETWORK_FAILED').includes('[NETWORK_FAILED]'));
ok('a timeout with no reason still says something', /timed out/.test(save('timeout', null)));

// ── 4. What a problem report says about the build ───────────────────────────
// Most reports are stale sideloads. Until this shipped there was no way to tell
// a store install from a hand-installed one, or a customer who never saw an
// update banner from one who ignored it.
console.log('\ndescribeVersion — which build, and is it current:');
const version = (channel, manifestVersion) => {
  const code = extract('background.js', ['describeVersion']);
  const factory = new Function('chrome', 'self', `${code} return describeVersion;`);
  return factory({ runtime: { getManifest: () => ({ version: manifestVersion }) } },
    { SVD_CONFIG: { CHANNEL: channel } });
};

check('current sideload', version('full', '1.3.9')({ channel: 'full', updateAvailable: false }), '1.3.9 full');
check('current store build', version('cws', '1.3.9')({ channel: 'cws', updateAvailable: false }), '1.3.9 cws');
check('a stale sideload says how stale',
  version('full', '1.1.6')({ channel: 'full', updateAvailable: true, latest: '1.3.9' }),
  '1.1.6 full · latest 1.3.9');
ok('…within the report worker\'s 32-character cap',
  version('full', '1.1.6')({ channel: 'full', updateAvailable: true, latest: '1.3.9' }).length <= 32);
check('a failed version check still names the channel',
  version('full', '1.3.9')(null), '1.3.9 full');
check('a missing build flag fails closed to the store build',
  (() => {
    const code = extract('background.js', ['describeVersion']);
    return new Function('chrome', 'self',
      `${code} return describeVersion;`)({ runtime: { getManifest: () => ({ version: '1.3.9' }) } }, {})(null);
  })(), '1.3.9 cws');

console.log(failures ? `\n✗ ${failures} failed\n` : '\n✓ all passed\n');
process.exit(failures ? 1 : 0);
