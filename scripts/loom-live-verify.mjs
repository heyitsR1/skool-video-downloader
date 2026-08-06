#!/usr/bin/env node
// Verifies the private-Loom capture against a REAL Skool lesson, using a real
// signed-in session. This is the one check the automated suites cannot do: they
// have no Skool account, and a Loom private to a classroom is served only to a
// player the account is entitled to.
//
//   Step 1 — sign in once. Chrome opens on a profile kept in this repo's
//            .loom-verify-profile (gitignored). Log into Skool, then close it.
//
//              node scripts/loom-live-verify.mjs --login
//
//   Step 2 — point it at a lesson whose video is a private Loom. Use one a
//            course backup skipped: open _download-log.txt and take a lesson
//            listed as needs-playback (or no-qualities on 1.5.1 and earlier).
//
//              node scripts/loom-live-verify.mjs "https://www.skool.com/<group>/classroom/<course>?md=<lesson>"
//
// It runs the extension's own captureViaPlayback against that URL and reports
// what came back. Nothing is downloaded and nothing is written to the course.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = path.join(ROOT, '.loom-verify-profile');
const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
].find(p => fs.existsSync(p));
if (!CHROME) { console.error('Chrome not found.'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = process.argv.slice(2);
const LOGIN = args.includes('--login');
const LESSON = args.find(a => a.startsWith('http'));

if (!LOGIN && !LESSON) {
  console.error('Pass a Skool lesson URL, or --login to sign in first.\n'
    + 'See the header of this file for the two steps.');
  process.exit(1);
}

if (LOGIN) {
  fs.mkdirSync(PROFILE, { recursive: true });
  console.log('\nChrome is opening on a throwaway profile kept at:\n  ' + PROFILE
    + '\n\nSign in to Skool, open any lesson to confirm it works, then CLOSE Chrome.'
    + '\nThen re-run with a lesson URL.\n');
  const p = spawn(CHROME, [`--user-data-dir=${PROFILE}`, '--no-first-run',
    '--no-default-browser-check', 'https://www.skool.com/'], { stdio: 'inherit' });
  p.on('exit', () => console.log('\nSigned-in profile saved. Now run:\n'
    + '  node scripts/loom-live-verify.mjs "<lesson URL>"\n'));
  await new Promise(r => p.on('exit', r));
  process.exit(0);
}

if (!fs.existsSync(PROFILE)) {
  console.error('No signed-in profile yet. Run this first:\n'
    + '  node scripts/loom-live-verify.mjs --login');
  process.exit(1);
}

// ── CDP over a pipe (same mechanism as e2e-smoke.mjs) ─────────────────────────
function launch() {
  const proc = spawn(CHROME, ['--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const [, , , writeFd, readFd] = proc.stdio;
  let buf = Buffer.alloc(0), id = 0;
  const pending = new Map();
  readFd.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let i;
    while ((i = buf.indexOf(0)) !== -1) {
      const raw = buf.subarray(0, i).toString(); buf = buf.subarray(i + 1);
      let m; try { m = JSON.parse(raw); } catch { continue; }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const myId = ++id;
    const timer = setTimeout(() => { pending.delete(myId); rej(new Error(`${method} timed out`)); }, 40000);
    pending.set(myId, m => { clearTimeout(timer); m.error ? rej(new Error(m.error.message)) : res(m.result); });
    writeFd.write(JSON.stringify({ id: myId, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  return { send, kill: () => { try { proc.kill('SIGKILL'); } catch {} } };
}

const cdp = launch();
let failures = 0;
const ok = (label, cond) => { console.log(`  ${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

try {
  await sleep(3500);
  const { id: EXT } = await cdp.send('Extensions.loadUnpacked', { path: ROOT });
  await sleep(1500);
  const { targetId: popupId } = await cdp.send('Target.createTarget',
    { url: `chrome-extension://${EXT}/popup.html` });
  await sleep(2500);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const sw = targetInfos.find(t => t.type === 'service_worker' && t.url.includes(EXT));
  if (!sw) throw new Error('the service worker is not running');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate',
      { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    return r.exceptionDetails ? { __error: r.exceptionDetails.exception?.description } : r.result.value;
  };

  console.log(`\nLesson: ${LESSON}\n`);

  // Confirm the session is real before blaming the capture for a sign-in problem.
  const signedIn = await ev(`fetch('https://www.skool.com/', { credentials: 'include' })
    .then(r => r.text()).then(t => !/Log In<\\/|Sign up<\\//i.test(t.slice(0, 200000)))
    .catch(() => false)`);
  ok('the profile is signed in to Skool', signedIn === true);
  if (!signedIn) console.log('    → re-run with --login; everything below would fail for that reason alone.');

  // What the ordinary API route does with this lesson. A private embed 403s here
  // — that is the failure the capture exists to recover from.
  const sourceId = await ev(`(async () => {
    const res = await fetch(${JSON.stringify(LESSON)}, { credentials: 'include' });
    const html = await res.text();
    const m = html.match(/loom\\.com\\\\?\\/(?:share|embed)\\\\?\\/([0-9a-f]{20,})/i);
    return m ? m[1] : null;
  })()`);
  ok('a Loom id was found on the lesson page', !!sourceId && !sourceId.__error);
  if (!sourceId || sourceId.__error) throw new Error('no Loom embed on that lesson — pick one that is a Loom video');
  console.log(`    loom id: ${sourceId}`);

  const apiRoute = await ev(`(async () => {
    try { const q = await resolveQualities({ platform: 'loom', sourceId: ${JSON.stringify(sourceId)},
                                             pageUrl: ${JSON.stringify(LESSON)} });
          return { ok: true, n: (q.qualities || []).length };
    } catch (e) { return { ok: false, msg: String(e.message).slice(0, 90) }; }
  })()`);
  console.log(`    API route: ${apiRoute.ok ? `${apiRoute.n} renditions` : 'refused — ' + apiRoute.msg}`);

  // The thing under test.
  const got = await ev(`(async () => {
    const t0 = Date.now();
    const c = await captureViaPlayback(
      { sourceKind: 'loom', lessonUrl: ${JSON.stringify(LESSON)} }, ${JSON.stringify(sourceId)});
    if (!c) return { ms: Date.now() - t0, url: null };
    let n = null, k = null, err = null;
    try { const q = await resolveQualities({ platform: 'loom', url: c.url, headers: c.headers,
                                             progressive: c.progressive });
          n = (q.qualities || []).length; k = (q.qualities || [])[0]?.kind || null; }
    catch (e) { err = String(e.message).slice(0, 90); }
    return { ms: Date.now() - t0, url: c.url, headers: c.headers,
             progressive: c.progressive, renditions: n, kind: k, err };
  })()`);

  if (got?.__error) { console.log('  ✗ captureViaPlayback threw: ' + got.__error.slice(0, 200)); failures++; }
  else {
    console.log(`\n    captured in ${got.ms}ms`);
    console.log(`    url: ${got.url ? got.url.slice(0, 140) : '(nothing)'}`);
    ok('the player handed over a stream', !!got.url);
    if (got.url) {
      const hls = /\.m3u8/.test(got.url);
      console.log(`    delivery: ${hls ? 'HLS master' : /transcoded/.test(got.url) ? 'progressive MP4' : 'unknown'}`);
      ok('and it resolves to at least one rendition', got.renditions > 0);
      // A progressive capture resolved as 'hls' means the flag was dropped on
      // the way through: the parser read the whole MP4 and mis-called it a
      // media playlist, and the download would run the segment path over it.
      ok('and as the right kind for how it was delivered',
        got.kind === (hls ? 'hls' : 'mp4'));
      if (got.err) console.log(`    resolve error: ${got.err}`);
      if (hls) console.log('    → this is the HLS path the automated suite could not reach.');
    }
  }

  await cdp.send('Target.closeTarget', { targetId: popupId });
  console.log(failures ? `\n✗ ${failures} check(s) failed\n` : '\n✓ the capture works on a real private Loom\n');
} catch (e) {
  console.error(`\n✗ could not run: ${e.message}\n`);
  failures++;
} finally {
  cdp.kill();
}
process.exit(failures ? 1 : 0);
