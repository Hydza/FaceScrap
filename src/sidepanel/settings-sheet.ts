// The Settings surface: four pages, a search over all of them, their controls, and the
// diagnostics export.
//
// Every write goes back out through the `apply` callback handed in at setup — this module
// reads the settings but never owns or persists them. The custom background is the one
// exception, and only because it must NOT ride on a settings write: panel-background.ts
// owns it under its own storage key.
//
// There is no fifth page. A profile archive would mean originating requests for media the
// user is not watching, which is the exact thing ARCHITECTURE.md's passive-hook invariant
// exists to forbid.

import { fmt, getLang, t, type Lang, type MsgKey } from '../shared/i18n';
import { diagLogDrain, formatDiagEvent } from '../shared/diag-log';
import { addDiagEvents, getDiagCounters, getDiagEvents } from '../shared/diag-store';
import { ACCENTS, PANEL_TINTS, type AccentGroup, type AccentId, type PanelTintId } from '../shared/appearance';
import { downloadFilename } from '../shared/download-naming';
import { makeItem } from '../shared/media';
import {
  DEFAULT_KEYMAP,
  isAssignableKey,
  KEY_ACTIONS,
  parseMaxItemsInput,
  sanitizeMaxItemsInput,
  type KeyAction,
  type Settings,
  type SettingsPatch,
} from '../shared/settings';
import { byId, pressOnly } from './format';
import { clearPanelBackground, storePanelBackground } from './panel-background';

interface SheetInputs {
  settings: () => Settings;
  /** The view to hand the nav back to when the sheet closes. */
  currentView: () => string;
  apply: (patch: SettingsPatch) => void;
  /** Auto/EN/ES is one control over two facts — followBrowserLang and the manual choice —
   *  so the controller resolves it: it is the one that owns setLang and the re-render. */
  chooseLang: (choice: 'auto' | Lang) => void;
}

let read: SheetInputs | undefined;
let focusFrame: number | undefined;

// ── Pages ─────────────────────────────────────────────────────────────────────

/** Which page is showing. DOM state, not a setting: reopening Settings on the page you
 *  happened to leave it on is the behaviour, and it should not survive a restart. */
let page = 'general';

/** Show one page. A live search query overrides this — it spans all four pages, so the
 *  strip stays lit on the page you will return to while the results ignore it. */
function showPage(name: string): void {
  const tabs = byId('set-tabs');
  const tab = tabs.querySelector<HTMLButtonElement>(`[data-tab="${name}"]`);
  if (tab == null) return;
  // Disarm any armed capture row. Left armed on a page that is about to be hidden, it would go on
  // swallowing keypresses the grid should get.
  if (capturing != null) {
    capturing = undefined;
    keyRefusal = undefined;
    renderKeymapRows();
  }
  page = name;
  pressOnly(tabs, tab);
  applySearch();
  // Back to the top: the pages differ in length, and a preserved scroll offset lands mid-card.
  byId('set-body').scrollTop = 0;
}

// ── Search ────────────────────────────────────────────────────────────────────

/** Fold accents in both indexed copy and typed queries for accent-insensitive search. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/** Every row the search can match, plus the card and the overline above it — both of
 *  which have to disappear when every row under them does, or the page fills with
 *  empty headed cards.
 *
 *  Exported for localize(): the query is matched against translated text, so a language
 *  change has to re-filter or the rows stay hidden by the previous language's copy. */
export function applySearch(): void {
  const query = fold(byId<HTMLInputElement>('set-search').value.trim());
  const searching = query.length > 0;
  let hits = 0;

  for (const el of document.querySelectorAll<HTMLElement>('.set-page')) {
    el.hidden = !searching && el.dataset.page !== page;
  }
  for (const row of document.querySelectorAll<HTMLElement>('[data-search]')) {
    const match = !searching || fold(row.textContent ?? '').includes(query);
    row.hidden = !match;
    if (match && searching) hits += 1;
  }
  // A card with nothing left in it, and the overline that introduced it.
  for (const card of document.querySelectorAll<HTMLElement>('.set-card')) {
    const empty = [...card.querySelectorAll<HTMLElement>('[data-search]')].every((row) => row.hidden);
    card.hidden = searching && empty;
    const label = card.previousElementSibling;
    if (label instanceof HTMLElement && label.classList.contains('set-label')) label.hidden = card.hidden;
  }
  byId('set-search-empty').hidden = !searching || hits > 0;
  byId('settings-footer').hidden = searching;
}

