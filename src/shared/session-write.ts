// How this extension writes to chrome.storage.session safely.
//
// No domain knowledge: the capture keys, the Saved ledger and the diagnostics
// counters all sit on top of these. Two hazards are handled here so no caller has to:
// storage.session's ~10 MB quota is SHARED by every Facebook tab, and a
// read-modify-write cycle on one key must never interleave with another.

const CONTROL_HEADROOM_KEY = 'capture_control_headroom_v1';
const CONTROL_HEADROOM_BYTES = 512 * 1024;
const CONTROL_HEADROOM_MIN_BYTES = 128 * 1024;
const CONTROL_HEADROOM = '0'.repeat(CONTROL_HEADROOM_BYTES);
const CONTROL_HEADROOM_MIN = '0'.repeat(CONTROL_HEADROOM_MIN_BYTES);

export const readKey = async <T>(key: string, fallback: T): Promise<T> =>
  ((await chrome.storage.session.get(key))[key] as T | undefined) ?? fallback;

/** Wrap a DATA-plane write so it carries the full control reserve. The reserve buys
 *  the bytes a later control write (playing/recent/pin) will need, so a large Library
 *  burst cannot leave the panel with media rows but no pointer to what is playing. */
export function dataValues(values: Record<string, unknown>): Record<string, unknown> {
  return { [CONTROL_HEADROOM_KEY]: CONTROL_HEADROOM, ...values };
}

// A chain mutex. Each CALL creates its own closed-over `chain`, so separate locks keep
// guarding their own resource — never collapse two callers into one shared lock.
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

/** A small single-key write (playing/recent/bind) cannot shed bytes of its own to
 *  recover, so swallowing its failure would silently hide that now-playing stopped
 *  updating. Log it where a persistent quota problem becomes visible. */
export const logWriteError =
  (label: string) =>
  (err: unknown): void => {
    console.error(`[FaceScrap] ${label} write failed`, err);
  };

export function isStorageQuotaError(err: unknown): boolean {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return /quota|QUOTA_BYTES|MAX_(?:WRITE|SUSTAINED_WRITE|ITEMS)/i.test(detail);
}

const withHeadroomLock = createChainLock();

async function restoreControlHeadroom(): Promise<void> {
  try {
    await chrome.storage.session.set({ [CONTROL_HEADROOM_KEY]: CONTROL_HEADROOM });
    return;
  } catch {
    // A compact recent payload can use part of the emergency reserve. Keep a smaller
    // second-use reserve rather than reporting the already-durable write as failed.
  }
  try {
    await chrome.storage.session.set({ [CONTROL_HEADROOM_KEY]: CONTROL_HEADROOM_MIN });
  } catch {
    // Best effort. Every later data-plane write attempts to restore the full reserve
    // atomically, and the next control failure remains retryable.
  }
}

/** Establish the shared control-plane headroom before capture listeners process their
 *  first event. Idempotent across MV3 worker restarts, because session storage
 *  outlives the worker. */
export function ensureCaptureHeadroom(): Promise<boolean> {
  return withHeadroomLock(async () => {
    let current: unknown = '';
    try {
      current = await readKey<unknown>(CONTROL_HEADROOM_KEY, '');
    } catch (err) {
      // A one-shot get failure must not poison the worker-wide readiness promise
      // forever. Continue to the idempotent set path; if storage is genuinely
      // unavailable those writes still fail and this still returns false.
      console.warn('[FaceScrap] control headroom read failed; re-establishing reserve', err);
    }
    if (typeof current === 'string' && current.length >= CONTROL_HEADROOM_MIN_BYTES) return true;
    try {
      await chrome.storage.session.set({ [CONTROL_HEADROOM_KEY]: CONTROL_HEADROOM });
      return true;
    } catch {
      try {
        await chrome.storage.session.set({ [CONTROL_HEADROOM_KEY]: CONTROL_HEADROOM_MIN });
        return true;
      } catch (err) {
        console.error('[FaceScrap] control headroom initialization failed', err);
        return false;
      }
    }
  });
}

interface CaptureWriteOptions {
  /** Pin writes are retried by the panel render loop; keeping their first non-quota
   *  failure observable avoids reporting an unconfirmed reservation. */
  retryTransient?: boolean;
  /** Smaller equivalent state to try before spending reserved headroom. Recent-track
   *  history can compact safely; PlayingRef and the pin cannot. */
  compactValues?: Record<string, unknown>;
}

/** Persist capture CONTROL state with a real success/failure contract. One ordinary
 *  backend hiccup gets an identical retry. Quota pressure first tries a smaller
 *  equivalent payload, then spends the dedicated headroom. It never deletes Library
 *  rows to persist a pointer: before the panel has correlated a new Story, no row can
 *  be proven safe to sacrifice. */
export async function writeCaptureState(
  values: Record<string, unknown>,
  options: CaptureWriteOptions = {},
): Promise<void> {
  let failure: unknown;
  try {
    await chrome.storage.session.set(values);
    return;
  } catch (err) {
    failure = err;
  }

  if (!isStorageQuotaError(failure) && options.retryTransient !== false) {
    try {
      await chrome.storage.session.set(values);
      return;
    } catch (err) {
      failure = err;
    }
  }

  if (!isStorageQuotaError(failure)) throw failure;
  if (options.compactValues != null) {
    try {
      await chrome.storage.session.set(options.compactValues);
      return;
    } catch (err) {
      failure = err;
      if (!isStorageQuotaError(failure)) throw failure;
    }
  }
  const criticalValues = options.compactValues ?? values;
  try {
    await withHeadroomLock(async () => {
      // One observable storage operation both releases the reserved bytes and writes
      // the critical state, so other lanes cannot interleave their own recovery.
      await chrome.storage.session.set({ [CONTROL_HEADROOM_KEY]: '', ...criticalValues });
      await restoreControlHeadroom();
    });
    return;
  } catch (err) {
    failure = err;
  }
  throw failure;
}
