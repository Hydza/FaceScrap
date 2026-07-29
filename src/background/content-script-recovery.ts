import { diagError } from '../shared/diag-log';

interface RecoverableFacebookTab {
  id?: number;
  url?: string;
}

/** What one probe answered, and WHICH document answered it — the identity every later
 *  step is pinned to. */
interface PageHookProbe {
  hooked: boolean;
  /** Absent only when the probe itself could not run. */
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
 * Every step after the first targets a DOCUMENT, never frame 0 again. inject → probe →
 * install is three IPC round trips, and frame 0 follows the FRAME across a navigation
 * inside that window. Pinning buys two things: a document that has gone makes the
 * injection reject rather than land somewhere else (the fail-closed answer the old
 * <script>.onerror gave), and a tab that navigated to fbcdn.net mid-sequence — a host
 * this extension holds permission for, with no declarative entry of its own — does not
 * get the hook evaluated in a media document's MAIN world.
 */
export function createContentScriptRecoveryCoordinator(
  dependencies: ContentScriptRecoveryDependencies,
): { recover(file?: string): Promise<ContentScriptRecoveryResult> } {
  /**
   * Give one document a hook, and only where none is alive. Never rejects: the sweep
   * below runs it per tab and must not stop at the first unreachable one.
   *
   * "Only where none is alive" is an optimisation now, not a correctness rule:
   * page-hook.js installs nothing at all once its own <html> stamp is there
   * (tests/page-hook-idempotent.test.ts), so a redundant injection costs a round trip
   * rather than another wrapper on the page's fetch and another set of window listeners
   * that never come off.
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
      await dependencies.installPageHook(tabId, probe.documentId ?? documentId);
    } catch (error) {
      // Not onError: that is a console.warn, and this failure is only ever read long
      // afterwards, from a tab that captures nothing. diagError writes both — live, and
      // into the exported trace.
      diagError('page hook install failed', error, { tab: tabId });
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