// ── Segmented controls ────────────────────────────────────────────────────────

/** Every segmented group whose value IS a setting, keyed by its data-seg. Language is
 *  absent on purpose — it is two facts behind one control, and the controller owns it. */
const SEGMENTS: Record<string, { read: (s: Settings) => string; patch: (value: string) => SettingsPatch }> = {
  quality: {
    read: (s) => s.defaultQuality,
    patch: (v) => ({ defaultQuality: v as Settings['defaultQuality'] }),
  },
  theme: { read: (s) => s.theme, patch: (v) => ({ theme: v as Settings['theme'] }) },
  order: { read: (s) => s.listOrder, patch: (v) => ({ listOrder: v as Settings['listOrder'] }) },
  cols: { read: (s) => String(s.columns), patch: (v) => ({ columns: Number(v) }) },
  backdrop: {
    read: (s) => s.panelBackdrop,
    patch: (v) => ({ panelBackdrop: v as Settings['panelBackdrop'] }),
  },
  corners: {
    read: (s) => s.panelCorners,
    patch: (v) => ({ panelCorners: v as Settings['panelCorners'] }),
  },
  minres: { read: (s) => String(s.minResolution), patch: (v) => ({ minResolution: Number(v) }) },
};

function segment(name: string): HTMLElement | undefined {
  return document.querySelector<HTMLElement>(`.seg[data-seg="${name}"]`) ?? undefined;
}

/** Press the stored option, or leave the group unpressed when no option matches. */
function reflectSegment(name: string, value: string): void {
  const group = segment(name);
  const button = group?.querySelector<HTMLButtonElement>(`[data-value="${value}"]`);
  if (group == null) return;
  group.querySelectorAll<HTMLButtonElement>('[aria-pressed]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b === button));
  });
}

/** Rebuild a group of buttons and put the keyboard back where it was. A rebuild replaces every
 *  node, so the focused one is gone by the time it returns and has to be re-found by the data-*
 *  value that identifies it. */
function withFocusKept(host: HTMLElement, attribute: string, rebuild: () => void): void {
  const active = document.activeElement;
  const held =
    active instanceof HTMLElement && host.contains(active) ? active.getAttribute(`data-${attribute}`) : null;
  rebuild();
  if (held == null) return;
  host.querySelector<HTMLElement>(`[data-${attribute}="${held}"]`)?.focus();
}

/** What each JS-built group last painted. reflectSettings runs after every settings write, and
 *  these are 38 nodes and 38 listeners between them, so each repaints only when its own state
 *  differs. */
let accentPainted = '';
let tintPainted = '';
let keysPainted = '';

// ── Colour swatches ───────────────────────────────────────────────────────────

/** Built from ACCENTS and PANEL_TINTS rather than written out in the markup, so each
 *  palette has one source and a swatch can never paint a colour the schema would reject. */
function renderSwatches(accent: AccentId, tint: PanelTintId): void {
  // Include the language because the memoized nodes contain translated labels.
  const accentKey = `${getLang()}|${accent}`;
  if (accentPainted !== accentKey) {
    accentPainted = accentKey;
    for (const group of ['solid', 'gradient'] as AccentGroup[]) {
      const host = byId(`set-accent-${group}`);
      withFocusKept(host, 'accent', () => paintAccents(host, group, accent));
    }
  }
  const tintKey = `${getLang()}|${tint}`;
  if (tintPainted === tintKey) return;
  tintPainted = tintKey;
  const host = byId('set-tint');
  withFocusKept(host, 'tint', () => paintTints(host, tint));
}

