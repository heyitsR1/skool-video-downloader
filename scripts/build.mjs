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
  'popup.html', 'popup.css', 'popup.js', 'welcome.html', 'welcome.js', 'icons', 'lib', '_locales',
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
  if (!enabled) {
    t = mustReplace(t, "CHANNEL: 'full'", "CHANNEL: 'cws'", 'CHANNEL flag');
  }
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

  // 4. Drop "YouTube" from every locale's store listing description. Each
  // locale's clause is listed explicitly (not regex-guessed) so a translation
  // that drifts from this shape fails the build instead of silently shipping
  // a CWS listing that still advertises YouTube downloads.
  const YOUTUBE_CLAUSE_BY_LOCALE = {
    en: ['Vimeo, YouTube & Wistia', 'Vimeo & Wistia'],
    en_GB: ['Vimeo, YouTube & Wistia', 'Vimeo & Wistia'],
    de: ['Vimeo-, YouTube- & Wistia-Lektionen', 'Vimeo- & Wistia-Lektionen'],
    es: ['Vimeo, YouTube y Wistia', 'Vimeo y Wistia'],
    es_419: ['Vimeo, YouTube y Wistia', 'Vimeo y Wistia'],
    pt_BR: ['Vimeo, YouTube e Wistia', 'Vimeo e Wistia'],
    fr: ['Vimeo, YouTube et Wistia', 'Vimeo et Wistia'],
    id: ['Vimeo, YouTube & Wistia', 'Vimeo & Wistia'],
    hi: ['Vimeo, YouTube और Wistia', 'Vimeo और Wistia'],
    vi: ['Vimeo, YouTube & Wistia', 'Vimeo & Wistia'],
    tr: ['Vimeo, YouTube ve Wistia', 'Vimeo ve Wistia'],
    ru: ['Vimeo, YouTube и Wistia', 'Vimeo и Wistia'],
    pl: ['Vimeo, YouTube i Wistia', 'Vimeo i Wistia'],
    it: ['Vimeo, YouTube e Wistia', 'Vimeo e Wistia'],
    nl: ['Vimeo-, YouTube- & Wistia-lessen', 'Vimeo- & Wistia-lessen'],
  };
  // Popup UI (planFeaturePlatforms) and the welcome page intro (welcomeSub) are
  // only fully translated for a subset of locales — the rest fall back to `en`
  // at runtime via chrome.i18n, which is already stripped below, so they don't
  // need entries here.
  const WELCOME_SUB_CLAUSE_BY_LOCALE = {
    en: ['Loom, Vimeo, YouTube or Wistia', 'Loom, Vimeo or Wistia'],
    de: ['Loom-, Vimeo-, YouTube- oder Wistia-Video', 'Loom-, Vimeo- oder Wistia-Video'],
    es: ['Loom, Vimeo, YouTube o Wistia', 'Loom, Vimeo o Wistia'],
    es_419: ['Loom, Vimeo, YouTube o Wistia', 'Loom, Vimeo o Wistia'],
    pt_BR: ['Loom, Vimeo, YouTube ou Wistia', 'Loom, Vimeo ou Wistia'],
    fr: ['Loom, Vimeo, YouTube ou Wistia', 'Loom, Vimeo ou Wistia'],
  };
  // Only needed where planFeaturePlatforms' wording differs from the store
  // description's clause for that locale — German's description compounds
  // "YouTube-" with a hyphen, but the popup's plain feature-list line doesn't.
  const PLAN_FEATURE_CLAUSE_BY_LOCALE = {
    de: ['Vimeo, YouTube & Wistia', 'Vimeo & Wistia'],
  };

  // Only strips if present — safe to call for a clause that a prior pass in
  // the same file already removed (e.g. extDescription and planFeaturePlatforms
  // happen to share identical wording in most locales, but not in German,
  // where planFeaturePlatforms stays unhyphenated).
  function replaceIfPresent(text, find, replace) {
    return text.includes(find) ? text.split(find).join(replace) : text;
  }

  const localesDir = path.join(dir, '_locales');
  for (const code of fs.readdirSync(localesDir)) {
    const clause = YOUTUBE_CLAUSE_BY_LOCALE[code];
    if (!clause) fail(`no YouTube-clause mapping for new locale "${code}" — add one to YOUTUBE_CLAUSE_BY_LOCALE`);
    const lp = path.join(localesDir, code, 'messages.json');
    let loc = fs.readFileSync(lp, 'utf8');

    // 4. Store listing description (every locale has this key).
    loc = mustReplace(loc, clause[0], clause[1], `${code} store description`);
    // 5. Popup pricing feature list, if this locale has full UI translation —
    // usually the same clause text as the description (already stripped
    // above), so this is a no-op except where the wording genuinely differs.
    loc = replaceIfPresent(loc, clause[0], clause[1]);
    const planClause = PLAN_FEATURE_CLAUSE_BY_LOCALE[code];
    if (planClause) loc = replaceIfPresent(loc, planClause[0], planClause[1]);

    // 6. Welcome page intro paragraph (only locales with full UI translation).
    const wsClause = WELCOME_SUB_CLAUSE_BY_LOCALE[code];
    if (wsClause) loc = mustReplace(loc, wsClause[0], wsClause[1], `${code} welcome intro`);

    // Verify: no UI/listing key in this locale still mentions YouTube. Catches
    // any clause wording that drifted out of sync with the maps above.
    const messages = JSON.parse(loc);
    for (const key of ['extDescription', 'planFeaturePlatforms', 'welcomeSub']) {
      const msg = messages[key]?.message;
      if (msg?.includes('YouTube')) fail(`${code}.${key} still mentions YouTube after CWS strip — update the clause maps in build.mjs`);
    }

    fs.writeFileSync(lp, loc);
  }

  // 5b. The <li data-i18n="planFeaturePlatforms"> element's static fallback
  // text (shown for an instant before popup.js's applyI18n() overwrites it,
  // and visible to anyone reading the shipped source) is hard-coded English —
  // strip YouTube from it too so no CWS-artifact surface mentions it.
  const hp = path.join(dir, 'popup.html');
  let html = fs.readFileSync(hp, 'utf8');
  html = mustReplace(html,
    'Skool, Loom, Vimeo, YouTube &amp; Wistia',
    'Skool, Loom, Vimeo &amp; Wistia',
    'popup feature line fallback text');
  fs.writeFileSync(hp, html);

  // 6b. Drop the YouTube chip from the welcome page platform list — a single
  // shared element (chrome.i18n picks the locale text at runtime), so this
  // only needs to happen once for the one welcome.html shipped.
  const wp = path.join(dir, 'welcome.html');
  let welcome = fs.readFileSync(wp, 'utf8');
  welcome = mustReplace(welcome,
    '<span class="chip" data-i18n="chipYoutube">▶️ YouTube</span>',
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
