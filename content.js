// Content script — runs on skool.com. Finds embedded videos two ways:
//   1. Skool's Next.js page data (window.__NEXT_DATA__ / hydrated props), which
//      often names the platform + source id before any player is even mounted.
//   2. Iframes / players in the DOM (Loom, Vimeo, YouTube, Wistia embeds).
// HLS-native (Skool Mux) streams are caught in the background by webRequest once
// the user presses play; this script covers everything embed-based and re-scans
// on SPA route changes so classroom navigation keeps detection fresh.

(() => {
  const seen = new Set();

  function report(videos) {
    const fresh = videos.filter(v => v && v.key && !seen.has(v.key));
    if (!fresh.length) return;
    fresh.forEach(v => seen.add(v.key));
    chrome.runtime.sendMessage({ type: 'REGISTER_VIDEOS', videos: fresh }).catch(() => {});
  }

  const pageUrl = () => location.href;

  // ── Source-id extractors ────────────────────────────────────────────────────
  function loomId(url) {
    const m = url.match(/loom\.com\/(?:share|embed)\/([0-9a-f]{20,})/i);
    return m ? m[1] : null;
  }
  function vimeoId(url) {
    const m = url.match(/(?:player\.)?vimeo\.com\/(?:video\/)?(\d{6,})/);
    const h = url.match(/[?&]h=([0-9a-f]+)/);
    return m ? { id: m[1], h: h ? h[1] : null } : null;
  }
  function youtubeId(url) {
    const m = url.match(/(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([\w-]{11})/);
    return m ? m[1] : null;
  }
  function wistiaId(url) {
    const m = url.match(/wistia\.(?:com|net)\/(?:embed\/(?:iframe|medias)\/|medias\/)([\w]{10,})/)
      || url.match(/wistia_async_([\w]{10,})/);
    return m ? m[1] : null;
  }

  // `src` names the scanner that produced the detection (dom-iframe /
  // dom-wistia / json-md / json-text). It rides into the background registry
  // and the debug log, so a phantom detection is traceable to its origin from
  // a single problem report.
  function makeVideo(platform, sourceId, src, extra = {}) {
    return {
      key: `${platform}:${sourceId}`,
      platform,
      label: ({ loom: 'Loom', vimeo: 'Vimeo', youtube: 'YouTube', wistia: 'Wistia' })[platform] || platform,
      sourceId,
      src,
      pageUrl: pageUrl(),
      ...extra
    };
  }

  // ── DOM scan (iframes + Wistia async divs) ──────────────────────────────────
  function scanDom() {
    const found = [];
    document.querySelectorAll('iframe[src], iframe[data-src]').forEach(f => {
      const src = f.src || f.getAttribute('data-src') || '';
      if (!src) return;
      let id;
      if ((id = loomId(src))) found.push(makeVideo('loom', id, 'dom-iframe'));
      else if ((id = vimeoId(src))) found.push(makeVideo('vimeo', id.id, 'dom-iframe', { hParam: id.h }));
      else if ((id = youtubeId(src))) found.push(makeVideo('youtube', id, 'dom-iframe'));
      else if ((id = wistiaId(src))) found.push(makeVideo('wistia', id, 'dom-iframe'));
    });
    // Wistia's newer embed uses <div class="wistia_embed wistia_async_<id>">.
    document.querySelectorAll('[class*="wistia_async_"]').forEach(el => {
      const m = el.className.match(/wistia_async_([\w]{10,})/);
      if (m) found.push(makeVideo('wistia', m[1], 'dom-wistia'));
    });
    return found;
  }

  // ── Next.js / hydrated JSON scan ────────────────────────────────────────────
  // Skool serves lesson metadata inside __NEXT_DATA__ and inline hydration blobs.
  //
  // CRITICAL: On a classroom page __NEXT_DATA__ contains the WHOLE course tree —
  // every lesson node carries its own metadata.videoLink. A full-text match over
  // that blob harvests OTHER lessons' videos as phantoms on the current lesson's
  // page (e.g. a native Mux lesson shows a sibling lesson's YouTube id, which
  // then dies with "YouTube refused playback (403)"). So when __NEXT_DATA__
  // parses as course data, we only classify the videoLink of the lesson whose id
  // matches the page's ?md= query param — the lesson actually on screen.
  // Native (Mux) lessons yield no embed link here; the background webRequest
  // capture registers them once the user presses play.
  //
  // Non-classroom JSON (post pages, hydration blobs) still goes through the
  // text-level scan, gated on a "…video…" field key sitting just before the URL
  // so YouTube/Vimeo links pasted in feed posts ("content"/"text"/"linkUrl"
  // fields) are rejected.
  const VIDEO_FIELD_CTX = /"[^"]*video[^"]*"\s*:\s*(?:\\?")?[^"]{0,40}$/i;
  function nearVideoField(text, index) {
    // Look back a short window for a "…video…": "<here>" style key.
    return VIDEO_FIELD_CTX.test(text.slice(Math.max(0, index - 80), index));
  }

  function classifyLink(url, src) {
    let id;
    if ((id = loomId(url))) return makeVideo('loom', id, src);
    const v = vimeoId(url);
    if (v) return makeVideo('vimeo', v.id, src, { hParam: v.h });
    if ((id = youtubeId(url))) return makeVideo('youtube', id, src);
    if ((id = wistiaId(url))) return makeVideo('wistia', id, src);
    return null;
  }

  // Collect every course/lesson node ({ id, metadata: { videoLink, title } })
  // from the parsed __NEXT_DATA__ tree. Schema-light on purpose: Skool renames
  // props, but the id + metadata pairing has been stable across scraper tooling.
  // Title-only nodes (modules, native-video lessons) are kept too — the popup
  // uses the ?md=-matched node's title to label wire-captured native videos.
  function collectLessons(node, out, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 30) return;
    if (Array.isArray(node)) { for (const item of node) collectLessons(item, out, depth + 1); return; }
    if (typeof node.id === 'string' && node.metadata && typeof node.metadata === 'object') {
      const videoLink = typeof node.metadata.videoLink === 'string' ? node.metadata.videoLink : '';
      const title = typeof node.metadata.title === 'string' ? node.metadata.title : '';
      if (videoLink || title) out.push({ id: node.id, videoLink, title });
    }
    for (const k of Object.keys(node)) collectLessons(node[k], out, depth + 1);
  }

  // Parsing/walking __NEXT_DATA__ on every scan tick would be wasteful; the blob
  // only changes on real navigations, so cache by its text.
  let ndCache = { text: null, lessons: null };
  function nextDataLessons(text) {
    if (ndCache.text !== text) {
      let lessons = [];
      try { collectLessons(JSON.parse(text), lessons); } catch { lessons = null; }
      ndCache = { text, lessons };
    }
    return ndCache.lessons; // null → unparseable, [] → no course tree inside
  }

  function scanJson() {
    const found = [];
    const blobs = [];

    const nd = document.getElementById('__NEXT_DATA__');
    if (nd?.textContent) {
      const lessons = nextDataLessons(nd.textContent) || [];
      const md = new URLSearchParams(location.search).get('md');
      // Classroom page: classify only the on-screen lesson's own videoLink.
      const current = md ? lessons.find(l => l.id === md) : null;
      if (current && current.videoLink) {
        const v = classifyLink(current.videoLink, 'json-md');
        if (v) found.push(v);
      }
      const isCourseData = lessons.some(l => l.videoLink);
      if (!md && !isCourseData) {
        // No course tree found and not a lesson page — gated text scan is safe.
        blobs.push(nd.textContent);
      } else {
        // Course data present, or ?md= says this IS a lesson page — NEVER
        // text-scan the blob: it holds every sibling lesson's link and would
        // resurrect phantom detections. Embeds still surface via the DOM
        // iframe scan; native via the wire capture.
        console.log('[SVD] __NEXT_DATA__ lessons:', lessons.length, '| md:', md,
          '| match:', current ? (current.videoLink || '(no videoLink — native?)') : 'none');
      }
    }

    // NB: skip __NEXT_DATA__ here — it matches script:not([src]) too, and when
    // it holds course data it must NOT reach the gated text scan (that's the
    // phantom-sibling-lesson path this function exists to prevent).
    document.querySelectorAll('script:not([src])').forEach(s => {
      if (s.id === '__NEXT_DATA__') return;
      const t = s.textContent || '';
      if (t.length < 5e5 && /(loom\.com|vimeo\.com|wistia|youtube|youtu\.be|mux\.com|videoLink|video_url)/.test(t)) blobs.push(t);
    });

    const text = blobs.join('\n');
    if (!text) return found;

    const gated = (re, make) => {
      for (const m of text.matchAll(re)) {
        if (nearVideoField(text, m.index)) found.push(make(m[1]));
      }
    };
    gated(/loom\.com\\?\/(?:share|embed)\\?\/([0-9a-f]{20,})/gi, id => makeVideo('loom', id, 'json-text'));
    gated(/(?:player\.)?vimeo\.com\\?\/(?:video\\?\/)?(\d{6,})/g, id => makeVideo('vimeo', id, 'json-text'));
    gated(/youtu(?:be(?:-nocookie)?\.com\\?\/(?:embed\\?\/|watch\?v=)|\.be\\?\/)([\w-]{11})/g, id => makeVideo('youtube', id, 'json-text'));
    gated(/wistia\.(?:com|net)\\?\/(?:medias|embed\\?\/(?:iframe|medias))\\?\/([\w]{10,})/g, id => makeVideo('wistia', id, 'json-text'));
    return found;
  }

  function scan() {
    const json = scanJson();
    const dom = scanDom();
    if (json.length || dom.length) {
      // Diagnostic: shows which scanner produced each candidate so a phantom
      // (e.g. a YouTube link shared in a feed post) can be traced to its source.
      console.log('[SVD] detected →',
        'JSON:', json.map(v => v.key),
        '| DOM(iframe):', dom.map(v => v.key));
    }
    report([...json, ...dom]);
  }

  // Fresh full page load — clear the previous page's captured videos, then scan.
  chrome.runtime.sendMessage({ type: 'CLEAR_TAB', reason: 'page-load', path: location.pathname + location.search }).catch(() => {});

  // Initial scan + a few retries (players hydrate late), then observe SPA changes.
  scan();
  let tries = 0;
  const early = setInterval(() => { scan(); if (++tries >= 6) clearInterval(early); }, 1200);

  const mo = new MutationObserver(() => { clearTimeout(mo._t); mo._t = setTimeout(scan, 600); });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // SPA route change — Skool swaps lessons without a full load. Clear BOTH the
  // local seen set AND the background registry: without the registry clear, a
  // sibling lesson's video (e.g. a Loom detected two lessons ago) stays listed
  // in the popup on every later lesson — the "phantom Loom" bug.
  let lastPath = location.pathname + location.search;
  setInterval(() => {
    const now = location.pathname + location.search;
    if (now !== lastPath) {
      lastPath = now;
      seen.clear();
      chrome.runtime.sendMessage({ type: 'CLEAR_TAB', reason: 'spa-nav', path: now }).catch(() => {});
      scan();
    }
  }, 800);

  // ── Page context for the popup (title + preview frame) ────────────────────
  function currentLessonTitle() {
    const nd = document.getElementById('__NEXT_DATA__');
    const md = new URLSearchParams(location.search).get('md');
    if (nd?.textContent && md) {
      const hit = (nextDataLessons(nd.textContent) || []).find(l => l.id === md);
      if (hit?.title) return hit.title;
    }
    return document.title.replace(/\s*[-|]\s*Skool.*$/i, '').trim();
  }

  // Grab a small JPEG frame from the largest playing <video> on the page.
  // Works for Skool-native (MSE blob src is same-origin, canvas stays clean);
  // embed platforms live in cross-origin iframes and simply return null.
  function grabVideoFrame() {
    try {
      const v = [...document.querySelectorAll('video')]
        .filter(el => el.readyState >= 2 && el.videoWidth > 0)
        .sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight))[0];
      if (!v) return null;
      const w = 320, h = Math.max(1, Math.round(w * v.videoHeight / v.videoWidth));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(v, 0, 0, w, h);
      return c.toDataURL('image/jpeg', 0.7);
    } catch { return null; } // tainted canvas / draw failure
  }

  // Let the popup nudge a rescan on demand.
  chrome.runtime.onMessage.addListener((msg, _s, respond) => {
    if (msg.type === 'RESCAN') { seen.clear(); scan(); respond?.({ ok: true }); }
    if (msg.type === 'GET_PAGE_TITLE') respond?.({ title: document.title.replace(/\s*[-|]\s*Skool.*$/i, '').trim() });
    if (msg.type === 'GET_PAGE_CONTEXT') respond?.({ title: currentLessonTitle(), frame: grabVideoFrame() });
    return true;
  });
})();