function paintAccents(host: HTMLElement, group: AccentGroup, active: AccentId): void {
  host.textContent = '';
  for (const accent of ACCENTS) {
    if (accent.group !== group) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'swatch';
    button.dataset.accent = accent.id;
    button.style.background = accent.grad;
    button.setAttribute('aria-pressed', String(accent.id === active));
    const label = t(accent.label);
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', () => read?.apply({ accent: accent.id }));
    host.appendChild(button);
  }
}

/** The tint swatch shows the tint's own CANVAS — that is the colour the choice changes
 *  most of, and the surfaces beside it are near-white in the light theme anyway. */
function paintTints(host: HTMLElement, active: PanelTintId): void {
  host.textContent = '';
  const light = document.documentElement.dataset.theme === 'light';
  for (const tint of PANEL_TINTS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'swatch swatch-tint';
    button.dataset.tint = tint.id;
    button.style.background = (light ? tint.light : tint.dark)[0];
    button.setAttribute('aria-pressed', String(tint.id === active));
    const label = t(tint.label);
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', () => read?.apply({ panelTint: tint.id }));
    host.appendChild(button);
  }
}

/** The tint swatches paint the resolved theme's canvas, so a theme flip has to repaint
 *  them even though the tint itself did not change. */
export function repaintTintSwatches(): void {
  tintPainted = '';
  const settings = read?.settings();
  if (settings != null) renderSwatches(settings.accent, settings.panelTint);
}

// ── File-name template ────────────────────────────────────────────────────────

/** The tokens downloadFilename substitutes. Same list, so a chip cannot offer one the
 *  namer would leave in the filename verbatim. */
const TOKENS = ['{source}', '{date}', '{id}'] as const;

/** A fixed sample, so the preview is stable rather than ticking with the clock. The date it
 *  shows is the sample's own timestamp, not now. */
const SAMPLE = makeItem(
  'https://scontent.xx.fbcdn.net/v/t42.1790-2/sample.mp4',
  'video',
  'reel',
  'dom',
  Date.UTC(2026, 0, 31, 14, 2, 11),
);

function renderTemplatePreview(): void {
  const settings = read?.settings();
  if (settings == null) return;
  const template = byId<HTMLInputElement>('set-template').value;
  // Through the real namer, including its subfolder prefix and its safety collapsing —
  // a preview that only substituted tokens would hide exactly the surprises worth seeing.
  byId('set-template-out').textContent = downloadFilename(SAMPLE, {
    filenameTemplate: template,
    subfolder: settings.subfolder,
  });
}

/** Insert a token where the cursor is, not at the end: the point of the chips is to build
 *  a pattern, and appending would force a manual move for every token but the last. */
function insertToken(token: string): void {
  const input = byId<HTMLInputElement>('set-template');
  const at = input.selectionStart ?? input.value.length;
  const to = input.selectionEnd ?? at;
  input.value = `${input.value.slice(0, at)}${token}${input.value.slice(to)}`;
  input.setSelectionRange(at + token.length, at + token.length);
  input.focus();
  renderTemplatePreview();
  read?.apply({ filenameTemplate: input.value });
}

// ── Keyboard bindings ─────────────────────────────────────────────────────────

const KEY_LABEL: Record<KeyAction, MsgKey> = {
  togglePick: 'keyTogglePick',
  downloadCard: 'keyDownloadCard',
  selectAll: 'keySelectAll',
  downloadPicks: 'keyDownloadPicks',
  viewNow: 'keyViewNow',
  viewLibrary: 'keyViewLibrary',
  viewSaved: 'keyViewSaved',
  cycleFilter: 'keyCycleFilter',
  openSettings: 'keyOpenSettings',
};

/** The row waiting for a keypress, if any. Module state, not a closure: the keydown lands
 *  on the document, never on the button that armed it. */
let capturing: KeyAction | undefined;
/** Why the last press was refused — cleared by the next successful bind or cancel. */
let keyRefusal: string | undefined;

/** One row per bindable function, built from KEY_ACTIONS so the order and the set of
 *  functions have a single source. Rebuilt whole on every state change: nine rows is
 *  cheaper to redraw than to reconcile. */
