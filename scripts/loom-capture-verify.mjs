#!/usr/bin/env node
// Verifies the private-Loom playback-capture fix against a real browser.
//
// Part 1 — Loom's own behaviour: does the embed player request its HLS master
//          WITHOUT anyone pressing play? The whole fix rests on this.
// Part 2 — our plumbing: does the sniffer file that master, and does
//          captureViaPlayback find it, open/close its tab, and return it?
//
// Usage: node loom-capture-verify.mjs [--headless] [<loom-id-or-url>]
//
// The default video is one of Loom's PROGRESSIVE sessions (a single signed
// MP4). Pass a long recording (10+ min) to exercise the HLS ladder instead —
// Part 1 detects which mode it got and asserts accordingly.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv.slice(2).find(a => !a.startsWith('--'));
// Accepts a bare id or any loom.com URL (/share/, /embed/, /community/<id>-slug).
const PUBLIC_LOOM = (arg?.match(/[0-9a-f]{32}/) || [])[0]
  || '09b1aa507cb846138847bf8e98b56a71';  // off loom.com's own homepage
const HEADLESS = process.argv.includes('--headless');

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find(p => fs.existsSync(p));
if (!CHROME) { console.log('· Chrome not found'); process.exit(0); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ✓ ${label}`); return; }
  console.error(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`);
  failures++;
};
const ok = (label, cond) => check(label, !!cond, true);

function launch(profile) {
  const args = ['--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=document-user-activation-required', 'about:blank'];
  if (HEADLESS) args.splice(-1, 0, '--headless=new');
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const [, , , writeFd, readFd] = proc.stdio;
  let buf = Buffer.alloc(0), id = 0;
  const pending = new Map(), listeners = [];
  readFd.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let i;
    while ((i = buf.indexOf(0)) !== -1) {
      const raw = buf.subarray(0, i).toString();
      buf = buf.subarray(i + 1);
      let m; try { m = JSON.parse(raw); } catch { continue; }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method) listeners.forEach(fn => fn(m));
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
  return { send, onEvent: fn => listeners.push(fn), kill: () => { try { proc.kill('SIGKILL'); } catch {} } };
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'svd-loom-'));
const cdp = launch(profile);
let server = null;
let exitCode = 1;
let MODE = 'none';

