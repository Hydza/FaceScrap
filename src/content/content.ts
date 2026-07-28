// FaceScrap content script (ISOLATED world).
//
// Two jobs, in this order:
//   1. Make sure the MAIN-world page hook is installed. An isolated content script
//      cannot patch the page's fetch/XHR, and reading Facebook's own GraphQL responses
//      is what yields complete quality ladders. This half runs even when the detector
//      does not, because a live detector does not prove a live hook.
//   2. Start the detector, if this document does not already have one.
//
// The detector itself is five bands in their own modules (relay, theme, diagnostics, DOM
// scan, playing detection) wired together at the bottom of this file. They share one
// lifecycle object and no state; content-runtime.ts explains why that matters.

import {
  shouldInjectPageHook,
  shouldStartContentInstance,
  type ContentScriptInstance,
} from './content-instance';
import { HOOK_ALIVE_ATTR } from '../shared/hook-attr';
import { setupDiagChannel } from './content-diag';
import { setupDomScan } from './content-dom-scan';
import { setupMediaRelay } from './content-media-relay';
import { setupPageHookIngress } from './content-page-hook';
import { setupPlayingDetection } from './content-playing';
import { createContentRuntime } from './content-runtime';
import { setupThemeSignal } from './content-theme';

const contentBootstrap = globalThis as typeof globalThis & {
  __facescrapContentInstance?: ContentScriptInstance;
  __facescrapForceContentRecovery?: boolean;
  __facescrapSkipPageHook?: boolean;
  __facescrapHookInjected?: boolean;
};
const skipPageHookInjection = contentBootstrap.__facescrapSkipPageHook === true;
const forceContentRecovery = contentBootstrap.__facescrapForceContentRecovery === true;
delete contentBootstrap.__facescrapSkipPageHook;
delete contentBootstrap.__facescrapForceContentRecovery;

const existingContentInstance = contentBootstrap.__facescrapContentInstance;
const startContentInstance = shouldStartContentInstance(
  existingContentInstance,
  forceContentRecovery,
);

// page-hook.ts stamps this on <html> before anything else, so it answers "is a hook
// alive here" with no ordering dependency. __facescrapHookInjected cannot: it is set
// by a cross-realm message this file's listener may be registered too late to catch.
function pageHookAliveInDom(): boolean {
  try {
    return document.documentElement.hasAttribute(HOOK_ALIVE_ATTR);
  } catch {
    return false;
  }
}

// Fallback installer for the ONE case the declarative entry cannot reach.
// manifest.json registers page-hook.js as a MAIN-world document_start script, so
// Chrome installs it before any page script runs — no race, no help needed here. The
// gap is a document that already finished loading before the background reached for
// it: executeScript re-injecting into an ALREADY-OPEN tab (a first install finding one,
// or update recovery). The readyState check below is what tells the two apart.
function ensurePageHook(): void {
  if (!shouldInjectPageHook(skipPageHookInjection, contentBootstrap.__facescrapHookInjected === true || pageHookAliveInDom())) {
    return;
  }
  // 'loading' holds only for the window between navigation commit and the end
  // of HTML parsing — exactly the window every document_start content script,
  // in either world, is guaranteed to run within (Chrome injects them all
  // before any DOM is constructed). A readyState past 'loading' proves this
  // pass was injected LATE, after that window closed, so no declarative
  // MAIN-world pass is coming for this document — fall through to the runtime
  // fallback below. Still 'loading' means the opposite: the declarative entry
  // fired (or is firing) for this same document already, so injecting again
  // here would only wrap fetch/XHR a second time.
  if (document.readyState === 'loading') return;
  try {
    const url = chrome.runtime.getURL('page-hook.js');
    const s = document.createElement('script');
    s.src = url;
    // Latch only once the browser CONFIRMS the load. Latching on injection instead
    // marks a document hooked when the fetch failed (an update invalidating the old
    // chrome-extension:// URL), and content-recovery's later passes then trust that
    // stale flag and keep skipping reinjection. A redundant load is the safe
    // direction: page-hook.js has its own alreadyHooked guard.
    s.onload = () => {
      contentBootstrap.__facescrapHookInjected = true;
      s.remove();
    };
    s.onerror = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch {
    /* context gone or DOM not ready */
  }
}
ensurePageHook();


// ── Start the detector ────────────────────────────────────────────────────────
//
// Bands in dependency order, each handed the runtime so it registers its own cleanup.
// Nothing above runs at import time: the modules export setup functions precisely so
// this order — not module resolution order — is what decides it.

if (!startContentInstance) {
  // Another live instance already owns this document. The bootstrap above still ran,
  // because a MAIN-world hook may still be missing even when the detector is not.
} else {
  const runtime = createContentRuntime((instance) => {
    contentBootstrap.__facescrapContentInstance = instance;
  });
  // Fixed for this script's whole lifetime, so it is decided once rather than re-tested
  // on every coalesced schedule.
  const usesAnimation = typeof window.requestAnimationFrame === 'function';
  const isPrerendering =
    (document as typeof document & { readonly prerendering?: boolean }).prerendering === true;

  const diag = setupDiagChannel(runtime);
  const scheduleTheme = setupThemeSignal(runtime, usesAnimation);
  const media = setupMediaRelay(runtime, isPrerendering);
  const playing = setupPlayingDetection(runtime, usesAnimation, {
    relay: media.relay,
    scheduleTheme,
    note: diag.note,
  });
  setupDomScan(runtime, {
    relay: media.relay,
    scheduleTheme,
    reportDiag: diag.report,
    note: diag.note,
    onImageLoaded: playing.requestDetect,
  });
  setupPageHookIngress(runtime, {
    relay: media.relay,
    reportDiag: diag.report,
    announceDiag: diag.announce,
    onNavigation: playing.detect,
    onHookProven: () => {
      // Receiving the hook's query at all proves page-hook.js already ran here and
      // patched fetch/XHR, whichever installer delivered it. Latching that is what keeps
      // content-recovery.ts's "did a hook survive" check honest for a document whose hook
      // only ever arrived declaratively, where ensurePageHook's own onload never runs.
      contentBootstrap.__facescrapHookInjected = true;
    },
  });

  // Activation is the one event that can make a batch rejected only for prerendering
  // suddenly acceptable. It fires at most once, so `once` needs no bookkeeping.
  if (isPrerendering) {
    document.addEventListener(
      'prerenderingchange',
      () => {
        media.setPrerendering(false);
        media.pumpNow();
        playing.reassert();
        scheduleTheme();
      },
      { once: true, signal: runtime.signal },
    );
  }
}