function renderKeymapRows(): void {
  const keymap = read?.settings().keymap ?? DEFAULT_KEYMAP;
  // getLang() belongs in the state: the nine row labels and the two cap words are t()
  // strings, so the keymap alone does not describe what is on screen.
  const state = JSON.stringify([getLang(), keymap, capturing ?? '', keyRefusal ?? '']);
  if (keysPainted === state) return;
  keysPainted = state;
  const host = byId('set-keys');
  withFocusKept(host, 'action', () => paintKeymapRows(host));
}

function paintKeymapRows(host: HTMLElement): void {
  host.textContent = '';
  const keymap = read?.settings().keymap ?? DEFAULT_KEYMAP;
  for (const action of KEY_ACTIONS) {
    const row = document.createElement('div');
    row.className = 'key-row';
    const label = document.createElement('span');
    label.className = 'key-name';
    label.id = `label-key-${action}`;
    label.textContent = t(KEY_LABEL[action]);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'key-cap';
    button.dataset.action = action;
    button.setAttribute('aria-labelledby', label.id);
    const armed = capturing === action;
    button.classList.toggle('is-armed', armed);
    button.classList.toggle('is-unbound', !armed && keymap[action] === '');
    // aria-pressed, so the armed state is announced and not only outlined.
    button.setAttribute('aria-pressed', String(armed));
    button.textContent = armed
      ? t('keyPressPrompt')
      : keymap[action] === ''
        ? t('keyUnbound')
        : keymap[action].toUpperCase();
    // withFocusKept above puts the focus back on this row, so nothing to do here.
    button.addEventListener('click', () => {
      capturing = capturing === action ? undefined : action;
      keyRefusal = undefined;
      renderKeymapRows();
    });

    row.append(label, button);
    host.appendChild(row);
  }
  const error = byId('set-keys-error');
  error.textContent = keyRefusal ?? '';
  error.hidden = keyRefusal == null;
}

/** Persist one binding. Only this action goes out — applyPatch merges it onto whatever storage
 *  holds, so a second rebind fired before this one lands keeps both. */
function bindKey(action: KeyAction, key: string): void {
  capturing = undefined;
  keyRefusal = undefined;
  renderKeymapRows();
  read?.apply({ keymap: { [action]: key } });
}

function refuse(message: string): void {
  keyRefusal = message;
  renderKeymapRows();
}

/** Capture phase, and it swallows the event: the panel's own keydown handler is on the
 *  document in the bubble phase, so without this, binding ',' would ALSO toggle the
 *  Settings sheet shut on the way past. */
function onCaptureKey(e: KeyboardEvent): void {
  const action = capturing;
  if (action == null) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') {
    capturing = undefined;
    keyRefusal = undefined;
    renderKeymapRows();
    return;
  }
  // An explicit way to leave a function with no key at all.
  if (e.key === 'Backspace' || e.key === 'Delete') {
    bindKey(action, '');
    return;
  }
  // Shift is allowed — Shift+, gives '<', which is a character you can press again.
  // Ctrl/Alt/Meta are not: the panel ignores modified combinations, so the binding would
  // fire on the unmodified key and not on what was actually pressed.
  if (e.ctrlKey || e.altKey || e.metaKey) {
    refuse(t('keyErrorPlain'));
    return;
  }
  const key = e.key.toLowerCase();
  if (!isAssignableKey(key)) {
    refuse(t('keyErrorSingle'));
    return;
  }
  const keymap = read?.settings().keymap ?? DEFAULT_KEYMAP;
  const clash = KEY_ACTIONS.find((other) => other !== action && keymap[other] === key);
  if (clash != null) {
    refuse(fmt('keyErrorTaken', { action: t(KEY_LABEL[clash]) }));
    return;
  }
  bindKey(action, key);
}

// ── Reflection ────────────────────────────────────────────────────────────────

/** Write a text field only when it differs. Assigning .value resets the caret to the end even
 *  for an identical string, and this runs after every settings write — including while the user
 *  is mid-word in the filename template. */
function reflectField(id: string, value: string): void {
  const field = byId<HTMLInputElement>(id);
  if (field.value !== value) field.value = value;
}

