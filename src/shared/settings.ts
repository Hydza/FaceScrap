// User settings, persisted in chrome.storage.local under a single key. Three jobs live
// here because all three turn on the same SETTINGS_KEY, SETTINGS_FIELDS and
// normalizeSettings; splitting them would only copy that coupling into a second file.
//
// - The model: every field, its default, and the coercion that pulls a partial or corrupt
//   stored shape back onto them, so adding a field is backward-safe and a bad value can
//   never reach a filename builder or a splice(). Read by the side panel (all fields), the
//   worker (the in-page download policy in playing-download.ts), the content scripts
//   (inPageButton) and storage.ts's retention cache (maxItems).
// - The worker's write lane: createSettingsMessageHandler admits only an extension page as
//   the sender, then feeds one serialized read-modify-write queue, so two pages patching
//   different fields at once cannot clobber each other.
// - The client half of that lane: saveSettings refuses any context that is not an extension
//   page and routes the patch through the worker, writing locally only when no receiver
//   exists; writeSettingOptimistically paints the value before the write lands and puts the
//   old one back if it rejects.

import {
  ACCENTS,
  BACKDROPS,
  CORNERS,
  DEFAULT_ACCENT,
  DEFAULT_TINT,
  PANEL_TINTS,
  type AccentId,
  type PanelBackdrop,
  type PanelCorners,
  type PanelTintId,
} from './appearance';
import type { SettingsUpdateAck, SettingsUpdateMsg } from './messages';
import type { ThemePreference } from './theme';

type QualityPref = 'highest' | 'lowest' | 'ask';
type ListOrder = 'newest' | 'oldest';

/** The panel functions a key can be bound to. Order is load-bearing: it is the
 *  order the keymap resolves conflicts in, and the order the Settings rows appear. */
export const KEY_ACTIONS = [
  'togglePick',
  'downloadCard',
  'selectAll',
  'downloadPicks',
  'viewNow',
  'viewLibrary',
  'viewSaved',
  'cycleFilter',
  'openSettings',
] as const;
export type KeyAction = (typeof KEY_ACTIONS)[number];
/** An action's key, or '' when it has none. */
export type Keymap = Record<KeyAction, string>;

/** Is this a key a user may bind?
 *
 *  One printable character, and never whitespace. That single rule is also what keeps
 *  the panel's own keys out: `Tab`, `Enter`, `Escape`, `ArrowUp`, `PageDown` and every
 *  other navigation key arrives from KeyboardEvent.key as a multi-character NAME, so
 *  the length check excludes them without a list to maintain. Space is the one
 *  single-character exception — it scrolls the grid — hence the trim.
 *
 *  Nothing here can collide with Facebook: these are read by the side panel, which is
 *  a separate document. A page never sees them. The one shortcut that does reach past
 *  the panel is declared in manifest.json under "commands", where Chrome itself
 *  intercepts the combination before the page. */
export function isAssignableKey(key: unknown): key is string {
  return typeof key === 'string' && key.length === 1 && key.trim().length === 1;
}

export const DEFAULT_KEYMAP: Keymap = {
  togglePick: 's',
  downloadCard: 'd',
  selectAll: 'a',
  downloadPicks: 'q',
  viewNow: '1',
  viewLibrary: '2',
  viewSaved: '3',
  cycleFilter: 'f',
  openSettings: ',',
};

/** Coerce a stored keymap so no two actions can ever share a key.
 *
 *  Resolved in KEY_ACTIONS order, so the same corrupt store always resolves the same
 *  way. An action whose stored key is unusable or already taken falls back to its
 *  default; if that is taken too it ends up UNBOUND rather than duplicated — one press
 *  firing two actions is worse than a function with no key. */
