// Pure helpers for bulk course backup, shared by the background service worker
// (loaded via importScripts) and the Node smoke tests. No chrome.* access, no
// DOM, no network — everything here is a total function over plain data, so the
// rules that are easy to get silently wrong are checkable without a browser.
//
// Contents: URLs · Page payload · Course tree · Output paths · Lesson notes ·
// Attachments · Manifest and resume.

// ── Vocabulary ────────────────────────────────────────────────────────────────

// Frozen so the strings the rest of the module branches on have one spelling.
// A typo'd literal in a comparison matches nothing and throws nothing — it just
// silently takes the other branch, which is the failure mode this file exists
// to prevent.
const KIND = Object.freeze({ LESSON: 'lesson', COURSE: 'course', INDEX: 'classroom-index', OTHER: 'other' });
const SOURCE = Object.freeze({
  NATIVE: 'skool-native', LOOM: 'loom', VIMEO: 'vimeo', WISTIA: 'wistia',
  YOUTUBE: 'youtube', TEXT: 'text', UNKNOWN: 'unknown',
});

// ── URLs ──────────────────────────────────────────────────────────────────────

// A classroom URL is /{group}/classroom[/{courseSlug}][?md={lessonId}].
// Anything else — including an unparseable string or a non-Skool host — is
// 'other', never a guess.
function parseClassroomUrl(href) {
  const none = { group: null, courseSlug: null, lessonId: null, kind: KIND.OTHER };
  let u;
  try { u = new URL(href); } catch { return none; }
  // new URL() already lowercases hostname, so no /i needed here.
  if (!/(^|\.)skool\.com$/.test(u.hostname)) return none;

  // Extra trailing segments past courseSlug (e.g. a future /module/lesson
  // shape) are ignored, not rejected — this only classifies the URL kind and
  // extracts what it needs; a stricter length check would just be more ways
  // to misclassify a URL Skool itself would still route.
  const segments = u.pathname.split('/').filter(Boolean);
  if (segments.length < 2 || segments[1] !== 'classroom') return none;

  const group = segments[0];
  const courseSlug = segments[2] || null;
  // A ?md= on a classroom-index URL (no courseSlug) is discarded: without a
  // course there is nothing for the id to select, so it is not surfaced as a
  // lessonId rather than guessed into one.
  const lessonId = u.searchParams.get('md') || null;

  if (!courseSlug) return { group, courseSlug: null, lessonId: null, kind: KIND.INDEX };
  return { group, courseSlug, lessonId, kind: lessonId ? KIND.LESSON : KIND.COURSE };
}

// Both builders below take values straight off parseClassroomUrl. searchParams
// decodes, so md must be re-encoded; u.pathname does NOT decode, so
// group/courseSlug arrive already-encoded and are passed through as-is.
//
// Both also refuse a missing part rather than interpolating it. Skool answers
// the resulting URL — with the course index — so a missing id would otherwise
// become a successful fetch of the wrong page, which is worse than a throw.
function lessonUrlFor(group, courseSlug, lessonId) {
  if (!group || !courseSlug || !lessonId) throw new Error('lessonUrlFor: missing id');
  return `https://www.skool.com/${group}/classroom/${courseSlug}?md=${encodeURIComponent(lessonId)}`;
}

function courseUrlFor(group, courseSlug) {
  if (!group || !courseSlug) throw new Error('courseUrlFor: missing id');
  return `https://www.skool.com/${group}/classroom/${courseSlug}`;
}

// ── Page payload ──────────────────────────────────────────────────────────────

// ── Course tree ───────────────────────────────────────────────────────────────

// The whole course is embedded in the classroom page's __NEXT_DATA__, so one
// authenticated fetch enumerates every lesson. Each node is a wrapper
// { course: { id, metadata }, children: [] } — including the root, which carries
// no metadata of its own, so the course title lives one level in.

