// Tiny async helpers shared across contexts (side panel, service worker).

/** A timeout that measures IDLENESS, not elapsed time: `beat()` restarts the
 *  clock, so work that keeps reporting progress is never cut off.
 *
 *  A wall-clock cap cannot tell a wedged job from a slow one. The offscreen
 *  document learned this for single track reads (see STALL_MS there) but the
 *  worker still capped the whole mux round-trip at a fixed 115s, so a large
 *  track on a slow-but-steady link died mid-download — deterministically, and
 *  with every downloaded byte thrown away. `hardCapMs` stays as the backstop
 *  for the case the idle timer cannot see: an offscreen document that died
 *  outright would send neither progress nor an answer.
 *
 *  Returns the guarded promise plus the beat function; the caller wires `beat`
 *  to whatever progress channel it owns. */
export function withHeartbeat<T>(
  work: Promise<T>,
  idleMs: number,
  hardCapMs: number,
  message: string,
): { promise: Promise<T>; beat: () => void } {
  let idleTimer: ReturnType<typeof setTimeout>;
  let settled = false;
  let fail: (e: Error) => void = () => {};
  const guard = new Promise<never>((_, reject) => {
    fail = reject;
  });
  const arm = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fail(new Error(message)), idleMs);
  };
  arm();
  const hardTimer = setTimeout(() => fail(new Error(message)), hardCapMs);
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
      if (!settled) arm();
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
 * Serializes async jobs on one FIFO chain: each call's work starts only after
 * every job enqueued before it has settled (succeeded OR failed), and one
 * job rejecting never blocks the ones queued behind it. The caller gets back
 * the RAW job promise — it rejects exactly when `run` does; only the internal
 * chain used to sequence FUTURE jobs is caught-and-swallowed so a failure
 * can't wedge the queue.
 *
 * service-worker.ts's dashChain and offscreen.ts's muxQueue independently grew
 * this exact `chain = job.catch(() => {}); return job;` shape — factored here
 * so the two can't drift apart. Three other serial-queue idioms elsewhere in
 * this codebase are DIFFERENT contracts on purpose and were deliberately left
 * alone rather than forced onto this helper: storage.ts's serialQueue hands
 * the caller the settled/caught chain instead of the raw job (a caller there
 * never sees its own task's rejection the way a caller here does);
 * settings.ts's createSettingsPatchWriter releases a hand-rolled latch in a
 * `finally` block; diag-observer.ts's flushChain reuses one handler for both
 * the fulfilled and rejected branches of `.then()`, so a failure is never
 * swallowed the way it is here. None of the three is "genuinely identical" to
 * this shape, so none was converged onto it.
 */
export function createJobChain<T>(): (run: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return (run) => {
    const job = chain.then(run);
    chain = job.catch(() => {});
    return job;
  };
}

/**
 * Exponential-backoff delay in ms: `baseMs` doubling per attempt, clamped to
 * `capMs`. `attempt` is 0 for the FIRST retry after a failure (so the first
 * delay is exactly `baseMs`); it is itself clamped to an exponent of 5 so the
 * delay can never overflow regardless of how large a caller's own failure
 * counter grows (2^5 already reaches most `capMs` values in one hop).
 *
 * Shared by content.ts's media-relay retry (pumpMedia) and now-playing.ts's
 * binding-flush retry (retryBindings) — the two EXPONENTIAL policies among
 * FaceScrap's five capture/ack retry channels. The counter/timer bookkeeping
 * around this math is deliberately NOT unified: the two call sites manage
 * their own failure counters differently (media's saturates at 16 before this
 * clamp even applies; bindings' grows unbounded) and their base/cap constants
 * differ, so only the shared arithmetic moved here.
 *
 * The other three channels (theme: fixed 1s; playing: no timer, rides the
 * content script's 300ms detectPlaying poll; pin: no timer, rides the side
 * panel's ~500ms render tick) intentionally have NO timer to share — see
 * acked-latest.ts's header comment for the full five-channel map.
 */
export function exponentialBackoffMs(attempt: number, baseMs: number, capMs: number): number {
  const exponent = Math.min(Math.max(0, attempt), 5);
  return Math.min(capMs, baseMs * 2 ** exponent);
}
