// Recovery entry for already-open tabs after an extension update (a first install goes
// through content.js directly — see service-worker.ts's onInstalled).
//
// The recovery flag replaces a detector whose chrome.* context was invalidated.
// The worker independently probes and restores the MAIN-world hook.

// Mark this dynamic-import entry as a module for isolatedModules.
export {};

// Keep the import dynamic so the recovery flag is set first. The IIFE build cannot
// use top-level await, so the inlined import starts the detector on a microtask.
(globalThis as typeof globalThis & { __facescrapForceContentRecovery?: boolean }).__facescrapForceContentRecovery =
  true;
void import('./content');
