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
import vm from 'node:vm';

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

// ── 5. The report's log budget ───────────────────────────────────────────────
// A report carries only the last 10 log lines. One bulk course run produces well
// over a hundred ordinary 'save' lines, so on recency alone the run's own start
// line — which course, what shape, what was asked for — is gone before the run
// ends, and a bulk report without it cannot be answered. Reserved slots are what
// stop that, and nothing else in the codebase would notice if they broke.
console.log('\nreport log budget:');
{
  const compose = (() => {
    const code = extract('background.js', ['BULK_LOG_RESERVED', 'REPORT_LOG_LINES', 'composeReportLog']);
    return new Function(`${code} return composeReportLog;`)();
  })();
  const gen = n => Array.from({ length: n }, (_, i) => ({ context: 'save', message: `g${i}` }));
  const blk = n => Array.from({ length: n }, (_, i) => ({ context: 'bulk', message: `b${i}` }));

  check('no bulk run: the general log gets every slot',
    compose([], gen(40)).map(e => e.message), ['g30','g31','g32','g33','g34','g35','g36','g37','g38','g39']);
  check('a bulk run keeps its lines against a flood of saves',
    compose(blk(5), gen(200)).map(e => e.message),
    ['b0','b1','b2','b3','b4','g195','g196','g197','g198','g199']);
  ok('and never exceeds what the worker keeps', compose(blk(8), gen(200)).length <= 10);
  check('bulk takes no more than its reserve', compose(blk(8), gen(200)).filter(e => e.context === 'bulk').length, 5);
  check('a short bulk run leaves the rest to the general log',
    compose(blk(2), gen(200)).map(e => e.message).slice(0, 3), ['b0','b1','g192']);
  check('the newest bulk lines win when there are more than the reserve',
    compose(blk(8), gen(0)).map(e => e.message), ['b3','b4','b5','b6','b7']);
  check('an empty general log is fine', compose(blk(3), []).map(e => e.message), ['b0','b1','b2']);
  check('both empty', compose([], []), []);
  check('non-array input never throws', compose(null, undefined), []);
}

// ── 6. What a failed course scan tells support ───────────────────────────────
// Every failure branch in scanCourse ends with "send a problem report", so the
// line it logs IS the diagnosis. Signed-out, rate-limited, an error page and a
// real schema change all present to the user as "it didn't work"; only these
// lines tell them apart, and nothing else in the codebase would notice if one
// started reporting the wrong thing.
console.log('\ncourse scan diagnostics:');
{
  const { createRequire } = await import('node:module');
  const bulk = createRequire(import.meta.url)(path.join(ROOT, 'bulk.js'));

  // Builds scanCourse against a scripted response, capturing what it logs.
  const runScan = async ({ finalUrl, status = 200, body = '' }) => {
    const code = extract('background.js',
      ['BULK_FETCH_TIMEOUT_MS', 'bulkFetch', 'fetchPageProps', 'bulkPathOf', 'scanCourse']);
    const logged = [];
    const scan = new Function('deps', `
      const { fetch, bulkLog, BulkError, extractPageProps, courseUrlFor, courseTreeFromPageProps } = deps;
      ${code}
      return scanCourse;
    `)({
      fetch: async () => ({
        url: finalUrl, status,
        text: async () => { if (body instanceof Error) throw body; return body; },
      }),
      bulkLog: m => logged.push(m),
      BulkError: class extends Error { constructor(c, m) { super(m); this.code = c; } },
      extractPageProps: bulk.extractPageProps,
      courseUrlFor: bulk.courseUrlFor,
      courseTreeFromPageProps: bulk.courseTreeFromPageProps,
    });
    let code_ = null;
    try { await scan('g1', 'slug1'); } catch (e) { code_ = e.code; }
    return { code: code_, logged };
  };

  const nextData = props => `<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: props } })}</script>`;
  const course = kids => ({ self: { id: 'u' }, renderData: { course: { course: { id: 'c0', metadata: { title: 'T' } }, children: kids } } });

  const signedOut = await runScan({ finalUrl: 'https://www.skool.com/g1/about', body: '<html></html>' });
  check('a redirect off /classroom/ is signed-out, not drift', signedOut.code, 'not-signed-in');
  ok('and the line says where it landed', /\/g1\/about/.test(signedOut.logged[0]));

  const limited = await runScan({ finalUrl: 'https://www.skool.com/g1/classroom/slug1', status: 429, body: '' });
  check('429 is its own code, not drift', limited.code, 'rate-limited');
  ok('and the line says so', /rate-limited/.test(limited.logged[0]));

  const noProps = await runScan({ finalUrl: 'https://www.skool.com/g1/classroom/slug1', body: '<html>error page</html>' });
  check('no page data is drift', noProps.code, 'schema-drift');
  ok('and the line carries the status, path and size',
    /HTTP 200/.test(noProps.logged[0]) && /\/g1\/classroom\/slug1/.test(noProps.logged[0]) && /\d+b/.test(noProps.logged[0]));
  ok('and says the payload was absent', /props=no/.test(noProps.logged[0]));

  const noUser = await runScan({ finalUrl: 'https://www.skool.com/g1/classroom/slug1', body: nextData({ self: null }) });
  check('page data but no user is signed-out', noUser.code, 'not-signed-in');
  ok('and is distinguishable from the redirect case', /no signed-in user/.test(noUser.logged[0]));

  const empty = await runScan({ finalUrl: 'https://www.skool.com/g1/classroom/slug1', body: nextData(course([])) });
  check('an empty course is not drift', empty.code, 'empty-course');
  ok('and the line names it', /empty-course/.test(empty.logged[0]));

  const drift = await runScan({
    finalUrl: 'https://www.skool.com/g1/classroom/slug1',
    body: nextData(course([{ lessonNode: { identifier: 'l1' } }, { lessonNode: { identifier: 'l2' } }])),
  });
  check('reshaped children are drift', drift.code, 'schema-drift');
  ok('and the line carries what the walk actually saw',
    /2 top-level nodes but no lesson node matched/.test(drift.logged[0]));

  const broken = await runScan({ finalUrl: 'https://x', body: new Error('boom') });
  check('a fetch failure is network, not drift', broken.code, 'network');
  ok('and names the error', /boom/.test(broken.logged[0]));

  const good = await runScan({
    finalUrl: 'https://www.skool.com/g1/classroom/slug1',
    body: nextData(course([{ course: { id: 'l1', metadata: { title: 'A', videoId: 'v' } }, children: [] }])),
  });
  check('a healthy scan throws nothing', good.code, null);
  check('and logs nothing — the run start line covers it', good.logged.length, 0);
}

