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

console.log('\nfilesystem-safe naming');
{
  // macOS and Windows are both case-insensitive by default, so two names that
  // differ only in case are one file. An exact-match collision check calls them
  // unique and lets the second silently replace the first.
  const used = new Set();
  const a = bulk.attachmentFilename('C/01 L', { label: 'Notes', fileName: 'a.pdf' }, used);
  const b = bulk.attachmentFilename('C/01 L', { label: 'notes', fileName: 'b.pdf' }, used);
  check('an attachment differing only in case is disambiguated', b, 'C/01 L - notes (2).pdf');
  ok('and the first keeps its own casing', a === 'C/01 L - Notes.pdf');

  // The same visible title can arrive precomposed or decomposed. Different
  // strings, one filename.
  const u = new Set();
  const p = { courseTitle: 'C', moduleIdx: null, moduleTitle: null, moduleCount: 0, lessonIdx: 1, lessonCount: 2 };
  const nfc = bulk.bulkLessonBase({ ...p, lessonTitle: 'Caf\u00e9' }, u);
  const nfd = bulk.bulkLessonBase({ ...p, lessonTitle: 'Cafe\u0301' }, u);
  check('a decomposed title does not claim the precomposed one\'s file', nfd, 'C/01 Caf\u00e9 (2)');
  ok('and the path itself is normalised', nfc === nfc.normalize('NFC'));

  // Windows refuses paths much past 260 characters including the download
  // folder. Over the limit the download fails, naming nothing actionable.
  const worst = bulk.bulkLessonBase({ courseTitle: 'C'.repeat(150), moduleIdx: 3,
    moduleTitle: 'M'.repeat(150), moduleCount: 99, lessonIdx: 5, lessonCount: 150,
    lessonTitle: 'L'.repeat(200) }, new Set());
  ok('a deep course with long titles still fits the path limit',
    worst.length + '.mp4'.length <= bulk.MAX_RELATIVE_PATH);
  // The stem must leave room for its own attachments, not just for itself.
  const att = bulk.attachmentFilename(worst, { label: 'A'.repeat(100), fileName: 'f.pdf' }, new Set());
  ok('and so do its attachments', att.length <= bulk.MAX_RELATIVE_PATH);
  ok('the ordering prefix survives truncation', worst.split('/').pop().startsWith('005 '));
}

