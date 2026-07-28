// FaceScrap service worker.
// - Observes fbcdn media requests (video/audio streams) via non-blocking
//   webRequest and records candidates per tab.
// - Receives media found by the content script / MAIN-world page hook.
// - Orchestrates DASH remux via an offscreen document (see mp4-remux.ts).
// - Keeps the toolbar badge in sync and cleans up per-tab state.
//
// Service workers are ephemeral: do minimal synchronous work in listeners and
// persist immediately. Never keep capture state in module-scope variables.

import { diagBump, diagDrain, setDiagEnabled } from '../shared/diag';
import {
  addMedia,
  clearTab,
  setFacebookTheme,
  purgeTab,
  setCaps,
  setPlayingMediaPin,
  setRecent,
} from '../shared/storage';
import { ensureCaptureHeadroom } from '../shared/session-write';
import { addSaved, SAVED_ID_MAX, SAVED_LABEL_MAX, SAVED_THUMB_MAX, type SavedEntry } from '../shared/saved';
import { addDiagCounters, getDiagCounters, resetDiagCounters } from '../shared/diag-store';
import {
  classifyNetworkRequest,
  DASH_BYTE_RANGE_RE,
  isFbcdn,
  MAX_MEDIA_BATCH_BYTES,
  MEDIA_KINDS,
  MEDIA_SOURCES,
  mediaSourceFromLocation,
  sanitizeIncomingItems,
  type MediaSource,
} from '../shared/media';
import { forgetVideoGroupMemory } from '../shared/now-playing';
import {
  type DownloadDirectMsg,
  type DownloadDirectResponse,
  type RuntimeMessage,
} from '../shared/messages';
import { facebookThemeRefAtReceipt } from '../shared/theme';
import { hasOffscreen, hasSidePanel } from '../shared/capabilities';
import { createSettingsMessageHandler, loadSettings } from '../shared/settings';
import { createDiagObserver } from './diag-observer';
import { createBindingMessageHandler } from './binding-handler';
import { createContentScriptRecoveryCoordinator } from './content-script-recovery';
import { downloadDash, downloadDirect } from './dash-download';
import { createPlayingDownloadHandler } from './playing-download';
import { createShortcutHandler } from './shortcut-download';
import { persistNowPlayingMessage } from './playing-handler';
import { createRecentObserver } from './recent-observer';
import {
  ClosedTabError,
  NavigationPendingError,
  StaleDocumentError,
  StaleTabEpochError,
  createTabLifecycle,
} from './tab-lifecycle';

// 0. Open the UI on toolbar click, adapting to the browser. sidePanel is
//    Chrome/Edge only; where it is missing (Opera/forks) fall back to opening the
//    SAME sidepanel.html as a toolbar popup. hasSidePanel() guards the property
//    access so this never throws at SW eval on a browser without the API.
if (hasSidePanel()) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error('[FaceScrap] setPanelBehavior', e));
  // Clear any stale popup (e.g. after a browser update) so it can't shadow the panel.
  chrome.action.setPopup({ popup: '' }).catch(() => {});
} else {
  chrome.action.setPopup({ popup: 'sidepanel/sidepanel.html' }).catch((e) => console.error('[FaceScrap] setPopup', e));
}

// Establish the global storage reserve before any capture write. The promise is
// reused by listeners below, so a first request cannot race worker startup.
const captureStorageReady = ensureCaptureHeadroom().then((ok) => {
  if (!ok) console.error('[FaceScrap] capture storage started without guaranteed control headroom');
});

// Publish detected capabilities so the side panel/popup can degrade gracefully.
void captureStorageReady
  .then(() => setCaps({ sidePanel: hasSidePanel(), offscreen: hasOffscreen() }))
  .catch(() => {});

