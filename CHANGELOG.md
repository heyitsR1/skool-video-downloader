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

## 1.5.0 — 2026-08-04

### Added
- **Download an entire course.** Back up every lesson you already have access to
  in one run — videos, lesson notes as Markdown, and attached files — organised
  into a folder per course and module.
- Runs in the background: close the popup, keep browsing, come back to a summary.
- Pause and resume any time, including after restarting your browser. Finished
  lessons are never downloaded twice. To fetch a course again from scratch — for
  instance after deleting some of it — use **Re-download everything**; Chrome
  does not tell an extension that a saved file was removed, so a normal re-run
  cannot notice on its own.
- Lessons your account cannot open yet are skipped and listed when the run
  finishes, so you always know exactly what you got.
- Courses whose modules each hold a single lesson are saved as a flat list
  rather than a folder per file, named after the module you clicked.
- YouTube-hosted lessons are collected into `_youtube-lessons.txt` for the
  download guide, since they cannot be saved in the browser.
- Every run writes `_download-log.txt` in the course folder, listing each lesson
  and what was saved, skipped or failed for it — including lessons that produced
  no file. Send it with a problem report if something looks missing.

## 1.4.0 — 2026-08-01

### Removed
- **Dodo Payments.** Dodo's compliance team ruled this product outside their
  Merchant Acceptance Policy on 2026-07-27 and terminated every subscription
  they had sold for it. The whole integration is gone: the two-processor
  activation dispatch, the provider-shaped revalidation, the checkout links and
  the `DODO_MODE` switch. Freemius is the only processor again, as it was before
  v1.3.0.

### Changed
- The nine subscriptions sold in the Dodo window (2026-07-26 → 2026-07-30) are
  carried by dated grants in the licensing Worker that run to one month past
  each purchase — the month those customers actually paid for. They keep working
  until then and lapse normally afterwards, rather than being cut off the moment
  the Dodo code was deleted.
- A licence key too long to be a Freemius key is now answered from those grants
  instead of being sent to a processor that no longer exists.

### Fixed
- Buying the lifetime plan while on a monthly subscription now cancels the
  monthly one whichever processor issued it. The check required the new licence
  to have come from Dodo, so removing Dodo would have made it dead code and
  quietly left upgraded customers paying twice.

## v1.3.9 — 2026-08-01

A Vimeo lesson is one row again, and a cancelled save says it was cancelled.

**The Vimeo entry that works is the one you're offered.** A played Vimeo lesson
was listed twice: once found in the page, once captured from the player. Only
the captured one can download a video whose share link Skool's embed builder
dropped — and the other one was the entry wearing the lesson title, the "on this
page" badge and the top of the list, because those are matched by a video id
only it carries. So the natural thing to click was the entry that could only
answer 403, and the error told you to press play and reopen the menu, which is
exactly what had already produced the working entry underneath it.

The two are now recognised as the same video — the player's own frame is what
ties the captured stream to the embed it came from — and merged into a single
row that downloads through the captured stream. Where that link can't be made,
a Vimeo entry that fails now falls back to the captured stream by itself rather
than handing you an error; if the page holds several, the message names the
entry to use instead of repeating advice you've already followed.

**Save failures name the real reason.** Every failed hand-off to Chrome reported
that a download manager was probably intercepting downloads — including the one
case that has nothing to do with one. Saves go through Chrome's own download
list, so if you have "Ask where to save each file" turned on and close that
window, the save is cancelled and you were sent hunting for an IDM install you
don't have. A cancelled save now says so and points at the setting; no space,
no write permission, antivirus blocks and a too-long filename each say what they
are. The raw reason from Chrome stays attached for support.

**Problem reports say which build they came from.** Reports now carry `full` or
`cws` and, when the copy is out of date, the version it should be on. Nearly
every report we receive turns out to be a build from weeks ago — the Chrome Web
Store copy updates itself, the hand-installed one does not — and there was no
way to tell the two apart, or to tell a customer who never saw an update banner
from one who ignored it.

**Also:** the update check now knows the Chrome Web Store is on 1.3.8. It had
been left at 1.3.2 since the store listing went live, so store customers were
told they were current while six releases of fixes sat unshipped to them.

**Also:** the licence box shows the shape of a key you actually have. Its
example was a hyphenated UUID left over from the six weeks this extension sold
through Dodo Payments — every key we issue now looks like `sk_…`, so the hint
was quietly telling customers their real key was the wrong one.

New in the repo: [`docs/BUG-LOG.md`](docs/BUG-LOG.md) indexes every error
message this extension has been reported for against the version that fixed it,
and `scripts/background-smoke.mjs` pins the four behaviours above.

## Server-side — 2026-07-31

**Licences stopped silently running out of activations.** This is a change to
the `skool-dl-license` Worker only. There is no new extension version and
nothing to install — every already-installed copy, of every version, is fixed
the moment the Worker is deployed.

If your key had stopped working, or the extension had dropped back to the free
tier on its own, this was why.

**What was happening.** Freemius accepts a device identifier (`uid`) when a
licence is activated and does not store it — verified against their live API:
activating twice with a byte-identical uid produces two separate installs, and
reading the install back reports `uid: null`. Nothing was idempotent, so *every*
activation attempt permanently consumed one of the licence's activation slots.

The extension revalidates a licence once every 24 hours, and that check was
routed through the same activation endpoint. So each customer quietly spent one
activation slot **per day**, forever, just by leaving the extension installed.
Against the old five-slot quota, a paying customer locked themselves out within
about four days of ordinary use — holding a licence that was perfectly valid.
Clicking "Activate license" more than once did the same thing, faster.

- **The daily revalidation no longer consumes anything.** It is now a read: it
  asks whether the licence is cancelled or expired and nothing else. It cannot
  create installs, because it no longer calls the activation endpoint at all. A
  regression test fails the build if it ever does again.
