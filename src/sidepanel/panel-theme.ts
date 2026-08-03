// Which theme the panel paints, and the two signals that can change it under it:
// the OS preference and the Facebook tab's own theme.
//
// Reads the panel's preference and tracked tab through thunks handed in at setup, so
// this module never owns either.

import { getFacebookTheme, facebookThemeKey } from '../shared/storage';
import type { Settings } from '../shared/settings';
import { resolveEffectiveTheme, type EffectiveTheme } from '../shared/theme';

interface ThemeInputs {
  theme: () => Settings['theme'];
  trackedTab: () => number | undefined;
}

// Defaults resolve from the system alone, so a call landing before setup is still
// correct rather than a crash.
let read: ThemeInputs = { theme: () => 'auto', trackedTab: () => undefined };
let systemThemeQuery: MediaQueryList | undefined;
let revisionCounter = 0;

function getSystemTheme(): EffectiveTheme {
  // Keep the dark appearance on Chromium forks where
  // matchMedia is unavailable. Manual light/dark still resolves above it.
  return systemThemeQuery == null || systemThemeQuery.matches ? 'dark' : 'light';
}

/**
 * Resolve the preference into the one effective theme painted on <html>. Revision and
 * tab guards stop a slow read for the outgoing tab from winning after a tab switch or
 * a preference change.
 *
 * themeChoice defaults to the committed setting; the optimistic write path passes the
 * pending value, since the panel's `settings` is only reassigned once the durable
 * write lands.
 */
export async function applyEffectiveTheme(themeChoice: Settings['theme'] = read.theme()): Promise<void> {
  const revision = ++revisionCounter;
  const trackedTab = read.trackedTab();

  if (themeChoice !== 'auto') {
    document.documentElement.dataset.theme = resolveEffectiveTheme(themeChoice, undefined, getSystemTheme());
    return;
  }

  const facebookTheme = trackedTab === undefined ? null : await getFacebookTheme(trackedTab);
  if (revision !== revisionCounter || trackedTab !== read.trackedTab()) return;
  document.documentElement.dataset.theme = resolveEffectiveTheme(
    themeChoice,
    facebookTheme?.theme,
    getSystemTheme(),
  );
}

/** Call before the panel's first storage read, so a theme signal persisted during
 *  startup cannot fall into a read/listener gap. */
export function setupPanelTheme(inputs: ThemeInputs): void {
  read = inputs;

  chrome.storage.session.onChanged.addListener((changes) => {
    const tab = read.trackedTab();
    if (read.theme() === 'auto' && tab !== undefined && facebookThemeKey(tab) in changes) {
      void applyEffectiveTheme();
    }
  });

  if (typeof window.matchMedia !== 'function') return;
  systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const onSystemChange = (): void => {
    if (read.theme() === 'auto') void applyEffectiveTheme();
  };
  // addListener is the pre-standard spelling, still the only one on some Chromium forks.
  if (typeof systemThemeQuery.addEventListener === 'function') {
    systemThemeQuery.addEventListener('change', onSystemChange);
  } else if (typeof systemThemeQuery.addListener === 'function') {
    systemThemeQuery.addListener(onSystemChange);
  }
  window.addEventListener('pagehide', () => {
    if (typeof systemThemeQuery?.removeEventListener === 'function') {
      systemThemeQuery.removeEventListener('change', onSystemChange);
    } else if (typeof systemThemeQuery?.removeListener === 'function') {
      systemThemeQuery.removeListener(onSystemChange);
    }
  });
}