// Diagnostics are opt-in at BOTH trust boundaries. Renderer reports are
// accumulated in memory and persisted at most once per interval; the worker's
// own counters join the same write instead of causing a second storage update.
const diagObserver = createDiagObserver({
  write: addDiagCounters,
  workerCounters: { drain: diagDrain, setEnabled: setDiagEnabled },
  onError: (error) => console.error('[FaceScrap] diagnostic flush failed', error),
});

function refreshDiagSetting(): void {
  void loadSettings().then((settings) => diagObserver.setEnabled(settings.diagEnabled));
}
refreshDiagSetting();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'settings' in changes) refreshDiagSetting();
});

// Diagnostics from the worker console ("Inspect views: service worker" on
// chrome://extensions) — reachable without opening the panel, which matters
// when the question is why the panel is showing nothing.
(globalThis as { faceScrapDiag?: unknown }).faceScrapDiag = {
  async dump(): Promise<Record<string, number>> {
    await diagObserver.flush(); // include renderer + worker counts not yet flushed
    const counters = await getDiagCounters();
    console.table(counters);
    return counters as Record<string, number>;
  },
  reset: (): Promise<void> => resetDiagCounters(),
};

// 0b. FaceScrap only operates on Facebook. Keep the toolbar action + side panel ENABLED
//     on facebook.com tabs and DISABLED everywhere else, so on any other site the
//     extension is inert: the icon is greyed and unclickable and the panel can't
//     open. tab.url is exposed only for host-permitted origins even without the
//     "tabs" permission, so its absence already means "not our site"; we also
//     require a facebook.com host (an fbcdn.net media tab is host-permitted but is
//     not a UI surface).
const FB_URL = /^https?:\/\/([^/]+\.)?facebook\.com(?:[/?#]|$)/i;

// Last-seen viewer surface per tab, so network captures are labeled with what
// the user is actually browsing (reel/story) instead of a flat "video". Unlike
// capture state, this is derived and self-healing: a SW restart only costs
// label precision until the next navigation or tab activation re-derives it.
const tabSurface = new Map<number, MediaSource>();

const contentScriptRecovery = createContentScriptRecoveryCoordinator({
  queryFacebookTabs: () => chrome.tabs.query({ url: ['*://*.facebook.com/*'] }),
  ping: async (tabId) => {
    try {
      const response = await chrome.tabs.sendMessage(
        tabId,
        { type: 'FACESCRAP_CONTENT_PING' },
        { frameId: 0 },
      ) as { ok?: unknown };
      return response?.ok === true;
    } catch {
      return false;
    }
  },
  inject: async (tabId, file) => {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: [file],
    });
  },
  onError: (tabId, error) => console.warn(`[FaceScrap] content recovery failed for tab ${tabId}`, error),
});

// Chrome treats an unpacked reload as an update, and public updates invalidate
// the chrome.* context of detectors already living in open Facebook tabs. Ping
// first, then restore only tabs whose receiver is gone.
chrome.runtime.onInstalled.addListener((details) => {
  // A first install has no old MAIN-world page hook, so use the normal entry.
  // Updates retain that hook in the page and use the recovery entry to avoid
  // stacking another pair of fetch/XHR wrappers around it.
  const file = details.reason === 'update' ? 'content-recovery.js' : 'content.js';
  void contentScriptRecovery.recover(file).catch((error) => {
    console.warn('[FaceScrap] content recovery failed', error);
  });
});

// Classification itself is shared with the page hook and content script
// (mediaSourceFromLocation, same precedence in all three so they can never
// drift apart); this wrapper only adds the host check and URL parse a bare
// location classifier can't do for itself. The query goes along with the path:
// a profile highlight is a /stories/ permalink whose only highlight marker is
// ?source=profile_highlight.
function surfaceOf(url: string | undefined): MediaSource {
  if (url == null || !FB_URL.test(url)) return 'video';
  try {
    const parsed = new URL(url);
    return mediaSourceFromLocation(parsed.pathname, parsed.search);
  } catch {
    return 'video'; // unparseable — keep the default
  }
}

