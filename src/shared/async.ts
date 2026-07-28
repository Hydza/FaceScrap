// Tiny async helpers shared across every extension context: idleness-bounded waits,
// the chain lock and keyed lanes that serialize storage writes, and the retry backoff.

/** A timeout that measures IDLENESS, not elapsed time: `beat()` restarts the
 *  clock, so work that keeps reporting progress is never cut off. A wall-clock
 *  cap cannot tell a wedged job from a slow one, and killed large tracks on
 *  slow-but-steady links deterministically.
 *
 *  `hardCapMs` is the backstop for what the idle timer cannot see: a peer that
 *  died outright and sends neither progress nor an answer.
 *
 *  Returns the guarded promise plus the beat function; the caller wires `beat`
 *  to whatever progress channel it owns.
 *
 *  `armStarted()` RESTARTS the hard cap, for the one caller whose wait spans a
 *  queue it cannot see the length of. dash-download.ts guards a single round-trip
 *  (the offscreen mux call, never itself queued) and simply ignores it. The
 *  panel's DASH_UI_HARD_CAP_MS wait (messages.ts) covers an unbounded dashChain
 *  queue PLUS one job: armed only at send time it budgeted for ONE job's worst
 *  case while actually covering "queue wait + that job", so a request queued
 *  behind a long merge could exhaust it while the worker was still entitled to
 *  keep working on that SAME request — then finish it and write a Saved receipt
 *  under a card the panel had already tagged Failed. The panel restarts this
 *  window from FACESCRAP_DASH_JOB_STARTED instead, giving the job its own full
 *  budget from the moment it actually starts.
 *
 *  Both rearming entry points are no-ops once the wait has settled, so a late or
 *  duplicate signal can never arm a timer against a promise nobody is awaiting
 *  anymore; and a request whose start signal never arrives — including a worker
 *  reaped and restarted mid-queue — still terminates at the original send-time
 *  `hardCapMs`. */
export function withHeartbeat<T>(
  work: Promise<T>,
  idleMs: number,
  hardCapMs: number,
  message: string,
): { promise: Promise<T>; beat: () => void; armStarted: () => void } {
  let settled = false;
  let idleTimer: ReturnType<typeof setTimeout>;
  let hardTimer: ReturnType<typeof setTimeout>;
  let fail: (e: Error) => void = () => {};
  const guard = new Promise<never>((_, reject) => {
    fail = reject;
  });
  const armIdle = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fail(new Error(message)), idleMs);
  };
  const armHard = (): void => {
    clearTimeout(hardTimer);
    hardTimer = setTimeout(() => fail(new Error(message)), hardCapMs);
  };
  armIdle();
  armHard(); // send-time cap: bounds the case where the job's own start signal never arrives
  const promise = Promise.race([work, guard]).finally(() => {
    settled = true;
    clearTimeout(idleTimer);
    clearTimeout(hardTimer);
  });
  return {
    promise,
    // Guarded: a progress report that races the final answer must not leave a
    // timer armed against an already-settled promise (an unhandled rejection).
    beat: () => {
      if (!settled) armIdle();
    },
    armStarted: () => {
      if (!settled) armHard();
    },
  };
}

/** Reject after `ms` if `p` hasn't settled, without leaking the timer. */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}

/**
 * A chain mutex: each task starts only after every task enqueued before it on the
 * SAME lock has settled (succeeded OR failed), and one rejection never blocks the
 * ones queued behind it. The caller gets back the RAW task promise — it rejects
 * exactly when `task` does; only the internal chain used to sequence FUTURE tasks
 * is caught-and-swallowed so a failure can't wedge the lane.
 *
 * Each CALL creates its own closed-over `chain`, so separate locks keep guarding
 * their own resource — never collapse two callers into one shared lock
 * (tests/found-storage-lock-factory.test.ts exists for exactly that mistake).
 *
 * storage.ts's two write locks, session-write.ts's headroom lock,
 * dash-download.ts's dashChain and offscreen.ts's muxQueue independently grew this
 * same shape, so it lives here once and they cannot drift apart. Two serial-queue
 * idioms elsewhere are DIFFERENT contracts on purpose and were deliberately left
 * alone rather than forced onto this helper: settings.ts's
 * createSettingsPatchWriter releases a hand-rolled latch in a `finally` block;
 * diag-observer.ts's flushChain reuses one handler for both the fulfilled and
 * rejected branches of `.then()`, so a failure is never swallowed the way it is
 * here. The keyed lanes below are the third shape and DO live here: they hand the
 * caller the settled/caught chain instead of the raw task, so a caller there never
 * sees its own task's rejection the way a caller here does.
 */
export function createChainLock(): <T>(task: () => Promise<T>) => Promise<T> {
  let chain: Promise<void> = Promise.resolve();
  return function withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/** One ordered lane per key: read-modify-write cycles on a key must run one at a
 *  time, but unrelated keys must never wait on each other's writes. A failure is
 *  reported through onError and does NOT poison the lane for the next task. */
export function keyedSerialQueue(): (
  key: number,
  task: () => Promise<void>,
  onError: (err: unknown) => void,
) => Promise<void> {
  const chains = new Map<number, Promise<void>>();
  return (key, task, onError) => {
    const run = (chains.get(key) ?? Promise.resolve()).then(task);
    const settled = run.catch(onError);
    chains.set(key, settled);
    void settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key);
    });
    return settled;
  };
}

/** The same lane, for a key space with only one member. */
export function serialQueue(): (task: () => Promise<void>, onError: (err: unknown) => void) => Promise<void> {
  const lane = keyedSerialQueue();
  return (task, onError) => lane(0, task, onError);
}

/**
 * Exponential-backoff delay in ms: `baseMs` doubling per attempt, clamped to
 * `capMs`. `attempt` is 0 for the FIRST retry after a failure (so the first
 * delay is exactly `baseMs`); it is itself clamped to an exponent of 5 so the
 * delay can never overflow regardless of how large a caller's own failure
 * counter grows (2^5 already reaches most `capMs` values in one hop).
 *
 * Shared by content-media-relay.ts's media retry (pump) and now-playing.ts's
 * binding-flush retry (retryBindings) — the two EXPONENTIAL policies among
 * FaceScrap's five capture/ack retry channels. The counter/timer bookkeeping
 * around this math is deliberately NOT unified: the two call sites manage
 * their own failure counters differently (media's saturates at 16 before this
 * clamp even applies; bindings' grows unbounded) and their base/cap constants
 * differ, so only the shared arithmetic moved here.
 *
 * The other three channels (theme: fixed 1s; playing: no timer, rides the
 * content script's 300ms detect() poller; pin: no timer, rides the side
 * panel's ~500ms render tick) intentionally have NO timer to share — see
 * acked-latest.ts's header comment for the full five-channel map.
 */
export function exponentialBackoffMs(attempt: number, baseMs: number, capMs: number): number {
  const exponent = Math.min(Math.max(0, attempt), 5);
  return Math.min(capMs, baseMs * 2 ** exponent);
}
