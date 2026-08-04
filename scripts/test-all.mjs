#!/usr/bin/env node
// Runs every smoke suite and fails if any one of them does. Four suites listed
// by hand in a docs file is how a suite quietly stops being run.
//
//   node scripts/test-all.mjs
//
// yt-smoke.mjs talks to YouTube, so it is the one suite that can fail for a
// reason that has nothing to do with this repo. It is still run and still
// counted — a suite that cannot reach the network is an unknown, not a pass,
// and reporting it as one is how a rotted-out client ships.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITES = ['bulk-smoke.mjs', 'background-smoke.mjs', 'e2e-smoke.mjs', 'vimeo-smoke.mjs', 'yt-smoke.mjs'];
const NETWORK = new Set(['vimeo-smoke.mjs', 'yt-smoke.mjs']);
// Drives a real browser; reports itself as skipped when Chrome is absent.
const BROWSER = new Set(['e2e-smoke.mjs']);

const failed = [];
for (const suite of SUITES) {
  const tag = NETWORK.has(suite) ? '  (needs network)' : BROWSER.has(suite) ? '  (needs Chrome)' : '';
  console.log(`\n━━ ${suite}${tag}`);
  const r = spawnSync(process.execPath, [path.join(HERE, suite)], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(`${suite} (exit ${r.status})`);
}
console.log(failed.length ? `\n✗ failing: ${failed.join(', ')}` : `\n✓ ${SUITES.length} suites pass`);
process.exit(failed.length ? 1 : 0);