function gateTab(tabId: number, url: string | undefined): void {
  const onFb = url != null && FB_URL.test(url);
  tabSurface.set(tabId, surfaceOf(url));
  if (onFb) chrome.action.enable(tabId).catch(() => {});
  else chrome.action.disable(tabId).catch(() => {});
  chrome.action.setTitle({ tabId, title: onFb ? 'FaceScrap' : 'FaceScrap — only works on Facebook' }).catch(() => {});
  if (hasSidePanel()) {
    chrome.sidePanel
      .setOptions(onFb ? { tabId, path: 'sidepanel/sidepanel.html', enabled: true } : { tabId, enabled: false })
      .catch(() => {});
  }
}

function gateAllTabs(): void {
  chrome.tabs
    .query({})
    .then((tabs) => {
      for (const t of tabs) if (typeof t.id === 'number') gateTab(t.id, t.url);
    })
    .catch(() => {});
}

// Disabled by DEFAULT (a fresh/unseen tab stays inert until proven to be on
// Facebook), then flip the currently-open tabs to their correct state.
chrome.action.disable().catch(() => {});
if (hasSidePanel()) chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});
gateAllTabs();
chrome.runtime.onStartup.addListener(gateAllTabs);
chrome.runtime.onInstalled.addListener(gateAllTabs);
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs
    .get(tabId)
    .then((tab) => gateTab(tabId, tab.url))
    .catch(() => {});
});

// Tabs closed this session. A capture event (webRequest or a content-script
// message) already in flight when a tab closes can otherwise be handled AFTER
// purgeTab's removal and resurrect media_/playing_/recent_<tabId> as an orphan
// key that nothing will ever clean up again (Chrome doesn't reuse tab ids in a
// session). Skipping known-dead tabs at every write entry point closes that.
const tabLifecycle = createTabLifecycle(captureStorageReady);
const handleBindingMessage = createBindingMessageHandler(tabLifecycle);
const handleSettingsMessage = createSettingsMessageHandler();
const handlePlayingDownload = createPlayingDownloadHandler({
  isDead: (tabId) => tabLifecycle.isDead(tabId),
  isFacebookUrl: (url) => FB_URL.test(url ?? ''),
  persistReceipt: (tabId, receipt) => persistCompletedDownload(tabId, receipt),
});

// The global keyboard shortcut. Its logic lives in shortcut-download.ts so a test can drive it
// without evaluating this whole module; here it is only wired to the browser.
//
// Guarded down to addListener, not just the namespace: a fork that ships chrome.commands without
// onCommand would throw at module scope and take every capture and download with it, for a
// shortcut nobody pressed.
chrome.commands?.onCommand?.addListener?.(
  createShortcutHandler({
    // tabs.query rejects when there is no last-focused window — every window minimised, or the
    // shortcut arriving as the last one closes.
    activeTab: async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []))[0],
    run: handlePlayingDownload,
    report: (tabId, message) => void chrome.tabs.sendMessage(tabId, message).catch(() => {}),
    onError: (error) => console.warn('[FaceScrap] shortcut download failed', error),
  }),
);

function chromeDocumentIdentity(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 128 ? `chrome:${raw}` : undefined;
}

function contentDocumentIdentity(sender: chrome.runtime.MessageSender, token: unknown): string | undefined {
  if (sender.frameId != null && sender.frameId !== 0) return undefined;
  // 'prerender' is a legitimate, stable document: Chrome prerenders omnibox
  // navigations to facebook.com before the user commits, and the document's
  // id does not change when it later activates. Rejecting it here used to
  // make every handler's early-return answer retryable:false, which the
  // content script treats as permanent and tears itself down over, leaving
  // the tab capture-dead once the prerendered page went live. Only a document
  // that is truly gone (bfcache eviction / pending deletion) still must be
  // rejected.
  if (
    sender.documentLifecycle != null &&
    sender.documentLifecycle !== 'active' &&
    sender.documentLifecycle !== 'prerender'
  ) {
    return undefined;
  }
  const browserIdentity = chromeDocumentIdentity(sender.documentId);
  if (browserIdentity != null) return browserIdentity;
  return typeof token === 'string' && token.length >= 8 && token.length <= 128 ? `content:${token}` : undefined;
}

