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

// ── Lesson notes ──────────────────────────────────────────────────────────────

// ── Attachments ───────────────────────────────────────────────────────────────

// ── Manifest and resume ───────────────────────────────────────────────────────

// This file must stay a plain script: background.js is a classic (non-module)
// service worker and importScripts cannot load an ES module. The footer below
// is the only concession to Node — guarded, since `module` is undefined there.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    KIND, SOURCE,
    parseClassroomUrl, lessonUrlFor, courseUrlFor,
    courseTitleFrom, classifyEmbedHost, courseTreeFromPageProps,
  };
}
