# Skool Video Downloader

Save your Skool course videos as MP4 — Skool-native lessons plus Loom, Vimeo,
Wistia, and YouTube embeds. Everything is processed locally in your browser; no
files pass through any server.

This is the **full version**, installed manually (sideloaded). The Chrome Web
Store edition doesn't include YouTube support, because the store's rules don't
allow extensions to save videos from YouTube. If you need that, use this build.

## Demo

Watch the full walkthrough: https://www.youtube.com/watch?v=MfELQ1Y3vv4

## Install (Chrome / Edge / Brave)

1. Download the latest `skool-video-downloader-full-vX.Y.Z.zip` from the
   [Releases](../../releases) page and unzip it.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the unzipped folder.
5. Pin the amber arrow icon and open any Skool lesson to start.

## Notes & limits

- You must already have access to the content — this does not bypass paywalls,
  logins, or DRM.
- Press play on a video first so the extension can detect it.
- Quality is whatever the source provides. Live streams aren't supported.
- Desktop Chromium browsers only (no mobile / Safari).

## Building from source

The extension source is in this repo. `scripts/build.mjs` produces both the
sideload build (this one) and the Chrome Web Store build (YouTube stripped):

```bash
node scripts/build.mjs   # → dist/*.zip
```

### Releasing

```bash
# 1. bump "version" in manifest.json
# 2. add the version's entry at the top of CHANGELOG.md
node scripts/build.mjs
git commit -am "vX.Y.Z: ..." && git push
gh release create vX.Y.Z dist/skool-video-downloader-full-vX.Y.Z.zip \
  --title "vX.Y.Z — full (sideload) build" --notes-file <(...)   # from CHANGELOG.md
node scripts/publish-version.mjs          # ← tells existing users an update exists
```

`CHANGELOG.md` is the single place a release is described in customer-facing
words; the GitHub release notes are written from it, not the reverse. Write it
before tagging — reconstructing it later from commit messages loses the "what
this meant for the user" half, which is the part support actually needs.

The `publish-version.mjs` step is not optional. The popup's update banner and
the /updates page both read their version from the Worker's KV config, so
skipping it means every sideload user is told they are current no matter how
many releases have shipped.

The Chrome Web Store zip is a separate manual upload to the dashboard. Once
that listing is actually **live** (not just submitted), publish its version too:

```bash
node scripts/publish-version.mjs --cws X.Y.Z
```

Never run `--cws` ahead of the store — it banners users about a build they
cannot install yet.

## Support

Questions or issues → https://skoolvideodownload.com/skool-video-downloader

## License

Source-available, not open source: the code is public for transparency so you
can verify what the extension does, but all rights are reserved — no
redistribution, no modified/derivative versions, no removing license checks.
See [LICENSE](LICENSE). Use the official builds from
[Releases](https://github.com/heyitsR1/skool-video-downloader/releases).
