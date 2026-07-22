#!/usr/bin/env node
// Publish this build's version to the update-check config the extension polls
// (GET /version?product=skool-video-downloader → popup update banner).
//
// This is the step that silently rotted once already: releases kept shipping to
// GitHub while the config sat at 1.1.0 from July 12, so every sideload user was
// told they were current for eight versions running. Run it as part of every
// release, right after `gh release create`:
//
//   node scripts/publish-version.mjs              # set latestFull = manifest version
//   node scripts/publish-version.mjs --cws 1.1.8  # ...and latestCws, once the
//                                                 # store listing is actually live
//
// latestFull comes from manifest.json because the GitHub release IS this build.
// latestCws must be passed explicitly and must match what is PUBLISHED in the
// Chrome Web Store, not what was built — a latestCws ahead of the store banners
// users about a version they have no way to install.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAMESPACE_ID = 'f7573563f0104a44bfed5a463af7c8bb'; // VERSION_INFO binding
const KEY = 'config:skool-video-downloader';

const args = process.argv.slice(2);
const cwsIdx = args.indexOf('--cws');
const cwsVersion = cwsIdx >= 0 ? args[cwsIdx + 1] : null;
if (cwsIdx >= 0 && !/^\d+\.\d+\.\d+$/.test(cwsVersion || '')) {
  console.error('✗ --cws needs a version like 1.1.8');
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;

// wrangler only authenticates from a directory holding a wrangler.toml — run it
// from this repo's worker/ dir, not the repo root. Run from the root it 401s on
// reads while writes still succeed, which is how a read-modify-write turns into
// a silent clobber.
const WORKER_DIR = path.join(ROOT, 'worker');
const kv = (...a) => execFileSync(
  'npx', ['wrangler', 'kv', ...a, '--namespace-id', NAMESPACE_ID, '--remote'],
  { cwd: WORKER_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
);

// Read-modify-write rather than overwrite: the record carries fields this
// script has no opinion on (message, minSupported), and blowing them away is
// how a config drifts out from under you. A failed read is fatal — writing a
// fresh record from a failed read is exactly the clobber described above.
let current;
try {
  current = JSON.parse(kv('key', 'get', KEY).trim());
} catch (e) {
  console.error('✗ could not read the current config — refusing to write over it');
  console.error(`  ${e.stderr || e.message}`);
  process.exit(1);
}

const next = {
  ...current,
  latestFull: version,
  latestCws: cwsVersion || current.latestCws || '0.0.0',
  url: current.url || 'https://skoolvideodownload.com/updates',
  updatedAt: new Date().toISOString(),
};

console.log('  before:', JSON.stringify(current));
console.log('  after: ', JSON.stringify(next));
kv('key', 'put', KEY, JSON.stringify(next));
console.log(`\n✓ published latestFull=${next.latestFull} latestCws=${next.latestCws}`);
if (!cwsVersion) console.log('  (latestCws untouched — pass --cws <ver> once the store listing goes live)');
