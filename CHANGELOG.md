# Changelog

All notable changes to Skool Video Downloader, newest first. Dates are the date
the version was tagged.

Every version ships in two builds from the same source: the **Chrome Web Store**
build and the **full (sideload)** build, which additionally includes YouTube
support the store can't accept. The store listing lags GitHub by however long
review takes, so the two channels can sit on different versions — the current
version of each is always shown at
<https://skoolvideodownload.com/updates>.

Keep this file updated as part of the release checklist in
[README.md](README.md#releasing): the entry here is the source the GitHub release
notes are written from.

## v1.3.3 — 2026-07-28

Stops the extension telling people their disk is full when it isn't.

A download that failed while handing the finished video to Chrome always
reported "your disk is out of space" — regardless of what had actually gone
wrong. Reports arrived contradicting themselves in a single sentence: needs
about 530 MB, 10.7 GB available. The real error was captured and then thrown
away, so those failures were undiagnosable.

- "Out of space" is now claimed only when the error really is a quota error, or
  the free space really is less than the video needs. Any other failure is
  reported as itself, and says plainly that disk space is not the problem.
- The failure message now points at the one step known to clear stale leftovers:
  fully quit and reopen Chrome. The extension purges its temporary storage on
  startup, which does what an in-session purge cannot.
- Both attempts' errors, the blob sizes, and the storage quota are written to the
  debug log, so the next report says what happened.
- Fixed the debug log dropping lines. Writes are read-modify-write on one key and
  two overlapping calls silently discarded one another — which is exactly how the
  cause of a failure got lost, every time, one tick before the failure itself was
  logged. Writes are now serialised, and a problem report waits for pending ones.
- Added the `unlimitedStorage` permission. Every save moves hundreds of megabytes
  through CacheStorage; there is no reason to do that against a shared quota.
- The retry after a purge now drops its handle to the old cache first. Chrome
  defers reclaiming a deleted cache while one is still live, so the retry could
  run against storage the purge had not actually freed.

## v1.3.2 — 2026-07-27

Fixes a save failure that showed up as `Save did not start @82%`.

The download and merge had actually succeeded — the extension gave Chrome only
8 seconds to start the save, then tore down the finished file. It now waits up to
90 seconds, polls Chrome's download list alongside the `onCreated` event (a
service worker evicted mid-wait misses the event entirely), and no longer
discards a save that is still in progress. `waitForDownloadEnd` had the same
defect one stage later and now extends, bounded, while the transfer is live.

- The error message names the likely culprits (download manager, antivirus,
  blocked automatic downloads) and says plainly that the download and merge
  succeeded, instead of a bare "Save did not start".
- Progress moves to 97% "saving" after the merge, so a slow hand-off to Chrome
  no longer looks like a freeze at 82%.
- Logs how long the item took and which path found it, so the next report tells
  slow apart from blocked.

Triage: [`docs/triage-2026-07-26-save-did-not-start.md`](docs/triage-2026-07-26-save-did-not-start.md)

## v1.3.1 — 2026-07-26

Fixes Vimeo lessons failing with `Vimeo config fetch failed (403)`. Two separate
faults were behind it:

- **Skool embeds Vimeo videos without their share link.** Vimeo needs the `?h=`
  hash for any video that isn't fully public, and Skool's embed builder drops it,
  so the video couldn't be read from its id alone. The hash is now recovered from
  the lesson data when it's there.
- **"Press play first" couldn't help.** Vimeo's player on Chrome streams DASH and
  the extension only watched for HLS, so pressing play produced nothing to
  capture. The stream is now picked up straight from the player — which covers
  private, unlisted and domain-restricted videos alike. Press play, let it start,
  then pick the entry labelled *Vimeo (from player)*.

Vimeo errors now say what's actually wrong instead of giving advice that can't
work, and problem reports record whether the share hash was available.

Triage: [`docs/triage-2026-07-26-vimeo-403.md`](docs/triage-2026-07-26-vimeo-403.md)

## v1.3.0 — 2026-07-25

**New checkout.** Purchases now go through Dodo Payments instead of Freemius.
Same prices ($9.99/month or $99.99 once), but the licence key arrives both by
email and on a confirmation page, so nobody waits on an inbox. Keys bought
before this release keep working permanently — that's a fallback, not a grace
period.

**Monthly → lifetime.** Activating a lifetime key while on monthly now cancels
the monthly for you. If that cancellation doesn't go through, the popup says so
and links to the cancel page instead of leaving a surprise charge.

**Licence messages that say what's actually wrong.**

- "All of its allowed installs are in use" now says that, instead of "invalid or
  expired licence key" — a customer read the old wording and reasonably concluded
  his lifetime licence had expired. A slot is used per *install*, so reinstalling
  consumes one; support frees them on request.
- A cancelled or lapsed subscription says so, and a key belonging to one of our
  other extensions is recognised and refused clearly.

**Fixes**

