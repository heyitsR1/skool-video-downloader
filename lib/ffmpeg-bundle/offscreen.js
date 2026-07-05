// Offscreen document — runs ffmpeg.wasm to merge video + audio HLS renditions
// into a single MP4. Offscreen documents can only use chrome.runtime messaging,
// so the merged file is handed back to the service worker as a blob: URL and
// the SW calls chrome.downloads.download on it. This document must stay alive
// until the SW confirms the download finished (MERGE_CLEANUP), or the blob URL
// dies with it.
const { FFmpeg } = self.FFmpegWASM;

let ffmpeg = null;
let currentJob = null; // { id, objectUrl } of the in-flight or completed merge

// Ring buffer of the most recent ffmpeg log lines. ffmpeg.wasm rarely throws on
// a bad remux — it prints the real reason (codec/muxer errors) to its log and
// then exits non-zero or stalls. We surface this tail in errors so it reaches
// the service-worker console even without inspecting the offscreen document.
const ffmpegLog = [];
function logTail() { return ffmpegLog.slice(-12).join('\n'); }

async function getFFmpeg() {
  if (ffmpeg && ffmpeg.loaded) return ffmpeg;
  ffmpeg = new FFmpeg();
  // Single progress listener for the instance lifetime — handleMerge stores the
  // active notifier here instead of stacking a new listener per job.
  ffmpeg.on('progress', ({ progress }) => {
    if (currentJob && currentJob.notify) {
      const p = Math.max(0, Math.min(100, Math.round(progress * 100)));
      currentJob.notify(p, `Merging: ${p}%`);
    }
  });
  ffmpeg.on('log', ({ message }) => {
    ffmpegLog.push(message);
    if (ffmpegLog.length > 200) ffmpegLog.shift();
    console.log('[ffmpeg]', message);
  });
  await ffmpeg.load({
    coreURL: chrome.runtime.getURL('lib/ffmpeg-bundle/ffmpeg-core.js'),
    wasmURL: chrome.runtime.getURL('lib/ffmpeg-bundle/ffmpeg-core.wasm')
  });
  return ffmpeg;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'MERGE_PING') {
    sendResponse({ ready: true });
  } else if (message.type === 'MERGE_AV') {
    handleMerge(message)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // async
  } else if (message.type === 'CREATE_BLOB_URL') {
    createBlobUrl(message)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // async
  } else if (message.type === 'SAVE_CLICK') {
    // Trigger the actual save from inside this document. A blob: URL minted here
    // is only valid in a context with a real frame — a chrome.downloads.download
    // initiated from the service worker has no frame to attribute the blob fetch
    // to, so Chrome rejects it with NETWORK_INVALID_REQUEST. Clicking an anchor
    // here gives the download a valid initiator; it still appears in
    // chrome.downloads so the SW can confirm it landed.
    try {
      if (!currentJob || !currentJob.objectUrl) throw new Error('No file ready to save');
      const a = document.createElement('a');
      a.href = currentJob.objectUrl;
      a.download = message.filename || 'download';
      document.body.appendChild(a);
      a.click();
      a.remove();
      sendResponse({ success: true });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
  } else if (message.type === 'MERGE_CANCEL') {
    if (ffmpeg) { try { ffmpeg.terminate(); } catch {} ffmpeg = null; }
    releaseJob();
    sendResponse({ success: true });
  } else if (message.type === 'MERGE_CLEANUP') {
    releaseJob();
    sendResponse({ success: true });
  }
});

function releaseJob() {
  if (currentJob && currentJob.objectUrl) URL.revokeObjectURL(currentJob.objectUrl);
  currentJob = null;
}

// MV3 service workers have no URL.createObjectURL. The SW stashes a blob in the
// Cache API and asks this document (a real page that does have it) to mint a
// blob: URL for chrome.downloads. The URL is kept alive on currentJob until the
// SW confirms the download finished and sends MERGE_CLEANUP.
async function createBlobUrl(message) {
  const { key } = message;
  releaseJob();
  const cache = await caches.open('video-blobs');
  const res = await cache.match(key);
  if (!res) throw new Error('Cached file missing — please retry the download');
  const blob = await res.blob();
  const job = { notify: null, objectUrl: URL.createObjectURL(blob) };
  currentJob = job;
  return { downloadUrl: job.objectUrl };
}

async function handleMerge(message) {
  const { videoKey, audioKey, tabId } = message;

  releaseJob();
  const job = { notify: null, objectUrl: null };
  currentJob = job;

  // Merge progress goes to the SW, which forwards it to the popup/content UI.
  job.notify = (percent, status) => {
    chrome.runtime.sendMessage({ type: 'MUX_PROGRESS', tabId, percent, status }).catch(() => {});
  };

  job.notify(0, 'Merging: loading engine…');
  console.log('[Whop DL offscreen] loading ffmpeg engine…');
  const ff = await getFFmpeg();
  console.log('[Whop DL offscreen] engine loaded; reading staged streams');

  const cache = await caches.open('video-blobs');
  const [vRes, aRes] = await Promise.all([cache.match(videoKey), cache.match(audioKey)]);
  if (!vRes || !aRes) throw new Error('Cached streams missing — please retry the download');

  const [videoBuf, audioBuf] = await Promise.all([vRes.arrayBuffer(), aRes.arrayBuffer()]);
  console.log(`[Whop DL offscreen] writing to wasm FS — video ${(videoBuf.byteLength/1048576).toFixed(1)}MB, audio ${(audioBuf.byteLength/1048576).toFixed(1)}MB`);

  await ff.writeFile('video.mp4', new Uint8Array(videoBuf));
  await ff.writeFile('audio.mp4', new Uint8Array(audioBuf));

  job.notify(0, 'Merging: 0%');
  console.log('[Whop DL offscreen] running ffmpeg -c copy mux…');

  // Stream copy (no re-encode): mux both tracks into one MP4 container.
  const code = await ff.exec([
    '-i', 'video.mp4',
    '-i', 'audio.mp4',
    '-c', 'copy',
    '-movflags', '+faststart',
    'output.mp4'
  ]);
  console.log(`[Whop DL offscreen] ffmpeg exited ${code}`);
  if (code !== 0) throw new Error(`Merge failed (ffmpeg exit ${code})\n${logTail()}`);

  // Free the input copies from the wasm FS BEFORE pulling the output back into
  // JS. On a long video the muxed output plus both inputs in MEMFS plus the
  // readback buffer can flirt with the wasm32 (~2GB) ceiling; dropping the
  // inputs first keeps peak memory lower and avoids a silent OOM.
  await ff.deleteFile('video.mp4').catch(() => {});
  await ff.deleteFile('audio.mp4').catch(() => {});

  const data = await ff.readFile('output.mp4');
  await ff.deleteFile('output.mp4').catch(() => {});
  await Promise.all([cache.delete(videoKey), cache.delete(audioKey)]);

  const blob = new Blob([data.buffer], { type: 'video/mp4' });
  job.objectUrl = URL.createObjectURL(blob);
  return { downloadUrl: job.objectUrl };
}
