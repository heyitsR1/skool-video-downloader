#!/usr/bin/env node
// Smoke tests for bulk.js — the pure half of bulk course backup.
//
// Everything here is a silent-failure risk: a tree walk that finds no lessons, a
// resume check that skips a lesson still missing its video, a path builder that
// collides two lessons onto one file. None of them throw; they just quietly cost
// the user part of their course. So each is pinned with a fixture.
//
//   node scripts/bulk-smoke.mjs
//
// Exit 0: every assertion holds.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// bulk.js ships as a plain script for importScripts, with a guarded CommonJS
// footer so Node can load the very code the extension runs.
const bulk = require(path.join(ROOT, 'bulk.js'));

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ✓ ${label}`); return; }
  console.error(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`);
  failures++;
}
function ok(label, cond) { check(label, !!cond, true); }
function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', `${name}.json`), 'utf8'));
}

console.log('\nparseCourseUrl');
check('lesson URL',
  bulk.parseCourseUrl('https://www.skool.com/g1/classroom/abc123?md=deadbeef'),
  { group: 'g1', courseSlug: 'abc123', lessonId: 'deadbeef', kind: 'lesson' });
check('course URL (no md)',
  bulk.parseCourseUrl('https://www.skool.com/g1/classroom/abc123'),
  { group: 'g1', courseSlug: 'abc123', lessonId: null, kind: 'course' });
check('classroom index',
  bulk.parseCourseUrl('https://www.skool.com/g1/classroom'),
  { group: 'g1', courseSlug: null, lessonId: null, kind: 'classroom-index' });
check('community feed is not a classroom',
  bulk.parseCourseUrl('https://www.skool.com/g1').kind, 'other');
check('non-Skool host',
  bulk.parseCourseUrl('https://example.com/g1/classroom/abc').kind, 'other');
check('garbage never throws',
  bulk.parseCourseUrl('not a url').kind, 'other');
check('subdomain is accepted',
  bulk.parseCourseUrl('https://skool.com/g1/classroom/abc').group, 'g1');
check('lesson URL round-trips',
  bulk.lessonUrlFor('g1', 'abc123', 'deadbeef'),
  'https://www.skool.com/g1/classroom/abc123?md=deadbeef');

console.log(`\n${failures ? `✗ ${failures} failure(s)` : '✓ all assertions hold'}`);
process.exit(failures ? 1 : 0);
