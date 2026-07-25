import { widenDashUrl } from '../shared/media';

export interface RecentObserver {
  /** Returns the scheduled write, or undefined when the same canonical track
   *  is still the latest observation for this tab. */
  bump(tabId: number, url: string, documentId?: string): Promise<boolean> | undefined;
  /** Invalidate callbacks and dedupe state across a clear/navigation boundary.
   *  Keeps the tab's map entry (a fresh navigation still needs its dedupe
   *  state) — use dispose() when the tab itself is gone for good. */
  reset(tabId: number): void;
  /** Release a tab's dedupe state entirely once the tab has closed. An
   *  in-flight write already holds its own closure over the old state object,
   *  so a late acknowledgement is unaffected — it still observes isDead(tabId)
   *  and no-ops, exactly as it would after reset(). */
  dispose(tabId: number): void;
}

interface RecentObserverOptions {
  now?: () => number;
  isDead?: (tabId: number) => boolean;
  onError?: (err: unknown) => void;
}

interface LatestObservation {
  generation: number;
  url: string;
  at: number;
  documentId?: string;
}

interface TabObservationState {
  epoch: number;
  nextGeneration: number;
  latest?: LatestObservation;
  activeByGeneration: Map<number, number>;
  // The url `latest.url` replaced, and whether {altPartner, latest.url} has
  // already been seen to swap back at least once. A DASH video keeps
  // re-appending its own unchanging video/audio track pair (widenDashUrl
  // already collapses byte-range churn within EACH track down to one
  // canonical url per track) — a single-slot "last url" compare is defeated
  // the moment the two tracks alternate, since every switch differs from its
  // immediate predecessor. Once this exact pair has confirmed one full swap
  // (u1,u2,u1), later repeats of EITHER member are the same pair cycling, not
  // a new track, and stop paying for a read-modify-write + panel re-render
  // every segment — but NOT forever: see ALT_CONFIRM_REFRESH_MS below, which
  // bounds the suppression so a still-playing item keeps a live freshness
  // signal in storage. A genuinely third url always falls through unconfirmed
  // below and must re-earn its own confirmation before ITS repeats dedupe.
  altPartner?: string;
  altConfirmed: boolean;
}

// Bounds how long a confirmed alternating pair may go unwritten before the
// NEXT occurrence of either member is let through as a periodic refresh (see
// the confirmed-pair check in bump() below), rather than suppressed forever.
// Forever-suppression starves now-playing.ts's ONLY freshness signal for a
// video with no DOM ids and no ref.vid — an MSE feed/reel video (blob:
// currentSrc, "never in ref.ids" per now-playing.ts's own fallback comment;
// PlayingRef.vid is "Absent on feed/story surfaces" per storage.ts). That
// signal is exactly the `write` callback below landing a fresh timestamp in
// storage's recent.tracks, which selectPlaying() reads back to decide the
// video is still streaming; once writes stop, the item silently ages out of
// its sticky window after now-playing.ts's PLAYING_GRACE_MS (5 * 60 * 1000).
// PLAYING_GRACE_MS is not exported there, so it can't be imported here
// without crossing this file's ownership boundary — this comment is the
// coupling instead of the type system, so re-check this value against
// PLAYING_GRACE_MS if that constant ever changes. 60s gives 5x margin under
// that 5-minute cliff — comfortably enough that even a late-arriving segment
// still refreshes storage with room to spare — while remaining a large cut
// from writing on every single alternation, the write-storm this suppression
// exists to prevent in the first place.
const ALT_CONFIRM_REFRESH_MS = 60 * 1000;

/** Per-tab acknowledgement-based dedupe for network track observations. A
 *  failed storage write never consumes the key, and a callback from before a
 *  clear cannot suppress the same track in the new page epoch. */