function nodeSelf(n) {
  return (n && typeof n === 'object' && n.course && typeof n.course === 'object') ? n.course : n;
}
function nodeMeta(n) {
  const s = nodeSelf(n);
  return (s && typeof s.metadata === 'object' && s.metadata) ? s.metadata : {};
}
function nodeKids(n) {
  if (Array.isArray(n?.children)) return n.children;
  const s = nodeSelf(n);
  return Array.isArray(s?.children) ? s.children : [];
}
function nodeId(n) {
  const id = nodeSelf(n)?.id;
  return typeof id === 'string' && id ? id : null;
}
function trimmed(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

const EMBED_HOSTS = [
  [/(?:^|\.)(?:youtube\.com|youtu\.be|youtube-nocookie\.com)$/i, SOURCE.YOUTUBE],
  [/(?:^|\.)loom\.com$/i, SOURCE.LOOM],
  [/(?:^|\.)vimeo\.com$/i, SOURCE.VIMEO],
  [/(?:^|\.)(?:wistia\.com|wistia\.net|wi\.st)$/i, SOURCE.WISTIA],
];

// An unrecognised host returns null so the caller can record 'unknown' and skip
// it with a named reason. Guessing a platform here would send the resolver at a
// service that cannot answer, and the user would see a meaningless failure.
function classifyEmbedHost(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  for (const [re, kind] of EMBED_HOSTS) if (re.test(host)) return kind;
  return null;
}

function courseTitleFrom(root, courseSlug) {
  return trimmed(nodeMeta(root).title)
      ?? trimmed(root?.metadata?.title)
      ?? `Course ${courseSlug}`;
}

// A node is a lesson when it carries its own video, or when it is a leaf. The
// leaf clause is what picks up text-only lessons, which have no video field.
function isLessonNode(n) {
  const m = nodeMeta(n);
  if (m.videoLink || m.videoId) return true;
  return nodeKids(n).length === 0;
}

function sourceOf(meta) {
  const link = trimmed(meta.videoLink);
  if (link) {
    const kind = classifyEmbedHost(link);
    return { sourceKind: kind || SOURCE.UNKNOWN, sourceRef: link };
  }
  const vid = trimmed(meta.videoId);
  if (vid) return { sourceKind: SOURCE.NATIVE, sourceRef: vid };
  return { sourceKind: SOURCE.TEXT, sourceRef: null };
}

// → { ok: true, courseTitle, shape, moduleCount, lessons[] }
//   { ok: false, code: 'schema-drift' | 'empty-course', courseTitle?, detail? }
//
// The two failure codes must stay distinct. An empty course and a changed schema
// look identical from a lesson count alone, and reporting drift as "this course
// has no lessons" is the silent wrong answer this whole module exists to avoid.
function courseTreeFromPageProps(pageProps, group, courseSlug) {
  const root = pageProps?.renderData?.course ?? pageProps?.course ?? null;
  if (!root || typeof root !== 'object') {
    return { ok: false, code: 'schema-drift', detail: 'no course node at renderData.course or course' };
  }

  const courseTitle = courseTitleFrom(root, courseSlug);
  const topLevel = nodeKids(root);
  if (topLevel.length === 0) return { ok: false, code: 'empty-course', courseTitle };

  const containers = topLevel.filter(n => nodeKids(n).length > 0);
  const shape = containers.length === 0 ? 'flat'
    : containers.length === topLevel.length ? 'nested'
    : 'mixed';

  const lessons = [];
  const seenIds = new Set();
  let moduleCount = 0;

  const push = (node, moduleIdx, moduleTitle, lessonIdx) => {
    const id = nodeId(node);
    if (!id || seenIds.has(id)) return false;
    seenIds.add(id);
    const m = nodeMeta(node);
    const { sourceKind, sourceRef } = sourceOf(m);
    lessons.push({
      lessonId: id,
      title: trimmed(m.title) ?? `Lesson ${lessonIdx}`,
      moduleIdx, moduleTitle, lessonIdx,
      sourceKind, sourceRef,
      lessonUrl: lessonUrlFor(group, courseSlug, id),
      durationMs: typeof m.videoLenMs === 'number' ? m.videoLenMs : null,
      descRaw: typeof m.desc === 'string' ? m.desc : null,
      resourcesRaw: typeof m.resources === 'string' ? m.resources : null,
    });
    return true;
  };

  // Depth cap and a visited set: the observed maximum is two levels, but a cycle
  // or an unexpectedly deep tree must not hang the worker.
  const walkInto = (node, moduleIdx, moduleTitle, counter, depth, visited) => {
    if (depth > 10 || visited.has(node)) return;
    visited.add(node);
    for (const kid of nodeKids(node)) {
      if (isLessonNode(kid)) {
        if (push(kid, moduleIdx, moduleTitle, counter.n + 1)) counter.n++;
      } else {
        walkInto(kid, moduleIdx, moduleTitle, counter, depth + 1, visited);
      }
    }
  };

  const rootCounter = { n: 0 };
  for (const node of topLevel) {
    if (nodeKids(node).length === 0) {
      // A loose top-level lesson. Putting it in an invented single-lesson module
      // folder would be worse than the course root it actually belongs to.
      if (push(node, null, null, rootCounter.n + 1)) rootCounter.n++;
      continue;
    }
    moduleCount++;
    const m = nodeMeta(node);
    const moduleTitle = trimmed(m.title) ?? `Module ${moduleCount}`;
    const counter = { n: 0 };
    // A module that also carries its own video contributes it as the first lesson
    // inside that module rather than losing it.
    if (m.videoLink || m.videoId) { if (push(node, moduleCount, moduleTitle, 1)) counter.n = 1; }
    walkInto(node, moduleCount, moduleTitle, counter, 1, new Set());
  }

  if (lessons.length === 0) {
    return { ok: false, code: 'schema-drift', courseTitle,
      detail: `${topLevel.length} top-level nodes but no lesson node matched` };
  }
  return { ok: true, courseTitle, shape, moduleCount, lessons };
}

// ── Output paths ──────────────────────────────────────────────────────────────
// Paths are relative to the browser's download directory, so every segment must
// be legal on Windows and macOS alike, and must stay short enough that a deep
// course does not blow a path-length limit.

function sanitizeForFs(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Windows refuses these names with or without an extension, in any case. A
// course or lesson titled after one would fail every download under it with an
// error the user has no way to act on, so it gets a suffix instead.
const RESERVED_SEGMENTS = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

// Trailing dots are silently stripped by Windows, which would turn two distinct
// lesson titles into one path — so they are dropped here, where the collision
// check can still see it.
function capSegment(name, max, fallback) {
  // Cap by character, not by UTF-16 unit: a bare .slice() can cut an emoji in
  // half and leave a lone surrogate in the filename.
  let clean = [...sanitizeForFs(name)].slice(0, max).join('').trim();
  clean = clean.replace(/\.+$/, '').trim();
  if (!clean) return fallback;
  return RESERVED_SEGMENTS.test(clean) ? `${clean}_` : clean;
}

// Two digits normally, three once a course has 100+ siblings, so a file browser
// sorts lessons in course order rather than lexically (…, 10, 100, 11, …).
function padIndex(n, total) {
  return String(n).padStart(Number(total) >= 100 ? 3 : 2, '0');
}

// Claims `candidate` in `used`, appending " (2)", " (3)" … before `suffix` until
// it is free. Shared by the lesson stems and the attachments hanging off them.
function claimUnique(used, stem, suffix) {
  let candidate = `${stem}${suffix}`;
  if (!used) return candidate;
  let n = 2;
  while (used.has(candidate)) candidate = `${stem} (${n++})${suffix}`;
  used.add(candidate);
  return candidate;
}

// Reserves and returns the extensionless stem for one lesson. Video, notes and
// attachments all hang off it, so a single collision check covers every asset.
function bulkLessonBase(parts, usedBases) {
  const { courseTitle, moduleIdx, moduleTitle, moduleCount, lessonIdx, lessonTitle, lessonCount } = parts;
  const course = capSegment(courseTitle, 100, 'skool-course');
  const dir = moduleIdx
    ? `${course}/${padIndex(moduleIdx, moduleCount)} ${capSegment(moduleTitle, 100, 'module')}`
    : course;
  const stem = `${padIndex(lessonIdx, lessonCount)} ${capSegment(lessonTitle, 120, 'lesson')}`;
  return claimUnique(usedBases, `${dir}/${stem}`, '');
}

function extensionOf(fileName) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(fileName || ''));
  return m ? m[1] : null;
}