/** The two literals the "while browsing" line names. Wrapped rather than substituted so
 *  the sentence stays one translatable string with its own word order. */
const CODE_TERMS = ['manifest.json', 'chrome://extensions/shortcuts'];

function renderGlobalKeyHint(): void {
  const host = byId('set-globalkey');
  host.textContent = '';
  let rest = t('settingsGlobalKeyHint');
  while (rest.length > 0) {
    const next = CODE_TERMS.map((term) => ({ term, at: rest.indexOf(term) }))
      .filter((hit) => hit.at >= 0)
      .sort((a, b) => a.at - b.at)[0];
    if (next == null) {
      host.append(rest);
      return;
    }
    host.append(rest.slice(0, next.at));
    const code = document.createElement('code');
    code.textContent = next.term;
    host.appendChild(code);
    rest = rest.slice(next.at + next.term.length);
  }
}

/** Push the current settings into the sheet's controls. */
export function reflectSettings(settings: Settings): void {
  reflectField('set-template', settings.filenameTemplate);
  byId<HTMLInputElement>('set-subfolder').checked = settings.subfolder;
  byId<HTMLInputElement>('set-direct').checked = settings.directDownload;
  byId<HTMLInputElement>('set-inpage').checked = settings.inPageButton;
  byId<HTMLInputElement>('set-confirmclear').checked = settings.confirmClear;
  byId<HTMLInputElement>('set-videosonly').checked = settings.videosOnly;
  reflectField('set-maxitems', String(settings.maxItems));
  byId<HTMLInputElement>('set-keysenabled').checked = settings.keysEnabled;
  for (const [name, spec] of Object.entries(SEGMENTS)) reflectSegment(name, spec.read(settings));
  // Auto/EN/ES: one control over two stored facts. getLang() IS the manual choice exactly
  // when Auto is off — while it is on, it holds whatever the browser resolved to, which is
  // why the pressed pill is decided by followBrowserLang first.
  const lang = byId('lang');
  const pressed = lang.querySelector<HTMLButtonElement>(
    `[data-lang="${settings.followBrowserLang ? 'auto' : getLang()}"]`,
  );
  if (pressed != null) pressOnly(lang, pressed);
  renderSwatches(settings.accent, settings.panelTint);
  renderKeymapRows();
  renderTemplatePreview();
  renderGlobalKeyHint();
  // #set-bg-state is t()-rendered and nothing else repaints it, so it stayed in the
  // previous language. A pending refusal is dropped here on purpose: it described the
  // last file pick, not the setting that just changed.
  reflectPanelBackground();
}

/** What the background row says, and why the last attempt was refused if it was. Whether an image
 *  is in use is read off the class applyPanelBackground sets rather than passed in, so a refused
 *  replacement cannot make the row claim "None chosen" while the previous image is still on
 *  screen. */
export function reflectPanelBackground(refusal?: MsgKey): void {
  const inUse = byId('app').classList.contains('has-bg');
  byId('set-bg-state').textContent = t(inUse ? 'bgSet' : 'bgNone');
  byId<HTMLButtonElement>('set-bg-clear').disabled = !inUse;
  const error = byId('set-bg-error');
  error.textContent = refusal == null ? '' : t(refusal);
  error.hidden = refusal == null;
}

// ── Open / close ──────────────────────────────────────────────────────────────

/** Treat Settings as the fourth panel surface and keep keyboard focus inside it. */
function setSheetOpen(open: boolean, restoreFocus = true): void {
  const sheet = byId('settings');
  const trigger = byId<HTMLButtonElement>('settings-open');
  const nav = byId('views');
  const hadFocus = sheet.contains(document.activeElement);
  if (focusFrame !== undefined) {
    window.cancelAnimationFrame(focusFrame);
    focusFrame = undefined;
  }
  sheet.hidden = !open;
  if (!open && capturing != null) {
    // Leaving the sheet mid-capture must not leave a row armed to swallow the next
    // keypress the grid was supposed to get.
    capturing = undefined;
    keyRefusal = undefined;
    renderKeymapRows();
  }
  byId('app').classList.toggle('is-settings', open);
  trigger.setAttribute('aria-expanded', String(open));
  if (open) {
    pressOnly(nav, trigger);
    focusFrame = window.requestAnimationFrame(() => {
      focusFrame = undefined;
      // The search field, not the first tab: it is the fastest way to any of the four
      // pages, and Tab from it reaches the strip immediately.
      if (!sheet.hidden) byId('set-search').focus();
    });
    return;
  }
  const route = nav.querySelector<HTMLButtonElement>(`[data-view="${read?.currentView() ?? 'now'}"]`);
  if (route != null) pressOnly(nav, route);
  if (restoreFocus && hadFocus) trigger.focus();
}

