// The Settings surface: four pages, their controls, and the diagnostics block.
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
import { getDiagCounters, resetDiagCounters } from '../shared/diag-store';
import { ACCENTS, type AccentId } from '../shared/appearance';
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

/** Show one page. Which one is DOM state, not a setting: reopening Settings on the page
 *  you happened to leave it on is the behaviour, and it should not survive a restart. */
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
  pressOnly(tabs, tab);
  for (const page of document.querySelectorAll<HTMLElement>('.set-page')) {
    page.hidden = page.dataset.page !== name;
  }
  // Back to the top: the pages differ in length, and a preserved scroll offset lands mid-card.
  byId('set-body').scrollTop = 0;
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

/** Press the button that matches the stored value. Nothing is pressed when the stored value
 *  has no button — which cannot happen through the UI, but a hand-edited store can hold a
 *  minResolution of 480 that this group no longer offers, and a lit button claiming
 *  otherwise would be a lie. */
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
 *  these two are 16 nodes and 16 listeners between them, so each repaints only when its own state
 *  differs. */
let accentPainted = '';
let keysPainted = '';

// ── Accent swatches ───────────────────────────────────────────────────────────

/** Built from ACCENTS rather than written out in the markup, so the palette has one source
 *  and a swatch can never paint a colour the schema would reject. */
function renderAccents(active: AccentId): void {
  if (accentPainted === active) return;
  accentPainted = active;
  const host = byId('set-accent');
  withFocusKept(host, 'accent', () => paintAccents(host, active));
}

function paintAccents(host: HTMLElement, active: AccentId): void {
  host.textContent = '';
  for (const accent of ACCENTS) {
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
  const state = JSON.stringify([keymap, capturing ?? '', keyRefusal ?? '']);
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

/** Push the current settings into the sheet's controls. */
/** Write a text field only when it differs. Assigning .value resets the caret to the end even
 *  for an identical string, and this runs after every settings write — including while the user
 *  is mid-word in the filename template. */
function reflectField(id: string, value: string): void {
  const field = byId<HTMLInputElement>(id);
  if (field.value !== value) field.value = value;
}

export function reflectSettings(settings: Settings): void {
  reflectField('set-template', settings.filenameTemplate);
  byId<HTMLInputElement>('set-subfolder').checked = settings.subfolder;
  byId<HTMLInputElement>('set-direct').checked = settings.directDownload;
  byId<HTMLInputElement>('set-inpage').checked = settings.inPageButton;
  byId<HTMLInputElement>('set-confirmclear').checked = settings.confirmClear;
  byId<HTMLInputElement>('set-videosonly').checked = settings.videosOnly;
  reflectField('set-maxitems', String(settings.maxItems));
  byId<HTMLInputElement>('set-diag').checked = settings.diagEnabled;
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
  renderAccents(settings.accent);
  renderKeymapRows();
  renderTemplatePreview();
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
      // The first tab, not a control: with four pages the tab strip is where you are, and
      // focusing a field on page one skipped past the way to reach the other three.
      if (!sheet.hidden) byId('set-tabs').querySelector<HTMLButtonElement>('[data-tab]')?.focus();
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

/** Counter names are printed RAW (jsonLineTooLarge, …) rather than translated: they are
 *  maintenance terms whose whole value is grepping straight to the discard site, and a
 *  localized label would break that link. */
export async function renderDiag(): Promise<void> {
  const counters = await getDiagCounters();
  const rows = Object.entries(counters).filter(([, n]) => n > 0);
  const pre = byId('diag-counters');
  if (rows.length === 0) {
    pre.textContent = t('diagEmpty');
    return;
  }
  const width = Math.max(...rows.map(([reason]) => reason.length));
  pre.textContent = rows
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${reason.padEnd(width)}  ${n}`)
    .join('\n');
}

export function isDiagOpen(): boolean {
  return byId<HTMLDetailsElement>('diag-details').open;
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
  onCheck('set-diag', 'diagEnabled');
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
    chip.textContent = `+ ${token}`;
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

  byId('diag-reset').addEventListener('click', () => {
    void resetDiagCounters().then(renderDiag);
  });
  // Only when opened: the counters are a maintenance detail, not worth a storage read on
  // every settings render.
  byId('diag-details').addEventListener('toggle', () => {
    if (isDiagOpen()) void renderDiag();
  });

  showPage('general');
  reflectSettings(settings());
}
