// Recovery entry used only for already-open tabs after an extension update.
// The old MAIN-world hook survives the extension API invalidation and still
// owns Facebook's fetch/XHR wrappers. Reinstall the isolated detector without
// wrapping those page APIs a second time on every public/unpacked update.
const recoveryBootstrap = globalThis as typeof globalThis & {
  __facescrapForceContentRecovery?: boolean;
  __facescrapSkipPageHook?: boolean;
};
recoveryBootstrap.__facescrapForceContentRecovery = true;
recoveryBootstrap.__facescrapSkipPageHook = true;
void import('./content');
