// Recovery entry used only for already-open tabs after an extension update
// (see service-worker.ts's onInstalled handler — a first install goes
// through content.js directly, with no old hook to preserve).
//
// manifest.json also registers page-hook.js as a declarative MAIN-world,
// document_start content script now, so most documents get it installed by
// Chrome itself, independent of anything content.ts does. That declarative
// pass can never reach THIS document, though: it only fires at a fresh
// navigation, and an already-open tab finished loading before the background
// reached for it. So the only hook this document can have is one a PREVIOUS
// pass of this same script chain already confirmed, before whatever killed
// its chrome.* context — the old MAIN-world hook survives that invalidation
// and still owns Facebook's fetch/XHR wrappers, but only when it actually
// installed in the first place. __facescrapHookInjected is latched true by
// content.ts's ensurePageHook() on a confirmed runtime <script> load, or by
// its message listener the instant page-hook.js's own startup announcement
// arrives — but that announcement is a cross-realm postMessage caught by a
// listener content.ts registers hundreds of lines into its own module
// evaluation, and for a declaratively-installed hook nothing orders that
// listener's registration ahead of page-hook.js's one-shot, never-retried
// query. If that race is lost, the flag stays false/missing forever for a
// document whose hook is genuinely alive — so, unlike before, that alone is
// NOT proof no hook survives.
//
// page-hook.ts also stamps HOOK_ALIVE_ATTR on document.documentElement before
// doing anything else (see its own "Idempotency" comment). Unlike the flag,
// that mark needs no message and nothing to race: both worlds share the DOM,
// so it is readable directly, at any later time, for as long as the document
// exists — exactly this file's situation, running an unknowable amount of
// time after the original hook (if any) installed. Trust the flag OR the DOM
// mark, so a lost message can no longer make this file reinject a second hook
// alongside one that is genuinely still alive. (page-hook.ts's own
// alreadyHooked guard is the backstop if this check is ever wrong anyway —
// see page-hook.ts — but getting this right avoids the wasted reinjection too.)
const HOOK_ALIVE_ATTR = 'data-facescrap-hook';
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
