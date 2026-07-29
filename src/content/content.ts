// FaceScrap content script (ISOLATED world).
//
// One job: start the detector, if this document does not already have one. Installing the
// MAIN-world page hook is NOT this file's business. manifest.json's declarative entry
// covers every fresh navigation, and the worker covers the already-open tabs it cannot
// (background/content-script-recovery.ts). Doing it here meant appending a
// <script src="chrome-extension://…"> to facebook.com's own head — a node any page script
// can observe, at a URL it can then fetch to read the hook's entire source.
//
// The detector is five bands in their own modules (relay, theme, diagnostics, DOM
// scan, playing detection) wired together at the bottom of this file. They share one
// lifecycle object and no state; content-runtime.ts explains why that matters.

import { shouldStartContentInstance, type ContentScriptInstance } from './content-instance';
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
};
const forceContentRecovery = contentBootstrap.__facescrapForceContentRecovery === true;
delete contentBootstrap.__facescrapForceContentRecovery;

const existingContentInstance = contentBootstrap.__facescrapContentInstance;
const startContentInstance = shouldStartContentInstance(
  existingContentInstance,
  forceContentRecovery,
);

// ── Start the detector ────────────────────────────────────────────────────────
//
// Bands in dependency order, each handed the runtime so it registers its own cleanup.
// Nothing above runs at import time: the modules export setup functions precisely so
// this order — not module resolution order — is what decides it.

if (!startContentInstance) {
  // Another live instance already owns this document — nothing left for this pass to do.
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