/** Close the sheet on a view switch: the nav press moves with the click, so returning focus
 *  to the settings trigger would fight it. */
export function closeSettingsSheet(): void {
  setSheetOpen(false, false);
}

export function isSettingsOpen(): boolean {
  return !byId('settings').hidden;
}

/** For the bound key, which has to both open and close. Routed through the two triggers
 *  rather than through setSheetOpen so the key takes the identical path the mouse does. */
export function toggleSettingsSheet(): void {
  byId(isSettingsOpen() ? 'settings-close' : 'settings-open').click();
}

// ── Diagnostics ───────────────────────────────────────────────────────────────
//
// The export contains counters, traced events and relevant settings.

/** Build a local diagnostics report. It contains no fbcdn tokens or response bodies,
 *  and it is never uploaded automatically. Settings provide capture context. */
async function buildDiagReport(settings: Settings): Promise<string> {
  // The panel's own events have nowhere else to go: it has no flush timer of its
  // own, so drain them into the store first or they die with the export.
  await addDiagEvents(diagLogDrain()).catch(() => {});
  const [counters, events] = await Promise.all([getDiagCounters(), getDiagEvents()]);
  const manifest = chrome.runtime.getManifest();
  return JSON.stringify(
    {
      report: 'facescrap-diagnostics',
      version: 1,
      generatedAt: new Date().toISOString(),
      extension: { version: manifest.version, name: manifest.name },
      browser: navigator.userAgent,
      lang: getLang(),
      settings,
      counters,
      eventCount: events.length,
      // Both shapes on purpose: the objects are what a script reads, the lines
      // are what a person reads without a JSON viewer.
      events,
      lines: events.map(formatDiagEvent),
    },
    null,
    2,
  );
}

