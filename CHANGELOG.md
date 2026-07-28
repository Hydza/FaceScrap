# Changelog

All notable changes to FaceScrap are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-07-28

### Added

- **The DASH merge moved in-repo.** `src/shared/mp4-remux.ts` replaces
  `ffmpeg.wasm`: it merges the video and audio tracks by copying their sample
  bytes and writing a new sample table around them — the same result
  `-c copy -shortest` gave, in ~30 KB instead of a 30.7 MB wasm core, and with
  no sample byte passing through JS. The unpacked extension went from 32.7 MB
  to ~806 KB, and `manifest.json` no longer grants `wasm-unsafe-eval`: there is
  no wasm left to compile.
- **A download button on the video itself**, overlaid on what is playing and
  switchable off in Settings, plus an `Alt+Shift+D` shortcut that downloads the
  current video without opening the panel.
- **Settings rebuilt** as a full-panel sheet, with keyboard navigation and drag
  selection across the card grid.
- **Diagnostics report.** The opt-in diagnostics switch now records an event log
  next to its counters: per GraphQL response the query name, its size and what
  was extracted from it (including HTTP failures and bodies dropped for size),
  classified fbcdn media requests, the video the detector settled on, what each
  navigation cleared, every download and remux outcome, and the uncaught errors
  of both the page and the extension's own contexts. A new **Export report**
  button in Settings → Advanced writes counters, log, settings and versions to
  one JSON file. Response bodies are never recorded and every URL is reduced to
  host + path before it is stored, so no fbcdn signature reaches the file.
  Bounded to 2 000 events / ~700 KB, and it reports its own truncation.
  `faceScrapDiag.log()` and `faceScrapDiag.report()` expose the same data from
  the service-worker console.

### Changed

- The side panel's colour and density were redesigned and 17 audited UI defects
  were fixed across it; the brand mark now comes from one SVG, which both the
  panel header and the generated toolbar PNGs read.

### Fixed

- **Every HD (DASH) download failed instantly.** Instrumenting the offscreen
  document added a `chrome.storage.onChanged` listener to it — but an offscreen
  document is given `chrome.runtime` and essentially nothing else, and
  `chrome.storage` is undefined there. The reference threw while the script was
  still evaluating, so the mux listener at the bottom of that file never
  registered: `FACESCRAP_MUX` reached no receiver, `sendMessage` resolved
  `undefined` in about a millisecond, and the worker reported the generic "Could
  not merge audio and video." Direct downloads were unaffected, which is what
  made it look like a Facebook-side problem. The offscreen document now receives
  the diagnostics flag on the mux request and returns its trace in the mux
  answer, using the one API it actually has. Found by reading the first exported
  report: 110 of 110 DASH downloads failed, all in under 2 ms, with zero events
  from the offscreen context.
- The content script's first diagnostic event (`contentReady`) was recorded
  without arming its report timer, so on an otherwise idle tab it never reached
  the worker — the trace read as if the content script had never started.
- **Long videos could not be remuxed at all.** Every output table carrying one
  entry per sample was spread into a variadic call, which throws a `RangeError`
  at around 62 000 arguments — a small fraction of the sample count this
  remuxer claims to handle. Those tables are now written in one allocation.
- **Negative composition offsets were written as ~4.29 billion.** A version-0
  `ctts` field is unsigned, so the negative offsets modern packagers emit by
  default placed frames four billion ticks away; the box is now emitted as
  version 1 whenever any offset is negative.
- A track with no sync samples at all was written with no `stss` box, which
  means the opposite — that every sample is a seek target.
- A track declaring more than one sample description is now refused outright,
  instead of being remuxed with every sample described by the first codec's
  parameters.
- **Resumed track downloads trusted whatever range they were sent.** A 206 says
  "a range", not "the range that was asked for": the `Content-Range` is now
  checked, and a mismatch restarts the track rather than producing a file
  longer than the original, which no later bounds check could have caught.
- Received bytes are sealed into `Blob`s as they arrive instead of being held
  as one growing list of `Uint8Array`, so a large track no longer keeps both
  tracks resident in the offscreen document's heap at once.

## [1.0.0] - 2026-07-24

Initial public release.

### Capture

- Facebook **reels, stories and highlights** captured from the media the tab
  is already playing: a passive MAIN-world GraphQL read, non-blocking
  `webRequest` observation of `*.fbcdn.net`, and a DOM-scan fallback.
- **Now Playing** tracks the video you are actually watching — on `/reel/<id>`
  and `/watch` pages by the URL's video id, elsewhere by the media centered in
  the viewport plus the tracks fbcdn is streaming right now, scored across a
  window so a background prefetch can't take the slot.
- DOM-proven marks are kept distinct from provisional tray-pinned fallbacks, and
  per-load video marks are epoch-scoped, so a page reload or a background
  prefetch can never pin the wrong video.

### Side panel

- Three views — **Now Playing**, **Library**, **Saved** — plus a full-panel
  **Settings** sheet, all in one consistent dark interface with a bundled
  Manrope display face, monospace metrics, and a persistent brand bar.
- Quality picker, per-card and multi-select downloads with a download tray,
  filename templates (`{source}`, `{date}`, `{id}`), a "FaceScrap/" subfolder,
  and an EN|ES language toggle.
- Preview framing and play-button placement adapt to each item's aspect ratio;
  every interactive control has hover feedback; panel theme follows the active
  Facebook tab, then the device, with a manual Light/Dark override.
- Optional diagnostics for discarded captures, with a bounded counter and a
  reset control.

### Downloads

- **HD (DASH) downloads with audio**: video and audio tracks are fetched and
  remuxed with `ffmpeg.wasm` (`-c copy -shortest`, no re-encode) in an
  offscreen document — the same approach yt-dlp uses.
- DRM (Widevine) streams are detected from the manifest and excluded; they
  cannot be decrypted by any extension.
- Track downloads are bounded and resumable, abort on stall rather than total
  time so large videos survive slow links, and are deduplicated only after a
  successful attempt completes.

### Reliability & security

- Acknowledged, bounded capture handoffs with explicit tab, document and
  navigation lifecycles; quota-aware session storage recovery that preserves
  active captures, saved items and control state.
- Size and count ceilings on page-hook input, captured media, diagnostics and
  downloaded tracks; non-Facebook CDN track URLs are rejected outright.
- Unit suite (`npm test`) covering the now-playing binding/rescue logic and
  mark provenance against a faithful `chrome.storage` fake; deterministic
  visual QA for every side-panel surface, layout and theme.

### Compatibility

- Feature-detected across Chromium browsers: a popup fallback where
  `chrome.sidePanel` is unavailable, video-only downloads where
  `chrome.offscreen` is unavailable, and a readable startup message if a
  required API is missing entirely.
- `color-scheme` so native scrollbars and selects match the dark UI on
  light-themed systems, `prefers-reduced-motion` support, and a one-column
  card grid on narrow panels.
