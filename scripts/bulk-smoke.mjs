#!/usr/bin/env node
// Smoke tests for bulk.js — the pure half of bulk course backup.
//
// Everything here will be a silent-failure risk: a tree walk that finds no
// lessons, a resume check that skips a lesson still missing its video, a path
// builder that collides two lessons onto one file. None of them throw; they
// just quietly cost the user part of their course. So each gets pinned with a
// fixture as its task lands.
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

console.log('\nparseClassroomUrl');
check('lesson URL',
  bulk.parseClassroomUrl('https://www.skool.com/g1/classroom/abc123?md=deadbeef'),
  { group: 'g1', courseSlug: 'abc123', lessonId: 'deadbeef', kind: 'lesson' });
check('course URL (no md)',
  bulk.parseClassroomUrl('https://www.skool.com/g1/classroom/abc123'),
  { group: 'g1', courseSlug: 'abc123', lessonId: null, kind: 'course' });
check('classroom index',
  bulk.parseClassroomUrl('https://www.skool.com/g1/classroom'),
  { group: 'g1', courseSlug: null, lessonId: null, kind: 'classroom-index' });
check('community feed is not a classroom',
  bulk.parseClassroomUrl('https://www.skool.com/g1').kind, 'other');
check('non-Skool host',
  bulk.parseClassroomUrl('https://example.com/g1/classroom/abc').kind, 'other');
check('garbage never throws',
  bulk.parseClassroomUrl('not a url').kind, 'other');
check('apex domain is accepted',
  bulk.parseClassroomUrl('https://skool.com/g1/classroom/abc').group, 'g1');
check('a real subdomain is accepted',
  bulk.parseClassroomUrl('https://community.skool.com/g1/classroom/abc').group, 'g1');
check('a lookalike host is not Skool',
  bulk.parseClassroomUrl('https://notskool.com/g1/classroom/abc').kind, 'other');
check('skool.com as a suffix is not Skool',
  bulk.parseClassroomUrl('https://skool.com.attacker.example/g1/classroom/abc').kind, 'other');
check('lesson URL round-trips',
  bulk.lessonUrlFor('g1', 'abc123', 'deadbeef'),
  'https://www.skool.com/g1/classroom/abc123?md=deadbeef');
let threw = false;
try { bulk.lessonUrlFor('g1', 'abc123', undefined); } catch { threw = true; }
ok('lessonUrlFor throws on a missing id, rather than building ?md=undefined', threw);
check('courseUrlFor',
  bulk.courseUrlFor('g1', 'abc123'),
  'https://www.skool.com/g1/classroom/abc123');
threw = false;
try { bulk.courseUrlFor('g1', undefined); } catch { threw = true; }
ok('courseUrlFor throws on a missing slug, rather than building /classroom/undefined', threw);

const { KIND, SOURCE } = bulk;