console.log('\nshouldFlattenModules');
{
  const L = (...idx) => idx.map(i => ({ moduleIdx: i }));
  // Observed on real courses: 37 of 38 modules held exactly one lesson, which
  // with a folder per module writes one folder per file, named after the file.
  ok('every module holding one lesson flattens', bulk.shouldFlattenModules(L(1, 2, 3)));
  ok('one module with two lessons keeps the folders', !bulk.shouldFlattenModules(L(1, 1, 2)));
  ok('the multi-lesson module can be last', !bulk.shouldFlattenModules(L(1, 2, 3, 3)));
  // A course with no modules is already flat. Answering yes would be true and
  // useless, and the caller reads this as "override the module path".
  ok('a course with no modules is not flattened', !bulk.shouldFlattenModules(L(null, null)));
  ok('a loose lesson beside single-lesson modules still flattens', bulk.shouldFlattenModules(L(null, 1, 2)));
  ok('an empty course does not flatten', !bulk.shouldFlattenModules([]));
  ok('a non-array is not flattened', !bulk.shouldFlattenModules(null));
  // moduleIdx 0 is not a real module index (they start at 1), but it must not be
  // read as "no module" by a truthiness test either.
  ok('module index 0 counts as a module', bulk.shouldFlattenModules(L(0, 1)));
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

console.log('\ndescToMarkdown');
{
  const doc = JSON.stringify([
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Overview' }] },
    { type: 'paragraph', content: [
      { type: 'text', text: 'Read ' },
      { type: 'text', marks: [{ type: 'bold' }], text: 'this' },
      { type: 'text', text: ' and ' },
      { type: 'text', marks: [{ type: 'italic' }], text: 'that' },
      { type: 'text', text: '.' },
    ] },
    { type: 'bulletList', content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One' }] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Two' }] }] },
    ] },
  ]);

  const md = bulk.descToMarkdown(`[v2]${doc}`);
  ok('[v2] prefix is stripped', !md.includes('[v2]'));
  ok('heading level respected', md.includes('## Overview'));
  ok('bold', md.includes('**this**'));
  ok('italic', md.includes('*that*'));
  ok('bullets', md.includes('- One') && md.includes('- Two'));

  check('an unprefixed document works too', bulk.descToMarkdown(doc).startsWith('## Overview'), true);

  check('link mark', bulk.descToMarkdown(JSON.stringify([
    { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }], text: 'here' }] }
  ])), '[here](https://example.com)');

  check('inline code', bulk.descToMarkdown(JSON.stringify([
    { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'code' }], text: 'npm run build' }] }
  ])), '`npm run build`');

  check('ordered list numbers from one', bulk.descToMarkdown(JSON.stringify([
    { type: 'orderedList', content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First' }] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Second' }] }] },
    ] }
  ])), '1. First\n2. Second');

  check('blockquote', bulk.descToMarkdown(JSON.stringify([
    { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quoted' }] }] }
  ])), '> Quoted');

  check('code block', bulk.descToMarkdown(JSON.stringify([
    { type: 'codeBlock', content: [{ type: 'text', text: 'let x = 1;' }] }
  ])), '```\nlet x = 1;\n```');

  check('hard break', bulk.descToMarkdown(JSON.stringify([
    { type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] }
  ])), 'a\nb');

  // An unknown wrapper must not delete the text inside it.
  check('unknown node types keep their contents', bulk.descToMarkdown(JSON.stringify([
    { type: 'someFutureBlock', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Survives' }] }] }
  ])), 'Survives');

  check('a single doc node, not an array', bulk.descToMarkdown(JSON.stringify(
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Solo' }] }] }
  )), 'Solo');

  // Plain text that is not JSON is content, not an error.
  check('non-JSON input is returned as-is', bulk.descToMarkdown('just a note'), 'just a note');
  // …but the marker is an encoding detail, never part of what the user wrote.
  check('a [v2] marker on unparseable text is still stripped',
    bulk.descToMarkdown('[v2]just a note'), 'just a note');
  check('null', bulk.descToMarkdown(null), '');
  check('empty string', bulk.descToMarkdown(''), '');

  // A nested list flattened onto its parent's line is unreadable, and the
  // structure the author wrote is gone for good once the file is on disk.
  check('a nested list keeps its nesting', bulk.descToMarkdown(JSON.stringify([
    { type: 'bulletList', content: [
      { type: 'listItem', content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Parent' }] },
        { type: 'bulletList', content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Child' }] }] },
        ] },
      ] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Sibling' }] }] },
    ] }
  ])), '- Parent\n  - Child\n- Sibling');

  check('an ordered list nested under a bullet', bulk.descToMarkdown(JSON.stringify([
    { type: 'bulletList', content: [
      { type: 'listItem', content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Steps' }] },
        { type: 'orderedList', content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] },
        ] },
      ] },
    ] }
  ])), '- Steps\n  1. a\n  2. b');

  // A fence inside the code would end the block early and spill the rest of the
  // lesson into the document as prose.
  check('a code block containing a fence is fenced longer', bulk.descToMarkdown(JSON.stringify([
    { type: 'codeBlock', content: [{ type: 'text', text: 'md:\n```\nx\n```' }] }
  ])), '````\nmd:\n```\nx\n```\n````');

  // Recursion is bounded, and says so rather than emitting empty notes — which
  // would be indistinguishable from a lesson that genuinely had none.
  const wrap = depth => {
    let n = { type: 'paragraph', content: [{ type: 'text', text: 'deep' }] };
    for (let i = 0; i < depth; i++) n = { type: 'someWrapper', content: [n] };
    return JSON.stringify([n]);
  };
  check('a document nested past the cap says so', bulk.descToMarkdown(wrap(150)),
    '[notes truncated: document nested too deeply]');
  check('a document just under the cap is converted normally', bulk.descToMarkdown(wrap(90)), 'deep');
  // Without the cap this is a stack overflow that costs the whole run, not one lesson.
  let deepThrew = false;
  try { bulk.descToMarkdown(wrap(50000)); } catch { deepThrew = true; }
  ok('a pathologically deep document never throws', !deepThrew);

  // Inline content recurses on its own path, so it needs its own bound.
  let inlineThrew = false;
  try {
    let n = { type: 'text', text: 'x' };
    for (let i = 0; i < 50000; i++) n = { type: 'someInlineWrapper', content: [n] };
    bulk.descToMarkdown(JSON.stringify([{ type: 'paragraph', content: [n] }]));
  } catch { inlineThrew = true; }
  ok('pathologically deep inline content never throws', !inlineThrew);

  // Indentation must follow list nesting, not recursion depth. A list inside any
  // wrapper node is still a top-level list and must not be indented into one.
  // Two items, because the final .trim() would hide a stray indent on line one.
  check('a list inside a wrapper is not spuriously indented', bulk.descToMarkdown(JSON.stringify([
    { type: 'someWrapper', content: [
      { type: 'bulletList', content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Top' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Next' }] }] },
      ] },
    ] },
  ])), '- Top\n- Next');
  check('an ordered list inside a wrapper is not indented either', bulk.descToMarkdown(JSON.stringify([
    { type: 'someWrapper', content: [
      { type: 'orderedList', content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Top' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Next' }] }] },
      ] },
    ] },
  ])), '1. Top\n2. Next');
}

