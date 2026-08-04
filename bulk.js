// Pure helpers for bulk course backup, shared by the background service worker
// (loaded via importScripts) and the Node smoke tests. No chrome.* access, no
// DOM, no network — everything here is a total function over plain data, so the
// rules that are easy to get silently wrong are checkable without a browser.
//
// Contents: URLs · Page payload · Course tree · Output paths · Lesson notes ·
// Attachments · Manifest and resume.

// ── URLs ──────────────────────────────────────────────────────────────────────

// A classroom URL is /{group}/classroom[/{courseSlug}][?md={lessonId}].
// Anything else — including an unparseable string or a non-Skool host — is
// 'other', never a guess.
function parseClassroomUrl(href) {
  const none = { group: null, courseSlug: null, lessonId: null, kind: 'other' };
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

  if (!courseSlug) return { group, courseSlug: null, lessonId: null, kind: 'classroom-index' };
  return { group, courseSlug, lessonId, kind: lessonId ? 'lesson' : 'course' };
}

// searchParams decodes, so md must be re-encoded; u.pathname does NOT decode,
// so group/courseSlug arrive already-encoded and must be passed through as-is.
function lessonUrlFor(group, courseSlug, lessonId) {
  // encodeURIComponent(undefined) is the string "undefined", which builds a URL
  // Skool answers — with the course index. A missing id must not become a fetch.
  if (!group || !courseSlug || !lessonId) throw new Error('lessonUrlFor: missing id');
  return `https://www.skool.com/${group}/classroom/${courseSlug}?md=${encodeURIComponent(lessonId)}`;
}

function courseUrlFor(group, courseSlug) {
  return `https://www.skool.com/${group}/classroom/${courseSlug}`;
}

// ── Page payload ──────────────────────────────────────────────────────────────

// ── Course tree ───────────────────────────────────────────────────────────────

// ── Output paths ──────────────────────────────────────────────────────────────

// ── Lesson notes ──────────────────────────────────────────────────────────────

// ── Attachments ───────────────────────────────────────────────────────────────

// ── Manifest and resume ───────────────────────────────────────────────────────

// This file must stay a plain script: background.js is a classic (non-module)
// service worker and importScripts cannot load an ES module. The footer below
// is the only concession to Node — guarded, since `module` is undefined there.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseClassroomUrl, lessonUrlFor, courseUrlFor };
}
