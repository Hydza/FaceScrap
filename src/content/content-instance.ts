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

/**
 * Decide whether this content-script pass must install the MAIN-world page hook.
 * Deliberately independent of shouldStartContentInstance: a pass that reuses a
 * live detector — e.g. a fresh navigation whose document_start injection raced an
 * update-recovery injection into the same world — has its detector body skipped,
 * yet the freshly navigated document owns no hook. Gating injection on a
 * per-document marker instead of the instance-start decision keeps that page load
 * from silently losing every GraphQL-origin capture.
 */
export function shouldInjectPageHook(skipRequested: boolean, alreadyInjected: boolean): boolean {
  return !skipRequested && !alreadyInjected;
}
