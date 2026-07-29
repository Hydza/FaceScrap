export interface ContentScriptInstance {
  active: boolean;
  alive: () => boolean;
  dispose: () => void;
}

/**
 * Decide whether this document needs a detector instance.
 *
 * Ordinary duplicate injections reuse a live instance. Recovery injection is
 * different: it runs only after the worker failed to ping the receiver, so it
 * must replace even a stale handle whose cached runtime id still looks truthy.
 */
export function shouldStartContentInstance(
  existing: Partial<ContentScriptInstance> | undefined,
  forceRecovery: boolean,
): boolean {
  if (forceRecovery) {
    try {
      existing?.dispose?.();
    } catch {
      /* stale instance cleanup must never block the replacement detector */
    }
    if (existing != null) {
      try {
        existing.active = false;
      } catch {
        /* a foreign/frozen legacy handle cannot block recovery */
      }
    }
    return true;
  }

  try {
    return existing?.alive?.() !== true;
  } catch {
    return true;
  }
}

// Gone from here: shouldInjectPageHook. The content script no longer installs the
// MAIN-world hook, so there is no per-pass decision left to make — the worker asks the
// document itself whether one is alive (background/content-script-recovery.ts).