function isExpectedLifecycleStop(error: unknown): boolean {
  return error instanceof ClosedTabError || error instanceof StaleDocumentError || error instanceof StaleTabEpochError;
}

type ContentAck = { ok: true } | { ok: false; retryable: boolean; error: string };

/** The sender could not be identified, or its tab is already gone. Permanent: the
 *  content script tears itself down rather than retry into a dead context. */
const INVALID_SENDER: ContentAck = { ok: false, retryable: false, error: 'Invalid or closed sender tab.' };

/**
 * Map a lifecycle rejection to the retry contract the content script acts on. One
 * decision for every capture message — three copies of this drifted apart once.
 *
 * A closed tab or a replaced document is permanent. A pending navigation is worth
 * retrying. A stale tab EPOCH acks ok: the document that would do the retrying is
 * already gone, so answering retryable:false would only make it tear itself down
 * over evidence that was never wrong.
 */
function lifecycleAck(err: unknown): ContentAck {
  if (err instanceof StaleTabEpochError) return { ok: true };
  return {
    ok: false,
    retryable:
      err instanceof NavigationPendingError ||
      !(err instanceof ClosedTabError || err instanceof StaleDocumentError),
    error: err instanceof Error ? err.message : String(err),
  };
}

function sanitizeDownloadFilename(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 240 || /[\\:*?"<>|\r\n]/.test(raw)) return undefined;
  const parts = raw.split('/');
  return parts.some((part) => part.length === 0 || part === '.' || part === '..') ? undefined : raw;
}

function sanitizeDownloadReceipt(raw: unknown): SavedEntry | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const receipt = raw as Record<string, unknown>;
  if (
    typeof receipt.id !== 'string' ||
    receipt.id.length === 0 ||
    receipt.id.length > SAVED_ID_MAX ||
    typeof receipt.kind !== 'string' ||
    !MEDIA_KINDS.has(receipt.kind) ||
    typeof receipt.source !== 'string' ||
    !MEDIA_SOURCES.has(receipt.source)
  ) {
    return undefined;
  }
  const clean: SavedEntry = {
    id: receipt.id,
    kind: receipt.kind as SavedEntry['kind'],
    source: receipt.source as SavedEntry['source'],
    // The durable receipt is minted only after Chrome confirms `complete`.
    savedAt: Date.now(),
  };
  if (typeof receipt.thumbUrl === 'string' && receipt.thumbUrl.length <= SAVED_THUMB_MAX && isFbcdn(receipt.thumbUrl)) {
    clean.thumbUrl = receipt.thumbUrl;
  }
  if (typeof receipt.resLabel === 'string') clean.resLabel = receipt.resLabel.slice(0, SAVED_LABEL_MAX);
  if (typeof receipt.durationSec === 'number' && Number.isFinite(receipt.durationSec)) {
    clean.durationSec = receipt.durationSec;
  }
  return clean;
}

async function persistCompletedDownload(tabId: number, receipt: SavedEntry): Promise<void> {
  if (tabLifecycle.isDead(tabId)) return;
  try {
    await addSaved(tabId, { ...receipt, savedAt: Date.now() });
  } catch (err) {
    // The download itself already succeeded — the file callers report ok:true
    // for is genuinely on disk by the time this runs — and addSaved has
    // already exhausted its own retry/shed attempts before rethrowing. A
    // receipt-write failure must never be reported as a failed DOWNLOAD: the
    // panel would tag the card Failed with a Retry, and clicking it lands
    // inside dashDeduper's success window and no-ops, showing an instant
    // "success" that hides the fact the file was already saved the first
    // time. Surfaced here rather than via a diag counter (diag.ts has no
    // reason for this loss class today).
    console.error('[FaceScrap] Saved receipt write failed after a successful download', err);
  }
}

