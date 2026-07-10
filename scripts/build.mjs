#!/usr/bin/env node
// Build both distributions of Skool Video Downloader from this single source tree.
//
//   full → dist/skool-video-downloader-full-v<version>.zip
//          YouTube downloading works. Sideloaded from GitHub.
//   cws  → dist/skool-video-downloader-cws-v<version>.zip
//          Chrome Web Store artifact. All YouTube-download code, host
//          permissions, and listing copy are stripped; the popup shows the
//          policy notice instead.
//
// The build FAILS LOUDLY if any expected transform target is missing (source
// drifted) or if the CWS artifact still contains YouTube-download code. Run:
//   node scripts/build.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

// Files/dirs that make up the shippable extension (everything else — docs,
// scripts, dist, git, old zips — is deliberately excluded).
const INCLUDE = [
  'manifest.json', 'background.js', 'content.js', 'detectors.js', 'buildConfig.js',
  'popup.html', 'popup.css', 'popup.js', 'welcome.html', 'icons', 'lib', '_locales',
];

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;

function fail(msg) { console.error(`\n✗ build failed: ${msg}\n`); process.exit(1); }

// Exact-match replace that asserts the target existed.
function mustReplace(text, find, replace, label) {
  if (!text.includes(find)) fail(`expected to find ${label} but it was missing — source drifted`);
  return text.split(find).join(replace);
}

function stage(target) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `svd-${target}-`));
  for (const item of INCLUDE) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) fail(`missing source: ${item}`);
    fs.cpSync(src, path.join(dir, item), { recursive: true });
  }
  return dir;
}

function writeFlag(dir, enabled) {
  const p = path.join(dir, 'buildConfig.js');
  let t = fs.readFileSync(p, 'utf8');
  t = mustReplace(t, 'YT_DOWNLOAD_ENABLED: true', `YT_DOWNLOAD_ENABLED: ${enabled}`, 'YT_DOWNLOAD_ENABLED flag');
  fs.writeFileSync(p, t);
}

function stripYouTube(dir) {
  // 1. Flag off.
  writeFlag(dir, false);

  // 2. Remove YouTube / googlevideo host permissions from the manifest.
  const mp = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const drop = new Set([
    '*://*.youtube.com/*', '*://*.youtube-nocookie.com/*', '*://*.googlevideo.com/*',
  ]);
  const before = manifest.host_permissions.length;
  manifest.host_permissions = manifest.host_permissions.filter(h => !drop.has(h));
  if (manifest.host_permissions.length !== before - drop.size) {
    fail('manifest host_permissions did not contain the expected YouTube/googlevideo entries');
  }
  fs.writeFileSync(mp, JSON.stringify(manifest, null, 2) + '\n');

  // 3. Replace the Innertube resolver block in detectors.js with a stub.
  const dp = path.join(dir, 'detectors.js');
  let det = fs.readFileSync(dp, 'utf8');
  const start = '// >>> SVD_YT_BLOCK_START';
  const end = '// <<< SVD_YT_BLOCK_END';
  const i = det.indexOf(start), j = det.indexOf(end);
  if (i === -1 || j === -1 || j < i) fail('SVD_YT_BLOCK markers not found in detectors.js');
  const stub =
    '// YouTube downloads are not available in the Chrome Web Store build.\n' +
    'async function resolveYouTubeQualities() {\n' +
    "  throw new Error('YouTube downloads are not available in this build.');\n" +
    '}';
  det = det.slice(0, i) + stub + det.slice(j + end.length);
  fs.writeFileSync(dp, det);

  // 4. Drop "YouTube" from the store listing description.
  const lp = path.join(dir, '_locales/en/messages.json');
  let loc = fs.readFileSync(lp, 'utf8');
  loc = mustReplace(loc,
    'Save Skool, Loom, Vimeo, YouTube & Wistia lessons as MP4',
    'Save Skool, Loom, Vimeo & Wistia lessons as MP4',
    'store description');
  fs.writeFileSync(lp, loc);

  // 5. Drop "YouTube" from the popup pricing feature list.
  const hp = path.join(dir, 'popup.html');
  let html = fs.readFileSync(hp, 'utf8');
  html = mustReplace(html,
    'Skool, Loom, Vimeo, YouTube &amp; Wistia',
    'Skool, Loom, Vimeo &amp; Wistia',
    'popup feature line');
  fs.writeFileSync(hp, html);

  // 6. Drop "YouTube" from the welcome page platform copy — the CWS build must
  // not advertise saving YouTube videos anywhere a reviewer might look.
  const wp = path.join(dir, 'welcome.html');
  let welcome = fs.readFileSync(wp, 'utf8');
  welcome = mustReplace(welcome,
    'Loom, Vimeo, YouTube or Wistia',
    'Loom, Vimeo or Wistia',
    'welcome platform line');
  welcome = mustReplace(welcome,
    '<span class="chip">▶️ YouTube</span>',
    '',
    'welcome YouTube chip');
  fs.writeFileSync(wp, welcome);
}

// Prove the CWS staging tree ships no YouTube-download capability.
function auditCws(dir) {
  const textExt = new Set(['.js', '.json', '.html', '.css']);
  const offenders = [];
  (function walk(d) {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!textExt.has(path.extname(name))) continue;
      const t = fs.readFileSync(p, 'utf8');
      for (const needle of ['youtubei', 'googlevideo']) {
        if (t.includes(needle)) offenders.push(`${path.relative(dir, p)} contains "${needle}"`);
      }
    }
  })(dir);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  for (const h of manifest.host_permissions) {
    if (/youtube|googlevideo/.test(h)) offenders.push(`manifest still grants ${h}`);
  }
  if (offenders.length) fail('CWS artifact is not clean:\n  - ' + offenders.join('\n  - '));
}

function zip(dir, name) {
  fs.mkdirSync(DIST, { recursive: true });
  const out = path.join(DIST, name);
  fs.rmSync(out, { force: true });
  execFileSync('zip', ['-r', '-q', '-X', out, '.'], { cwd: dir });
  const mb = (fs.statSync(out).size / 1048576).toFixed(1);
  console.log(`✓ ${name}  (${mb} MB)`);
}

// ── Full build ────────────────────────────────────────────────────────────────
const full = stage('full');
const fullFlag = fs.readFileSync(path.join(full, 'buildConfig.js'), 'utf8');
if (!fullFlag.includes('YT_DOWNLOAD_ENABLED: true')) fail('full build lost its enabled flag');
zip(full, `skool-video-downloader-full-v${version}.zip`);

// ── Chrome Web Store build ────────────────────────────────────────────────────
const cws = stage('cws');
stripYouTube(cws);
auditCws(cws);
zip(cws, `skool-video-downloader-cws-v${version}.zip`);

// Cleanup.
fs.rmSync(full, { recursive: true, force: true });
fs.rmSync(cws, { recursive: true, force: true });
console.log(`\nBuilt v${version} → dist/`);