console.log('\nnotesDocument');
check('notes document leads with the lesson title', bulk.notesDocument({
  title: 'Hooks', lessonUrl: 'https://www.skool.com/g/classroom/c?md=l', markdown: 'Body text', links: [],
}), '# Hooks\n\nBody text\n\n---\nLesson: https://www.skool.com/g/classroom/c?md=l\n');
check('resource links are appended', bulk.notesDocument({
  title: 'Hooks', lessonUrl: 'https://u', markdown: 'Body', links: [{ label: 'Post', url: 'https://p' }],
}), '# Hooks\n\nBody\n\n## Links\n\n- [Post](https://p)\n\n---\nLesson: https://u\n');
check('a lesson with no notes still gets a document', bulk.notesDocument({
  title: 'Hooks', lessonUrl: 'https://u', markdown: '', links: [],
}), '# Hooks\n\n---\nLesson: https://u\n');
check('a bracket in a link label does not break the link', bulk.notesDocument({
  title: 'H', lessonUrl: 'https://u', markdown: '', links: [{ label: 'A [B] C', url: 'https://p' }],
}), '# H\n\n## Links\n\n- [A \\[B\\] C](https://p)\n\n---\nLesson: https://u\n');

console.log('\nparseResources');
{
  const mixed = JSON.stringify([
    { title: 'Workbook', file_id: 'a'.repeat(32), file_name: 'workbook.pdf', file_content_type: 'application/pdf' },
    { title: 'Related Post', link: 'https://example.com/post' },
  ]);
  const r = bulk.parseResources(mixed);
  check('one file', r.files.length, 1);
  check('one link', r.links.length, 1);
  check('nothing dropped', r.dropped, 0);
  check('file fields', r.files[0], { fileId: 'a'.repeat(32), label: 'Workbook', fileName: 'workbook.pdf', contentType: 'application/pdf' });
  check('link fields', r.links[0], { label: 'Related Post', url: 'https://example.com/post' });

  check('empty array', bulk.parseResources('[]'), { files: [], links: [], dropped: 0 });
  check('absent', bulk.parseResources(null), { files: [], links: [], dropped: 0 });

  // A malformed entry is counted, never silently vanished.
  const bad = bulk.parseResources(JSON.stringify([{ title: 'Neither' }, { file_id: 'too-short' }]));
  check('malformed entries are counted', bad.dropped, 2);
  check('and none are kept', bad.files.length + bad.links.length, 0);

  check('unparseable string is one drop', bulk.parseResources('{not json').dropped, 1);
  check('a JSON object rather than an array is one drop', bulk.parseResources('{"a":1}').dropped, 1);
  check('url is accepted as well as link',
    bulk.parseResources(JSON.stringify([{ title: 'T', url: 'https://u' }])).links[0].url, 'https://u');
  check('file name stands in for a missing label',
    bulk.parseResources(JSON.stringify([{ file_id: 'b'.repeat(32), file_name: 'notes.txt' }])).files[0].label, 'notes.txt');
  check('a non-http link is dropped, not written into a file',
    bulk.parseResources(JSON.stringify([{ title: 'X', link: 'javascript:alert(1)' }])).dropped, 1);

  // The same file listed twice would be fetched twice and written to two names,
  // and the manifest keys assets by fileId, so the second has nowhere to record.
  const dup = bulk.parseResources(JSON.stringify([
    { title: 'Workbook', file_id: 'c'.repeat(32), file_name: 'w.pdf' },
    { title: 'Workbook again', file_id: 'c'.repeat(32), file_name: 'w.pdf' },
  ]));
  check('a repeated file_id is kept once', dup.files.length, 1);
  check('the first labelling of it wins', dup.files[0].label, 'Workbook');
  check('a duplicate is not counted as malformed', dup.dropped, 0);

  // Labels and URLs are written into Markdown, where a newline ends the line.
  check('a newline in a label is flattened',
    bulk.parseResources(JSON.stringify([{ title: 'Two\nLines', link: 'https://u' }])).links[0].label,
    'Two Lines');
  check('a newline in a URL is a drop, not a broken link',
    bulk.parseResources(JSON.stringify([{ title: 'X', link: 'https://u\nevil' }])).dropped, 1);
  check('a tab in a file label is flattened',
    bulk.parseResources(JSON.stringify([{ title: 'A\tB', file_id: 'd'.repeat(32) }])).files[0].label, 'A B');
}

