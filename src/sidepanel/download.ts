// The panel's download transport: hand one item to the service worker and report
// whether it landed.
//
// Holds no panel state. Everything it needs about the panel arrives as arguments, so
// the busy/failed/saved bookkeeping — which is keyed by CARD, and an item does not
// know which card is downloading it — stays with the caller.

import { withHeartbeat } from '../shared/async';
import type { MediaItem } from '../shared/media';
import { downloadFilename } from '../shared/download-naming';
import { t } from '../shared/i18n';
import type { SavedEntry } from '../shared/saved';
import type { Settings } from '../shared/settings';
import { dashDownloadKey } from '../shared/download-settlement';
import {
  DASH_UI_HARD_CAP_MS,
  DASH_UI_IDLE_MS,
  type DownloadDirectMsg,
  type DownloadDirectResponse,
  type DownloadDashMsg,
  type DownloadDashResponse,
} from '../shared/messages';

/** Beat function of the download awaiting a merge. Only one can be in flight per
 *  panel (the caller gates on that), so a single slot suffices — same below. */
let muxBeat: (() => void) | null = null;
/** dashDownloadKey of the DASH job THIS panel is waiting on, plus the function that
 *  rebases its hard cap once that job actually starts (withHeartbeat's armStarted,
 *  DASH_UI_HARD_CAP_MS). Matching by key keeps another window's queued job from
 *  rebasing this wait — unlike FACESCRAP_MUX_PROGRESS, which beats on ANY job's
 *  progress: right for an idle timer, wrong for a hard-cap rebase. */
let pendingDashJobKey: string | null = null;
let armDashJobHardCap: (() => void) | null = null;

chrome.runtime.onMessage.addListener((msg) => {
  const m = msg as { type?: string; key?: unknown } | undefined;
  if (m?.type === 'FACESCRAP_MUX_PROGRESS') {
    muxBeat?.();
  } else if (m?.type === 'FACESCRAP_DASH_JOB_STARTED' && m.key === pendingDashJobKey) {
    armDashJobHardCap?.();
  }
});

/**
 * Remux a DASH pair via the offscreen doc. The SW dedups by track pair.
 *
 * DASH_UI_IDLE_MS is a UI hang backstop only, for an SW that dies without closing the
 * port; correctness timeouts live in the SW. It counts IDLE time, not elapsed — every
 * forwarded mux report restarts the clock — so a merge that legitimately runs for
 * minutes, or sits queued behind another, is never tagged failed while the worker is
 * still working.
 */
async function startDashDownload(
  tid: number,
  item: MediaItem,
  receipt: SavedEntry,
  settings: Settings,
  forceSaveAs: boolean,
): Promise<string | null> {
  const audioUrl = item.audioUrl;
  if (audioUrl == null) return t('errNoAudioTrack'); // callers gate on audioUrl; narrow it for the typed message
  const filename = downloadFilename(item, settings);
  // 'ask' means open Chrome's Save-As dialog for every download; the Now Playing
  // "Save as…" link asks for it once, without touching the setting.
  const saveAs = forceSaveAs || settings.defaultQuality === 'ask';
  // Same fields and shape as downloadDash()'s own dashDownloadKey(request) call, so
  // this wait recognises its OWN FACESCRAP_DASH_JOB_STARTED without a round trip.
  const key = dashDownloadKey({ tabId: tid, receiptId: receipt.id, videoUrl: item.url, audioUrl, filename, saveAs });
  try {
    const guarded = withHeartbeat(
      chrome.runtime.sendMessage({
        type: 'FACESCRAP_DOWNLOAD_DASH',
        tabId: tid,
        videoUrl: item.url,
        audioUrl,
        filename,
        saveAs,
        receipt,
      } satisfies DownloadDashMsg),
      DASH_UI_IDLE_MS,
      DASH_UI_HARD_CAP_MS,
      t('errMergeTimedOut'),
    );
    muxBeat = guarded.beat;
    pendingDashJobKey = key;
    armDashJobHardCap = guarded.armStarted;
    let r: DownloadDashResponse | undefined;
    try {
      r = (await guarded.promise) as DownloadDashResponse | undefined;
    } finally {
      muxBeat = null;
      armDashJobHardCap = null;
      pendingDashJobKey = null;
    }
    if (!r?.ok) throw new Error(r?.error || t('errMergeFailed'));
    return null;
  } catch (e: unknown) {
    console.error('[FaceScrap]', e);
    return (e as Error)?.message || t('errMergeFailed');
  }
}

/** Direct download of a progressive/complete media URL (it already has audio). */
async function startDirectDownload(
  tid: number,
  item: MediaItem,
  receipt: SavedEntry,
  settings: Settings,
  forceSaveAs: boolean,
): Promise<string | null> {
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'FACESCRAP_DOWNLOAD_DIRECT',
      tabId: tid,
      url: item.url,
      filename: downloadFilename(item, settings),
      saveAs: forceSaveAs || settings.defaultQuality === 'ask',
      receipt,
    } satisfies DownloadDirectMsg)) as DownloadDirectResponse | undefined;
    if (!response?.ok) throw new Error(response?.error || t('errDownloadFailed'));
    return null;
  } catch (e) {
    console.error('[FaceScrap]', e);
    return (e as Error)?.message || t('errDownloadFailed');
  }
}

/**
 * Download one item, DASH pair or progressive URL. Returns null on success, else the
 * failure reason to surface on the card.
 *
 * Never rejects: a bulk run must survive one bad item. Both routes go through the
 * worker, which waits for Chrome's terminal state and persists the receipt only on
 * `complete`, so closing this panel cannot lose that bookkeeping.
 */
export async function downloadOne(
  tid: number | undefined,
  item: MediaItem,
  receipt: SavedEntry,
  settings: Settings,
  /** Open Chrome's Save-As dialog for THIS download regardless of the setting. */
  saveAs = false,
): Promise<string | null> {
  if (tid === undefined) return t('errInvalidTab');
  return item.audioUrl != null
    ? startDashDownload(tid, item, receipt, settings, saveAs)
    : startDirectDownload(tid, item, receipt, settings, saveAs);
}
