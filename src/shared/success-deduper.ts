interface SuccessDeduper {
  readonly inFlightCount: number;
  run(key: string, task: () => Promise<void>): Promise<void>;
}

/** Collapses concurrent duplicates and remembers only successful completion.
 * A rejection is deliberately never cached, so Retry always runs real work. */
export function createSuccessDeduper(windowMs: number, now: () => number): SuccessDeduper {
  const inFlight = new Map<string, Promise<void>>();
  const completed = new Map<string, number>();

  return {
    get inFlightCount() {
      return inFlight.size;
    },

    run(key, task) {
      const pending = inFlight.get(key);
      if (pending != null) return pending;

      const current = now();
      const completedAt = completed.get(key);
      if (completedAt != null && current >= completedAt && current - completedAt < windowMs) {
        return Promise.resolve();
      }
      if (completedAt != null && current < completedAt) completed.delete(key);

      const work = task()
        .then(() => {
          const at = now();
          completed.set(key, at);
          for (const [candidate, time] of completed) {
            if (at < time || at - time > windowMs) completed.delete(candidate);
          }
        })
        .finally(() => {
          inFlight.delete(key);
        });
      inFlight.set(key, work);
      return work;
    },
  };
}

/** Plain-object mirror of the completed-map above, safe to serialize (e.g. into
 *  chrome.storage.session) so a successful run can still be recognized after a
 *  worker restart — the Maps above are in-memory only and MV3 can tear a
 *  service worker down well inside a realistic dedup window. Wall-clock
 *  (Date.now()) ALWAYS, never performance.now(): the in-memory deduper above
 *  can safely use the latter because it is never compared across a restart,
 *  but a snapshot may be read back by a LATER worker instance whose
 *  performance.now() origin has nothing to do with the one that wrote it. */
export type DedupSnapshot = Readonly<Record<string, number>>;

/** Same window rule createSuccessDeduper applies in-memory (run() above):
 *  completed no more than `windowMs` ago, and a backwards clock sample (nowMs
 *  before the stored stamp) invalidates rather than falsely extending it. */
export function isRecentlyCompleted(snapshot: DedupSnapshot, key: string, nowMs: number, windowMs: number): boolean {
  const at = snapshot[key];
  return at != null && nowMs >= at && nowMs - at < windowMs;
}

/** Record `key` completed at `nowMs`, in a NEW snapshot that also drops every
 *  entry `windowMs` (or a backwards clock) has already invalidated — the same
 *  prune run()'s own `.then()` does above, so a snapshot that only ever grows
 *  by appending cannot grow without bound. Never mutates `snapshot`. */
export function withCompletion(snapshot: DedupSnapshot, key: string, nowMs: number, windowMs: number): DedupSnapshot {
  const next: Record<string, number> = { [key]: nowMs };
  for (const [k, at] of Object.entries(snapshot)) {
    if (k !== key && nowMs >= at && nowMs - at < windowMs) next[k] = at;
  }
  return next;
}