console.log('\nmanifest / resume (G1)');
{
  const saved = { video: { path: 'C/01 A.mp4', downloadId: 7 }, notes: { path: 'C/01 A.md' }, files: {} };

  check('everything wanted is present → skip',
    bulk.lessonNeedsWork(saved, { video: true, notes: true, files: true }, []), false);
  check('video missing → work',
    bulk.lessonNeedsWork({ ...saved, video: null }, { video: true, notes: false, files: false }, []), true);
  check('video missing but not wanted → skip',
    bulk.lessonNeedsWork({ ...saved, video: null }, { video: false, notes: true, files: false }, []), false);

  // …and the mirror of it: a video-only pass must not satisfy a later notes run.
  check('missing notes alone is enough work',
    bulk.lessonNeedsWork({ video: { path: 'v' }, notes: null, files: {} }, { video: true, notes: true, files: false }, []), true);
  check('missing notes that are not wanted is not',
    bulk.lessonNeedsWork({ video: { path: 'v' }, notes: null, files: {} }, { video: true, notes: false, files: false }, []), false);

  // The rule that matters: a notes-only pass must never satisfy a later full run.
  check('notes-only history does not satisfy a video run',
    bulk.lessonNeedsWork({ video: null, notes: { path: 'x.md' }, files: {} }, { video: true, notes: true, files: false }, []), true);

  // Attachments are tracked per file, so one 423 retries only itself.
  const partial = { video: { path: 'v' }, notes: { path: 'n' }, files: { ['a'.repeat(32)]: { path: 'f1' } } };
  check('all wanted files present → skip',
    bulk.lessonNeedsWork(partial, { video: true, notes: true, files: true }, ['a'.repeat(32)]), false);
  check('one missing file → work',
    bulk.lessonNeedsWork(partial, { video: true, notes: true, files: true }, ['a'.repeat(32), 'b'.repeat(32)]), true);

  // Permanently unsatisfiable assets settle, so they are not retried forever.
  check('a YouTube-hosted lesson settles',
    bulk.lessonNeedsWork({ video: { skipped: 'youtube' }, notes: { path: 'n' }, files: {} }, { video: true, notes: true, files: false }, []), false);
  check('a text-only lesson settles',
    bulk.lessonNeedsWork({ video: { skipped: 'text' }, notes: { path: 'n' }, files: {} }, { video: true, notes: true, files: false }, []), false);
  // A locked lesson does not settle — access can change.
  check('a locked lesson stays retryable',
    bulk.lessonNeedsWork({ video: null, notes: { path: 'n' }, files: {} }, { video: true, notes: true, files: false }, []), true);
  // …including when a run has actually written the reason down, which is the
  // only way this can go wrong in practice.
  check('a recorded locked skip is still retryable',
    bulk.lessonNeedsWork({ video: { skipped: 'locked' }, notes: { path: 'n' }, files: {} }, { video: true, notes: true, files: false }, []), true);
  check('an unrecognised skip reason does not settle either',
    bulk.lessonNeedsWork({ video: { skipped: 'whatever' }, notes: { path: 'n' }, files: {} }, { video: true, notes: true, files: false }, []), true);
  check('a settled skip on an attachment counts',
    bulk.lessonNeedsWork({ video: { path: 'v' }, notes: { path: 'n' }, files: { ['a'.repeat(32)]: { skipped: 'unknown' } } },
      { video: true, notes: true, files: true }, ['a'.repeat(32)]), false);
  check('a locked skip on an attachment does not',
    bulk.lessonNeedsWork({ video: { path: 'v' }, notes: { path: 'n' }, files: { ['a'.repeat(32)]: { skipped: 'locked' } } },
      { video: true, notes: true, files: true }, ['a'.repeat(32)]), true);
  ok('locked is deliberately not a settling kind', !bulk.SETTLED_SKIP_KINDS.includes('locked'));

  check('a missing record needs everything',
    bulk.lessonNeedsWork(bulk.normalizeAssets(null), { video: true, notes: true, files: false }, []), true);
  check('normalizeAssets shape', bulk.normalizeAssets(null), { video: null, notes: null, files: {} });
  check('normalizeAssets tolerates a record with no assets',
    bulk.normalizeAssets({ status: 'saved' }), { video: null, notes: null, files: {} });

  console.log('\nmergeManifest');
  const scanned = [
    { lessonId: 'l1', title: 'A' },
    { lessonId: 'l2', title: 'B' },
  ];
  const existing = { lessons: { l2: { status: 'saved', assets: { video: { path: 'p' } } } } };
  const merged = bulk.mergeManifest(existing, scanned);
  check('unseen lesson gets an empty prior', merged[0].priorAssets, { video: null, notes: null, files: {} });
  check('known lesson carries its prior', merged[1].priorAssets.video, { path: 'p' });
  check('prior status carried', merged[1].priorStatus, 'saved');

  // Keyed by lessonId, never by index — instructors reorder courses.
  const reordered = bulk.mergeManifest(existing, [{ lessonId: 'l2', title: 'B' }, { lessonId: 'l1', title: 'A' }]);
  check('reordering does not move prior state', reordered[0].priorAssets.video, { path: 'p' });
  check('and the other lesson stays untouched', reordered[1].priorAssets.video, null);

  check('no existing manifest at all', bulk.mergeManifest(null, scanned).length, 2);
  check('no scanned lessons at all', bulk.mergeManifest(existing, null), []);

  console.log('\nrunSummary');
  const summary = bulk.runSummary([
    { status: 'saved' }, { status: 'saved' },
    { status: 'skipped', reason: 'locked' }, { status: 'skipped', reason: 'youtube' },
    { status: 'failed', reason: 'network' },
  ]);
  check('counts', { saved: summary.saved, skipped: summary.skipped, failed: summary.failed }, { saved: 2, skipped: 2, failed: 1 });
  check('counts account for every lesson', summary.saved + summary.skipped + summary.failed, summary.total);
  check('skip reasons are broken out', summary.skippedByReason, { locked: 1, youtube: 1 });
  check('failure reasons are broken out too', summary.failedByReason, { network: 1 });

  // A status nobody recognises must land in a bucket, not fall out of the count.
  const odd = bulk.runSummary([{ status: 'saved' }, { status: 'in-flight' }, null]);
  check('an unrecognised status still balances', odd.saved + odd.skipped + odd.failed, odd.total);
  check('empty run', bulk.runSummary([]),
    { total: 0, notAttempted: 0, saved: 0, skipped: 0, failed: 0, skippedByReason: {}, failedByReason: {} });

  // A cancelled run has records only for the lessons it reached. Taking the total
  // from that list let a 40-lesson course cancelled at lesson 3 report
  // "3 lessons — 3 saved", i.e. a partial backup presenting as a complete one.
  const stopped = bulk.runSummary(Array(3).fill({ status: 'saved' }), 40);
  check('a cancelled run keeps the course total', stopped.total, 40);
  check('and says how many it never reached', stopped.notAttempted, 37);
  check('every lesson is still in exactly one bucket',
    stopped.saved + stopped.skipped + stopped.failed + stopped.notAttempted, stopped.total);
  check('the end line states it rather than implying it',
    bulk.bulkRunEndLine(stopped), 'done 40les: 3 saved, 37 not attempted');
  // A complete run must not grow a "0 not attempted" tail.
  check('a complete run says nothing about it',
    bulk.bulkRunEndLine(bulk.runSummary(Array(4).fill({ status: 'saved' }), 4)), 'done 4les: 4 saved');
  // A course that gained lessons mid-run must not produce a negative bucket.
  const extra = bulk.runSummary(Array(5).fill({ status: 'saved' }), 3);
  check('more records than expected does not go negative', extra.notAttempted, 0);
  check('and the total follows the records', extra.total, 5);
}