export function normalizeKeymap(raw: unknown): Keymap {
  const stored = (raw ?? {}) as Record<string, unknown>;
  const map = {} as Keymap;
  const taken = new Set<string>();
  for (const action of KEY_ACTIONS) {
    const value = stored[action];
    const wanted = typeof value === 'string' ? value.toLowerCase() : undefined;
    // '' is a choice, not an absence — it is what the Settings row stores when Backspace clears a
    // binding — so it passes through rather than falling back to the default.
    if (wanted === '') {
      map[action] = '';
      continue;
    }
    const fallback = DEFAULT_KEYMAP[action];
    const key =
      wanted != null && isAssignableKey(wanted) && !taken.has(wanted)
        ? wanted
        : taken.has(fallback)
          ? ''
          : fallback;
    map[action] = key;
    if (key !== '') taken.add(key);
  }
  return map;
}

export interface Settings {
  /** Filename pattern; tokens {source} {date} {id} are substituted, the rest kept. */
  filenameTemplate: string;
  /** Save downloads inside a "FaceScrap/" subfolder of the Downloads directory. */
  subfolder: boolean;
  /** Which representation the quality picker preselects; 'ask' opens the Save-As dialog. */
  defaultQuality: QualityPref;
  /** Skip the DASH audio+video remux and download the video track directly (muted). */
  directDownload: boolean;
  /** Show the download button on the reel, story or photo being watched. Off means the
   *  content script injects nothing into the page at all — see playing-download.ts. */
  inPageButton: boolean;
  /** Pick EN/ES from navigator.language instead of the manual toggle. */
  followBrowserLang: boolean;
  /** Panel appearance; automatic follows Facebook for this tab, then the device. */
  theme: ThemePreference;
  listOrder: ListOrder;
  /** Grid columns. 1 reads as a single tall column, 4 fits most at the cost of size. */
  columns: number;
  /** Accent for the selection, the progress and the primary button — see appearance.ts. */
  accent: AccentId;
  /** The panel's own background family: canvas, both surfaces and the hairline move
   *  together, so every surface stays in one hue. */
  panelTint: PanelTintId;
  /** How much of a custom background shows through the panel's surfaces. */
  panelBackdrop: PanelBackdrop;
  /** The corner radius family. */
  panelCorners: PanelCorners;
  /** Master switch for the panel's own key bindings, for anyone whose IME or other
   *  extension fights them. The arrows and the grid cursor go with it. */
  keysEnabled: boolean;
  /** Which key runs which panel function. A patch may name only the actions it rebinds; the
   *  rest merge in from storage (see applyPatch). */
  keymap: Keymap;
  /** Ask for confirmation before the Clear button wipes the list. */
  confirmClear: boolean;
  /** View filter: show only video rows (images/audio hidden, not dropped). */
  videosOnly: boolean;
  /** View filter: hide video groups whose best height is below this (0 = off). */
  minResolution: number;
  /** Per-tab retention cap in storage (0 = unlimited). */
  maxItems: number;
}

export const DEFAULT_SETTINGS: Settings = {
  filenameTemplate: '{source}-{date}-{id}',
  subfolder: true,
  defaultQuality: 'highest',
  directDownload: false,
  inPageButton: true,
  followBrowserLang: false,
  theme: 'auto',
  listOrder: 'newest',
  columns: 2,
  accent: DEFAULT_ACCENT,
  panelTint: DEFAULT_TINT,
  panelBackdrop: 'solid',
  panelCorners: 'soft',
  keysEnabled: true,
  // A copy: loadSettings' error path spreads DEFAULT_SETTINGS shallowly, and a shared
  // map would let one panel's edit rewrite the defaults for every later reader.
  keymap: { ...DEFAULT_KEYMAP },
  confirmClear: false,
  videosOnly: false,
  minResolution: 0,
  maxItems: 1500,
};

const SETTINGS_KEY = 'settings';
const QUALITY: QualityPref[] = ['highest', 'lowest', 'ask'];
const ORDER: ListOrder[] = ['newest', 'oldest'];
export const COLUMN_CHOICES = [1, 2, 3, 4];
const THEME: ThemePreference[] = ['auto', 'light', 'dark'];
const SETTINGS_FIELDS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Keep the editable retention-limit draft restricted to ASCII digits. */
export function sanitizeMaxItemsInput(value: string): string {
  return value.replace(/[^0-9]/g, '');
}

