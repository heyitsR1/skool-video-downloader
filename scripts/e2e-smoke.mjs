#!/usr/bin/env node
// End-to-end smoke test: installs this extension into a throwaway Chrome and
// drives its real service worker.
//
//   node scripts/e2e-smoke.mjs
//
// The other suites read the source or run its pure helpers. This one is the only
// check that the extension actually *loads and answers* — the class of failure
// where every unit test passes and nothing works, because two files declared the
// same global and the worker died before its first line ran.
//
// Notes on the mechanism, all of which cost an afternoon to find:
//   * Chrome 137+ ignores --load-extension. The replacement is the CDP
//     Extensions domain, which only takes effect over --remote-debugging-pipe,
//     never over --remote-debugging-port.
//   * Chrome refuses remote debugging on the default profile directory, so this
//     always uses a temporary one.
//   * An extension installed this way lasts for the browser session only.
//
// The profile has no Skool session, so this covers everything up to the point
// where a real course is needed: loading, message routing, the tier gate, and
// the signed-out path. Exit 0 if every assertion holds; exit 0 with a notice if
// Chrome is not installed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(p => fs.existsSync(p));

if (!CHROME) {
  console.log('· Chrome not found — skipping the end-to-end suite (not a pass)');
  process.exit(0);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── CDP over a pipe: fd 3 is where Chrome reads, fd 4 is where it writes ──────
function launch(profile) {
  const proc = spawn(CHROME, [
    '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--headless=new', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const [, , , writeFd, readFd] = proc.stdio;
  let buf = Buffer.alloc(0), id = 0;
  const pending = new Map();
  readFd.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let i;
    while ((i = buf.indexOf(0)) !== -1) {
      const raw = buf.subarray(0, i).toString();
      buf = buf.subarray(i + 1);
      let m; try { m = JSON.parse(raw); } catch { continue; }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const myId = ++id;
    const timer = setTimeout(() => { pending.delete(myId); rej(new Error(`${method} timed out`)); }, 30000);
    pending.set(myId, (m) => {
      clearTimeout(timer);
      m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result);
    });
    writeFd.write(JSON.stringify({ id: myId, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  return { send, kill: () => { try { proc.kill('SIGKILL'); } catch {} } };
}

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ✓ ${label}`); return; }
  console.error(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`);
  failures++;
}
const ok = (label, cond) => check(label, !!cond, true);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'svd-e2e-'));
const cdp = launch(profile);
let exitCode = 1;
try {
  await sleep(3500);
  const { id: EXT } = await cdp.send('Extensions.loadUnpacked', { path: ROOT });
  await sleep(1200);

  const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${EXT}/popup.html` });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await sleep(2000);

  const ev = async (expression) => {
    const r = await cdp.send('Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result.value;
  };
  // Raced against a deadline in the page: a worker that failed to load never
  // answers at all, and without this the whole suite hangs on the first message
  // instead of saying which one went unanswered.
  const msg = (o) => ev(`Promise.race([
    new Promise(r => chrome.runtime.sendMessage(${JSON.stringify(o)}, x =>
      r(chrome.runtime.lastError ? { __lastError: chrome.runtime.lastError.message } : x))),
    new Promise(r => setTimeout(() => r({ __noAnswer: '${o.type}' }), 5000)),
  ])`);

  console.log('the extension loads');
  // If the worker's scripts collide in the shared global scope, nothing below
  // this line can pass — which is the whole reason this suite exists.
  check('the popup is served by the extension', await ev(`typeof chrome?.runtime`), 'object');
  ok('the bulk panel is in the document', await ev(`!!document.getElementById('bulk')`));
  const hello = await msg({ type: 'GET_LICENSE_STATUS' });
  if (hello?.__noAnswer) {
    console.error('  ✗ the service worker never answered — it most likely failed to load.'
      + '\n      Check for a duplicate top-level declaration across the importScripts files.');
    failures++;
  } else ok('the popup reached the service worker', hello?.remaining !== undefined);
  check('no run is in progress', await msg({ type: 'GET_BULK_STATE' }), { ok: true, state: null });

  console.log('\nURL classification');
  check('a community page is not a course',
    (await msg({ type: 'BULK_PREFLIGHT', url: 'https://www.skool.com/some-group' }))?.code, 'not-a-course');
  check('a non-Skool page is not a course',
    (await msg({ type: 'BULK_PREFLIGHT', url: 'https://example.com/x' }))?.code, 'not-a-course');

  console.log('\nthe tier gate lives in the worker, not only in the popup');
  check('a free account cannot start a run',
    await msg({ type: 'START_BULK', group: 'g', courseSlug: 'c' }), { ok: false, code: 'pro-required' });
  check('nor resume one',
    await msg({ type: 'RESUME_BULK', group: 'g', courseSlug: 'c' }), { ok: false, code: 'pro-required' });
  check('and nothing was started', await msg({ type: 'GET_BULK_STATE' }), { ok: true, state: null });

  console.log('\nsigned out of Skool');
  // Skool answers a classroom URL with the community's about page rather than an
  // error, so this is decided on the final URL and not the status code.
  check('a course URL blames sign-in, not "no lessons"',
    (await msg({ type: 'BULK_PREFLIGHT', url: 'https://www.skool.com/some-group/classroom/abc' }))?.code,
    'not-signed-in');

  console.log('\na run that cannot reach the course ends honestly');
  await ev(`chrome.storage.local.set({ tier: 'lifetime' })`);
  check('the run is accepted',
    await msg({ type: 'START_BULK', group: 'some-group', courseSlug: 'abc', want: { video: true } }),
    { ok: true, started: true });
  let state = null;
  for (let i = 0; i < 20 && !['error', 'completed', 'cancelled'].includes(state?.phase); i++) {
    await sleep(1000);
    state = (await msg({ type: 'GET_BULK_STATE' }))?.state;
  }
  check('it reaches the error phase', state?.phase, 'error');
  check('naming the cause', state?.code, 'not-signed-in');
  ok('with a message a user can act on', /Sign in to Skool/.test(state?.message || ''));
  ok('and the run is on record for a problem report',
    /run aborted: not-signed-in/.test(await ev(
      `new Promise(r => chrome.storage.local.get('bulkLog', o => r((o.bulkLog||[]).map(x=>x.message).join(' | '))))`)));

  console.log('\nthe controls answer');
  check('PAUSE_BULK', await msg({ type: 'PAUSE_BULK' }), { ok: true });
  check('CANCEL_BULK', await msg({ type: 'CANCEL_BULK' }), { ok: true });
  check('CLEAR_MANIFEST', await msg({ type: 'CLEAR_MANIFEST', group: 'g', courseSlug: 'c' }), { ok: true });

  exitCode = failures ? 1 : 0;
  console.log(failures ? `\n✗ ${failures} failed\n` : '\n✓ all passed\n');
} catch (e) {
  console.error(`\n✗ the suite could not run: ${e.message}\n`);
  exitCode = 1;
} finally {
  cdp.kill();
  fs.rmSync(profile, { recursive: true, force: true });
}
process.exit(exitCode);