console.log('\nnativePlaybackFrom (§2.5)');
{
  const unlocked = bulk.nativePlaybackFrom(fixture('lesson-video-unlocked'));
  check('unlocked resolves', unlocked.ok, true);
  check('primary host is Skool\'s Mux domain', unlocked.masterUrl,
    'https://stream.video.skool.com/PLAYBACKIDPLACEHOLDER0000000000000000000000000.m3u8?token=header.payload.signature');
  check('a fallback host is offered', unlocked.fallbackUrl,
    'https://stream.mux.com/PLAYBACKIDPLACEHOLDER0000000000000000000000000.m3u8?token=header.payload.signature');
  check('duration carried', unlocked.durationMs, 618966);
  check('token expiry carried', unlocked.tokenExpire, 1785900683);

  // The whole point: everything else looks healthy on a locked lesson.
  const locked = bulk.nativePlaybackFrom(fixture('lesson-video-locked'));
  check('locked is refused', { ok: locked.ok, code: locked.code }, { ok: false, code: 'locked' });
  ok('locked fixture still has a playbackId', !!fixture('lesson-video-locked').video.playbackId);
  ok('locked fixture still reports ready', fixture('lesson-video-locked').video.status === 'ready');
  ok('locked fixture still reports a duration', fixture('lesson-video-locked').video.duration > 0);
  ok('locked fixture has no hasAccess field to consult',
    !('hasAccess' in fixture('lesson-video-locked').video));

  check('no video object at all', bulk.nativePlaybackFrom({}).code, 'locked');
  check('null pageProps', bulk.nativePlaybackFrom(null).code, 'locked');
  check('an empty token string is not a token', bulk.nativePlaybackFrom({ video: { playbackId: 'p', playbackToken: '' } }).code, 'locked');
  check('a token with no playbackId cannot build a URL', bulk.nativePlaybackFrom({ video: { playbackToken: 't' } }).code, 'locked');
  check('a non-string token is not a token', bulk.nativePlaybackFrom({ video: { playbackId: 'p', playbackToken: 1 } }).code, 'locked');

  // status is never consulted: a ready-looking locked lesson is the case above,
  // and refusing an unready-looking one would be a guess this file has not
  // verified. The token is the only signal.
  check('an unready status with a token still resolves',
    bulk.nativePlaybackFrom({ video: { playbackId: 'p', playbackToken: 't', status: 'preparing' } }).ok, true);

  // A token is interpolated into a query string, so it is encoded. Real tokens
  // are base64url and unaffected; one that is not would otherwise truncate.
  check('a token needing encoding is encoded',
    bulk.nativePlaybackFrom({ video: { playbackId: 'p', playbackToken: 'a+b&c' } }).masterUrl,
    'https://stream.video.skool.com/p.m3u8?token=a%2Bb%26c');
  check('a playbackId needing encoding is encoded',
    bulk.nativePlaybackFrom({ video: { playbackId: 'a/b', playbackToken: 't' } }).masterUrl,
    'https://stream.video.skool.com/a%2Fb.m3u8?token=t');
}