/** Parse a committed retention limit without treating blank/scientific input as a number. */
export function parseMaxItemsInput(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) return undefined;
  const parsed = Number(value);
  return isNonNegativeSafeInteger(parsed) ? parsed : undefined;
}

/** Merge a stored (possibly partial/corrupt) object onto the defaults, coercing
 *  every field so downstream code can trust the shape. */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw ?? {}) as Record<string, unknown>;
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
  const num = (v: unknown, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d;
  return {
    filenameTemplate:
      typeof r.filenameTemplate === 'string' && r.filenameTemplate.length > 0 && r.filenameTemplate.length <= 200
        ? r.filenameTemplate
        : DEFAULT_SETTINGS.filenameTemplate,
    subfolder: bool(r.subfolder, DEFAULT_SETTINGS.subfolder),
    defaultQuality: QUALITY.includes(r.defaultQuality as QualityPref)
      ? (r.defaultQuality as QualityPref)
      : DEFAULT_SETTINGS.defaultQuality,
    directDownload: bool(r.directDownload, DEFAULT_SETTINGS.directDownload),
    inPageButton: bool(r.inPageButton, DEFAULT_SETTINGS.inPageButton),
    followBrowserLang: bool(r.followBrowserLang, DEFAULT_SETTINGS.followBrowserLang),
    theme: THEME.includes(r.theme as ThemePreference) ? (r.theme as ThemePreference) : DEFAULT_SETTINGS.theme,
    listOrder: ORDER.includes(r.listOrder as ListOrder) ? (r.listOrder as ListOrder) : DEFAULT_SETTINGS.listOrder,
    columns: COLUMN_CHOICES.includes(r.columns as number) ? (r.columns as number) : DEFAULT_SETTINGS.columns,
    accent: ACCENTS.some((a) => a.id === r.accent) ? (r.accent as AccentId) : DEFAULT_SETTINGS.accent,
    panelTint: PANEL_TINTS.some((tint) => tint.id === r.panelTint)
      ? (r.panelTint as PanelTintId)
      : DEFAULT_SETTINGS.panelTint,
    panelBackdrop: BACKDROPS.includes(r.panelBackdrop as PanelBackdrop)
      ? (r.panelBackdrop as PanelBackdrop)
      : DEFAULT_SETTINGS.panelBackdrop,
    panelCorners: CORNERS.includes(r.panelCorners as PanelCorners)
      ? (r.panelCorners as PanelCorners)
      : DEFAULT_SETTINGS.panelCorners,
    keysEnabled: bool(r.keysEnabled, DEFAULT_SETTINGS.keysEnabled),
    keymap: normalizeKeymap(r.keymap),
    confirmClear: bool(r.confirmClear, DEFAULT_SETTINGS.confirmClear),
    videosOnly: bool(r.videosOnly, DEFAULT_SETTINGS.videosOnly),
    minResolution: num(r.minResolution, DEFAULT_SETTINGS.minResolution),
    maxItems: isNonNegativeSafeInteger(r.maxItems) ? r.maxItems : DEFAULT_SETTINGS.maxItems,
  };
}

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
    return normalizeSettings(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export interface SettingsStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

/** A settings change. `keymap` is the one field that may be partial: it names only the actions
 *  being rebound, and the rest are merged in from storage at write time. */
export type SettingsPatch = Omit<Partial<Settings>, 'keymap'> & { keymap?: Partial<Keymap> };

type SettingsPatchWriter = (patch: SettingsPatch) => Promise<Settings>;

/** The value a patch produces on top of `base`. Scalars replace; `keymap` merges per action, so a
 *  patch naming one binding leaves the other eight alone and two rebinds resolved from the same
 *  snapshot both survive. normalizeKeymap settles any collision between them. */
function applyPatch(base: Settings, patch: SettingsPatch): Settings {
  return normalizeSettings({ ...base, ...patch, keymap: { ...base.keymap, ...patch.keymap } });
}

/** Create one serialized read-modify-write lane. The service worker owns the
 * shared instance; direct writers are a fallback when no compatible worker answers. */
export function createSettingsPatchWriter(
  storage?: SettingsStorageArea,
): SettingsPatchWriter {
  let waitForPrevious: Promise<void> = Promise.resolve();

  return async (patch: SettingsPatch): Promise<Settings> => {
    const pendingPatch = { ...patch };
    const previous = waitForPrevious;
    let release!: () => void;
    waitForPrevious = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      // Do not use loadSettings() here: its read-error fallback is right for
      // rendering, but writing defaults after a transient read failure would
      // erase unrelated preferences.
      const area = storage ?? chrome.storage.local;
      const raw = (await area.get(SETTINGS_KEY))[SETTINGS_KEY];
      const next = applyPatch(normalizeSettings(raw), pendingPatch);
      await area.set({ [SETTINGS_KEY]: next });
      return next;
    } finally {
      release();
    }
  };
}