export function createRecentObserver(
  write: (tabId: number, url: string, at: number, documentId?: string) => Promise<boolean>,
  options: RecentObserverOptions = {},
): RecentObserver {
  const now = options.now ?? Date.now;
  const isDead = options.isDead ?? (() => false);
  const stateByTab = new Map<number, TabObservationState>();

  function stateFor(tabId: number): TabObservationState {
    let state = stateByTab.get(tabId);
    if (state == null) {
      state = { epoch: 0, nextGeneration: 0, activeByGeneration: new Map(), altConfirmed: false };
      stateByTab.set(tabId, state);
    }
    return state;
  }

  function activeCount(state: TabObservationState, generation: number): number {
    return state.activeByGeneration.get(generation) ?? 0;
  }

  function schedule(
    tabId: number,
    state: TabObservationState,
    epoch: number,
    observation: LatestObservation,
  ): Promise<boolean> {
    state.activeByGeneration.set(observation.generation, activeCount(state, observation.generation) + 1);
    return (async () => {
      let ok = false;
      try {
        ok = await write(tabId, observation.url, observation.at, observation.documentId);
      } catch (err) {
        options.onError?.(err);
      }

      const remaining = activeCount(state, observation.generation) - 1;
      if (remaining > 0) state.activeByGeneration.set(observation.generation, remaining);
      else state.activeByGeneration.delete(observation.generation);

      if (state.epoch !== epoch || isDead(tabId)) return ok;
      const latest = state.latest;
      if (latest == null) return ok;

      if (!ok) {
        // Failure does not consume the newest observation. Only clear it after
        // its last attempt settles; an older failed callback must not make a
        // newer transition eligible as a false duplicate.
        if (latest.generation === observation.generation && activeCount(state, latest.generation) === 0) {
          state.latest = undefined;
        }
        return false;
      }

      if (latest.generation !== observation.generation && activeCount(state, latest.generation) === 0) {
        // This older write completed after the latest state had already
        // settled, so storage now contains the wrong track. Reassert the real
        // latest observation. If its own attempt is still running, that attempt
        // is already the required compensation and no duplicate is launched.
        void schedule(tabId, state, epoch, latest);
      }
      return true;
    })();
  }

  return {
    bump(tabId, url, documentId) {
      if (isDead(tabId)) return undefined;
      const widened = widenDashUrl(url);
      const state = stateFor(tabId);
      const nowTs = now();
      const priorUrl = state.latest?.url;
      if (priorUrl === widened) return undefined;
      // Confirmed-pair dedupe: once the SAME two urls have already swapped back
      // once (see altConfirmed's definition above), a repeat of the other member
      // stops being scheduled — UNLESS this pair has already gone
      // ALT_CONFIRM_REFRESH_MS without a write (see that constant for why this
      // must not be permanent), in which case THIS occurrence is let through as
      // a periodic refresh instead of suppressed. `state.latest.at` doubles as
      // "when this pair last wrote": latest freezes on every suppressed call
      // below and only updates when this pair is written — confirmed or
      // refreshed alike.
      if (
        state.altConfirmed &&
        widened === state.altPartner &&
        state.latest != null &&
        nowTs - state.latest.at < ALT_CONFIRM_REFRESH_MS
      ) {
        return undefined;
      }
      // This transition is either the first sighting of a brand-new url, the
      // still-unconfirmed return leg of a candidate pair, or a confirmed pair's
      // periodic refresh past ALT_CONFIRM_REFRESH_MS — either way it is
      // scheduled below. Update the pair bookkeeping BEFORE overwriting latest:
      // confirming requires seeing widened match what altPartner was carrying
      // going into this call, and a genuinely new third url must reset the
      // flag rather than inherit confirmation earned by a different pair. A
      // refresh of an already-confirmed pair re-confirms itself here the same
      // way, just with latest/altPartner's roles swapped, which restarts the
      // window from this write.
      state.altConfirmed = priorUrl != null && widened === state.altPartner;
      state.altPartner = priorUrl;
      const observation = {
        generation: ++state.nextGeneration,
        url: widened,
        at: nowTs,
        documentId,
      };
      state.latest = observation;
      return schedule(tabId, state, state.epoch, observation);
    },

    reset(tabId) {
      const state = stateFor(tabId);
      state.epoch++;
      state.latest = undefined;
      state.altPartner = undefined;
      state.altConfirmed = false;
    },

    dispose(tabId) {
      stateByTab.delete(tabId);
    },
  };
}
