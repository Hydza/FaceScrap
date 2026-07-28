// The two download requests the panel sends, and the Saved receipt they mint.
//
// Split out of service-worker.ts for the reason binding-handler.ts and
// playing-download.ts already were: the router should read as a list of message
// types, not carry one message's validation inline. Nothing here touches tab
// state — the caller injects `isDead`.
//
// Both messages carry a URL, so both are refused outright when `sender.tab` is
// set: a content script shares a process with the page, and a compromised page
// must never be able to aim the downloader. (The in-page button's own request
// carries no URL for exactly that reason — see playing-download.ts.)

import { isFbcdn, MEDIA_KINDS, MEDIA_SOURCES } from '../shared/media';
import { addSaved, SAVED_ID_MAX, SAVED_LABEL_MAX, SAVED_THUMB_MAX, type SavedEntry } from '../shared/saved';
import { diagError, diagLog, errorText, redactUrl } from '../shared/diag-log';
import { hasOffscreen } from '../shared/capabilities';
import type { DownloadDirectMsg, DownloadDirectResponse, RuntimeMessage } from '../shared/messages';
import { downloadDash, downloadDirect } from './dash-download';

interface DownloadHandlerDeps {
  isDead: (tabId: number) => boolean;
}

interface DownloadHandler {
  /** chrome.runtime.onMessage shape: true when this handler owns the message. */
  handle: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => boolean;
  /** Also injected into the in-page button's handler, which downloads too. */
  persistCompletedDownload: (tabId: number, receipt: SavedEntry) => Promise<void>;
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

export function createDownloadHandler(deps: DownloadHandlerDeps): DownloadHandler {
  const persistCompletedDownload = async (tabId: number, receipt: SavedEntry): Promise<void> => {
    if (deps.isDead(tabId)) return;
    try {
      await addSaved(tabId, { ...receipt, savedAt: Date.now() });
    } catch (err) {
      // The download already succeeded and the file is on disk; addSaved has
      // exhausted its own retries. Never report this as a failed DOWNLOAD: the
      // panel would offer Retry, and retrying lands inside dashDeduper's success
      // window and no-ops — a false "success" hiding the real save.
      diagError('Saved receipt write failed after a successful download', err, { tab: tabId, id: receipt.id });
    }
  };

  /** Log the outcome and answer. One shape for both routes, so the trace of a
   *  dash download and a direct one stay comparable. */
  const settle = (
    mode: 'dash' | 'direct',
    tabId: number,
    startedAt: number,
    sendResponse: (response: unknown) => void,
  ): { done: () => void; failed: (error: unknown) => void } => ({
    done: () => {
      diagLog('downloadDone', { mode, tab: tabId, ms: Date.now() - startedAt });
      sendResponse({ ok: true });
    },
    failed: (error: unknown) => {
      // The panel shows this on the card; the log is what keeps it after the
      // panel is closed, next to the capture that produced the URL.
      diagLog('downloadFailed', { mode, tab: tabId, ms: Date.now() - startedAt, error: errorText(error) }, 'error');
      sendResponse({ ok: false, error: String((error as Error)?.message ?? error) });
    },
  });

  const handle = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean => {
    const m = message as RuntimeMessage | undefined;

    if (m?.type === 'FACESCRAP_DOWNLOAD_DASH') {
      if (sender.tab) {
        sendResponse({ ok: false, error: 'Unauthorized request.' });
        return true;
      }
      const { tabId, videoUrl, audioUrl, filename: rawFilename, saveAs, receipt: rawReceipt } = message as {
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
        typeof tabId !== 'number' ||
        !Number.isInteger(tabId) ||
        tabId < 0 ||
        deps.isDead(tabId) ||
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
          error: "This browser can't merge audio and video (no offscreen API). Download the direct version.",
        });
        return true;
      }
      const outcome = settle('dash', tabId, Date.now(), sendResponse);
      diagLog('downloadStart', {
        mode: 'dash',
        tab: tabId,
        file: filename,
        video: redactUrl(videoUrl),
        audio: redactUrl(audioUrl),
      });
      downloadDash({ tabId, receiptId: receipt.id, videoUrl, audioUrl, filename, saveAs: saveAs === true })
        .then(() => persistCompletedDownload(tabId, receipt))
        .then(outcome.done, outcome.failed);
      return true; // async response
    }

    if (m?.type === 'FACESCRAP_DOWNLOAD_DIRECT') {
      if (sender.tab) {
        sendResponse({ ok: false, error: 'Unauthorized request.' } satisfies DownloadDirectResponse);
        return true;
      }
      const request = message as Partial<DownloadDirectMsg>;
      const filename = sanitizeDownloadFilename(request.filename);
      const receipt = sanitizeDownloadReceipt(request.receipt);
      if (
        !Number.isInteger(request.tabId) ||
        (request.tabId ?? -1) < 0 ||
        deps.isDead(request.tabId as number) ||
        typeof request.url !== 'string' ||
        !isFbcdn(request.url) ||
        filename == null ||
        receipt == null
      ) {
        sendResponse({ ok: false, error: 'Invalid download request.' } satisfies DownloadDirectResponse);
        return true;
      }
      const tabId = request.tabId as number;
      const outcome = settle('direct', tabId, Date.now(), sendResponse);
      diagLog('downloadStart', { mode: 'direct', tab: tabId, file: filename, url: redactUrl(request.url) });
      downloadDirect(request.url, filename, request.saveAs === true)
        .then(() => persistCompletedDownload(tabId, receipt))
        .then(outcome.done, outcome.failed);
      return true;
    }

    return false;
  };

  return { handle, persistCompletedDownload };
}
