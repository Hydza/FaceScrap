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
 * Create an independent FIFO chain lock. Each task starts after the preceding task
 * settles, and a rejection cannot block later work. Callers receive the raw task
 * promise while the internal sequencing chain absorbs failures.
 *
 * Keyed lanes below return the settled sequencing chain instead, so a caller never
 * sees its own task's rejection as a caller here does.
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
 * Shared by the media and binding-flush exponential retries. Each caller retains
 * its own counter, timer and base/cap policy; only the arithmetic is shared.
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
