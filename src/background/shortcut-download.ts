// The one keyboard shortcut that works while the user is on facebook.com.
//
// Declared in manifest.json under "commands", so Chrome intercepts the combination before the
// page: unlike a content script reading keys it cannot collide with Facebook's own, and unlike the
// panel's bindings (settings.keymap) it does not need the panel focused.
//
// It runs the in-page button's own handler with the active tab as the sender. That tab comes from
// chrome.tabs, which no page can forge, so every guard that handler applies to the button — a
// Facebook tab, not dead, every URL resolved from capture state the worker already owns — applies
// here unchanged. Factored out of the worker's module scope so it can be driven by a test without
// evaluating the whole worker.

import type { ShortcutResultMsg } from '../shared/messages';

export const DOWNLOAD_PLAYING_COMMAND = 'download-playing';

interface ShortcutDeps {
  /** The tab the shortcut acts on. Rejections resolve to nothing rather than escaping. */
  activeTab: () => Promise<{ id?: number; url?: string } | undefined>;
  /** The in-page button's handler, called with a synthesized sender. */
  run: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => unknown;
  /** Tell the tab how it went, so the in-page button can show it on its own glyph. */
  report: (tabId: number, message: ShortcutResultMsg) => void;
  onError?: (error: string | undefined) => void;
}

export function createShortcutHandler(deps: ShortcutDeps): (command: string) => void {
  return (command) => {
    if (command !== DOWNLOAD_PLAYING_COMMAND) return;
    void (async () => {
      const tab = await deps.activeTab();
      if (tab?.id == null) return;
      const tabId = tab.id;
      deps.run({ type: 'FACESCRAP_REQUEST_PLAYING_DOWNLOAD' }, { tab } as chrome.runtime.MessageSender, (response) => {
        const answer = response as { ok?: boolean; error?: string } | undefined;
        const ok = answer?.ok === true;
        if (!ok) deps.onError?.(answer?.error);
        deps.report(tabId, { type: 'FACESCRAP_SHORTCUT_RESULT', ok });
      });
    })();
  };
}
