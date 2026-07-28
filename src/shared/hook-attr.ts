// The one DOM mark that answers "is a MAIN-world page hook alive in this document?"
//
// page-hook.ts stamps it on <html> before it does anything else; content.ts and
// content-recovery.ts read it to decide whether to inject another hook. Those three
// files live in TWO JS worlds that share no globals — only the DOM — so this string
// is their entire contract, and it was hand-copied into each of them.
//
// Chrome-free on purpose: this is the one shared module the MAIN-world bundle may
// import (see i18n.ts's header for what must NOT go there).

export const HOOK_ALIVE_ATTR = 'data-facescrap-hook';
