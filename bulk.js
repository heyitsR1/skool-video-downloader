// Pure helpers for bulk course backup, shared by the background service worker
// (loaded via importScripts) and the Node smoke tests. No chrome.* access, no
// DOM, no network — everything here is a total function over plain data, so the
// rules that are easy to get silently wrong are checkable without a browser.

// ── URLs ──────────────────────────────────────────────────────────────────────

// A classroom URL is /{group}/classroom[/{courseSlug}][?md={lessonId}].
// Anything else — including an unparseable string or a non-Skool host — is
// 'other', never a guess.
function parseCourseUrl(href) {
  const none = { group: null, courseSlug: null, lessonId: null, kind: 'other' };
  let u;
  try { u = new URL(href); } catch { return none; }
  if (!/(^|\.)skool\.com$/i.test(u.hostname)) return none;

  const seg = u.pathname.split('/').filter(Boolean);
  if (seg.length < 2 || seg[1] !== 'classroom') return none;

  const group = seg[0];
  const courseSlug = seg[2] || null;
  const lessonId = u.searchParams.get('md') || null;

  if (!courseSlug) return { group, courseSlug: null, lessonId: null, kind: 'classroom-index' };
  return { group, courseSlug, lessonId, kind: lessonId ? 'lesson' : 'course' };
}

function lessonUrlFor(group, courseSlug, lessonId) {
  return `https://www.skool.com/${group}/classroom/${courseSlug}?md=${encodeURIComponent(lessonId)}`;
}

function courseUrlFor(group, courseSlug) {
  return `https://www.skool.com/${group}/classroom/${courseSlug}`;
}

// Guarded so importScripts (where `module` is undefined) ignores it.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseCourseUrl, lessonUrlFor, courseUrlFor };
}