console.log('\ncourseTreeFromPageProps');
{
  const flat = bulk.courseTreeFromPageProps(fixture('course-flat'), 'g1', 'slug1');
  check('flat: ok', flat.ok, true);
  check('flat: title from the wrapped course node', flat.courseTitle, 'Flat Course');
  check('flat: shape', flat.shape, 'flat');
  check('flat: no modules invented', flat.moduleCount, 0);
  check('flat: lesson count', flat.lessons.length, 3);
  check('flat: lessons sit at the course root', flat.lessons.map(l => l.moduleIdx), [null, null, null]);
  check('flat: source kinds', flat.lessons.map(l => l.sourceKind),
    [SOURCE.NATIVE, SOURCE.LOOM, SOURCE.TEXT]);
  check('flat: lesson indices are 1-based and sequential', flat.lessons.map(l => l.lessonIdx), [1, 2, 3]);
  check('flat: native ref is the videoId', flat.lessons[0].sourceRef, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1');
  check('flat: a text lesson has no ref to resolve', flat.lessons[2].sourceRef, null);
  check('flat: duration carried', flat.lessons[0].durationMs, 60000);
  check('flat: a missing duration is null, not 0', flat.lessons[1].durationMs, null);
  check('flat: lesson URL built', flat.lessons[0].lessonUrl,
    'https://www.skool.com/g1/classroom/slug1?md=l1');

  const nested = bulk.courseTreeFromPageProps(fixture('course-nested'), 'g1', 'slug2');
  check('nested: shape', nested.shape, 'nested');
  check('nested: module count', nested.moduleCount, 2);
  check('nested: lesson count', nested.lessons.length, 3);
  check('nested: module indices', nested.lessons.map(l => l.moduleIdx), [1, 1, 2]);
  check('nested: module titles', nested.lessons.map(l => l.moduleTitle), ['Module One', 'Module One', 'Module Two']);
  check('nested: lesson index restarts per module', nested.lessons.map(l => l.lessonIdx), [1, 2, 1]);
  check('nested: vimeo classified', nested.lessons[2].sourceKind, SOURCE.VIMEO);
  check('nested: modules are not themselves lessons', nested.lessons.map(l => l.lessonId), ['l1', 'l2', 'l3']);

  const mixed = bulk.courseTreeFromPageProps(fixture('course-mixed'), 'g1', 'slug3');
  check('mixed: shape', mixed.shape, 'mixed');
  check('mixed: one module', mixed.moduleCount, 1);
  check('mixed: lesson count', mixed.lessons.length, 3);
  check('mixed: loose lesson goes to the course root', mixed.lessons[0].moduleIdx, null);
  check('mixed: module lessons keep their folder', mixed.lessons.slice(1).map(l => l.moduleIdx), [1, 1]);

  // §6.2 — these two must never be reported the same way.
  const empty = bulk.courseTreeFromPageProps(fixture('course-empty'), 'g1', 'slug4');
  check('empty course is named as such', { ok: empty.ok, code: empty.code }, { ok: false, code: 'empty-course' });
  const drift = bulk.courseTreeFromPageProps(fixture('course-drift'), 'g1', 'slug5');
  check('reshaped children are drift, not emptiness', { ok: drift.ok, code: drift.code }, { ok: false, code: 'schema-drift' });
  ok('empty and drift differ', empty.code !== drift.code);
  ok('drift says what it saw', /2 top-level nodes/.test(drift.detail || ''));

  // A missing course node is drift, not a crash.
  check('no course node at all', bulk.courseTreeFromPageProps({}, 'g1', 'slug6').code, 'schema-drift');
  check('null pageProps', bulk.courseTreeFromPageProps(null, 'g1', 'slug7').code, 'schema-drift');

  // An unrecognised embed host must be named, never guessed into a platform.
  const unknown = bulk.courseTreeFromPageProps({
    course: { course: { id: 'c', metadata: { title: 'C' } }, children: [
      { course: { id: 'x', metadata: { title: 'Odd', videoLink: 'https://videos.example.com/watch/1' } }, children: [] }
    ] }
  }, 'g1', 'slug8');
  check('unrecognised host is "unknown", not a guess', unknown.lessons[0].sourceKind, SOURCE.UNKNOWN);
  check('an unknown source still keeps its link', unknown.lessons[0].sourceRef, 'https://videos.example.com/watch/1');

  // A host that merely ends in a known name is not that platform.
  check('lookalike embed host', bulk.classifyEmbedHost('https://notloom.com/share/1'), null);
  check('suffix embed host', bulk.classifyEmbedHost('https://vimeo.com.attacker.example/1'), null);
  check('subdomain embed host', bulk.classifyEmbedHost('https://player.vimeo.com/video/1'), SOURCE.VIMEO);
  check('embed garbage never throws', bulk.classifyEmbedHost('not a url'), null);

  // A titleless course falls back to something identifiable, never "undefined".
  check('untitled course names itself by slug',
    bulk.courseTitleFrom({ course: { id: 'c0' } }, 'slug9'), 'Course slug9');
}

console.log('\nbulkLessonBase');
{
  const used = new Set();
  const base = p => bulk.bulkLessonBase(p, used);

  check('nested lesson',
    base({ courseTitle: 'My Course', moduleIdx: 1, moduleTitle: 'Intro', moduleCount: 3, lessonIdx: 2, lessonCount: 9, lessonTitle: 'Hooks' }),
    'My Course/01 Intro/02 Hooks');
  check('flat lesson goes to the course root',
    base({ courseTitle: 'My Course', moduleIdx: null, moduleTitle: null, moduleCount: 0, lessonIdx: 1, lessonCount: 4, lessonTitle: 'Welcome' }),
    'My Course/01 Welcome');
  check('100+ siblings pad to three digits',
    base({ courseTitle: 'Archive', moduleIdx: null, moduleTitle: null, moduleCount: 0, lessonIdx: 7, lessonCount: 182, lessonTitle: 'Allergy' }),
    'Archive/007 Allergy');
  check('illegal characters are replaced',
    base({ courseTitle: 'A/B: Test', moduleIdx: null, moduleTitle: null, moduleCount: 0, lessonIdx: 1, lessonCount: 1, lessonTitle: 'Why? <yes>' }),
    'A B Test/01 Why yes');

  const dup = { courseTitle: 'C', moduleIdx: null, moduleTitle: null, moduleCount: 0, lessonIdx: 1, lessonCount: 2, lessonTitle: 'Same' };
  const first = base(dup);
  const second = base({ ...dup, lessonIdx: 1 });
  check('first of a colliding pair', first, 'C/01 Same');
  ok('second is disambiguated', second !== first);
  check('second of a colliding pair', second, 'C/01 Same (2)');
  check('third of a colliding run', base({ ...dup, lessonIdx: 1 }), 'C/01 Same (3)');

  check('a title that sanitises to nothing still yields a path',
    bulk.bulkLessonBase({ courseTitle: '///', moduleIdx: null, moduleTitle: null, moduleCount: 0, lessonIdx: 1, lessonCount: 1, lessonTitle: '***' }, new Set()),
    'skool-course/01 lesson');

  const long = bulk.bulkLessonBase({ courseTitle: 'C'.repeat(200), moduleIdx: null, moduleTitle: null, moduleCount: 0, lessonIdx: 1, lessonCount: 1, lessonTitle: 'L'.repeat(200) }, new Set());
  check('course segment capped at 100', long.split('/')[0].length, 100);
  ok('lesson segment capped at 120 plus the index', long.split('/')[1].length <= 124);
  check('emoji survive sanitising',
    bulk.bulkLessonBase({ courseTitle: 'Course 🎬', moduleIdx: null, moduleTitle: null, moduleCount: 0, lessonIdx: 1, lessonCount: 1, lessonTitle: 'Lesson ✅' }, new Set()),
    'Course 🎬/01 Lesson ✅');

  // Capping counts characters, not UTF-16 units: slicing mid-surrogate would
  // write a lone half of an emoji into a filename.
  // The leading 'x' matters: it puts the cap on an odd UTF-16 boundary, which is
  // where a naive slice splits a surrogate pair rather than landing between two.
  const emojiLong = bulk.bulkLessonBase({ courseTitle: 'x' + '🎬'.repeat(200), moduleIdx: null, moduleTitle: null, moduleCount: 0, lessonIdx: 1, lessonCount: 1, lessonTitle: 'x' }, new Set());
  const courseSeg = emojiLong.split('/')[0];
  ok('a capped emoji title is not cut mid-character',
    !/[\uD800-\uDFFF]/.test(courseSeg.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')));
  check('the cap counts characters, not UTF-16 units', [...courseSeg].length, 100);

  // Windows refuses these outright, so a course named after one would fail every
  // lesson in it with an error the user cannot act on.
  check('a device name is escaped, not written',
    bulk.bulkLessonBase({ courseTitle: 'CON', moduleIdx: null, moduleTitle: null, moduleCount: 0, lessonIdx: 1, lessonCount: 1, lessonTitle: 'nul' }, new Set()),
    'CON_/01 nul_');
  check('a device name with an extension is escaped too',
    bulk.bulkLessonBase({ courseTitle: 'COM1.txt', moduleIdx: null, moduleTitle: null, moduleCount: 0, lessonIdx: 1, lessonCount: 1, lessonTitle: 'ok' }, new Set()),
    'COM1.txt_/01 ok');
  check('a name that merely starts with a device name is left alone',
    bulk.bulkLessonBase({ courseTitle: 'Console', moduleIdx: null, moduleTitle: null, moduleCount: 0, lessonIdx: 1, lessonCount: 1, lessonTitle: 'ok' }, new Set()),
    'Console/01 ok');
  check('a trailing dot is dropped',
    bulk.bulkLessonBase({ courseTitle: 'Course.', moduleIdx: null, moduleTitle: null, moduleCount: 0, lessonIdx: 1, lessonCount: 1, lessonTitle: 'Part 2..' }, new Set()),
    'Course/01 Part 2');
  check('a name of only dots falls back',
    bulk.bulkLessonBase({ courseTitle: '..', moduleIdx: null, moduleTitle: null, moduleCount: 0, lessonIdx: 1, lessonCount: 1, lessonTitle: '.' }, new Set()),
    'skool-course/01 lesson');
}

console.log('\nattachmentFilename');
check('attachment hangs off the lesson base',
  bulk.attachmentFilename('C/01 Lesson', { label: 'Workbook', fileName: 'workbook.pdf' }),
  'C/01 Lesson - Workbook.pdf');
check('extension comes from the file name, not the label',
  bulk.attachmentFilename('C/01 Lesson', { label: 'Slides.key', fileName: 'deck.zip' }),
  'C/01 Lesson - Slides.key.zip');
check('no file name means no extension invented',
  bulk.attachmentFilename('C/01 Lesson', { label: 'Link Bundle', fileName: null }),
  'C/01 Lesson - Link Bundle');
check('a missing label is named, not blank',
  bulk.attachmentFilename('C/01 Lesson', { label: null, fileName: 'x.pdf' }),
  'C/01 Lesson - attachment.pdf');
{
  // Two attachments on one lesson can share a label. Without a check they land
  // on one filename and the second silently replaces the first.
  const used = new Set();
  const a = bulk.attachmentFilename('C/01 Lesson', { label: 'Workbook', fileName: 'a.pdf' }, used);
  const b = bulk.attachmentFilename('C/01 Lesson', { label: 'Workbook', fileName: 'b.pdf' }, used);
  check('first same-labelled attachment', a, 'C/01 Lesson - Workbook.pdf');
  check('second same-labelled attachment keeps its own file', b, 'C/01 Lesson - Workbook (2).pdf');
  ok('the suffix sits before the extension', b.endsWith('.pdf'));
}

console.log(`\n${failures ? `✗ ${failures} failure(s)` : '✓ all assertions hold'}`);
process.exit(failures ? 1 : 0);
