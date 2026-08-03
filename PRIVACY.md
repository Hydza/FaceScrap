# FaceScrap Privacy Notice

- **Español:** [PRIVACY.es.md](PRIVACY.es.md)
- **Last updated:** August 2, 2026
- **Maintainer:** Hydza

This notice describes how FaceScrap 1.0.2 handles information when installed as an unpacked
browser extension. FaceScrap runs in the browser and does not require a FaceScrap account.

## Information handled by the extension

FaceScrap processes the information needed to identify, display, and download supported media
from Facebook pages that the user visits:

- Media addresses and related metadata exposed by the page, its responses, or media requests.
- The active tab identifier, page location, playback state, and temporary capture state.
- Extension preferences, including language, appearance, download behavior, and shortcuts.
- Local diagnostic counters and events such as query names, result counts, status codes, and
  sanitized resource paths.
- An optional panel background selected by the user.

The extension has access to Facebook pages and `fbcdn.net` resources because those host
permissions are required for capture and download features. It does not request access to other
website hosts in the extension manifest.

## Storage and retention

FaceScrap uses browser-managed extension storage:

- `chrome.storage.session` holds captures, saved-item receipts, and other per-tab state for the
  browser session.
- `chrome.storage.local` holds preferences, language, diagnostics, and an optional panel
  background. This data may remain across browser restarts until it is cleared or the extension
  is removed.
- Files downloaded by the user and exported diagnostic reports are written through the browser
  to the selected download location. They remain outside extension storage until the user
  deletes them.

Diagnostic storage is bounded in the current release. Its formatter is designed to omit response
bodies, request headers, cookies, and signed resource query values. Users should still review any
report or screenshot before attaching it to a public issue.

## Network activity and disclosure

The current extension code does not include a project-operated analytics, advertising, or
telemetry endpoint. It observes requests made by Facebook pages and may request selected media
from `fbcdn.net` when the user starts a download. Browser and Facebook services process those
requests under their own terms and privacy notices.

FaceScrap does not include code that sells extension data or forwards it to a server operated by
the project. Information a user voluntarily places in a repository issue, discussion, or security
report is handled by the hosting service and becomes subject to the visibility selected there.

## User controls

Users can clear captures for the active tab, change or reset preferences, remove a custom panel
background, and uninstall the extension through the browser. Uninstalling does not delete files
already saved to the Downloads folder or copies of reports shared elsewhere.

## Changes and questions

This notice may be updated when the extension's permissions or data handling change. Material
changes should accompany the release that introduces them. For a privacy question, open a
[repository issue](https://github.com/Hydza/FaceScrap/issues) without including private data. For
a sensitive security matter, follow [SECURITY.md](SECURITY.md).
