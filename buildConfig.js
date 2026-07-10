// Build-time flags for Skool Video Downloader.
//
// This file is the single source of truth for the difference between the two
// distributions. scripts/build.mjs rewrites the flag below when producing each
// artifact:
//   • true  → full build (sideloaded from GitHub) — YouTube downloading works.
//   • false → Chrome Web Store build — YouTube downloading is removed and the
//             popup shows the policy notice instead.
//
// Committed value is `true` (the repo IS the full/GitHub build). The popup reads
// this via `self.SVD_CONFIG` and fails closed to the CWS-safe behaviour if the
// flag is ever missing.
//
// CHANNEL names the distribution ('full' = GitHub sideload, 'cws' = Chrome Web
// Store) so the update check compares against the right latest version — the
// two channels ship on different schedules (CWS review lag).
self.SVD_CONFIG = { YT_DOWNLOAD_ENABLED: true, CHANNEL: 'full' };
