// --- FaceScrap's five capture/ack retry policies, in one place ---
// This module and acked-batch.ts deliberately supply only dedupe + a single
// in-flight pump — NEITHER schedules a retry on failure. Every concrete
// channel built on top decides its own cadence, at its own call site, and
// they are NOT the same policy. Reading any one channel's code in isolation
// only shows that one; this map is here so the other four don't have to be
// rediscovered by grepping four other files:
//
//   media    (content-media-relay.ts, pump)   exponential: baseMs=500,
//                                              capMs=10s (exponentialBackoffMs,
//                                              shared/async.ts). Uses
//                                              createAckedBatch.
//   theme    (content-theme.ts, scheduleRetry) fixed 1s. Uses this module
//                                              (createAckedLatest); pump() is
//                                              ALSO re-armed by the theme
//                                              MutationObserver/matchMedia
//                                              listeners, independent of the
//                                              timer.
//   playing  (content-playing.ts, deliver)    no timer of its own: a 'retry'
//                                              outcome just leaves `pending`
//                                              set below, and the next tick of
//                                              the 300ms detect() poller
//                                              re-offers and re-pumps it. Uses
//                                              this module.
//   bindings (now-playing.ts, retryBindings)  exponential: baseMs=250,
//                                              capMs=8s (same
//                                              exponentialBackoffMs). Its own
//                                              versioned-CAS outbox, not this
//                                              module.
//   pin      (now-playing.ts,                 no timer either:
//             persistPlayingPin)               persistPlayingPin() just leaves
//                                              confirmedPinWrites unset on
//                                              failure, and the side panel's
//                                              ~500ms render tick calls
//                                              selectPlaying() again, which
//                                              retries the write. Its own
//                                              idempotency cache, not this
//                                              module.
//
// The two exponential policies share their backoff MATH but keep independent
// failure counters and base/cap constants; the other three keep independent,
// deliberately different scheduling. Unifying the cadence itself would change
// live retry timing on four channels for no behavioural gain, so beyond the
// shared arithmetic this stays documentation, not one shared scheduler.

/** Outcome of delivering one latest-state observation. `retry` preserves the
 *  exact payload; `refresh` discards it so the next poll can timestamp a new
 *  observation after a terminal expiry/validation failure. */
export type AckedLatestOutcome = 'accepted' | 'retry' | 'refresh';

interface Pending<T> {
  key: string;
  value: T;
  inFlight: boolean;
}

interface AckedLatest<T> {
  /** Offer the currently observed logical state. Returns false only when that
   *  exact key is already committed. A repeated pending key keeps its original
   *  payload (notably its detection timestamp). */
  offer(key: string, value: T): boolean;
  /** Attempt the latest uncommitted state once. Concurrent pumps collapse. */
  pump(send: (value: T) => Promise<AckedLatestOutcome>): Promise<void>;
  /** Force the current DOM state to be reasserted, while preserving an existing
   *  in-flight/retry payload for that same state. */
  invalidateCommitted(): void;
}

/** Deliver the latest state with acknowledgement-based deduplication.
 * Only the current pending owner can commit. */
export function createAckedLatest<T>(): AckedLatest<T> {
  let committedKey = '';
  let pending: Pending<T> | undefined;

  return {
    offer(key, value) {
      if (key === committedKey) {
        // The DOM returned to the committed state while another state was in
        // flight. Its remote side effect cannot be cancelled: replace it with a
        // fresh compensating delivery of this state, so B cannot land after an
        // A→B→A transition and leave storage stuck on B.
        if (pending != null && pending.key !== key) {
          pending = { key, value, inFlight: false };
          return true;
        }
        return false;
      }
      if (pending?.key !== key) pending = { key, value, inFlight: false };
      return true;
    },

    async pump(send) {
      const entry = pending;
      if (entry == null || entry.inFlight) return;
      entry.inFlight = true;
      let outcome: AckedLatestOutcome = 'retry';
      try {
        outcome = await send(entry.value);
      } catch {
        // Transport errors are retryable. The caller controls cadence (the DOM
        // detector's poll), so no timer has to survive MV3 suspension here.
      }
      if (pending !== entry) return;
      entry.inFlight = false;
      if (outcome === 'accepted') {
        committedKey = entry.key;
        pending = undefined;
      } else if (outcome === 'refresh') {
        pending = undefined;
      }
    },

    invalidateCommitted() {
      committedKey = '';
    },
  };
}