- **Re-activating on a device that already has the licence is free.** Installs
  now carry a device tag the API actually persists, so a repeat activation finds
  the existing install instead of minting another. Clicking Activate five times
  costs one slot instead of five.
- **A cancelled or expired licence is still refused.** Skipping the activation
  call must not skip the refusal, so entitlement is checked explicitly before
  any device is let through on a re-activation.
- **A licence lookup that fails is never treated as a revocation.** An
  unreachable provider, or a search that returns nothing, keeps the customer
  paid — the same guarantee the Dodo path has always had.

Fixed slot accounting is not retroactive: slots consumed by the daily leak
before this deploy are still held by junk installs and have to be released
per-licence. Quotas were raised in the meantime.

## v1.3.8 — 2026-07-30

Downloads that hit Skool's rate limit now wait it out instead of dying, and the
error you get when something does go wrong finally says something useful.

Two problem reports showed a download failing at 8% and 12% with the message
"Failed to fetch" — Chrome's own wording for a connection that dropped, which
had been reaching the screen untranslated. The reports also showed what caused
it: four large downloads back to back, then every request to Skool's video
server crawling and then failing. That is rate-limiting. The extension already
recognised rate-limiting when the server *answered* with an HTTP 429, but a
server that copes by silently dropping connections instead produced a raw
network error that bypassed all of that handling.

- **A throttled download now pauses instead of failing.** When the connection
  keeps dropping, the download holds everything it has already fetched and
  retries after 1 minute, then 2, then 4. The queue shows a countdown and the
  percentage it is holding. Previously the job ended and every downloaded
  segment was discarded — in one of these reports, seven minutes of transfer
  thrown away at 8%.
- **Dropped connections get the same advice as HTTP 429**, in plain language,
  instead of "Failed to fetch".
- **Stalled connections are detected.** A request that connects and then
  delivers nothing used to hang forever, freezing the whole batch behind it;
  those are now given 45 seconds and retried.
- **Much more patience for dropped connections.** They previously got five
  attempts across about 8 seconds, which never outlasts a real throttle.
- **Cancel works during all of the above.**
- **Fix: expiry timestamps in problem reports now show the date.** Skool's video
  links last 24 hours, but the log printed the time of day only, so a link
  valid until tomorrow at 21:01 sat next to a 21:00 failure and looked like it
  had just expired. This one cost real time during triage.

## v1.3.7 — 2026-07-28

Checkout moves back to Freemius. Nothing else about the extension changes.

Dodo Payments, the processor introduced in v1.3.0, notified us on 2026-07-27
that this product falls outside their Merchant Acceptance Policy and asked us to
stop selling through them. The Buy buttons therefore point at Freemius again —
the same checkout every customer used before v1.3.0.

**If you bought a licence between v1.3.0 and v1.3.6, nothing changes for you.**
Your key still activates, still revalidates, and still carries whatever tier you
paid for. Both processors are accepted permanently; the licence server decides
which one to ask from the shape of the key you type, so neither era of key can
be mistaken for the other. There is nothing you need to do.

## v1.3.6 — 2026-07-28

Hardening ahead of the Chrome Web Store release of this work.

The pre-download size check added in v1.3.5 refused any video whose length it
couldn't measure. That's the wrong default: it trades a rare bad file for
blocking working downloads on any CDN that answers neither a HEAD nor a ranged
request. The check is an optimisation — it moves a known failure ahead of a long
download — and the size guard at save time, which sees the real bytes, remains
the actual safety net. Unmeasurable videos now proceed.

## v1.3.5 — 2026-07-28

Makes private Loom lessons download from one obvious button, and fixes a
regression v1.3.4 introduced.

**A captured video is used again.** v1.3.4 started recording the Loom id on
videos captured from the player so the popup could name them — and that
inadvertently sent those captures back through Loom's API, the exact path the
capture exists to avoid. Pressing play no longer helps if the extension then
ignores what it caught. A captured stream is now always preferred over an API
lookup.

**One row per video, not two.** A Loom lesson could appear twice: once found on
the page, once captured from the player. Only the second one works for videos
private to a classroom, and nothing told you which was which. They are now a
single entry that uses whichever source can actually fetch the video.

**Failures happen before the wait, not after it.** Loom answers for videos it
won't serve with a token-sized stub — one customer received 24,877 bytes after a
long download. The size is now checked before anything is offered for download,
and the message says what actually fixes it: press play on the lesson in Skool,
then download.

## v1.3.4 — 2026-07-28

Stops the extension saving files that have no video in them, and makes a page
full of Loom lessons possible to tell apart.

A download that came back empty was saved anyway. Nothing in the pipeline ever
checked how big the result was, so an unreachable video, a placeholder response
or a stream that died early all produced a file that opened as a 00:00:00 track
with no picture — and the extension reported success. Reported by a customer
whose player showed exactly that.

- A transfer that ends before the server's `content-length` is now a failure, not
  a silent truncation. That length was previously read only to drive the progress
  bar.
- A result too small to be a video is refused with a message that says what to do
  instead: press play on the lesson in Skool, then download. Going through the
  player is what makes private Loom embeds resolvable.
- ffmpeg exiting successfully having written an empty file is caught too.
- The debug log now records how many bytes were handed to Chrome, so "the file
  won't open" is answerable from a report instead of by inference.

Wire capture picks up every Loom the page requests, not only the one on screen,
so a module could list six rows all reading "Loom" with no way to choose.

- The lesson on screen is now matched to its row by video id, labelled with the
  lesson title, badged "on this page", and sorted to the top.
- Any other untitled rows carry a short id suffix, so they are at least distinct
  from one another.

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