// The label is what the user sees, so it names the file; the extension comes
// from the real file name, because a label often has none or a wrong one.
//
// Two attachments on one lesson may share a label. `usedNames` is optional so
// the pure name is still testable, but the writer must pass one — otherwise the
// second file quietly overwrites the first.
function attachmentFilename(base, file, usedNames) {
  const label = capSegment(file?.label, 80, 'attachment');
  const ext = extensionOf(file?.fileName);
  return claimUnique(usedNames, `${base} - ${label}`, ext ? `.${ext}` : '');
}

// ── Lesson notes ──────────────────────────────────────────────────────────────
// metadata.desc holds a rich-text document as JSON, sometimes behind a "[v2]"
// prefix. Unknown node types recurse into their contents rather than being
// dropped: a future wrapper element must not silently delete the text inside it.

// Depth is tracked separately from list indentation below: a wrapper element
// nests the recursion without nesting the list, so one counter cannot do both —
// and conflating them leaves the recursion unguarded.
const MAX_NODE_DEPTH = 100;

function pmInline(node, depth) {
  const d = Number(depth) || 0;
  if (!node || typeof node !== 'object' || d > MAX_NODE_DEPTH) return '';
  if (node.type === 'text') {
    let t = typeof node.text === 'string' ? node.text : '';
    for (const mark of Array.isArray(node.marks) ? node.marks : []) {
      if (!mark || typeof mark !== 'object') continue;
      if (mark.type === 'bold') t = `**${t}**`;
      else if (mark.type === 'italic') t = `*${t}*`;
      else if (mark.type === 'code') t = '`' + t + '`';
      else if (mark.type === 'link' && typeof mark.attrs?.href === 'string') t = `[${t}](${mark.attrs.href})`;
    }
    return t;
  }
  if (node.type === 'hardBreak') return '\n';
  return (Array.isArray(node.content) ? node.content : []).map(k => pmInline(k, d + 1)).join('');
}