const settingsPatchWriter = createSettingsPatchWriter();

/** The actions named by a keymap patch, with each key either a bindable character or '' for
 *  "unbound". Anything else is dropped, leaving that action to whatever storage already holds. */
function sanitizeKeymapPatch(raw: unknown): Partial<Keymap> | undefined {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const patch: Partial<Keymap> = {};
  for (const action of KEY_ACTIONS) {
    const value = record[action];
    if (typeof value !== 'string') continue;
    const key = value.toLowerCase();
    if (key === '' || isAssignableKey(key)) patch[action] = key;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

function sanitizeSettingsPatch(raw: unknown): SettingsPatch | undefined {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const normalized = normalizeSettings(raw);
  const patch: SettingsPatch = {};
  const record = raw as Record<string, unknown>;
  // Carry every supplied field, coerced to a valid value: the worker write queue
  // must only ever persist a well-formed Settings, so a present-but-invalid field
  // is normalized to its default rather than rejecting the caller's whole patch.
  for (const field of SETTINGS_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
    // keymap alone stays partial: normalizeSettings would fill every unnamed action from the
    // defaults, turning a one-key rebind into a whole-map write.
    if (field === 'keymap') patch.keymap = sanitizeKeymapPatch(record.keymap);
    else (patch as Record<string, unknown>)[field] = normalized[field];
  }
  if (patch.keymap === undefined) delete patch.keymap;
  return patch;
}

interface SettingsRuntimeIdentity {
  readonly id?: string;
  getURL(path: string): string;
}

function extensionPageUrl(url: unknown, runtime: SettingsRuntimeIdentity): boolean {
  if (typeof url !== 'string') return false;
  const root = runtime.getURL('');
  const origin = root.endsWith('/') ? root.slice(0, -1) : root;
  return url === origin || url.startsWith(root);
}

function authorizedSettingsSender(
  sender: chrome.runtime.MessageSender,
  runtime: SettingsRuntimeIdentity,
): boolean {
  if (sender.id !== runtime.id) return false;
  const origin = (sender as chrome.runtime.MessageSender & { origin?: string }).origin;
  return extensionPageUrl(sender.url, runtime) || extensionPageUrl(origin, runtime);
}

/** Build the service-worker handler separately so its authorization, durable ACK
 * and cross-page serialization stay unit-testable without evaluating the whole
 * MV3 worker in Node. */
export function createSettingsMessageHandler(
  writePatch: SettingsPatchWriter = settingsPatchWriter,
  runtime: SettingsRuntimeIdentity = chrome.runtime,
): (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: SettingsUpdateAck) => void,
) => boolean {
  return (message, sender, sendResponse): boolean => {
    const candidate = message as Partial<SettingsUpdateMsg> | undefined;
    if (candidate?.type !== 'FACESCRAP_UPDATE_SETTINGS') return false;
    if (!authorizedSettingsSender(sender, runtime)) {
      sendResponse({ ok: false, error: 'Unauthorized request.' });
      return true;
    }
    const patch = sanitizeSettingsPatch(candidate.patch);
    if (patch == null) {
      sendResponse({ ok: false, error: 'Invalid settings update.' });
      return true;
    }

    void (async () => {
      try {
        await writePatch(patch);
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return true;
  };
}

function runtimeSettingsBroker():
  | (SettingsRuntimeIdentity & {
      sendMessage(message: SettingsUpdateMsg): Promise<unknown>;
    })
  | undefined {
  const runtime = chrome.runtime as typeof chrome.runtime | undefined;
  if (
    runtime == null ||
    typeof runtime.getURL !== 'function' ||
    typeof runtime.sendMessage !== 'function'
  ) {
    return undefined;
  }
  return runtime;
}

function currentContextIsExtensionPage(runtime: SettingsRuntimeIdentity): boolean {
  return extensionPageUrl(globalThis.location?.href, runtime);
}

function settingsUpdateAck(raw: unknown): SettingsUpdateAck | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const response = raw as Partial<SettingsUpdateAck>;
  if (response.ok === true) return { ok: true };
  if (response.ok === false && typeof response.error === 'string') {
    return { ok: false, error: response.error };
  }
  return undefined;
}

function missingMessageReceiver(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /receiving end does not exist/i.test(message);
}

/** Route extension-page writes through the worker-owned queue. A direct local write
 *  remains available when no runtime or compatible receiver exists. */
export async function saveSettings(patch: SettingsPatch): Promise<void> {
  const pendingPatch = { ...patch };
  const runtime = runtimeSettingsBroker();
  if (runtime) {
    if (!currentContextIsExtensionPage(runtime)) {
      throw new Error('Settings updates are restricted to extension pages.');
    }
    let rawResponse: unknown;
    try {
      rawResponse = await runtime.sendMessage({
        type: 'FACESCRAP_UPDATE_SETTINGS',
        patch: pendingPatch,
      });
    } catch (error) {
      if (!missingMessageReceiver(error)) throw error;
    }
    if (rawResponse !== undefined) {
      const response = settingsUpdateAck(rawResponse);
      if (response == null) throw new Error('Invalid settings update response.');
      if (!response.ok) throw new Error(response.error);
      return;
    }
  }

  // Without the worker queue, concurrent extension pages may race because
  // chrome.storage has no cross-context lock. applySetting rolls back failed writes.
  await settingsPatchWriter(pendingPatch);
}

interface OptimisticSettingWrite {
  /** Persist the patch durably; a rejection triggers rollback. */
  save(patch: SettingsPatch): Promise<void>;
  /** Reflect the optimistic value before the durable write resolves. */
  applyOptimistic?(next: Settings): void | Promise<void>;
  /** Effects that must happen only once the write is durable (re-render, etc.). */
  onCommitted?(next: Settings, patch: SettingsPatch): void | Promise<void>;
  /** Restore any optimistic UI to the previous value after a rejected write. */
  onRolledBack?(previous: Settings): void | Promise<void>;
  /** Surface a rejected write instead of dropping it. */
  onError?(error: unknown): void;
}

/**
 * Apply one settings patch optimistically, persist it, and roll the value back
 * if the durable write rejects — returning whichever state is now authoritative
 * (the merged value on success, the untouched previous value on failure). A
 * long-lived side panel can therefore never keep showing a value storage
 * refused (e.g. a write that threw "Extension context invalidated"). Kept pure
 * and DOM-free so the rollback contract is unit-testable without a renderer.
 */
export async function writeSettingOptimistically(
  previous: Settings,
  patch: SettingsPatch,
  hooks: OptimisticSettingWrite,
): Promise<Settings> {
  const next = applyPatch(previous, patch);
  // applyOptimistic is inside the try: it can reject too (it touches the DOM and,
  // in the panel, storage), and outside the try that rejection escaped past the
  // rollback — leaving the control showing a value that was never persisted.
  try {
    await hooks.applyOptimistic?.(next);
    await hooks.save(patch);
  } catch (error) {
    await hooks.onRolledBack?.(previous);
    hooks.onError?.(error);
    return previous;
  }
  await hooks.onCommitted?.(next, patch);
  return next;
}
