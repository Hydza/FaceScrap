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
        /* a foreign or frozen handle cannot block recovery */
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
