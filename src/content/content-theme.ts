// Facebook's own light/dark theme, observed and relayed so the panel can match it.
//
// Read from computed background colours rather than a class name: Facebook's class
// names are generated and rotate, the colours do not.

import { withTimeout } from '../shared/async';
import { createAckedLatest, type AckedLatestOutcome } from '../shared/acked-latest';
import type { FacebookThemeAck, FacebookThemeMsg } from '../shared/messages';
import { inferFacebookTheme } from '../shared/theme';
import { createFrameCoalescer } from './detection-frame';
import type { ContentRuntime } from './content-runtime';

const THEME_ACK_TIMEOUT_MS = 5_000;
const THEME_RETRY_MS = 1_000;
/** How many inconclusive looks to retry before leaving the theme unreported. Eight seconds, which
 *  is past first paint on any page slow enough to need them. */
const UNDECIDED_LOOK_LIMIT = 8;

function computedBackground(element: Element | null): string | undefined {
  if (element == null || typeof getComputedStyle !== 'function') return undefined;
  try {
    return getComputedStyle(element).backgroundColor;
  } catch {
    return undefined;
  }
}

/** Coalesce into one frame; `usesAnimation` is fixed for this script's whole lifetime,
 *  so it is decided once by the caller rather than re-tested on every schedule. */
export function setupThemeSignal(runtime: ContentRuntime, usesAnimation: boolean): () => void {
  const delivery = createAckedLatest<FacebookThemeMsg>();
  let retryTimer: number | undefined;
  // A look that cannot decide, retried a bounded number of times. The ack retry below covers a
  // rejected send; this covers no send at all, which is what an unpainted surface gives. Nothing
  // else re-runs detect on a page that then sits still.
  let undecidedLooks = 0;
  let undecidedTimer: number | undefined;
  let observer: MutationObserver | undefined;
  let mediaQuery: MediaQueryList | undefined;
  let mediaQueryListener: (() => void) | undefined;

  const scheduleRetry = (): void => {
    if (runtime.isDisposed() || retryTimer !== undefined) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined;
      void delivery.pump(deliver);
    }, THEME_RETRY_MS);
  };

  const deliver = async (message: FacebookThemeMsg): Promise<AckedLatestOutcome> => {
    if (runtime.isDisposed() || !runtime.alive()) {
      if (!runtime.alive()) runtime.teardown();
      return 'retry';
    }
    try {
      const response = (await withTimeout(
        chrome.runtime.sendMessage(message),
        THEME_ACK_TIMEOUT_MS,
        'FACEBOOK_THEME acknowledgement timed out.',
      )) as FacebookThemeAck | undefined;
      if (response?.ok === true) return 'accepted';
      if (response?.ok === false && response.retryable === false) return 'refresh';
      scheduleRetry();
      return 'retry';
    } catch {
      if (!runtime.alive()) runtime.teardown();
      else scheduleRetry();
      return 'retry';
    }
  };

  const detect = (): void => {
    if (runtime.isDisposed()) return;
    let mainSurface: Element | null = null;
    try {
      mainSurface = document.querySelector('main, [role="main"]');
    } catch {
      /* a partial DOM implementation may not support selectors */
    }
    const theme = inferFacebookTheme(
      [computedBackground(document.documentElement), computedBackground(document.body)],
      computedBackground(mainSurface),
    );
    if (theme == null) {
      if (undecidedTimer !== undefined || undecidedLooks >= UNDECIDED_LOOK_LIMIT) return;
      undecidedLooks++;
      undecidedTimer = window.setTimeout(() => {
        undecidedTimer = undefined;
        detect();
      }, THEME_RETRY_MS);
      return;
    }
    undecidedLooks = 0;
    const message: FacebookThemeMsg = {
      type: 'FACEBOOK_THEME',
      theme,
      at: Date.now(),
      documentToken: runtime.documentToken,
    };
    if (!delivery.offer(theme, message)) return;
    void delivery.pump(deliver);
  };

  const frame = createFrameCoalescer(
    detect,
    (callback) => (usesAnimation ? window.requestAnimationFrame(callback) : window.setTimeout(callback, 0)),
    (handle) => {
      if (usesAnimation && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(handle);
      else clearTimeout(handle);
    },
  );

  const schedule = (): void => {
    if (runtime.isDisposed()) return;
    frame.request();
  };

  const observeRoots = (): void => {
    if (observer == null) return;
    try {
      observer.observe(document.documentElement, { attributes: true });
      if (document.body != null) observer.observe(document.body, { attributes: true });
    } catch {
      /* incomplete DOM implementation: event-driven detection remains active */
    }
  };

  try {
    observer = new MutationObserver(schedule);
    observeRoots();
  } catch {
    /* MutationObserver unavailable: lifecycle and media scans still detect theme */
  }

  try {
    if (typeof window.matchMedia === 'function') {
      mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      mediaQueryListener = schedule;
      if (typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', mediaQueryListener);
      } else {
        mediaQuery.addListener(mediaQueryListener);
      }
    }
  } catch {
    mediaQuery = undefined;
    mediaQueryListener = undefined;
  }

  document.addEventListener('DOMContentLoaded', () => {
    observeRoots();
    schedule();
  }, { signal: runtime.signal });

  runtime.onTeardown(() => {
    frame.cancel();
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    if (undecidedTimer !== undefined) clearTimeout(undecidedTimer);
    observer?.disconnect();
    if (mediaQuery != null && mediaQueryListener != null) {
      try {
        if (typeof mediaQuery.removeEventListener === 'function') {
          mediaQuery.removeEventListener('change', mediaQueryListener);
        } else {
          mediaQuery.removeListener(mediaQueryListener);
        }
      } catch {
        /* legacy or detached MediaQueryList */
      }
    }
  });

  schedule();
  return schedule;
}