// 1. Observe fbcdn media streams (reels/stories video + DASH tracks).
const recentObserver = createRecentObserver(async (tabId, url, at, documentId) => {
  try {
    return await tabLifecycle.runIfLive(tabId, () => setRecent(tabId, url, at, Date.now()), documentId);
  } catch (err) {
    if (isExpectedLifecycleStop(err) || err instanceof NavigationPendingError) return false;
    throw err;
  }
}, {
  isDead: (tabId) => tabLifecycle.isDead(tabId),
  onError: (err) => console.error('[FaceScrap] recent observation failed', err),
});

function bumpRecent(tabId: number, url: string, documentId?: string): void {
  void recentObserver.bump(tabId, url, documentId);
}

// DASH/MSE tracks are fetched as XHR (not type `media`), so we watch both request
// types for bumpRecent / now-playing only. addMedia intentionally stays gated to
// `media`: DASH video and audio XHR segments share the same URL shape and cannot
// be classified safely here. Complete linked ladders come from the passive
// GraphQL parser in page-hook.ts instead.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    // A subframe's own document must never be allowed to CLAIM the tab's
    // identity below (tabLifecycle.runIfLive/claimDocument treat an absent
    // claim as "first writer wins"). After a service-worker restart empties
    // that map, an ad/tracking iframe on an otherwise-idle Facebook tab
    // fetching an fbcdn URL could win that race and lock every later
    // top-level MEDIA_FOUND/NOW_PLAYING/FACEBOOK_THEME message out as stale
    // for the rest of the session. Mirrors the frameId gate every other
    // identity path here already applies (contentDocumentIdentity,
    // onBeforeNavigate, onCommitted).
    if (details.tabId < 0 || details.frameId !== 0) return;
    const url = details.url;
    if (DASH_BYTE_RANGE_RE.test(url) || /\.mp4(\?|$)/i.test(url)) {
      bumpRecent(details.tabId, url, chromeDocumentIdentity(details.documentId));
    }
    if (details.type === 'media' && !tabLifecycle.isDead(details.tabId)) {
      const item = classifyNetworkRequest(url, Date.now(), tabSurface.get(details.tabId) ?? 'video');
      if (item) {
        diagBump('captureNetwork');
        void tabLifecycle
          .runIfLive(details.tabId, () => addMedia(details.tabId, [item]), chromeDocumentIdentity(details.documentId))
          .then((n) => setBadge(details.tabId, n))
          .catch((err) => {
            if (!isExpectedLifecycleStop(err) && !(err instanceof NavigationPendingError)) {
              console.error('[FaceScrap] network capture write failed', err);
            }
          });
      }
    }
  },
  { urls: ['*://*.fbcdn.net/*'], types: ['media', 'xmlhttprequest'] },
);

// 2. Bind every capture to a committed top-level document. The begin/commit
//    barrier rejects old-document IPC even when it arrives after clearTab, and
//    also orders startup-delayed writes against that clear. Viewer continuations
//    retain Library rows and already-accepted prefetch work, but later messages
//    from their replaced document are still rejected.
function isViewerContinuation(url: string): boolean {
  if (!FB_URL.test(url)) return false;
  try {
    return /^\/(?:reel\/|stories\/|watch(?:\/|$)|videos\/)/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
chrome.webNavigation.onBeforeNavigate.addListener(
  (details) => {
    if (details.tabId < 0 || details.frameId !== 0) return;
    tabSurface.set(details.tabId, surfaceOf(details.url));
    recentObserver.reset(details.tabId);
    tabLifecycle.beginNavigation(details.tabId, !isViewerContinuation(details.url));
  },
);

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.tabId < 0 || details.frameId !== 0) return;
  tabSurface.set(details.tabId, surfaceOf(details.url));
  tabLifecycle.commitDocument(details.tabId, chromeDocumentIdentity(details.documentId));
  if (isViewerContinuation(details.url)) return;
  void tabLifecycle
    .runIfLive(details.tabId, () => clearTab(details.tabId))
    .then(() => chrome.action.setBadgeText({ tabId: details.tabId, text: '' }))
    .catch((error) => {
      if (!isExpectedLifecycleStop(error)) console.error('[FaceScrap] navigation clear failed', error);
    });
});

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.tabId >= 0 && details.frameId === 0) tabLifecycle.abortNavigation(details.tabId);
});