function saveDiagReport(text: string): void {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `facescrap-diagnostics-${stamp}.json`;
  link.click();
  // Same reason the offscreen document revokes its mux blobs: a side panel is
  // long-lived, and an un-revoked blob is retained for its whole lifetime. The
  // delay lets the download start first.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

/** Open/close the surface and wire every control to `apply`. */
export function setupSettingsSheet(inputs: SheetInputs): void {
  read = inputs;
  const { settings, apply } = inputs;

  byId('settings-open').addEventListener('click', () => setSheetOpen(true));
  byId('settings-close').addEventListener('click', () => setSheetOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !byId('settings').hidden) {
      e.preventDefault();
      setSheetOpen(false);
    }
  });

  // One delegated handler for the whole strip, and one for every segmented group: a new
  // page or a new segment then needs no new listener, only its markup and its SEGMENTS row.
  byId('set-tabs').addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tab]');
    if (tab?.dataset.tab != null) showPage(tab.dataset.tab);
  });
  byId('set-body').addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('.seg > [data-value]');
    const name = button?.parentElement?.dataset.seg;
    const spec = name == null ? undefined : SEGMENTS[name];
    // Looked up rather than asserted: #lang is a .seg with no data-seg, and a group whose
    // data-seg has no SEGMENTS row is inert instead of throwing out of the delegated listener.
    if (button?.dataset.value == null || spec == null) return;
    apply(spec.patch(button.dataset.value));
  });

  const search = byId<HTMLInputElement>('set-search');
  search.addEventListener('input', applySearch);
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || search.value === '') return;
    // Clear before the document handler sees it, so the first Escape empties the box
    // rather than closing the whole sheet.
    e.preventDefault();
    e.stopPropagation();
    search.value = '';
    applySearch();
  });

  const onCheck = (id: string, key: keyof Settings): void => {
    byId<HTMLInputElement>(id).addEventListener('change', (e) => {
      apply({ [key]: (e.target as HTMLInputElement).checked } as SettingsPatch);
    });
  };
  onCheck('set-subfolder', 'subfolder');
  onCheck('set-direct', 'directDownload');
  onCheck('set-inpage', 'inPageButton');
  onCheck('set-confirmclear', 'confirmClear');
  onCheck('set-videosonly', 'videosOnly');
  onCheck('set-keysenabled', 'keysEnabled');

  byId('lang').addEventListener('click', (e) => {
    const choice = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-lang]')?.dataset.lang;
    if (choice === 'auto' || choice === 'en' || choice === 'es') inputs.chooseLang(choice);
  });

  const template = byId<HTMLInputElement>('set-template');
  template.addEventListener('input', renderTemplatePreview);
  template.addEventListener('change', () => apply({ filenameTemplate: template.value }));
  const tokens = byId('set-template-tokens');
  for (const token of TOKENS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'token';
    chip.textContent = token;
    chip.addEventListener('click', () => insertToken(token));
    tokens.appendChild(chip);
  }

  // maxItems is the only free-text number: filter as it is typed, and on commit either
  // clamp to the parsed value or snap back to the stored one.
  const maxItemsInput = byId<HTMLInputElement>('set-maxitems');
  maxItemsInput.addEventListener('input', () => {
    const digits = sanitizeMaxItemsInput(maxItemsInput.value);
    if (digits !== maxItemsInput.value) maxItemsInput.value = digits;
  });
  maxItemsInput.addEventListener('change', () => {
    const maxItems = parseMaxItemsInput(maxItemsInput.value);
    if (maxItems === undefined) {
      maxItemsInput.value = String(settings().maxItems);
      return;
    }
    maxItemsInput.value = String(maxItems);
    if (maxItems !== settings().maxItems) apply({ maxItems });
  });
  maxItemsInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    maxItemsInput.blur();
  });

  const file = byId<HTMLInputElement>('set-bg-file');
  // The <label> is the styled trigger; a label is not a button, so Enter/Space on it does
  // nothing without this.
  file.parentElement?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    file.click();
  });
  file.addEventListener('change', () => {
    const chosen = file.files?.[0];
    // Reset first: picking the same file twice must fire change the second time too.
    file.value = '';
    if (chosen == null) return;
    void storePanelBackground(chosen).then((result) => {
      reflectPanelBackground(result.ok ? undefined : result.reason);
    });
  });
  byId('set-bg-clear').addEventListener('click', () => {
    void clearPanelBackground().then(() => reflectPanelBackground());
  });

  document.addEventListener('keydown', onCaptureKey, { capture: true });
  byId('keys-reset').addEventListener('click', () => {
    capturing = undefined;
    keyRefusal = undefined;
    renderKeymapRows();
    apply({ keymap: { ...DEFAULT_KEYMAP } });
  });

  const exportButton = byId<HTMLButtonElement>('diag-export');
  exportButton.addEventListener('click', () => {
    // Disabled across the await: the report is one storage read plus a JSON
    // serialization of up to 1 500 events, and a double click would write the
    // same file twice.
    exportButton.disabled = true;
    void buildDiagReport(settings())
      .then(saveDiagReport)
      .catch((error) => console.error('[FaceScrap] diagnostics export failed', error))
      .finally(() => {
        exportButton.disabled = false;
      });
  });

  showPage('general');
  reflectSettings(settings());
}

/** Ctrl/Cmd K — open Settings if it is closed, then put the caret in the search box. */
export function focusSettingsSearch(): void {
  if (!isSettingsOpen()) byId('settings-open').click();
  const search = byId<HTMLInputElement>('set-search');
  // After setSheetOpen's own rAF focus, or it would be stolen back.
  window.requestAnimationFrame(() => {
    search.focus();
    search.select();
  });
}
