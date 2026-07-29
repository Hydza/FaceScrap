// Recovery entry for already-open tabs after an extension update (a first install goes
// through content.js directly — see service-worker.ts's onInstalled).
//
// One flag is the whole difference from content.js: the detector already living in this
// document survived the update with a dead chrome.* context, so it must be disposed and
// replaced rather than reused. Whether this document ALSO needs a MAIN-world hook is not
// decided here any more — the worker reads page-hook.ts's own <html> stamp and injects
// one only where it is missing (background/content-script-recovery.ts).

// Keeps this file a MODULE now that nothing is imported statically: isolatedModules
// rejects a file whose only import is dynamic, because it has no top-level import or
// export to mark it as one.
export {};

// The import stays DYNAMIC on purpose — a static one hoists and would run content.ts
// before this flag is set. It also FLOATS, and cannot not: esbuild rejects top-level
// await in an iife bundle. So this file's evaluation — and with it the worker's
// executeScript promise — finishes before the detector exists, and only the import being
// inlined (no code splitting) puts the detector on a microtask that runs first.
// background/content-script-recovery.ts says what that ordering is worth and what it
// costs when it slips.
(globalThis as typeof globalThis & { __facescrapForceContentRecovery?: boolean }).__facescrapForceContentRecovery =
  true;
void import('./content');