try {
  await sleep(3500);

  // ── Part 1: does the Loom player fetch its master with no interaction? ──────
  console.log(`\nPart 1 — Loom player init (${HEADLESS ? 'headless' : 'headed'}, autoplay blocked)`);
  {
    const seen = [], all = [];
    cdp.onEvent((m) => {
      if (m.method === 'Network.requestWillBeSent') {
        const u = m.params?.request?.url || '';
        all.push(u);
        if (/\.m3u8|luna\.loom\.com/.test(u)) seen.push(u);
      }
    });
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url: `https://www.loom.com/embed/${PUBLIC_LOOM}` }, sessionId);

    // No clicks, no synthetic events. Just wait, the way a background tab would.
    for (let i = 0; i < 20 && !seen.some(u => /\.m3u8/.test(u)); i++) await sleep(1000);

    const masters = seen.filter(u => /\.m3u8/.test(u));
    console.log(`    total requests: ${all.length}, loom/m3u8: ${seen.length}, m3u8: ${masters.length}`);
    const hosts = {};
    for (const u of all) { try { const h = new URL(u).host; hosts[h] = (hosts[h] || 0) + 1; } catch {} }
    console.log(`    hosts: ${JSON.stringify(hosts)}`);
    console.log(`    media-ish: ${JSON.stringify(all.filter(u => /\.(m3u8|mp4|m4s|ts|mpd|webm)|video|stream|cdn/i.test(u)).slice(0, 12).map(u => u.slice(0, 130)), null, 1)}`);
    if (masters[0]) console.log(`    first master: ${masters[0].slice(0, 120)}`);
    // Loom ships a session one of two ways (see the two-modes note): an HLS
    // ladder on luna, or a single signed progressive MP4 on the cdn. Which one
    // this video uses is a property of the video, not of our capture — so
    // assert the shared contract, then the mode-specific detail.
    const transcoded = all.filter(u => /cdn\.loom\.com\/sessions\/transcoded\//.test(u));
    const thumbs = all.filter(u => /cdn\.loom\.com\/sessions\/thumbnails\//.test(u));
    MODE = masters.length ? 'HLS' : transcoded.length ? 'progressive' : 'none';
    console.log(`    delivery mode: ${MODE}`);
    const media = MODE === 'HLS' ? masters : transcoded;
    ok('the player fetches its media with NO user interaction', media.length > 0);
    ok('and the media is signed', media.some(u => /Policy=|Signature=|\?/.test(u)));
    ok('carrying the same id as the share URL', media.some(u => u.includes(PUBLIC_LOOM)));
    if (MODE === 'HLS') {
      ok('the master is on luna', masters.some(u => /luna\.loom\.com/.test(u)));
      ok('and no progressive MP4 is offered for it', transcoded.length === 0);
    }
    // The trap the sniffer's path match exists for.
    ok('a hover-preview thumbnail mp4 is fetched on the same load',
      thumbs.length > 0);
    ok('and it is NOT under /sessions/transcoded/',
      thumbs.every(u => !/\/sessions\/transcoded\//.test(u)));
    await cdp.send('Target.closeTarget', { targetId });
  }

  // ── Part 2: our sniffer + captureViaPlayback, driven in the real worker ─────
  console.log('\nPart 2 — the extension captures it and captureViaPlayback returns it');

  // A stand-in "lesson page" that embeds the same Loom, served locally so the
  // test does not need a Skool account. What matters is that captureViaPlayback
  // opens a tab, an embedded Loom player runs in it, and the master is filed
  // under this tab's registry — all of which is host-agnostic.
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><meta charset=utf-8><title>lesson</title>
      <iframe src="https://www.loom.com/embed/${PUBLIC_LOOM}"
              width="640" height="360" frameborder="0" allowfullscreen></iframe>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const lessonUrl = `http://127.0.0.1:${server.address().port}/lesson`;
  console.log(`    stand-in lesson page: ${lessonUrl}`);

  const { id: EXT } = await cdp.send('Extensions.loadUnpacked', { path: ROOT });
  await sleep(1500);

  // Wake the worker via the popup, then attach to the worker itself.
  const { targetId: popupId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${EXT}/popup.html` });
  await sleep(2000);

  const { targetInfos } = await cdp.send('Target.getTargets');
  const sw = targetInfos.find(t => t.type === 'service_worker' && t.url.includes(EXT));
  ok('the service worker is running', !!sw);
  if (!sw) throw new Error('no service worker target');

  const { sessionId: swSession } = await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, swSession);

  const evalSW = async (expression) => {
    const r = await cdp.send('Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true }, swSession);
    if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result.value;
  };

  check('captureViaPlayback exists in the worker', await evalSW('typeof captureViaPlayback'), 'function');
  check('capturedMasterFor exists too', await evalSW('typeof capturedMasterFor'), 'function');

  const tabsBefore = await evalSW('new Promise(r => chrome.tabs.query({}, ts => r(ts.length)))');
  const winsBefore = await evalSW('new Promise(r => chrome.windows.getAll(ws => r(ws.length)))');

  const result = await evalSW(`(async () => {
    const t0 = Date.now();
    const got = await captureViaPlayback(
      { sourceKind: 'loom', lessonUrl: ${JSON.stringify(lessonUrl)} },
      ${JSON.stringify(PUBLIC_LOOM)}
    );
    return { ms: Date.now() - t0, url: got && got.url, headers: got && got.headers,
             progressive: got && got.progressive, registrySize: tabVideos.size };
  })()`);

  if (result?.__error) { console.error('  ✗ captureViaPlayback threw:\n      ' + result.__error); failures++; }
  else {
    console.log(`    took ${result.ms}ms; master: ${String(result.url).slice(0, 110)}`);
    ok('captureViaPlayback returned a signed media URL', !!result.url);
    ok('and it is a loom URL', /loom\.com/.test(result.url || ''));
    ok('carrying the id we asked for', String(result.url || '').includes(PUBLIC_LOOM));
    ok('well inside the 15s budget', result.ms < 15000);
    check('and it reports the delivery mode it captured', !!result.progressive, MODE === 'progressive');
    check('and it left no registry entry behind', result.registrySize, 0);
  }

  // chrome.windows.remove resolves before its tab stops appearing in
  // tabs.query, so a single sample right after the capture reads one tab too
  // many. Give the teardown a moment to settle before failing on it.
  let tabsAfter = tabsBefore + 1;
  for (let i = 0; i < 10 && tabsAfter !== tabsBefore; i++) {
    await sleep(500);
    tabsAfter = await evalSW('new Promise(r => chrome.tabs.query({}, ts => r(ts.length)))');
  }
  const winsAfter = await evalSW('new Promise(r => chrome.windows.getAll(ws => r(ws.length)))');
  check('the tab it opened was closed again', tabsAfter, tabsBefore);
  check('and so was the window', winsAfter, winsBefore);

  // ── Part 3: the captured URL resolves to something downloadable ────────────
  // Capture alone is not the feature. A progressive MP4 has no playlist, so it
  // needs its own branch in resolveQualities; an HLS master goes through the
  // parser. Whichever mode this video uses, the end of the line is the same:
  // at least one rendition the download step could fetch.
  console.log('\nPart 3 — resolveQualities turns the capture into renditions');
  const resolved = await evalSW(`(async () => {
    // Exactly what resolveBulkLesson passes — including the progressive flag,
    // whose absence is invisible in the label and only shows up in \`kind\`.
    const r = await resolveQualities({ platform: 'loom',
      url: CAPTURED_URL, headers: CAPTURED_HEADERS, progressive: CAPTURED_PROGRESSIVE });
    return { n: (r && r.qualities || []).length,
             labels: (r && r.qualities || []).map(q => q.label || q.height || '?').slice(0, 6),
             kinds: (r && r.qualities || []).map(q => q.kind),
             first: (r && r.qualities || [])[0]?.videoUrl?.slice(0, 110) };
  })()`.replace('CAPTURED_URL', JSON.stringify(result?.url || ''))
       .replace('CAPTURED_HEADERS', JSON.stringify(result?.headers || null))
       .replace('CAPTURED_PROGRESSIVE', JSON.stringify(result?.progressive || false)));

  if (resolved?.__error) { console.error('  ✗ resolveQualities threw:\n      ' + resolved.__error); failures++; }
  else {
    console.log(`    renditions: ${resolved.n} ${JSON.stringify(resolved.labels)} kinds=${JSON.stringify(resolved.kinds)}`);
    console.log(`    first: ${resolved.first}`);
    ok('the captured master resolves to at least one rendition', resolved.n > 0);
    ok('and the rendition carries a fetchable loom URL', /loom\.com/.test(resolved.first || ''));
    if (MODE === 'HLS') {
      // The ladder must actually have been parsed — one entry per rendition,
      // labelled by height, not the single 'Original' the progressive branch
      // returns without parsing anything.
      ok('the ladder was parsed into per-height renditions',
        resolved.n > 1 && resolved.labels.every(l => /^\d+p$/.test(String(l))));
      check('and the renditions are HLS', [...new Set(resolved.kinds)], ['hls']);
    } else {
      ok('the progressive branch returns the streamed file itself',
        resolved.n === 1 && resolved.labels[0] === 'Original');
      // BOTH branches label it 'Original', so the label proves nothing. `kind`
      // is the only thing that distinguishes "the MP4 itself" from "an MP4 the
      // playlist parser mistook for a single-rendition media playlist" — and
      // getting that wrong sends the whole file through res.text() and then
      // down the HLS segment path.
      check('and as an MP4, not a playlist the parser mis-read', resolved.kinds, ['mp4']);
    }
  }

  // The negative case: an id that never appears must not borrow another
  // video's master, and must give up rather than hang.
  const miss = await evalSW(`(async () => {
    const t0 = Date.now();
    const got = await captureViaPlayback(
      { sourceKind: 'loom', lessonUrl: ${JSON.stringify(lessonUrl)} }, 'f'.repeat(32));
    return { ms: Date.now() - t0, url: got && got.url };
  })()`);
  console.log(`    miss case took ${miss.ms}ms`);
  // One lone same-platform capture is deliberately accepted (the unlinked-Vimeo
  // rule), so a single embed on the page IS returned. Assert the real contract:
  // it returns a genuine master, never a fabricated one, and it terminates.
  ok('a mismatched id still terminates within budget', miss.ms <= 16000);
  ok('and never invents a URL', miss.url == null || /loom\.com/.test(miss.url));

  await cdp.send('Target.closeTarget', { targetId: popupId });
  exitCode = failures ? 1 : 0;
  console.log(failures ? `\n✗ ${failures} failed\n` : '\n✓ all passed\n');
} catch (e) {
  console.error(`\n✗ could not run: ${e.message}\n`);
  exitCode = 1;
} finally {
  cdp.kill();
  if (server) server.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
process.exit(exitCode);