console.log('\nrun diagnostics');
{
  check('start line fingerprints the run', bulk.bulkRunStartLine({
    courseTitle: 'My Course', shape: 'nested', moduleCount: 3, lessonCount: 40,
    want: { video: true, notes: true, files: true },
  }), 'start "My Course" nested 3mod/40les want=video+notes+files');

  check('a resumed run says so', bulk.bulkRunStartLine({
    courseTitle: 'My Course', shape: 'flat', moduleCount: 0, lessonCount: 3,
    want: { video: true, notes: false, files: false }, resumed: 12,
  }), 'start "My Course" flat 0mod/3les want=video resume=12done');

  check('nothing wanted is stated, not blank', bulk.bulkRunStartLine({
    courseTitle: 'C', shape: 'flat', moduleCount: 0, lessonCount: 1, want: {},
  }), 'start "C" flat 0mod/1les want=none');

  // Reasons are tallied, never logged per lesson: the report carries only the
  // last 10 lines, so one line per lesson evicts the run's own start line.
  const t = bulk.reasonTally();
  bulk.tallyReason(t, 'locked', 'lesson "Intro": no playback token');
  bulk.tallyReason(t, 'locked', 'lesson "Setup": no playback token');
  bulk.tallyReason(t, 'network', 'lesson "Deep Dive": HTTP 503');
  check('tally counts by reason', bulk.describeTally(t), 'locked×2, network×1');
  check('the first example of each reason is kept', bulk.tallyExamples(t),
    'locked: lesson "Intro": no playback token | network: lesson "Deep Dive": HTTP 503');
  check('an empty tally describes as none', bulk.describeTally(bulk.reasonTally()), 'none');
  check('a missing reason is named, not blank',
    bulk.describeTally(bulk.tallyReason(bulk.reasonTally(), null, 'x')), 'unknown×1');
  check('the commonest reason is listed first', bulk.describeTally(
    ['a', 'b', 'b', 'b'].reduce((acc, r) => bulk.tallyReason(acc, r, 'd'), bulk.reasonTally())),
    'b×3, a×1');

  check('end line accounts for every lesson', bulk.bulkRunEndLine(bulk.runSummary([
    ...Array(25).fill({ status: 'saved' }),
    ...Array(12).fill({ status: 'skipped', reason: 'locked' }),
    ...Array(3).fill({ status: 'failed', reason: 'network' }),
  ])), 'done 40les: 25 saved, 12 skipped (locked×12), 3 failed (network×3)');

  check('a clean run says so plainly',
    bulk.bulkRunEndLine(bulk.runSummary(Array(4).fill({ status: 'saved' }))),
    'done 4les: 4 saved');
  check('an empty run is still a line', bulk.bulkRunEndLine(bulk.runSummary([])), 'done 0les: 0 saved');

  // Every line must survive the report worker's 300-char cap intact enough to
  // read, and say so when it did not.
  const huge = bulk.bulkRunStartLine({
    courseTitle: 'C'.repeat(500), shape: 'flat', moduleCount: 0, lessonCount: 1,
    want: { video: true },
  });
  ok('an overlong start line is capped', huge.length <= 300);
  ok('and marks itself as cut', huge.endsWith('…'));

  const manyReasons = bulk.reasonTally();
  for (let i = 0; i < 200; i++) bulk.tallyReason(manyReasons, `reason-${i}`, `detail ${i}`);
  ok('a tally of many reasons is capped', bulk.describeTally(manyReasons).length <= 300);
  ok('examples are capped too', bulk.tallyExamples(manyReasons).length <= 300);
  ok('the cap does not lose the count', /reason-\d+×1/.test(bulk.describeTally(manyReasons)));

  // A newline would split one log entry into two in the dashboard's list.
  check('a detail containing a newline is flattened',
    bulk.tallyExamples(bulk.tallyReason(bulk.reasonTally(), 'x', 'a\nb')), 'x: a b');
}

