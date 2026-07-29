import {
  addBoundedCounters,
  DIAG_REASONS,
  sanitizeDiagCounters,
  type DiagCounters,
} from '../shared/diag';
import { createEventRing, sanitizeDiagEvents, type DiagEvent } from '../shared/diag-log';

/** How long renderer reports are coalesced before they reach storage. Raised from
 *  1.5 s when the log became permanent: this interval IS the storage write rate, and
 *  a read-modify-write of the whole stored trace every 1.5 s for the life of the
 *  install is the one cost of always-on that no cap bounds. Five seconds still sits
 *  well inside the ~30 s a service worker stays alive after the activity that produced
 *  the events, so a flush is never left to a worker that has already been reaped. */
const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_MAX_TABS = 128;
const DEFAULT_MAX_COUNT = 1_000_000;
/** Renderer events held between flushes. Coalescing at all is what keeps a scroll
 *  burst from turning one storage write per report into hundreds; this bounds how
 *  much a burst can retain while it waits. The oldest are dropped, and the drop is
 *  reported as its own event rather than silently narrowing the window. */
const DEFAULT_MAX_PENDING_EVENTS = 1_000;

type TimerHandle = unknown;

interface DiagObserverOptions {
  write: (delta: DiagCounters) => Promise<void>;
  /** Persist the coalesced event trace. Optional so a test can drive the counter
   *  half on its own; when absent, events are accepted and discarded. */
  writeEvents?: (events: DiagEvent[]) => Promise<void>;
  /** diag-log.ts's ring for the context this observer runs in, so the worker's own
   *  trace joins the renderer write instead of causing a second one. */
  workerEvents?: { drain: () => DiagEvent[] };
  /** diag.ts's counters for the context this observer runs in, for the same reason. */
  workerCounters?: { drain: () => DiagCounters };
  intervalMs?: number;
  maxTabs?: number;
  maxCountPerReason?: number;
  maxPendingEvents?: number;
  schedule?: (task: () => void, delayMs: number) => TimerHandle;
  cancel?: (handle: TimerHandle) => void;
  onError?: (error: unknown) => void;
}

interface DiagObserver {
  report(tabId: number, counters: unknown, events?: unknown): boolean;
  removeTab(tabId: number): void;
  flush(): Promise<void>;
}

/** The receiver's own bound, applied even where the content script already
 *  sanitized: only whitelisted reasons survive, and no total runs past
 *  maxCountPerReason. The summing rule itself is diag.ts's — the content script's
 *  coalescer runs the same one against its own, larger bound. */
function addBounded(target: DiagCounters, source: DiagCounters, max: number): void {
  addBoundedCounters(target, source, DIAG_REASONS, max);
}

/**
 * Coalesces renderer diagnostics before persistence. The scheduler is injected
 * so tests can drive flushes without real timers, and the receiver applies its
 * own whitelist/count bounds even when the content script already sanitized.
 */
export function createDiagObserver(options: DiagObserverOptions): DiagObserver {
  const intervalMs = Math.max(100, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const maxTabs = Math.max(1, options.maxTabs ?? DEFAULT_MAX_TABS);
  const maxCount = Math.max(1, options.maxCountPerReason ?? DEFAULT_MAX_COUNT);
  const maxEvents = Math.max(1, options.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS);
  const schedule = options.schedule ?? ((task, delay) => setTimeout(task, delay));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const pending = new Map<number, DiagCounters>();
  const pendingEvents = createEventRing(maxEvents);
  let timer: TimerHandle | undefined;
  let flushChain = Promise.resolve();

  const clearTimer = (): void => {
    if (timer === undefined) return;
    cancel(timer);
    timer = undefined;
  };

  const scheduleFlush = (): void => {
    if (timer !== undefined) return;
    timer = schedule(() => {
      timer = undefined;
      void api.flush().catch((error) => options.onError?.(error));
    }, intervalMs);
  };

  /** The ring bounds itself, dropping oldest first; this only spreads one report
   *  across it. */
  const queueEvents = (events: readonly DiagEvent[]): void => {
    for (const event of events) pendingEvents.push(event);
  };

  const flushOnce = async (): Promise<void> => {
    clearTimer();

    const aggregate: DiagCounters = {};
    for (const counters of pending.values()) addBounded(aggregate, counters, maxCount);
    pending.clear();
    addBounded(aggregate, sanitizeDiagCounters(options.workerCounters?.drain()), maxCount);
    queueEvents(sanitizeDiagEvents(options.workerEvents?.drain(), maxEvents));
    // `where` names which ring lost events: this one coalesces across every tab, so
    // its gap is not the same gap a renderer's own ring reports.
    const events = pendingEvents.drain('worker', { where: 'observer' });
    if (events.length > 0 && options.writeEvents != null) {
      try {
        await options.writeEvents(events);
      } catch (error) {
        // Same retention contract as the counters below: a transient local-storage
        // failure must not make the coalescer itself lossy. Requeued at the FRONT so
        // the retained trace keeps its order.
        pendingEvents.requeue(events);
        scheduleFlush();
        options.onError?.(error);
      }
    }
    if (Object.keys(aggregate).length > 0) {
      try {
        await options.write(aggregate);
      } catch (error) {
        // Diagnostics are best-effort, but a transient local-storage failure
        // should not make the coalescer itself lossy. A reserved internal bucket
        // retains the already-aggregated delta without expanding the tab map.
        const retry = pending.get(-1) ?? {};
        addBounded(retry, aggregate, maxCount);
        pending.set(-1, retry);
        scheduleFlush();
        throw error;
      }
    }
    if (pending.size > 0 || pendingEvents.length > 0) scheduleFlush();
  };

  const api: DiagObserver = {
    report(tabId, counters, events): boolean {
      if (!Number.isInteger(tabId) || tabId < 0) return false;
      const clean = sanitizeDiagCounters(counters);
      // Stamped with the tab they came from: the trace is read across tabs, and a
      // renderer cannot name its own tab id (it has no way to know it). The origin is
      // stamped too, and NOT taken from the sender: `ctx` is one of a known set, so a
      // forged report could otherwise arrive labelled `worker` and be read as ours.
      // Everything reaching this function came from a renderer by definition.
      const cleanEvents: DiagEvent[] = sanitizeDiagEvents(events, maxEvents).map((event) => ({
        ...event,
        ctx: event.ctx === 'hook' ? 'hook' : 'content',
        data: { ...event.data, tab: tabId },
      }));
      if (Object.keys(clean).length === 0 && cleanEvents.length === 0) return false;
      queueEvents(cleanEvents);

      if (Object.keys(clean).length > 0) {
        let tabCounters = pending.get(tabId);
        if (!tabCounters) {
          // The tab cap bounds the COUNTER map only. Events are already bounded by
          // maxEvents as one shared ring, so a report from a 129th tab still keeps
          // its trace instead of vanishing.
          if (pending.size >= maxTabs) {
            scheduleFlush();
            return cleanEvents.length > 0;
          }
          tabCounters = {};
          pending.set(tabId, tabCounters);
        }
        addBounded(tabCounters, clean, maxCount);
      }
      scheduleFlush();
      return true;
    },

    removeTab(tabId): void {
      pending.delete(tabId);
      if (pending.size === 0) clearTimer();
    },

    flush(): Promise<void> {
      flushChain = flushChain.then(flushOnce, flushOnce);
      return flushChain;
    },
  };

  return api;
}
