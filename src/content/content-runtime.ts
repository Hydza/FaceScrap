// The content script's lifetime, in one place.
//
// After the extension is reloaded or updated this script keeps running in the
// already-open page, but its chrome.* context is dead — calls then throw "Extension
// context invalidated" SYNCHRONOUSLY, so a .catch() cannot help. Every chrome.* call
// goes through here, and the first failure tears the whole detector down.
//
// Each band of the detector registers its own cleanup with onTeardown, so teardown()
// is a list of disposals rather than a growing pile of timer variables that a new band
// can silently forget to add itself to.

import type { ContentScriptPingAck, ContentScriptPingMsg, RuntimeMessage } from '../shared/messages';
import type { ContentScriptInstance } from './content-instance';

export interface ContentRuntime {
  /** The extension context is still usable AND this instance has not been replaced. */
  alive: () => boolean;
  isDisposed: () => boolean;
  /** Fire-and-forget. A dead context tears the detector down instead of throwing. */
  send: (message: RuntimeMessage) => void;
  /** Identifies THIS document to the worker; also the epoch for per-load video marks. */
  documentToken: string;
  /** Every DOM/window listener registers with this, so teardown detaches them at once. */
  signal: AbortSignal;
  onTeardown: (dispose: () => void) => void;
  teardown: () => void;
}

function mintDocumentToken(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) =>
    part.toString(16).padStart(8, '0'),
  ).join('-');
}

/** Publishes `instance` on the bootstrap object so update recovery can find and
 *  dispose it, and answers the worker's liveness ping. Call before any asynchronous
 *  setup: the worker must be able to tell a live detector from an invalidated one
 *  before it reinjects the packaged script into an already-open tab. */
export function createContentRuntime(publish: (instance: ContentScriptInstance) => void): ContentRuntime {
  const chromeRuntime = ((): typeof chrome.runtime | undefined => {
    try {
      return chrome.runtime;
    } catch {
      return undefined;
    }
  })();

  const listeners = new AbortController();
  const disposals: (() => void)[] = [];
  let disposed = false;

  const instance: ContentScriptInstance = {
    active: true,
    alive: () => {
      try {
        return instance.active && Boolean(chromeRuntime?.id);
      } catch {
        return false;
      }
    },
    dispose: () => teardown(),
  };
  publish(instance);

  const documentToken = mintDocumentToken();

  const handlePing = (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): void => {
    const ping = message as Partial<ContentScriptPingMsg> | undefined;
    if (ping?.type !== 'FACESCRAP_CONTENT_PING') return;
    sendResponse({ ok: true, documentToken } satisfies ContentScriptPingAck);
  };
  try {
    chromeRuntime?.onMessage.addListener(handlePing);
  } catch {
    /* extension context already invalidated */
  }

  function teardown(): void {
    if (disposed) return;
    disposed = true;
    instance.active = false;
    try {
      chromeRuntime?.onMessage.removeListener(handlePing);
    } catch {
      /* extension context already invalidated */
    }
    // Reverse order, so a band never tears down while one that set up after it — and
    // may still call into it — is alive.
    for (const dispose of disposals.reverse()) {
      try {
        dispose();
      } catch (error) {
        console.error('[FaceScrap] content teardown step failed', error);
      }
    }
    listeners.abort();
  }

  return {
    alive: () => instance.alive(),
    isDisposed: () => disposed,
    send: (message) => {
      if (disposed) return;
      if (!instance.alive()) {
        teardown();
        return;
      }
      try {
        void chrome.runtime.sendMessage(message).catch(() => {});
      } catch {
        teardown();
      }
    },
    documentToken,
    signal: listeners.signal,
    onTeardown: (dispose) => disposals.push(dispose),
    teardown,
  };
}
