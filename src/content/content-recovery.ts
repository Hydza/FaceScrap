// Recovery entry for already-open tabs after an extension update (a first install goes
// through content.js directly — see service-worker.ts's onInstalled).
//
// manifest.json's declarative MAIN-world page-hook.js only fires on a fresh navigation,
// so it can never reach THIS document: the only hook an already-open tab can have is one
// a previous pass of this script chain installed, which survives the chrome.* context
// invalidation and still owns Facebook's fetch/XHR wrappers.
//
// __facescrapHookInjected can be false even when a hook IS alive: it is latched by a
// cross-realm postMessage that content.ts's listener may be registered too late to catch,
// and that announcement is never retried. So the flag alone is not proof of absence.
// page-hook.ts also stamps HOOK_ALIVE_ATTR on <html> before anything else runs, and both
// worlds share the DOM, so that mark is readable at any later time with no race. Trust
// the flag OR the mark, and a lost message can no longer cause a second hook.
import { HOOK_ALIVE_ATTR } from '../shared/hook-attr';

const recoveryBootstrap = globalThis as typeof globalThis & {
  __facescrapForceContentRecovery?: boolean;
  __facescrapSkipPageHook?: boolean;
  __facescrapHookInjected?: boolean;
};
recoveryBootstrap.__facescrapForceContentRecovery = true;
let domHookAlive = false;
try {
  domHookAlive = document.documentElement.hasAttribute(HOOK_ALIVE_ATTR);
} catch {
  /* DOM unavailable is not expected this late, but must never block recovery */
}
if (recoveryBootstrap.__facescrapHookInjected === true || domHookAlive) {
  recoveryBootstrap.__facescrapSkipPageHook = true;
}
void import('./content');