console.log('\nextractPageProps');
{
  const html = `<html><head><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { hello: 'world' } } })}</script></head><body></body></html>`;
  check('reads the embedded payload', bulk.extractPageProps(html), { hello: 'world' });
  check('single-quoted id attribute', bulk.extractPageProps(`<script id='__NEXT_DATA__'>{"props":{"pageProps":{"a":1}}}</script>`), { a: 1 });
  check('missing script', bulk.extractPageProps('<html></html>'), null);
  check('malformed JSON', bulk.extractPageProps('<script id="__NEXT_DATA__">{oops</script>'), null);
  check('no pageProps inside', bulk.extractPageProps('<script id="__NEXT_DATA__">{"props":{}}</script>'), null);
  check('empty input', bulk.extractPageProps(''), null);
  check('non-string input', bulk.extractPageProps(null), null);

  // The id attribute is what scopes this. Another inline script must not match,
  // in either direction — picking up the wrong one yields a confident wrong
  // answer rather than a failure anyone would notice.
  check('a decoy script before it is not matched', bulk.extractPageProps(
    `<script>window.x={"props":{"pageProps":{"wrong":1}}}</script>` +
    `<script id="__NEXT_DATA__">{"props":{"pageProps":{"right":1}}}</script>`), { right: 1 });
  check('a similarly named id does not match',
    bulk.extractPageProps('<script id="__NEXT_DATA__EXTRA">{"props":{"pageProps":{"a":1}}}</script>'), null);
  check('attributes before the id are fine', bulk.extractPageProps(
    '<script type="application/json" nonce="abc" id="__NEXT_DATA__">{"props":{"pageProps":{"a":1}}}</script>'), { a: 1 });
  check('a closing tag with trailing space', bulk.extractPageProps(
    '<script id="__NEXT_DATA__">{"props":{"pageProps":{"a":1}}}</script >'), { a: 1 });
  check('pageProps that is not an object', bulk.extractPageProps(
    '<script id="__NEXT_DATA__">{"props":{"pageProps":"nope"}}</script>'), null);
  check('a course payload survives the round trip',
    bulk.extractPageProps(`<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: fixture('course-flat') } })}</script>`)
      .renderData.course.course.metadata.title, 'Flat Course');
}

console.log(`\n${failures ? `✗ ${failures} failure(s)` : '✓ all assertions hold'}`);
process.exit(failures ? 1 : 0);
