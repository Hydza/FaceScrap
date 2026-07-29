// The one DOM mark that answers "is a MAIN-world page hook alive in this document?"
//
// page-hook.ts stamps it on <html> before it does anything else; the service worker
// reads it back — through chrome.scripting, in the ISOLATED world that shares the same
// DOM — to decide whether an already-open tab still needs a hook. Two JS worlds and a
// third context that share no globals, only this attribute, so the string is their
// entire contract.
//
// Chrome-free on purpose: this is the one shared module the MAIN-world bundle may
// import (see i18n.ts's header for what must NOT go there).

// Deliberately says nothing about this extension. The mark lands on <html> in
// facebook.com's own DOM, so a name that identifies the product hands the page a
// one-selector test for which extension is installed — the attribution the passive
// hook exists to avoid.
export const HOOK_ALIVE_ATTR = 'data-vp-init';
