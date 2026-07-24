export interface RecoverableFacebookTab {
  id?: number;
  url?: string;
}

export interface ContentScriptRecoveryDependencies {
  queryFacebookTabs(): Promise<RecoverableFacebookTab[]>;
  ping(tabId: number): Promise<boolean>;
  inject(tabId: number, file: string): Promise<void>;
  onError?(tabId: number, error: unknown): void;
}

export interface ContentScriptRecoveryResult {
  checked: number;
  injected: number;
}

/**
 * Reinstall the isolated-world detector after an extension update/reload.
 *
 * Chrome invalidates content-script extension APIs when an unpacked or public
 * extension updates, but it does not navigate already-open Facebook tabs. A
 * ping prevents duplicates on tabs whose current detector is still alive; only
 * a missing receiver receives the packaged content.js again.
 */
export function createContentScriptRecoveryCoordinator(
  dependencies: ContentScriptRecoveryDependencies,
): { recover(file?: string): Promise<ContentScriptRecoveryResult> } {
  return {
    async recover(file = 'content.js'): Promise<ContentScriptRecoveryResult> {
      const tabs = await dependencies.queryFacebookTabs();
      let checked = 0;
      let injected = 0;
      for (const tab of tabs) {
        if (typeof tab.id !== 'number') continue;
        checked++;
        try {
          if (await dependencies.ping(tab.id)) continue;
          await dependencies.inject(tab.id, file);
          injected++;
        } catch (error) {
          dependencies.onError?.(tab.id, error);
        }
      }
      return { checked, injected };
    },
  };
}