function isListNode(n) {
  return n?.type === 'bulletList' || n?.type === 'orderedList';
}

// A list inside a list item becomes its own indented lines rather than being
// folded onto the parent's. Flattening it would destroy the structure the author
// wrote, and once the .md is on disk there is nothing left to recover it from.
function pmListItems(kids, marker, listDepth, depth) {
  const indent = '  '.repeat(listDepth);
  return kids.map((li, i) => {
    const parts = Array.isArray(li?.content) ? li.content : [];
    const lead = parts.filter(p => !isListNode(p))
      .map(p => pmBlock(p, listDepth, depth + 1)).join(' ').trim();
    const sub = parts.filter(isListNode).map(p => pmBlock(p, listDepth + 1, depth + 1));
    const line = `${indent}${marker(i)} ${lead}`.trimEnd();
    return sub.length ? [line, ...sub].join('\n') : line;
  }).join('\n');
}

// A fence inside the code would close the block early and spill the rest of the
// lesson into the document as prose, so the fence grows past the longest run.
function pmFence(body) {
  const longest = (body.match(/`{3,}/g) || []).reduce((m, s) => Math.max(m, s.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

// listDepth is how far the output is indented; depth is how far the recursion
// has gone. A wrapper node advances the second without the first.
function pmBlock(node, listDepth, depth) {
  if (!node || typeof node !== 'object') return '';
  const li = Number(listDepth) || 0;
  const d = Number(depth) || 0;
  // Deeper than any real document: a pathological one must not blow the worker's
  // stack and cost the user the whole run. It says so in the file rather than
  // returning '', because silently emitting empty notes is indistinguishable
  // from a lesson that genuinely had none.
  if (d > MAX_NODE_DEPTH) return '[notes truncated: document nested too deeply]';
  const kids = Array.isArray(node.content) ? node.content : [];
  const inline = () => kids.map(k => pmInline(k, d + 1)).join('');
  switch (node.type) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1) || 1));
      return `${'#'.repeat(level)} ${inline()}`;
    }
    case 'paragraph':   return inline();
    case 'bulletList':  return pmListItems(kids, () => '-', li, d);
    case 'orderedList': return pmListItems(kids, i => `${i + 1}.`, li, d);
    case 'blockquote':  return kids.map(k => pmBlock(k, li, d + 1)).join('\n').split('\n').map(l => `> ${l}`).join('\n');
    case 'codeBlock': {
      const body = inline();
      return `${pmFence(body)}\n${body}\n${pmFence(body)}`;
    }
    case 'text':
    case 'hardBreak':   return pmInline(node, d);
    default:            return kids.map(k => pmBlock(k, li, d + 1)).join('\n\n');
  }
}

function descToMarkdown(raw) {
  if (typeof raw !== 'string' || raw === '') return '';
  // The marker is an encoding detail. It is stripped before the parse attempt so
  // that unparseable text falls back to what the user wrote, not to the marker.
  const body = raw.startsWith('[v2]') ? raw.slice(4) : raw;
  let parsed;
  try { parsed = JSON.parse(body); } catch { return body; }  // plain text is content, not a failure
  let nodes = null;
  if (Array.isArray(parsed)) nodes = parsed;
  else if (parsed && typeof parsed === 'object') nodes = Array.isArray(parsed.content) ? parsed.content : [parsed];
  if (!nodes) return body;
  return nodes.map(n => pmBlock(n, 0, 0)).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

// The .md file written beside a lesson's video: its title, its notes, any
// resource links that are not downloadable files, and a pointer back to the
// lesson so the user can always find the original.
function notesDocument({ title, lessonUrl, markdown, links }) {
  const out = [`# ${title}`, ''];
  if (markdown) out.push(markdown, '');
  if (Array.isArray(links) && links.length) {
    out.push('## Links', '');
    // A bracket in a label would otherwise end the link text early and leave the
    // rest of it, plus the URL, as loose characters in the file.
    for (const l of links) out.push(`- [${String(l.label).replace(/([[\]])/g, '\\$1')}](${l.url})`);
    out.push('');
  }
  out.push('---', `Lesson: ${lessonUrl}`, '');
  return out.join('\n');
}

// ── Attachments ───────────────────────────────────────────────────────────────
// resources is a JSON string, and its entries are either a downloadable file
// (file_id) or a plain external link. Entries matching neither are counted in
// `dropped` rather than discarded quietly, so a schema change shows up as a
// number we can report instead of attachments that simply stop appearing.

const FILE_ID_RE = /^[0-9a-f]{32}$/i;

// Labels end up in filenames and in a Markdown list, where a newline or a tab
// would end the line early and split one entry into two.
function flattenLabel(v) {
  return typeof v === 'string' && v.replace(/\s+/g, ' ').trim() ? v.replace(/\s+/g, ' ').trim() : null;
}

function parseResources(raw) {
  const out = { files: [], links: [], dropped: 0 };
  if (raw == null || raw === '') return out;

  let arr;
  try { arr = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return { files: [], links: [], dropped: 1 }; }
  if (!Array.isArray(arr)) return { files: [], links: [], dropped: 1 };

  // The manifest keys a lesson's assets by fileId, so the same file listed twice
  // has one slot to record in — and would otherwise be fetched twice and written
  // to two names. The first labelling of it wins.
  const seenFileIds = new Set();

  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') { out.dropped++; continue; }

    const label = [entry.title, entry.label, entry.file_name].map(flattenLabel).find(Boolean) || null;
    const fileId = typeof entry.file_id === 'string' && FILE_ID_RE.test(entry.file_id) ? entry.file_id : null;
    // http(s) only, and no whitespace — a resource entry is not a place to accept
    // an arbitrary scheme, and a URL with a newline in it breaks the Markdown
    // link it gets written into.
    const url = [entry.link, entry.url]
      .find(v => typeof v === 'string' && /^https?:\/\//i.test(v) && !/\s/.test(v)) || null;

    if (fileId) {
      if (seenFileIds.has(fileId)) continue;
      seenFileIds.add(fileId);
      out.files.push({
        fileId,
        label: label || 'attachment',
        fileName: typeof entry.file_name === 'string' ? entry.file_name : null,
        contentType: typeof entry.file_content_type === 'string' ? entry.file_content_type : null,
      });
    } else if (url) {
      out.links.push({ label: label || url, url });
    } else {
      out.dropped++;
    }
  }
  return out;
}

// ── Manifest and resume ───────────────────────────────────────────────────────

// This file must stay a plain script: background.js is a classic (non-module)
// service worker and importScripts cannot load an ES module. The footer below
// is the only concession to Node — guarded, since `module` is undefined there.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    KIND, SOURCE,
    parseClassroomUrl, lessonUrlFor, courseUrlFor,
    courseTitleFrom, classifyEmbedHost, courseTreeFromPageProps,
    sanitizeForFs, capSegment, padIndex, bulkLessonBase, extensionOf, attachmentFilename,
    descToMarkdown, notesDocument,
    FILE_ID_RE, parseResources,
  };
}
