#!/usr/bin/env node
// Smoke test for the YouTube Innertube resolver in detectors.js.
//
// Replicates the exact player requests the extension makes (same clients, same
// order, no Origin header — the extension strips its chrome-extension:// Origin
// via a DNR session rule) and fails loudly when no client yields downloadable
// streams, i.e. when YouTube rots another client out from under us.
//
//   node scripts/yt-smoke.mjs [videoId]
//
// Exit 0: at least one client returned playable formats AND a sample stream URL
//         served real bytes. Exit 1 otherwise.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const videoId = process.argv[2] || 'aqz-KE-bpKQ'; // Big Buck Bunny (Blender), stable public upload

// Parse YT_CLIENTS out of detectors.js so the test exercises what actually ships.
const src = fs.readFileSync(path.join(ROOT, 'detectors.js'), 'utf8');
const m = src.match(/const YT_CLIENTS = (\[[\s\S]*?\]);/);
if (!m) { console.error('✗ could not find YT_CLIENTS in detectors.js'); process.exit(1); }
const YT_CLIENTS = eval(m[1]);
const YT_PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';

let ok = false;
for (const client of YT_CLIENTS) {
  const { clientId, userAgent, ...ctx } = client;
  const res = await fetch(YT_PLAYER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': userAgent,
      'X-Youtube-Client-Name': String(clientId),
      'X-Youtube-Client-Version': client.clientVersion
    },
    body: JSON.stringify({ videoId, context: { client: { ...ctx, hl: 'en', gl: 'US' } }, contentCheckOk: true, racyCheckOk: true })
  });
  if (!res.ok) { console.error(`✗ ${client.clientName}: HTTP ${res.status}`); continue; }
  const data = await res.json();
  const status = data?.playabilityStatus?.status;
  if (status !== 'OK' || !data.streamingData) {
    console.error(`✗ ${client.clientName}: ${data?.playabilityStatus?.reason || status || 'unavailable'}`);
    continue;
  }
  const withUrl = [...(data.streamingData.formats || []), ...(data.streamingData.adaptiveFormats || [])].filter(f => f.url);
  const vids = withUrl.filter(f => /^video\/mp4/.test(f.mimeType || ''));
  const auds = withUrl.filter(f => /^audio\/mp4/.test(f.mimeType || ''));
  if (!vids.length || !auds.length && !data.streamingData.formats?.some(f => f.url)) {
    console.error(`✗ ${client.clientName}: OK but no usable mp4 streams (video:${vids.length} audio:${auds.length})`);
    continue;
  }
  // Prove the URL actually serves bytes (PO-token-gated URLs 403 here).
  const probe = await fetch(vids[0].url, { headers: { 'User-Agent': userAgent, Range: 'bytes=0-1023' } });
  if (!probe.ok) { console.error(`✗ ${client.clientName}: stream URL probe HTTP ${probe.status}`); continue; }
  await probe.arrayBuffer();
  console.log(`✓ ${client.clientName}: ${vids.length} video / ${auds.length} audio mp4 streams, sample URL serves bytes`);
  ok = true;
}

if (!ok) { console.error('\n✗ NO WORKING YOUTUBE CLIENT — the full-build YouTube download is broken.'); process.exit(1); }
console.log('\n✓ YouTube resolver smoke test passed');