// 3. Messages: candidates from the content script, and download requests from the side panel.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (handleBindingMessage(msg, sender, sendResponse)) return true;
  if (handleSettingsMessage(msg, sender, sendResponse)) return true;
  if (handlePlayingDownload(msg, sender, sendResponse)) return true;
  const tabId = sender.tab?.id;
  // Narrowing on the shared union couples this receiver to the senders at
  // compile time. The runtime field checks below are not redundant: content
  // scripts share a process with the page, so their messages are never
  // believed blindly.
  const m = msg as RuntimeMessage | undefined;

  if (m?.type === 'FACEBOOK_THEME') {
    const documentId = contentDocumentIdentity(sender, m.documentToken);
    const signal = facebookThemeRefAtReceipt(m, Date.now());
    if (typeof tabId !== 'number' || tabLifecycle.isDead(tabId) || documentId == null || signal == null) {
      sendResponse(INVALID_SENDER);
      return true;
    }
    tabLifecycle.runIfLive(tabId, () => setFacebookTheme(tabId, signal), documentId).then(
      (stored) =>
        sendResponse(
          stored ? { ok: true } : { ok: false, retryable: true, error: 'Facebook theme storage failed.' },
        ),
      (err) => sendResponse(lifecycleAck(err)),
    );
    return true;
  }

  if (m?.type === 'MEDIA_FOUND') {
    const documentId = contentDocumentIdentity(sender, m.documentToken);
    if (typeof tabId !== 'number' || tabLifecycle.isDead(tabId) || documentId == null || !Array.isArray(m.items)) {
      sendResponse(INVALID_SENDER);
      return true;
    }
    // The content script sanitizes too, but it shares the renderer process with
    // the page — a compromised renderer can send anything. Re-sanitize here so
    // stored items are shaped/bounded regardless of what the sender ran.
    tabLifecycle
      .runIfLive(tabId, () => addMedia(tabId, sanitizeIncomingItems(m.items, MAX_MEDIA_BATCH_BYTES)), documentId)
      .then(
        (n) => {
          void setBadge(tabId, n);
          sendResponse({ ok: true });
        },
        (err) => sendResponse(lifecycleAck(err)),
      );
    return true;
  }

  if (m?.type === 'NOW_PLAYING') {
    const documentId = contentDocumentIdentity(sender, m.documentToken);
    if (typeof tabId !== 'number' || tabLifecycle.isDead(tabId) || documentId == null) {
      sendResponse(INVALID_SENDER);
      return true;
    }
    tabLifecycle.runIfLive(tabId, () => persistNowPlayingMessage(tabId, m, Date.now()), documentId).then(
      (ack) => sendResponse(ack),
      (err) => sendResponse(lifecycleAck(err)),
    );
    return true;
  }

  if (m?.type === 'DIAG_REPORT') {
    // Same defence-in-depth as MEDIA_FOUND: these counts started life in the
    // MAIN world, which shares a process with the page. The observer rejects
    // disabled, invalid, closed or over-limit senders and re-sanitizes values.
    const documentId = contentDocumentIdentity(sender, m.documentToken);
    if (typeof tabId === 'number' && documentId != null && tabLifecycle.acceptDocument(tabId, documentId)) {
      diagObserver.report(tabId, m.counters);
    }
    return undefined;
  }

  if (m?.type === 'FACESCRAP_PIN_PLAYING_MEDIA') {
    // Only an extension page may confirm a selection. Content scripts have a
    // sender.tab and must not be able to reserve arbitrary Library rows.
    if (sender.tab) {
      sendResponse({ ok: false, error: 'Unauthorized request.' });
      return true;
    }
    if (
      !Number.isInteger(m.tabId) ||
      m.tabId < 0 ||
      tabLifecycle.isDead(m.tabId) ||
      typeof m.identity !== 'string' ||
      !Array.isArray(m.groups) ||
      typeof m.playingAt !== 'number' ||
      !Number.isFinite(m.playingAt)
    ) {
      sendResponse({ ok: false, error: 'Invalid playing pin.' });
      return true;
    }
    const receivedAt = Date.now();
    tabLifecycle.runIfLive(m.tabId, () => setPlayingMediaPin(m.tabId, m.identity, m.groups, m.playingAt, receivedAt)).then(
      (ok) => sendResponse({ ok, error: ok ? undefined : 'Playing pin storage failed.' }),
      (err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true;
  }

  if (m?.type === 'FACESCRAP_CLEAR_TAB') {
    // Only the extension's own pages (side panel / popup) may wipe a tab. A
    // content script has sender.tab set; reject it so a compromised page can't
    // clear an arbitrary tab's captures. Routed here (not run in the panel) so
    // the removal serializes on the same write chain as addMedia — see ClearTabMsg.
    if (sender.tab) {
      sendResponse({ ok: false, error: 'Unauthorized request.' });
      return true;
    }
    const wanted = (msg as { tabId?: unknown }).tabId;
    if (typeof wanted !== 'number') {
      sendResponse({ ok: false, error: 'Invalid clear request.' });
      return true;
    }
    recentObserver.reset(wanted);
    tabLifecycle.invalidate(wanted, false);
    tabLifecycle.runIfLive(wanted, () => clearTab(wanted, { preserveFacebookTheme: true })).then(
      () => {
        void setBadge(wanted, 0);
        sendResponse({ ok: true });
      },
      (e: unknown) => sendResponse({ ok: false, error: String((e as Error)?.message ?? e) }),
    );
    return true; // async response
  }

  if (m?.type === 'FACESCRAP_DOWNLOAD_DASH') {
    // Only the extension's own pages (side panel / popup) may drive a download.
    // A content script has sender.tab set; reject it so a compromised page can't
    // request a remux/download of an arbitrary URL.
    if (sender.tab) {
      sendResponse({ ok: false, error: 'Unauthorized request.' });
      return true;
    }
    const { tabId: requestedTab, videoUrl, audioUrl, filename: rawFilename, saveAs, receipt: rawReceipt } = msg as {
      tabId?: unknown;
      videoUrl?: unknown;
      audioUrl?: unknown;
      filename?: unknown;
      saveAs?: unknown;
      receipt?: unknown;
    };
    const filename = sanitizeDownloadFilename(rawFilename);
    const receipt = sanitizeDownloadReceipt(rawReceipt);
    if (
      typeof requestedTab !== 'number' ||
      !Number.isInteger(requestedTab) ||
      requestedTab < 0 ||
      tabLifecycle.isDead(requestedTab) ||
      typeof videoUrl !== 'string' ||
      typeof audioUrl !== 'string' ||
      filename == null ||
      receipt == null ||
      !isFbcdn(videoUrl) ||
      !isFbcdn(audioUrl)
    ) {
      sendResponse({ ok: false, error: 'Invalid download request.' });
      return true;
    }
    if (!hasOffscreen()) {
      sendResponse({
        ok: false,
        error: 'This browser can\'t merge audio and video (no offscreen API). Download the direct version.',
      });
      return true;
    }
    downloadDash({
      tabId: requestedTab,
      receiptId: receipt.id,
      videoUrl,
      audioUrl,
      filename,
      saveAs: saveAs === true,
    })
      .then(() => persistCompletedDownload(requestedTab, receipt))
      .then(
        () => {
          sendResponse({ ok: true });
        },
        (e: unknown) => {
          sendResponse({ ok: false, error: String((e as Error)?.message ?? e) });
        },
      );
    return true; // async response
  }

  if (m?.type === 'FACESCRAP_DOWNLOAD_DIRECT') {
    if (sender.tab) {
      sendResponse({ ok: false, error: 'Unauthorized request.' } satisfies DownloadDirectResponse);
      return true;
    }
    const request = msg as Partial<DownloadDirectMsg>;
    const filename = sanitizeDownloadFilename(request.filename);
    const receipt = sanitizeDownloadReceipt(request.receipt);
    if (
      !Number.isInteger(request.tabId) ||
      (request.tabId ?? -1) < 0 ||
      tabLifecycle.isDead(request.tabId as number) ||
      typeof request.url !== 'string' ||
      !isFbcdn(request.url) ||
      filename == null ||
      receipt == null
    ) {
      sendResponse({ ok: false, error: 'Invalid download request.' } satisfies DownloadDirectResponse);
      return true;
    }
    const requestedTab = request.tabId as number;
    downloadDirect(request.url, filename, request.saveAs === true)
      .then(() => persistCompletedDownload(requestedTab, receipt))
      .then(
        () => sendResponse({ ok: true } satisfies DownloadDirectResponse),
        (error: unknown) =>
          sendResponse({ ok: false, error: String((error as Error)?.message ?? error) } satisfies DownloadDirectResponse),
      );
    return true;
  }

  return undefined;
});