- A licence-server hiccup no longer knocks you back to the free plan: the 24-hour
  re-check treated "couldn't reach the provider" as "invalid" and removed the
  licence. It now keeps the plan and retries.
- Licence keys are no longer upper-cased before validation, which silently broke
  keys containing lowercase characters.

## v1.2.0 — 2026-07-23

**Free video-only and audio-only downloads.** Two new buttons in the quality
picker save a single rendition with no merge and don't count against the weekly
free downloads. If the machine can't merge at all (older CPUs and VMs lack an
instruction set Chrome needs) the extension now says so up front and points at
these buttons, instead of downloading everything and failing at 82%.

**Fixes**

- `Failed to execute 'put' on 'Cache'` — what Chrome reports when it can't write
  the finished video to disk. Leftover data from cancelled downloads was a likely
  cause and was only cleared on browser restart; it's now cleared and retried
  automatically, and a genuine out-of-disk says so with real numbers.
- HTTP 429 mid-download now produces a plain-English "wait a few minutes" instead
  of a status code; 403 tells you to reload the lesson and press play again.
- Downloads that error no longer leave stale buttons from the previous video.

**Pricing.** Annual is gone — monthly or lifetime only, and lifetime is a proper
card in the upgrade screen rather than a small text link.

**Other.** German, Spanish (ES + LatAm), French and Portuguese now cover
everything in this release. Corrected a long-standing false claim in the UI:
downloads run **one at a time**, not three at once — that's what keeps Skool's
CDN from rate-limiting you.

## v1.1.8 — 2026-07-22

Fixes Loom downloads dying mid-way with `Segment fetch failed: HTTP 504`.
Transient CDN errors (504/502/500/408) and dropped connections are retried with
backoff instead of killing the whole download. Also surfaces the real reason
behind `Merge failed`, which previously showed no detail in error reports.

## v1.1.7 — 2026-07-22 (withdrawn)

Dropped the unused `tabs` permission to clear a Chrome Web Store rejection.
Never tagged or released on its own — superseded by v1.1.8 the same day.

## v1.1.6 — 2026-07-21

Fixes downloads failing partway with `Segment fetch failed: HTTP 403`.

The extension attaches a Referer/Origin header rule so Skool's CDN accepts its
segment requests. That rule was keyed off the browser tab, so two downloads
started from the same tab shared one rule and whichever finished first deleted it
out from under the other — the survivor's next segment went out bare and was
rejected.

- Header rules are now per-download.
- Downloads run one at a time; running several in parallel hammered the same CDN
  edge, which is what the v1.1.5 rate-limit fix was working around. Queued items
  still show in the manager.
- Problem reports record the video token's expiry and the percentage a download
  failed at, so a stale token and a header problem can be told apart.

## v1.1.5 — 2026-07-20

Fixes Skool (Mux) segment downloads failing with HTTP 429 — Fastly was
rate-limiting bursts of 20 concurrent segment requests. Now retries with backoff
on 429/503 (honoring `Retry-After`) and fetches in smaller batches.

## v1.1.4 — 2026-07-20

- Detected videos survive Chrome suspending the MV3 background worker —
  previously the popup could show "no videos" on native Skool lessons until a
  full page reload.
- UI and store listing localized across 15 locales.
- Problem reports record free-tier limit state for faster support triage.

## v1.1.3 — 2026-07-14

Licence housekeeping and a licensing-check fix: a hand-set paid tier is no longer
kept across revalidation. Added the source-available [LICENSE](LICENSE) — the
code is public for transparency; redistribution and modified builds are not
permitted.

## v1.1.2 — 2026-07-14

Private and embed-only Loom videos now download from the stream captured when you
press play inside Skool, with no loom.com access needed. Open the lesson, press
play for a second, then use the extension.

## v1.1.1 — 2026-07-14

Fixes Loom downloads. Loom changed how it serves videos: the transcoded-URL
endpoint started returning 204, and the CloudFront signature query was being
dropped between the master playlist and its variants/segments, so every request
came back 403. The signature is now inherited through the whole HLS chain.

A private Loom video may still need you signed in at loom.com — open it there
once, then retry in Skool.

## v1.1.0 — 2026-07-12

YouTube videos in Skool lessons now hand off to a guided one-command download.
YouTube's 2025–26 server-side changes (SABR) block in-browser YouTube downloads
for every extension; clicking a YouTube video opens
<https://skoolvideodownload.com/youtube> with the link pre-filled and a hosted
installer for a standalone yt-dlp. Skool, Loom, Vimeo and Wistia downloads are
unchanged and still fully in-browser.

## v1.0.0 — 2026-07-05

First release. In-browser HLS → MP4 downloads for Skool lessons and the players
Skool embeds (Loom, Vimeo, Wistia, YouTube), merged locally with ffmpeg.wasm —
nothing leaves the machine. You must already have access to the content; this
does not bypass paywalls, logins, or DRM.
