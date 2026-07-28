import {
  DIAG_REASONS,
  sanitizeDiagCounters,
  type DiagCounters,
} from '../shared/diag';
import { sanitizeDiagEvents, type DiagEvent } from '../shared/diag-log';

const DEFAULT_INTERVAL_MS = 1_500;
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
  /** diag-log.ts's ring for the context this observer runs in — its drain and its
   *  flag travel together for exactly the reason workerCounters' do below. */
  workerEvents?: { drain: () => DiagEvent[]; setEnabled: (enabled: boolean) => void };
  /** diag.ts's counters for the context this observer runs in — drain and flag as ONE
   *  option, so a caller cannot wire half of it. The two flags are easy to conflate:
   *  `enabled` below decides whether renderer reports are persisted; `setEnabled` here
   *  decides whether a diagBump raised in THIS context is counted at all. A drain
   *  without its flag can only ever return nothing. */
  workerCounters?: { drain: () => DiagCounters; setEnabled: (enabled: boolean) => void };
  intervalMs?: number;
  maxTabs?: number;
  maxCountPerReason?: number;
  maxPendingEvents?: number;
  schedule?: (task: () => void, delayMs: number) => TimerHandle;
  cancel?: (handle: TimerHandle) => void;
  onError?: (error: unknown) => void;
}

interface DiagObserver {
  setEnabled(enabled: boolean): void;
  report(tabId: number, counters: unknown, events?: unknown): boolean;
  removeTab(tabId: number): void;
  flush(): Promise<void>;
}

function addBounded(target: DiagCounters, source: DiagCounters, max: number): void {
  for (const reason of DIAG_REASONS) {
    const value = source[reason];
    if (value === undefined || value <= 0) continue;
    target[reason] = Math.min(max, (target[reason] ?? 0) + Math.min(value, max));
  }
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
  const pendingEvents: DiagEvent[] = [];
  let droppedEvents = 0;
  let enabled = false;
  let timer: TimerHandle | undefined;
  let flushChain = Promise.resolve();

  const clearTimer = (): void => {
    if (timer === undefined) return;
    cancel(timer);
    timer = undefined;
  };

  const scheduleFlush = (): void => {
    if (!enabled || timer !== undefined) return;
    timer = schedule(() => {
      timer = undefined;
      void api.flush().catch((error) => options.onError?.(error));
    }, intervalMs);
  };

  /** Queue events under the pending bound, dropping oldest first. */
  const queueEvents = (events: readonly DiagEvent[]): void => {
    for (const event of events) {
      pendingEvents.push(event);
      if (pendingEvents.length > maxEvents) {
        pendingEvents.shift();
        droppedEvents += 1;
      }
    }
  };

  const drainPendingEvents = (): DiagEvent[] => {
    const out = pendingEvents.splice(0, pendingEvents.length);
    if (droppedEvents > 0) {
      out.unshift({
        at: Date.now(),
        ctx: 'worker',
        ev: 'logOverflow',
        lvl: 'warn',
        data: { dropped: droppedEvents, where: 'observer' },
      });
      droppedEvents = 0;
    }
    return out;
  };

  const flushOnce = async (): Promise<void> => {
    clearTimer();
    if (!enabled) {
      pending.clear();
      pendingEvents.length = 0;
      droppedEvents = 0;
      options.workerCounters?.drain();
      options.workerEvents?.drain();
      return;
    }

    const aggregate: DiagCounters = {};
    for (const counters of pending.values()) addBounded(aggregate, counters, maxCount);
    pending.clear();
    addBounded(aggregate, sanitizeDiagCounters(options.workerCounters?.drain()), maxCount);
    queueEvents(sanitizeDiagEvents(options.workerEvents?.drain(), maxEvents));
    const events = drainPendingEvents();
    if (events.length > 0 && options.writeEvents != null) {
      try {
        await options.writeEvents(events);
      } catch (error) {
        // Same retention contract as the counters below: a transient local-storage
        // failure must not make the coalescer itself lossy. Requeued at the FRONT so
        // the retained trace keeps its order.
        pendingEvents.unshift(...events.slice(-maxEvents));
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
    setEnabled(on): void {
      // Only on a real change: setting the flag CLEARS the counters, and the worker calls
      // this on every settings write, so re-asserting it would wipe the accumulated counts
      // whenever an unrelated setting moved.
      if (enabled !== on) {
        options.workerCounters?.setEnabled(on);
        options.workerEvents?.setEnabled(on);
      }
      enabled = on;
      if (on) return;
      clearTimer();
      pending.clear();
      pendingEvents.length = 0;
      droppedEvents = 0;
      options.workerCounters?.drain();
      options.workerEvents?.drain();
    },

    report(tabId, counters, events): boolean {
      if (!enabled || !Number.isInteger(tabId) || tabId < 0) return false;
      const clean = sanitizeDiagCounters(counters);
      // Stamped with the tab they came from: the trace is read across tabs, and a
      // renderer cannot name its own tab id (it has no way to know it).
      const cleanEvents = sanitizeDiagEvents(events, maxEvents).map((event) => ({
        ...event,
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
