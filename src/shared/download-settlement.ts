interface DownloadEvents {
  addListener(listener: (delta: chrome.downloads.DownloadDelta) => void): void;
  removeListener(listener: (delta: chrome.downloads.DownloadDelta) => void): void;
}

export interface DownloadSettlementApi {
  onChanged: DownloadEvents;
  search(query: chrome.downloads.DownloadQuery): Promise<chrome.downloads.DownloadItem[]>;
  cancel(downloadId: number): Promise<void>;
}

interface DownloadSettlementOptions {
  /** Omit for ordinary network downloads, whose healthy duration is unbounded. */
  timeoutMs?: number;
  /** Cancel an in-progress download before exposing Retry after timeout. */
  cancelOnTimeout?: boolean;
}

export interface DashDownloadIdentity {
  tabId: number;
  receiptId: string;
  videoUrl: string;
  audioUrl: string;
  filename: string;
  saveAs: boolean;
}

/** Scope successful-download suppression to one logical request. The same
 * fbcdn representations can legitimately back different cards or tabs, so a
 * track-pair-only key would report a download that never ran for the latter. */
export function dashDownloadKey(identity: DashDownloadIdentity): string {
  return JSON.stringify([
    identity.tabId,
    identity.receiptId,
    identity.videoUrl,
    identity.audioUrl,
    identity.filename,
    identity.saveAs,
  ]);
}

export class DownloadInterruptedError extends Error {
  constructor(reason?: string) {
    super(reason ? `Download interrupted: ${reason}` : 'Download interrupted.');
    this.name = 'DownloadInterruptedError';
  }
}

function terminalError(state: string | undefined, reason?: string): Error | null | undefined {
  if (state === 'complete') return null;
  if (state === 'interrupted') return new DownloadInterruptedError(reason);
  return undefined;
}

// Bounded retries for the registration-race search below: a download's state
// never reverts out of terminal, so a search that could not read it (rejected,
// or came back with no matching item) will see the true state on a follow-up
// attempt soon after. Kept short — this only needs to outlast a microtask-scale
// listener-attach race, not a real network delay.
const REGISTRATION_RACE_RETRIES = 3;
const REGISTRATION_RACE_DELAY_MS = 150;

/** Wait for the browser's terminal download state. downloads.download() only
 * confirms enqueue; Saved/dedup state must never advance on that weaker signal.
 * The listener is installed before search so a fast blob download cannot settle
 * in the gap, and every exit removes its listener/timer exactly once. */
export function waitForDownloadSettlement(
  api: DownloadSettlementApi,
  downloadId: number,
  options: DownloadSettlementOptions = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let raceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      api.onChanged.removeListener(onChanged);
      if (timer !== undefined) clearTimeout(timer);
      if (raceTimer !== undefined) clearTimeout(raceTimer);
      if (error == null) resolve();
      else reject(error);
    };

    const inspect = (item: chrome.downloads.DownloadItem | undefined): boolean => {
      const result = terminalError(item?.state, item?.error);
      if (result === undefined) return false;
      finish(result);
      return true;
    };

    const onChanged = (delta: chrome.downloads.DownloadDelta): void => {
      if (delta.id !== downloadId) return;
      const result = terminalError(delta.state?.current, delta.error?.current);
      if (result !== undefined) finish(result);
    };

    api.onChanged.addListener(onChanged);

    // Closes the race where the download already reached its terminal state
    // before the listener above was attached — a found item (terminal or not)
    // answers that question for good, and a non-terminal item is left to
    // onChanged from here, same as always. But a rejection or an empty result
    // proves nothing, and if the race above is what actually happened, no
    // onChanged delta is EVER coming to recover us: a caller with no
    // options.timeoutMs (e.g. downloadDirect) would then await this promise
    // forever, pinning its keepalive on one dropped browser response. Retry a
    // few times before giving up so a stuck check fails loudly instead.
    let raceAttempt = 0;
    const closeRegistrationRace = (): void => {
      void api.search({ id: downloadId }).then(
        (items) => {
          if (settled) return;
          if (items[0] !== undefined) {
            inspect(items[0]);
            return;
          }
          retryOrFailRace();
        },
        () => {
          if (!settled) retryOrFailRace();
        },
      );
    };
    const retryOrFailRace = (): void => {
      if (raceAttempt >= REGISTRATION_RACE_RETRIES) {
        finish(new Error('Could not confirm the download state.'));
        return;
      }
      raceAttempt += 1;
      raceTimer = setTimeout(closeRegistrationRace, REGISTRATION_RACE_DELAY_MS);
    };
    closeRegistrationRace();

    if (options.timeoutMs != null && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        void api.search({ id: downloadId }).then(
          async (items) => {
            if (inspect(items[0]) || settled) return;
            // Settle the timeout BEFORE cancelling. onChanged is still
            // registered during the cancel() await below, and a cancelled
            // in-progress download fires its own 'interrupted'/USER_CANCELED
            // delta — finish() is first-wins (:above), so cancelling first
            // would report that delta's reason instead of the real one,
            // showing the user a cancellation they never made.
            const shouldCancel = options.cancelOnTimeout && items[0]?.state === 'in_progress';
            finish(new Error('Download settlement timed out.'));
            if (shouldCancel) {
              await api.cancel(downloadId).catch(() => {});
            }
          },
          () => finish(new Error('Download settlement timed out.')),
        );
      }, options.timeoutMs);
    }
  });
}
