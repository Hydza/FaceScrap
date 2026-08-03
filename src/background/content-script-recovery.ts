interface RecoverableFacebookTab {
  id?: number;
  url?: string;
}

/** What one probe answered, and WHICH document answered it. A probe that ran always
 *  reports its document; the absent case is the caller's own failure value below. */
interface PageHookProbe {
  hooked: boolean;
  documentId?: string;
}

interface ContentScriptRecoveryDependencies {
  queryFacebookTabs(): Promise<RecoverableFacebookTab[]>;
  ping(tabId: number): Promise<boolean>;
  /** Inject the detector, and answer with the document it landed in. */
  inject(tabId: number, file: string): Promise<string | undefined>;
  /** Is a MAIN-world hook already alive in this document? */
  hasPageHook(tabId: number, documentId: string | undefined): Promise<PageHookProbe>;
  installPageHook(tabId: number, documentId: string | undefined): Promise<void>;
  /** Every per-tab failure, detector or hook. The composition root picks the channel —
   *  this module deliberately reaches no logger of its own. */
  onError?(tabId: number, error: unknown): void;
}

interface ContentScriptRecoveryResult {
  checked: number;
  injected: number;
}

/**
 * Reinstall the isolated-world detector — and, where it is missing, the MAIN-world page
 * hook — after an extension update/reload.
 *
 * Chrome invalidates content-script extension APIs when an unpacked or public
 * extension updates, but it does not navigate already-open Facebook tabs. A
 * ping prevents duplicates on tabs whose current detector is still alive; only
 * a missing receiver receives the packaged content.js again.
 *
 * The worker injects the hook directly into the MAIN world without exposing an
 * extension URL in the page DOM.
 *
 * Once a step has named a document, every step after it is pinned to that document
 * rather than to frame 0, which follows the FRAME across a navigation. So an install
 * aimed at a document that has since gone rejects instead of landing elsewhere.
 *
 * The pin only covers the span it can see. Where the ping answered there was no
 * injection to name a document, so the probe itself opens on frame 0 and a tab that
 * navigates before it lands may answer from the new document. Host and frame checks
 * keep subsequent work scoped to supported pages.
 */
export function createContentScriptRecoveryCoordinator(
  dependencies: ContentScriptRecoveryDependencies,
): { recover(file?: string): Promise<ContentScriptRecoveryResult> } {
  /**
   * Give one document a hook, and only where none is alive. Never rejects: the sweep
   * below runs it per tab and must not stop at the first unreachable one.
   *
   * The probe supplies a document id and avoids parsing the hook bundle when the
   * document stamp is present. Redundant injection is safe because the hook installs
   * nothing when it finds that stamp.
   */
  async function ensurePageHook(tabId: number, documentId?: string): Promise<void> {
    // Its own catch, answering "no hook": a probe that could not run has told us nothing,
    // and of the two ways to be wrong that is the survivable one — a document with no hook
    // loses every GraphQL response, while a document that is really gone rejects the
    // install below as well. A try block rather than .catch(), so a dependency that throws
    // synchronously cannot make this reject after all.
    let probe: PageHookProbe;
    try {
      probe = await dependencies.hasPageHook(tabId, documentId);
    } catch {
      probe = { hooked: false };
    }
    if (probe.hooked) return;
    try {
      // The probe's document when it ran, the injected one otherwise: the catch above
      // synthesises no id, and falling back keeps a failed probe pinned rather than
      // reopening on frame 0.
      await dependencies.installPageHook(tabId, probe.documentId ?? documentId);
    } catch (error) {
      // Reported like any other per-tab failure. This one is read long afterwards, from a
      // tab that captures nothing, so the worker points onError at the trace rather than
      // at the console alone.
      dependencies.onError?.(tabId, error);
    }
  }

  return {
    async recover(file = 'content.js'): Promise<ContentScriptRecoveryResult> {
      const tabs = await dependencies.queryFacebookTabs();
      let checked = 0;
      let injected = 0;
      for (const tab of tabs) {
        if (typeof tab.id !== 'number') continue;
        const tabId = tab.id;
        checked++;
        let documentId: string | undefined;
        try {
          if (!(await dependencies.ping(tabId))) {
            documentId = await dependencies.inject(tabId, file);
            injected++;
          }
        } catch (error) {
          // A ping or an injection that threw leaves nothing to hook — the document is
          // unreachable, and probing it would only report the same cause twice.
          dependencies.onError?.(tabId, error);
          continue;
        }
        // Evaluate the detector before injecting the hook. Recovery starts its inlined
        // detector import on a microtask, which runs before the next injection.
        // Probe the hook independently even when the detector ping succeeds.
        await ensurePageHook(tabId, documentId);
      }
      return { checked, injected };
    },
  };
}
