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
 * The hook rides along because this is the ONLY caller that can reach those tabs and the
 * only context that knows their ids. The content script used to install it itself, which
 * meant a <script src="chrome-extension://…"> in facebook.com's DOM; the page could see
 * that node and fetch the hook's source from it.
 *
 * Once a step has named a document, every step after it is pinned to that document
 * rather than to frame 0, which follows the FRAME across a navigation. So an install
 * aimed at a document that has since gone REJECTS instead of landing somewhere else —
 * the fail-closed answer the old <script>.onerror gave.
 *
 * The pin only covers the span it can see. Where the ping answered there was no
 * injection to name a document, so the probe itself opens on frame 0 and a tab that
 * navigates before it lands is answered for by whatever document is there — including
 * an fbcdn.net one, a host this extension holds permission for and which carries no
 * declarative entry of its own. Resolving the document once per tab up front would
 * close that too; it is not closed today.
 */
export function createContentScriptRecoveryCoordinator(
  dependencies: ContentScriptRecoveryDependencies,
): { recover(file?: string): Promise<ContentScriptRecoveryResult> } {
  /**
   * Give one document a hook, and only where none is alive. Never rejects: the sweep
   * below runs it per tab and must not stop at the first unreachable one.
   *
   * The probe never saves a round trip — it IS one, and a redundant install would have
   * cost the same. What it buys is the document id on the path where the ping answered
   * and nothing else named one, plus the parse of the hook bundle on a tab that already
   * carries it. It is no longer a correctness rule: page-hook.js installs nothing at all
   * once its own <html> stamp is there (tests/page-hook-idempotent.test.ts), so being
   * wrong here costs a wasted injection rather than a second wrapper on the page's fetch
   * and a second set of window listeners that never come off. That stamp lives in the
   * page's DOM and the page may delete it, which is exactly why the answer is allowed to
   * be wrong.
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
        // Detector first, hook second — as far as this can enforce it. The await above
        // returns when the injected file's TOP-LEVEL evaluation ends, which for content.js
        // is after the detector's window-message listener exists; content-recovery.js only
        // sets a flag and starts a FLOATING import('./content') that nothing can await
        // (esbuild refuses top-level await in an iife bundle). What orders THAT one is the
        // import being inlined, so the detector runs on a microtask that drains before the
        // next injection arrives — a build property, anchored in
        // tests/detection-migration-guardrails.test.ts. Reversed, the cost is the hook's
        // one startup query: its diagnostics window then opens only when the content
        // script announces the flag itself, a storage read later. Captures are never in
        // that window.
        //
        // No longer below the ping's early exit: the probe reads the stamp from the
        // ISOLATED world and needs no detector at all, so a tab whose detector answered
        // but whose hook is gone — loaded while the extension was off, or an install that
        // failed — is repairable without reinjecting a detector it already has.
        await ensurePageHook(tabId, documentId);
      }
      return { checked, injected };
    },
  };
}