// 4. Toolbar badge = number of captured items for that tab (count comes from
//    addMedia's write, so this never re-reads the array).
// The colour is a constant, so it is set once per worker instance rather than before
// every badge write — setBadge runs on the worker's hottest paths. Module scope is
// what re-arms it after a restart. Caught, never left to reject: a rejected cached
// promise would make every future badge write throw.
const badgeColorReady: Promise<void> = chrome.action
  .setBadgeBackgroundColor({ color: '#1877F2' })
  .catch((err) => {
    console.error('[FaceScrap] setBadgeBackgroundColor failed', err);
  });

async function setBadge(tabId: number, n: number): Promise<void> {
  await badgeColorReady;
  await chrome.action.setBadgeText({ tabId, text: n > 0 ? String(Math.min(n, 999)) : '' });
}

// 5. Clean up when a tab closes — the one path that also drops the download
//    history (navigation and the Clear button keep it; see purgeTab).
chrome.tabs.onRemoved.addListener((tabId) => {
  tabLifecycle.markDead(tabId); // before purgeTab: late in-flight events must not re-write
  diagObserver.removeTab(tabId);
  recentObserver.dispose(tabId); // tab is gone for good — release its dedupe state, not just reset it
  tabSurface.delete(tabId);
  forgetVideoGroupMemory(tabId);
  void purgeTab(tabId);
});

// 6. Clear per-tab state once a tab has left facebook.com. `changeInfo.url` is
//    an unreliable signal (absent on same-URL reloads, prerender activations and
//    bfcache restores), so read the settled tab.url instead: without the "tabs"
//    permission it is exposed only for host-permitted (facebook) origins, so an
//    invisible url means the tab genuinely left the site.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // SPA navigations (feed → /reel/<id> via pushState) fire neither a main_frame
  // request nor a 'complete' status — only this url delta keeps tabSurface and
  // the gate current there. Exposed without the "tabs" permission only for
  // host-permitted (facebook) origins, which is exactly the set we label.
  if (changeInfo.url) gateTab(tabId, changeInfo.url);
  if (changeInfo.status !== 'complete') return;
  chrome.tabs
    .get(tabId)
    .then((tab) => {
      gateTab(tabId, tab.url); // enable on facebook, disable (and inert) elsewhere
      if (!tab.url) {
        recentObserver.reset(tabId);
        tabLifecycle.invalidate(tabId, true);
        void tabLifecycle.runIfLive(tabId, () => clearTab(tabId)); // left facebook → drop its captures
      }
    })
    .catch(() => {});
});