// ── 7. The download settle hook ──────────────────────────────────────────────
// A bulk run downloads one lesson at a time and awaits each. So a job that ends
// without settling does not fail the run — it HANGS it, with no error, no
// progress and no way out. Every path a job can leave by must settle exactly
// once, including the two that never reach runJob at all.
console.log('\ndownload settle hook:');
{
  // Real queue, stubbed runJob: the interesting logic is the plumbing around it.
  const build = () => {
    const code = extract('background.js',
      ['MAX_CONCURRENT', 'enqueueDownload', 'enqueueDownloadAwaited', 'settleJob', 'pump', 'cancelJob']);
    const started = [];
    const activeJobs = new Map();
    const api = new Function('deps', `
      const { broadcast, runJob, activeJobs, downloadQueue, jobSeqBox } = deps;
      let jobSeq = 0;
      ${code.replace(/\bjobSeq\b/g, 'jobSeqBox.n')}
      return { enqueueDownload, enqueueDownloadAwaited, cancelJob, settleJob, pump };
    `)({
      broadcast: () => {},
      // Occupies a slot the way the real runJob does, so pump() stops at
      // MAX_CONCURRENT and the rest genuinely stay queued — which is the state
      // this whole section is about.
      runJob: job => { started.push(job); activeJobs.set(job.jobId, { meta: job.meta }); },
      activeJobs,
      downloadQueue: [],
      jobSeqBox: { n: 0 },
    });
    return { ...api, started, activeJobs };
  };

  // A job cancelled while still queued never reaches runJob, so runJob's finally
  // never runs. Before this was fixed, nothing settled it and the awaiting run
  // waited forever.
  {
    const q = build();
    const outcomes = [];
    for (let i = 0; i < 12; i++) q.enqueueDownloadAwaited({ quality: {}, filename: `f${i}` }).then(o => outcomes.push(o));
    const queuedId = q.started.length + 1;   // the first that did NOT start
    q.cancelJob(queuedId);
    await new Promise(r => setTimeout(r, 0));
    check('cancelling a still-queued job settles it', outcomes, [{ ok: false, cancelled: true }]);
  }

  // Settling twice would resolve one promise and silently drop the other job's
  // outcome onto it.
  {
    const q = build();
    const seen = [];
    const job = { onSettled: o => seen.push(o) };
    q.settleJob(job, { ok: true, downloadId: 1 });
    q.settleJob(job, { ok: false, cancelled: true });
    check('a job settles exactly once', seen, [{ ok: true, downloadId: 1 }]);
  }

  check('a job with no handler is harmless', (() => {
    const q = build();
    q.settleJob({}, { ok: true }); q.settleJob(null, { ok: true });
    return 'no throw';
  })(), 'no throw');

  check('a throwing handler does not break the queue', (() => {
    const q = build();
    q.settleJob({ onSettled: () => { throw new Error('boom'); } }, { ok: true });
    return 'no throw';
  })(), 'no throw');

  // The outcome mapping in runJob's finally reads meta.phase. These pin the two
  // ways it can silently lie: a cancelled job reported as saved (the manifest
  // then records it done and never retries), or a failure reported as success.
  const src = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  ok('the cancel path mutates meta.phase, not just a copy',
    /meta\.phase = 'cancelled';\s*\n\s*recordFinished\(meta, 'cancelled'\)/.test(src));
  // Scoped to runJob's own finally block: searching the whole file would find
  // some later pump() and pass no matter what the order actually is.
  ok('settle happens before pump() inside runJob\'s finally', (() => {
    const start = src.indexOf('if (ruleId != null) await removeHeaderRules(ruleId);');
    // Comments stripped first: the comment above the call explains the ordering
    // and contains the literal "pump()", which matched ahead of the real call
    // and made this assertion pass no matter what the code did.
    const block = src.slice(start, src.indexOf('\n}', start)).replace(/\/\/[^\n]*/g, '');
    const s = block.indexOf('settleJob(job,'), p = block.indexOf('pump()');
    return s !== -1 && p !== -1 && s < p;
  })());
  ok('every save path records its downloadId',
    src.match(/await (?:saveBlob|mergeAndSave)\(/g).length ===
    src.match(/meta\.downloadId = await (?:saveBlob|mergeAndSave)\(/g).length);
  ok('saveBlob returns the id it waited on', /if \(state !== 'complete'\)[^}]*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*return downloadId;/.test(src));
}

// ── 8. Resolving one lesson's media ──────────────────────────────────────────
// Every branch either produces something downloadable or a NAMED skip. A skip
// with the wrong name is the expensive failure: 'unknown' settles permanently,
// so a lesson misfiled under it is never retried, while a locked lesson filed
// correctly comes back the moment the user gains access.
console.log('\nlesson media resolution:');
{
  const { createRequire } = await import('node:module');
  const bulk = createRequire(import.meta.url)(path.join(ROOT, 'bulk.js'));

  const build = (deps = {}) => {
    const code = extract('background.js', ['resolveBulkLesson', 'embedSourceId']);
    return new Function('d', `
      const { SOURCE, fetchPageProps, nativePlaybackFrom, resolveQualities, bulkPathOf } = d;
      ${code}
      return { resolveBulkLesson, embedSourceId };
    `)({
      SOURCE: bulk.SOURCE,
      nativePlaybackFrom: bulk.nativePlaybackFrom,
      bulkPathOf: u => { try { return new URL(u).pathname; } catch { return String(u); } },
      fetchPageProps: async () => ({ pageProps: null, status: 500, finalUrl: 'https://x/y' }),
      resolveQualities: async () => ({ qualities: [] }),
      ...deps,
    });
  };
  const lesson = (over = {}) => ({ sourceKind: bulk.SOURCE.NATIVE, sourceRef: 'v', lessonUrl: 'https://u', ...over });

  // A text lesson and an unnamed host are different outcomes, and only one of
  // them is allowed to settle forever.
  check('a text lesson needs no media',
    (await build().resolveBulkLesson(lesson({ sourceKind: bulk.SOURCE.TEXT }))).kind, 'notes-only');
  const unknown = await build().resolveBulkLesson(lesson({ sourceKind: bulk.SOURCE.UNKNOWN }));
  check('an unnamed host skips as unknown', { kind: unknown.kind, reason: unknown.reason },
    { kind: 'skip', reason: 'unknown' });
  ok('and unknown is the reason that settles for good', bulk.SETTLED_SKIP_KINDS.includes(unknown.reason));

  // The locked case. Everything on the page looks healthy; only the token is
  // missing — and it must NOT settle, or gaining access never brings it back.
  {
    const r = await build({
      fetchPageProps: async () => ({ pageProps: { video: { playbackId: 'p', status: 'ready', duration: 1 } }, status: 200, finalUrl: 'https://u' }),
    }).resolveBulkLesson(lesson());
    check('a locked lesson skips as locked', { kind: r.kind, reason: r.reason }, { kind: 'skip', reason: 'locked' });
    ok('and locked never settles', !bulk.SETTLED_SKIP_KINDS.includes(r.reason));
  }

  // Resolving is the probe. The plan fetched the master to test it and then let
  // the resolver fetch it again — 40 wasted round trips on a 40-lesson course,
  // against a token that is already expiring.
  {
    const tried = [];
    const r = await build({
      fetchPageProps: async () => ({ pageProps: { video: { playbackId: 'p', playbackToken: 't' } }, status: 200, finalUrl: 'https://u' }),
      resolveQualities: async v => { tried.push(v.url); return { qualities: [{ height: 720 }] }; },
    }).resolveBulkLesson(lesson());
    check('a healthy native lesson resolves', { kind: r.kind, platform: r.platform }, { kind: 'qualities', platform: 'skool' });
    check('the primary host is fetched exactly once', tried.length, 1);
    ok('and it is the skool host', /stream\.video\.skool\.com/.test(tried[0]));
  }

  // The fallback host exists for one of the two going away.
  {
    const tried = [];
    const r = await build({
      fetchPageProps: async () => ({ pageProps: { video: { playbackId: 'p', playbackToken: 't' } }, status: 200, finalUrl: 'https://u' }),
      resolveQualities: async v => {
        tried.push(v.url);
        if (tried.length === 1) throw new Error('Playlist fetch failed (403)');
        return { qualities: [{ height: 1080 }] };
      },
    }).resolveBulkLesson(lesson());
    check('a failed primary falls back to the other host', r.kind, 'qualities');
    check('both hosts were tried, in order', tried.length, 2);
    ok('fallback is the mux host', /stream\.mux\.com/.test(tried[1]));
  }

  {
    const r = await build({
      fetchPageProps: async () => ({ pageProps: { video: { playbackId: 'p', playbackToken: 't' } }, status: 200, finalUrl: 'https://u' }),
      resolveQualities: async () => { throw new Error('Playlist fetch failed (403) — replay the video'); },
    }).resolveBulkLesson(lesson());
    check('both hosts failing is no-qualities', r.reason, 'no-qualities');
    ok('and the detail carries the real error, not just a code', /403/.test(r.detail));
    ok('and no-qualities stays retryable', !bulk.SETTLED_SKIP_KINDS.includes(r.reason));
  }

  {
    const r = await build().resolveBulkLesson(lesson());
    check('a lesson page with no data is drift, not locked', r.reason, 'schema-drift');
    ok('and the detail carries the status', /HTTP 500/.test(r.detail));
  }

  // Embed platforms: an id we cannot parse must never be guessed. A wrong id
  // resolves to someone else's video and downloads it silently.
  const ids = build().embedSourceId;
  check('loom id', ids(bulk.SOURCE.LOOM, 'https://www.loom.com/share/' + '0'.repeat(31) + '2'), '0'.repeat(31) + '2');
  check('loom embed form', ids(bulk.SOURCE.LOOM, 'https://www.loom.com/embed/' + 'a'.repeat(24)), 'a'.repeat(24));
  check('vimeo id', ids(bulk.SOURCE.VIMEO, 'https://vimeo.com/123456789'), '123456789');
  check('vimeo /video/ form', ids(bulk.SOURCE.VIMEO, 'https://player.vimeo.com/video/987654321'), '987654321');
  check('wistia id', ids(bulk.SOURCE.WISTIA, 'https://fast.wistia.net/embed/iframe/abc12345'), 'abc12345');
  check('an unparseable loom link yields no id', ids(bulk.SOURCE.LOOM, 'https://www.loom.com/'), null);
  check('a too-short vimeo id is not accepted', ids(bulk.SOURCE.VIMEO, 'https://vimeo.com/123'), null);
  check('a null url never throws', ids(bulk.SOURCE.VIMEO, null), null);

  {
    const r = await build().resolveBulkLesson(lesson({ sourceKind: bulk.SOURCE.VIMEO, sourceRef: 'https://vimeo.com/nope' }));
    check('an unparseable embed link is missing-source', r.reason, 'missing-source');
    ok('and the detail quotes the link', /vimeo\.com\/nope/.test(r.detail));
  }

  {
    const seen = [];
    const r = await build({ resolveQualities: async v => { seen.push(v); return { qualities: [{ height: 720 }] }; } })
      .resolveBulkLesson(lesson({ sourceKind: bulk.SOURCE.LOOM, sourceRef: 'https://www.loom.com/share/' + 'b'.repeat(32) }));
    check('a loom lesson resolves through the shared resolver', r.kind, 'qualities');
    check('and is handed an id, not a url', { platform: seen[0].platform, sourceId: seen[0].sourceId },
      { platform: 'loom', sourceId: 'b'.repeat(32) });
  }

  {
    const r = await build().resolveBulkLesson(lesson({ sourceKind: bulk.SOURCE.YOUTUBE, sourceRef: 'https://youtu.be/x' }));
    check('youtube is handed off as a link, never downloaded', { kind: r.kind, url: r.url },
      { kind: 'link', url: 'https://youtu.be/x' });
  }
  check('a youtube lesson with no link is missing-source',
    (await build().resolveBulkLesson(lesson({ sourceKind: bulk.SOURCE.YOUTUBE, sourceRef: null }))).reason, 'missing-source');
}

// ── 9. Asset writers ─────────────────────────────────────────────────────────
// The caller records an asset in the manifest the moment a writer resolves, and
// a manifest entry means "on disk, never fetch again". So a writer that returns
// before the file actually landed writes a permanent lie: the lesson is marked
// saved, the file is not there, and no later run retries it.
console.log('\nasset writers:');
{
  const { createRequire } = await import('node:module');
  const bulk = createRequire(import.meta.url)(path.join(ROOT, 'bulk.js'));

  const build = (deps = {}) => {
    const code = extract('background.js',
      ['textDataUrl', 'startDownload', 'BULK_CONFLICT_ACTION', 'saveTextFile',
       'fetchAttachmentUrl', 'saveAttachment', 'youtubeShortcut', 'saveYoutubeStub']);
    const calls = { download: [], waited: [] };
    const api = new Function('d', `
      const { chrome, BulkError, FILE_ID_RE, bulkFetch, waitForDownloadEnd, saveFailureMessage, TextEncoder, btoa } = d;
      ${code}
      return { textDataUrl, saveTextFile, fetchAttachmentUrl, saveAttachment, youtubeShortcut, saveYoutubeStub, BULK_CONFLICT_ACTION };
    `)({
      chrome: {
        runtime: { lastError: deps.lastError || null },
        downloads: { download: (o, cb) => { calls.download.push(o); cb(deps.refuse ? undefined : 7); } },
      },
      BulkError: class extends Error { constructor(c, m) { super(m); this.code = c; } },
      FILE_ID_RE: bulk.FILE_ID_RE,
      bulkFetch: deps.bulkFetch || (async () => ({ ok: true, status: 200, text: async () => 'https://cdn.example/file.pdf' })),
      waitForDownloadEnd: async id => { calls.waited.push(id); return deps.endState || { state: 'complete' }; },
      saveFailureMessage: (s, e) => `save failed: ${s}${e ? ` (${e})` : ''}`,
      TextEncoder, btoa,
    });
    return { ...api, calls };
  };

  // The bug this section exists for.
  {
    const w = build();
    await w.saveTextFile('C/01 A.md', '# Notes', 'text/markdown');
    check('a text write waits for the download to complete', w.calls.waited, [7]);
  }
  {
    const w = build({ endState: { state: 'interrupted', error: 'FILE_NO_SPACE' } });
    let code = null;
    try { await w.saveTextFile('C/01 A.md', 'x', 'text/markdown'); } catch (e) { code = e.code; }
    check('an interrupted text write throws rather than reporting saved', code, 'save-failed');
  }
  {
    const w = build({ endState: { state: 'interrupted', error: 'FILE_NO_SPACE' },
      bulkFetch: async () => ({ ok: true, status: 200, text: async () => 'https://cdn.example/f.pdf' }) });
    let code = null;
    try { await w.saveAttachment('a'.repeat(32), 'C/01 A - W.pdf'); } catch (e) { code = e.code; }
    check('an interrupted attachment throws too', code, 'save-failed');
  }
  {
    const w = build({ refuse: true });
    let code = null;
    try { await w.saveTextFile('C/01 A.md', 'x', 'text/markdown'); } catch (e) { code = e.code; }
    check('a refused download is not a silent success', code, 'save-failed');
  }

  // Overwrite, not uniquify: reaching a writer means the manifest says the asset
  // is not settled, so any file already there is stale. Uniquify would keep the
  // stale copy, add "notes (1).md" beside it, and record the path we asked for.
  {
    const w = build();
    await w.saveTextFile('C/01 A.md', 'x', 'text/markdown');
    check('conflicts overwrite the stale file', w.calls.download[0].conflictAction, 'overwrite');
    check('and never prompt', w.calls.download[0].saveAs, false);
  }

  // Notes are UTF-8. btoa alone throws on anything outside Latin-1, which would
  // fail every lesson whose notes contain an em dash or an emoji.
  {
    const w = build();
    const url = w.textDataUrl('héllo — 🎬', 'text/markdown');
    ok('a data URL is produced for non-Latin-1 text', url.startsWith('data:text/markdown;base64,'));
    check('and it round-trips exactly',
      Buffer.from(url.split(',')[1], 'base64').toString('utf8'), 'héllo — 🎬');
  }
  {
    const w = build();
    const big = 'x'.repeat(200000);
    check('a large document does not blow the argument list',
      Buffer.from(w.textDataUrl(big, 'text/plain').split(',')[1], 'base64').toString('utf8').length, 200000);
  }

  // Attachments: 403/423 are a skip, everything else is a failure, and the two
  // must not be confused — a skip is recorded, a failure is retried this run.
  const att = async (over) => {
    const w = build({ bulkFetch: async () => over });
    try { return { url: await w.fetchAttachmentUrl('a'.repeat(32)) }; }
    catch (e) { return { code: e.code, message: e.message }; }
  };
  check('a bare URL body is used as-is',
    (await att({ ok: true, status: 200, text: async () => ' https://cdn.example/f.pdf ' })).url,
    'https://cdn.example/f.pdf');
  check('403 is a forbidden skip', (await att({ ok: false, status: 403, text: async () => '' })).code, 'attachment-forbidden');
  check('423 is a forbidden skip too', (await att({ ok: false, status: 423, text: async () => '' })).code, 'attachment-forbidden');
  check('500 is a network failure, not a skip', (await att({ ok: false, status: 500, text: async () => '' })).code, 'network');
  ok('and names the status', /500/.test((await att({ ok: false, status: 500, text: async () => '' })).message));
  ok('attachment-forbidden deliberately does not settle — access can change',
    !bulk.SETTLED_SKIP_KINDS.includes('attachment-forbidden'));

  // A JSON envelope is the obvious way for this endpoint to change. Downloading
  // a file literally named {"url":... is worse than either outcome.
  check('a JSON envelope is understood',
    (await att({ ok: true, status: 200, text: async () => '{"url":"https://cdn.example/f.pdf"}' })).url,
    'https://cdn.example/f.pdf');
  check('a JSON string body is understood',
    (await att({ ok: true, status: 200, text: async () => '"https://cdn.example/f.pdf"' })).url,
    'https://cdn.example/f.pdf');
  {
    const r = await att({ ok: true, status: 200, text: async () => '<html>nope</html>' });
    check('an unreadable body is a failure', r.code, 'network');
    ok('and the error quotes what actually arrived', /nope/.test(r.message));
  }
  {
    const w = build();
    let code = null;
    try { await w.fetchAttachmentUrl('too-short'); } catch (e) { code = e.code; }
    check('a malformed file id never becomes a request', code, 'attachment-forbidden');
  }
  check('a non-https link is refused',
    (await att({ ok: true, status: 200, text: async () => 'javascript:alert(1)' })).code, 'network');

  // YouTube lessons are recorded, not downloaded.
  {
    const w = build();
    check('the shortcut is a Windows .url file',
      w.youtubeShortcut('https://youtu.be/x'), '[InternetShortcut]\r\nURL=https://youtu.be/x\r\n');
    await w.saveYoutubeStub('C/01 Lesson', 'https://youtu.be/x');
    check('and hangs off the lesson base', w.calls.download[0].filename, 'C/01 Lesson.url');
    check('and it waits like every other writer', w.calls.waited, [7]);
  }
}

// ── 10. Manifest store and disk verification (G1/G2) ─────────────────────────
// The manifest is the only record of what is on disk. Two ways it can be wrong,
// both expensive and both silent: forget a file that IS there and re-download a
// multi-gigabyte course, or keep a record of a file that ISN'T and never restore
// it. The "no download record at all" case is the one that decides which.
console.log('\nmanifest store and disk check:');
{
  const { createRequire } = await import('node:module');
  const bulk = createRequire(import.meta.url)(path.join(ROOT, 'bulk.js'));

  const build = ({ store = {}, search } = {}) => {
    const code = extract('background.js',
      ['manifestKey', 'normalizeManifest', 'loadManifest', 'saveManifest', 'clearManifest',
       'manifestChain', 'withManifestWrite', 'recordAsset', 'pruneDeletedAssets']);
    const logged = [];
    const api = new Function('d', `
      const { chrome, normalizeAssets, bulkLog } = d;
      ${code}
      return { loadManifest, saveManifest, clearManifest, recordAsset, pruneDeletedAssets, manifestKey };
    `)({
      chrome: {
        storage: { local: {
          // Structured-clone on both sides, like the real API. Handing back a
          // live reference would let an in-memory mutation look like a
          // successful write and hide a missing set().
          get: async k => (k in store ? { [k]: structuredClone(store[k]) } : {}),
          set: async o => { for (const [k, v] of Object.entries(o)) store[k] = structuredClone(v); },
          remove: async k => { delete store[k]; },
        } },
        downloads: { search: search || (async () => []) },
      },
      normalizeAssets: bulk.normalizeAssets,
      bulkLog: m => logged.push(m),
    });
    return { ...api, store, logged };
  };
  const KEY = 'bulk:g1/slug1';

  // A record that survived a partial write must not crash every later read —
  // a throw here reads as "nothing was ever saved" and re-downloads everything.
  for (const [label, bad] of [['no lessons key', { updatedAt: 1 }], ['lessons is a string', { lessons: 'x' }],
                              ['lessons is null', { lessons: null }], ['not an object', 42]]) {
    const m = await build({ store: { [KEY]: bad } }).loadManifest('g1', 'slug1');
    check(`a malformed manifest still loads (${label})`, typeof m.lessons, 'object');
  }
  check('a missing manifest is empty, not undefined',
    (await build().loadManifest('g1', 'slug1')).lessons, {});
  {
    const m = build({ store: { [KEY]: { lessons: {} } } });
    m.store[KEY] = { lessons: {} };
    let threw = false;
    try { await m.recordAsset('g1', 'slug1', 'l1', { video: { path: 'v' } }); } catch { threw = true; }
    ok('recording against a malformed manifest does not throw', !threw);
  }

  // Overlapping writes: read-modify-write on one key, so without serialising,
  // the second set() discards the first's asset. This file's own debug log was
  // bitten by exactly this; here it costs a file the user believes is saved.
  {
    const w = build();
    await Promise.all([
      w.recordAsset('g1', 'slug1', 'l1', { video: { path: 'v', downloadId: 1 } }),
      w.recordAsset('g1', 'slug1', 'l2', { notes: { path: 'n', downloadId: 2 } }),
      w.recordAsset('g1', 'slug1', 'l3', { file: { fileId: 'a'.repeat(32), slot: { path: 'f', downloadId: 3 } } }),
    ]);
    check('concurrent writes do not discard each other',
      Object.keys(w.store[KEY].lessons).sort(), ['l1', 'l2', 'l3']);
  }
  {
    const w = build();
    await Promise.all([
      w.recordAsset('g1', 'slug1', 'l1', { video: { path: 'v' } }),
      w.recordAsset('g1', 'slug1', 'l1', { notes: { path: 'n' } }),
      w.recordAsset('g1', 'slug1', 'l1', { file: { fileId: 'b'.repeat(32), slot: { path: 'f' } } }),
    ]);
    const a = w.store[KEY].lessons.l1.assets;
    check('three assets on one lesson all survive',
      { v: !!a.video, n: !!a.notes, f: Object.keys(a.files).length }, { v: true, n: true, f: 1 });
  }

  // The disk check. Three outcomes, and the third is the one that matters.
  const manifestWith = slots => ({ lessons: { l1: { status: 'saved', assets: {
    video: { path: 'v', downloadId: 10 }, notes: { path: 'n', downloadId: 11 },
    files: { ['c'.repeat(32)]: { path: 'f', downloadId: 12 } },
  } } }, ...slots });

  {
    const w = build({ store: { [KEY]: manifestWith() }, search: async () => [{ exists: true }] });
    const m = await w.pruneDeletedAssets('g1', 'slug1');
    check('files that are still there are kept', !!m.lessons.l1.assets.video, true);
    check('and nothing is logged when everything checks out', w.logged.length, 0);
  }
  {
    const w = build({ store: { [KEY]: manifestWith() }, search: async () => [{ exists: false }] });
    const m = await w.pruneDeletedAssets('g1', 'slug1');
    check('a deleted video is re-queued', m.lessons.l1.assets.video, null);
    check('a deleted notes file is re-queued', m.lessons.l1.assets.notes, null);
    check('a deleted attachment is dropped from the map', Object.keys(m.lessons.l1.assets.files).length, 0);
    ok('and the re-queue is logged', /3 deleted/.test(w.logged.join(' ')));
    check('the pruning is persisted, not just returned', w.store[KEY].lessons.l1.assets.video, null);
  }
  // THE case: clearing Chrome's download history empties search(), which is
  // "unknown", never "missing". Reading it as missing re-downloads everything.
  {
    const w = build({ store: { [KEY]: manifestWith() }, search: async () => [] });
    const m = await w.pruneDeletedAssets('g1', 'slug1');
    check('a cleared download history keeps the video', m.lessons.l1.assets.video.path, 'v');
    check('and the notes', m.lessons.l1.assets.notes.path, 'n');
    check('and the attachment', Object.keys(m.lessons.l1.assets.files).length, 1);
    ok('and says so, so "it skipped everything" is answerable', /3 not in history/.test(w.logged.join(' ')));
  }
  // `exists` absent is not `exists: false`. Chrome omits the field in some
  // states, and a falsy test would read every one of those as a deleted file and
  // re-download the course. Only an explicit false means the user deleted it.
  {
    const w = build({ store: { [KEY]: manifestWith() }, search: async () => [{ id: 10 }] });
    const m = await w.pruneDeletedAssets('g1', 'slug1');
    check('a record with no exists field keeps the file', m.lessons.l1.assets.video.path, 'v');
    check('and nothing is re-queued', w.logged.length, 0);
  }
  // A failed check is not a deletion either.
  {
    const w = build({ store: { [KEY]: manifestWith() }, search: async () => { throw new Error('nope'); } });
    const m = await w.pruneDeletedAssets('g1', 'slug1');
    check('an unreadable download record keeps the file', m.lessons.l1.assets.video.path, 'v');
    ok('and is counted separately from an empty history', /3 unreadable/.test(w.logged.join(' ')));
  }
  // Mixed: only the deleted one goes.
  {
    const w = build({
      store: { [KEY]: manifestWith() },
      search: async ({ id }) => (id === 11 ? [{ exists: false }] : [{ exists: true }]),
    });
    const m = await w.pruneDeletedAssets('g1', 'slug1');
    check('only the deleted asset is re-queued',
      { video: !!m.lessons.l1.assets.video, notes: m.lessons.l1.assets.notes, files: Object.keys(m.lessons.l1.assets.files).length },
      { video: true, notes: null, files: 1 });
    check('the lesson keeps its prior status', m.lessons.l1.status, 'saved');
  }
  {
    const w = build({ store: { [KEY]: { lessons: {} } }, search: async () => { throw new Error('x'); } });
    const m = await w.pruneDeletedAssets('g1', 'slug1');
    check('an empty manifest checks nothing', { lessons: m.lessons, logged: w.logged.length }, { lessons: {}, logged: 0 });
  }
  {
    const w = build({ store: { [KEY]: { lessons: { l1: { assets: { video: { path: 'v' } } } } } },
      search: async () => [{ exists: false }] });
    const m = await w.pruneDeletedAssets('g1', 'slug1');
    check('a slot with no downloadId is never checked or dropped', m.lessons.l1.assets.video.path, 'v');
  }
}

// ── 11. The orchestrator ─────────────────────────────────────────────────────
// The whole feature, end to end. What is pinned here is what a course run must
// never do: write a file to the wrong name, disable a guard the single-download
// path relies on, or finish without leaving a report anyone can read.
console.log('\norchestrator:');
{
  const { createRequire } = await import('node:module');
  const bulk = createRequire(import.meta.url)(path.join(ROOT, 'bulk.js'));

  const build = (deps = {}) => {
    const code = extract('background.js',
      ['BULK_STATE_KEY', 'bulkAbort', 'getBulkState', 'setBulkState', 'bulkBroadcast',
       'runBulkCourse', 'runBulkCourseInner', 'runBulkLesson', 'pickBestQuality']);
    const calls = { enqueued: [], recorded: [], text: [], stubs: [], state: [] };
    const logged = [];
    const session = {};
    const env = {
      chrome: { storage: { session: {
        get: async k => (k in session ? { [k]: structuredClone(session[k]) } : {}),
        set: async o => { for (const [k, v] of Object.entries(o)) session[k] = structuredClone(v); },
      } }, runtime: { sendMessage: async () => {} } },
      BulkError: class extends Error { constructor(c, m) { super(m); this.code = c; } },
      bulkLog: m => logged.push(m),
      scanCourse: deps.scanCourse || (async () => ({
        courseTitle: 'C', shape: 'flat', moduleCount: 0, group: 'g1', courseSlug: 's1',
        lessons: [{ lessonId: 'l1', title: 'A', moduleIdx: null, moduleTitle: null, lessonIdx: 1,
          sourceKind: 'skool-native', sourceRef: 'v', lessonUrl: 'https://u', descRaw: null, resourcesRaw: null }],
      })),
      pruneDeletedAssets: deps.pruneDeletedAssets || (async () => ({ lessons: {} })),
      resolveBulkLesson: deps.resolveBulkLesson || (async () => ({ kind: 'qualities', qualities: [{ height: 720 }], platform: 'skool' })),
      enqueueDownloadAwaited: deps.enqueueDownloadAwaited || (async o => { calls.enqueued.push(o); return { ok: true, downloadId: 5 }; }),
      recordAsset: async (g, c, id, patch) => { calls.recorded.push({ id, patch }); },
      saveTextFile: deps.saveTextFile || (async (p, t) => { calls.text.push({ path: p, text: t }); return 9; }),
      saveYoutubeStub: async (b, u) => { calls.stubs.push({ base: b, url: u }); return 9; },
      saveAttachment: deps.saveAttachment || (async () => 9),
      // Real pure helpers — the orchestrator's job is to wire them correctly.
      mergeManifest: bulk.mergeManifest, lessonNeedsWork: bulk.lessonNeedsWork,
      isSettled: bulk.isSettled, SETTLED_SKIP_KINDS: bulk.SETTLED_SKIP_KINDS,
      bulkLessonBase: bulk.bulkLessonBase, capSegment: bulk.capSegment,
      parseResources: bulk.parseResources, descToMarkdown: bulk.descToMarkdown,
      notesDocument: bulk.notesDocument, attachmentFilename: bulk.attachmentFilename,
      reasonTally: bulk.reasonTally, tallyReason: bulk.tallyReason,
      describeTally: bulk.describeTally, tallyExamples: bulk.tallyExamples,
      bulkRunStartLine: bulk.bulkRunStartLine, bulkRunEndLine: bulk.bulkRunEndLine,
      runSummary: bulk.runSummary,
      flags: { bulkRunActive: false },
      ...deps.env,
    };
    const api = new Function('d', `
      const { chrome, BulkError, bulkLog, scanCourse, pruneDeletedAssets, resolveBulkLesson,
              enqueueDownloadAwaited, recordAsset, saveTextFile, saveYoutubeStub, saveAttachment,
              mergeManifest, lessonNeedsWork, isSettled, SETTLED_SKIP_KINDS, bulkLessonBase, capSegment,
              parseResources, descToMarkdown, notesDocument, attachmentFilename, reasonTally, tallyReason,
              describeTally, tallyExamples, bulkRunStartLine, bulkRunEndLine, runSummary, flags } = d;
      ${code.replace(/\bbulkRunActive\b/g, 'flags.bulkRunActive')}
      return { runBulkCourse, pickBestQuality, getBulkState, abort: () => bulkAbort };
    `)(env);
    return { ...api, calls, logged, env, session };
  };

  // The filename bug. runJob appends ".mp4" itself, so passing "<base>.mp4"
  // writes "<base>.mp4.mp4" — every video in every course, silently.
  {
    const o = build();
    await o.runBulkCourse({ group: 'g1', courseSlug: 's1', want: { video: true } });
    check('the queue is handed a stem, not a filename with an extension',
      o.calls.enqueued[0].filename, 'C/01 A');
    ok('and the recorded path is the file that is actually written',
      o.calls.recorded.some(r => r.patch.video?.path === 'C/01 A.mp4'));
  }

  // mode must be absent. A truthy unknown value reads as "single-rendition,
  // free" and skips the pre-merge SIMD guard.
  {
    const o = build();
    await o.runBulkCourse({ group: 'g1', courseSlug: 's1', want: { video: true } });
    check('no mode is set, so the SIMD guard still applies', o.calls.enqueued[0].mode, undefined);
    check('and no tab can cancel the run', o.calls.enqueued[0].tabId, null);
  }

  // Every run leaves a readable trace, whatever happened.
  {
    const o = build();
    await o.runBulkCourse({ group: 'g1', courseSlug: 's1', want: { video: true } });
    ok('a run opens with its fingerprint', /^start "C" flat 0mod\/1les want=video/.test(o.logged[0]));
    ok('and closes with counts that add up', /^done 1les: 1 saved/.test(o.logged[1]));
    check('a clean run is exactly two lines', o.logged.length, 2);
  }
  {
    const o = build({ scanCourse: async () => { const e = new Error('Sign in to Skool'); e.code = 'not-signed-in'; throw e; } });
    let threw = false;
    try { await o.runBulkCourse({ group: 'g1', courseSlug: 's1', want: { video: true } }); } catch { threw = true; }
    ok('a failed scan still rejects', threw);
    ok('and says the run aborted rather than leaving only a scan line', /run aborted/.test(o.logged.join(' ')));
    check('and the state says error, not running', (await o.getBulkState()).phase, 'error');
    check('and the per-download log suppression is lifted', o.env.flags.bulkRunActive, false);
  }
  {
    const o = build();
    await o.runBulkCourse({ group: 'g1', courseSlug: 's1', want: { video: true } });
    check('the suppression flag is cleared on the happy path too', o.env.flags.bulkRunActive, false);
  }

  // Skips carry the resolver's worked example into the report.
  {
    const o = build({ resolveBulkLesson: async () => ({ kind: 'skip', reason: 'no-qualities', detail: 'both playback hosts failed: HTTP 403' }) });
    await o.runBulkCourse({ group: 'g1', courseSlug: 's1', want: { video: true } });
    const all = o.logged.join(' | ');
    ok('the tally names the reason', /no-qualities×1/.test(all));
    ok('and carries the resolver detail, not just the word', /HTTP 403/.test(all));
  }
  {
    const o = build({ resolveBulkLesson: async () => ({ kind: 'skip', reason: 'locked' }) });
    await o.runBulkCourse({ group: 'g1', courseSlug: 's1', want: { video: true } });
    const rec = o.calls.recorded.find(r => r.patch.reason === 'locked');
    check('a locked lesson records no settling slot, so a later run retries it', rec.patch.video, undefined);
  }
  {
    const o = build({ resolveBulkLesson: async () => ({ kind: 'skip', reason: 'unknown', detail: 'x' }) });
    await o.runBulkCourse({ group: 'g1', courseSlug: 's1', want: { video: true } });
    const rec = o.calls.recorded.find(r => r.patch.reason === 'unknown');
    check('an unknown source settles for good', rec.patch.video, { skipped: 'unknown' });
  }

  // YouTube: a stub per lesson plus one course index, and the index failing must
  // not vanish — it is the only list of every hosted lesson.
  {
    const o = build({ resolveBulkLesson: async () => ({ kind: 'link', url: 'https://youtu.be/x' }) });
    await o.runBulkCourse({ group: 'g1', courseSlug: 's1', want: { video: true } });
    check('a stub is written beside the lesson', o.calls.stubs[0], { base: 'C/01 A', url: 'https://youtu.be/x' });
    ok('and a course-level index is written', o.calls.text.some(t => t.path === 'C/_youtube-lessons.txt'));
  }
  {
    const o = build({
      resolveBulkLesson: async () => ({ kind: 'link', url: 'https://youtu.be/x' }),
      saveTextFile: async p => { if (p.includes('_youtube')) throw new Error('disk full'); return 9; },
    });
    await o.runBulkCourse({ group: 'g1', courseSlug: 's1', want: { video: true } });
    ok('a failed index is reported, not swallowed', /youtube-index/.test(o.logged.join(' ')));
    ok('and the run still completes', /^done 1les/.test(o.logged.find(l => l.startsWith('done')) || ''));
  }

  // A download that fails is a named failure on that lesson, and the run goes on.
  {
    const o = build({ enqueueDownloadAwaited: async () => ({ ok: false, error: 'Network connection lost' }) });
    await o.runBulkCourse({ group: 'g1', courseSlug: 's1', want: { video: true } });
    ok('the end line counts it as failed', /1 failed \(download×1\)/.test(o.logged.find(l => l.startsWith('done'))));
    ok('and the example carries the real error', /Network connection lost/.test(o.logged.join(' ')));
  }

  // An unreadable resource list leaves no failure anywhere unless it is tallied:
  // the lesson simply looks like it had no attachments.
  {
    const o = build({
      scanCourse: async () => ({ courseTitle: 'C', shape: 'flat', moduleCount: 0,
        lessons: [{ lessonId: 'l1', title: 'A', moduleIdx: null, moduleTitle: null, lessonIdx: 1,
          sourceKind: 'text', sourceRef: null, lessonUrl: 'https://u', descRaw: null,
          resourcesRaw: JSON.stringify([{ nothing: 1 }, { also: 2 }]) }] }),
    });
    await o.runBulkCourse({ group: 'g1', courseSlug: 's1', want: { video: true, files: true } });
    ok('dropped resource entries are reported', /resources-unreadable/.test(o.logged.join(' ')));
    ok('with the count', /2 entr/.test(o.logged.join(' ')));
  }

  check('the best quality wins', build().pickBestQuality([{ height: 480 }, { height: 1080 }, { height: 720 }]).height, 1080);
  check('an unlabelled height does not beat a real one', build().pickBestQuality([{ height: 720 }, {}]).height, 720);
}

// ── 11b. The worker's scripts share one global scope ─────────────────────────
// importScripts does not give each file its own scope: every top-level const,
// let, class and function lands in the same global. Two files declaring the same
// name is a SyntaxError that kills the whole worker before a line of it runs —
// no download, no popup response, nothing. It shipped once (BULK_LOG_MAX meant
// "how many lines" in background.js and "how many characters" in bulk.js), and
// no other test could see it: each file parses fine alone.
//
// Compiling the concatenation, in the worker's own load order, is exactly the
// check the browser performs. vm.Script compiles without executing, so no
// chrome.* stub is needed.
console.log('\nworker global scope');
{
  const imported = /importScripts\(([^)]*)\)/.exec(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'));
  const files = [...(imported ? imported[1].matchAll(/'([^']+)'/g) : [])].map(m => m[1]);
  ok('importScripts targets were found', files.length > 0);
  // Imported files are evaluated first, then background.js's own body.
  const combined = [...files, 'background.js']
    .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8'))
    .join('\n;\n');
  let error = null;
  try { new vm.Script(combined, { filename: 'worker-bundle.js' }); }
  catch (e) { error = e.message; }
  check(`${[...files, 'background.js'].join(' + ')} compile together`, error, null);
}

// ── 12. Bulk orchestrator invariants ─────────────────────────────────────────
// Source-level pins for the four orchestrator behaviours that fail silently:
// nothing throws when a pause is late, a cancel discards a manifest, progress is
// stored where a restart wipes it, or a missing record is read as a deleted file.
console.log('\nbulk orchestrator invariants');
{
  const src = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  // The body of one switch case: up to the next `case '` at the same level. The
  // whole file would make "this case does not do X" pass for the wrong reason.
  const caseBody = (name) => {
    const from = src.indexOf(`case '${name}':`);
    if (from === -1) return '';
    let rest = src.slice(from + name.length + 8);
    // Skip the labels a case falls through from — START_BULK and RESUME_BULK
    // share one body, so stopping at the next `case '` would find nothing.
    let m;
    while ((m = /^\s*case '[A-Z_]+':/.exec(rest))) rest = rest.slice(m[0].length);
    const to = rest.search(/\n {4}(case '|\})/);
    return to === -1 ? rest : rest.slice(0, to);
  };

  // Serial only: the offscreen merge engine holds one instance, and a course run
  // is background work where predictability beats speed.
  ok('bulk downloads are awaited one at a time', /await enqueueDownloadAwaited\(/.test(src));

  // A pause that is only checked at the top of the loop would run to the end of a
  // 183-lesson course before taking effect.
  ok('pause is checked in the lesson loop', /if \(bulkAbort\.pause\)/.test(src));
  ok('pause is checked inside a lesson too', /bulkAbort\.pause \|\| bulkAbort\.cancel/.test(src));

  // One bad lesson must not abort the course.
  const loop = src.slice(src.indexOf('for (const lesson of merged)'));
  ok('each lesson runs inside its own try', /try \{[\s\S]{0,400}runBulkLesson/.test(loop));

  // Cancelling means stop, not discard.
  ok('cancel does not clear the manifest', !/clearManifest/.test(caseBody('CANCEL_BULK')));
  // …and it does reach the download already in flight: the lesson loop only
  // checks the flags between lessons, so without this a cancel waits out the
  // rest of a long video.
  ok('cancel stops the download in flight', /cancelJob\(bulkCurrentJobId\)/.test(caseBody('CANCEL_BULK')));

  // A UI-only Pro check is not a gate.
  ok('starting a run is gated on the tier here',
    /tier !== 'lifetime' && tier !== 'monthly'/.test(caseBody('START_BULK')));
  // Two popups can each press start; a second orchestrator over the same
  // manifest downloads every remaining lesson twice.
  ok('a second concurrent run is refused', /if \(bulkRunActive\)/.test(caseBody('START_BULK')));

  // The record of finished work must outlive the browser.
  ok('the manifest lives in storage.local', /chrome\.storage\.local\.(get|set)\(/.test(src) && /manifestKey\(/.test(src));
  ok('live progress lives in storage.session', /chrome\.storage\.session\.(get|set)\([^)]*BULK_STATE_KEY/.test(src));

  // No record must never be read as "file deleted".
  const prune = src.slice(src.indexOf('async function pruneDeletedAssets'));
  ok('a cleared download history is not a deletion', /if \(!items\.length\) \{ unknown\+\+; continue; \}/.test(prune));
  ok('only an explicit exists:false counts as deleted', /items\[0\]\.exists === false\) missing\.add/.test(prune));
  ok('a failed lookup is not a deletion', /catch \{ failed\+\+; continue; \}/.test(prune));

  // A run marked active with nothing behind it must not show a live progress bar.
  // The call, not the declaration: a helper nothing invokes reconciles nothing.
  ok('an interrupted run is reconciled on startup', /^reconcileBulkStateOnStartup\(\);$/m.test(src));

  // Access is decided on the playback token, never on a hasAccess flag.
  ok('access is not decided from hasAccess', !/hasAccess/.test(src));
}

console.log(failures ? `\n✗ ${failures} failed\n` : '\n✓ all passed\n');
process.exit(failures ? 1 : 0);
