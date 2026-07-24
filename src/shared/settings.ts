// User settings, persisted in chrome.storage.local under a single key. Read by the
// side panel (all fields) and the service worker (maxItems only). A partial or
// corrupt stored shape is coerced back onto the defaults, so adding a field here
// is backward-safe and a bad value can never reach a filename builder or a splice().

import type { SettingsUpdateAck, SettingsUpdateMsg } from './messages';
import type { ThemePreference } from './theme';

export type QualityPref = 'highest' | 'lowest' | 'ask';
export type ListOrder = 'newest' | 'oldest';

export interface Settings {
  /** Filename pattern; tokens {source} {date} {id} are substituted, the rest kept. */
  filenameTemplate: string;
  /** Save downloads inside a "FaceScrap/" subfolder of the Downloads directory. */
  subfolder: boolean;
  /** Which representation the quality picker preselects; 'ask' opens the Save-As dialog. */
  defaultQuality: QualityPref;
  /** Skip the DASH audio+video remux and download the video track directly (muted). */
  directDownload: boolean;
  /** Pick EN/ES from navigator.language instead of the manual toggle. */
  followBrowserLang: boolean;
  /** Panel appearance; automatic follows Facebook for this tab, then the device. */
  theme: ThemePreference;
  listOrder: ListOrder;
  /** Ask for confirmation before the Clear button wipes the list. */
  confirmClear: boolean;
  /** View filter: show only video rows (images/audio hidden, not dropped). */
  videosOnly: boolean;
  /** View filter: hide video groups whose best height is below this (0 = off). */
  minResolution: number;
  /** Per-tab retention cap in storage (0 = unlimited). */
  maxItems: number;
  /** Count why captures get discarded (see diag.ts). Off by default: it is a
   *  maintenance tool, and the page hook only picks the flag up on a page load. */
  diagEnabled: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  filenameTemplate: '{source}-{date}-{id}',
  subfolder: true,
  defaultQuality: 'highest',
  directDownload: false,
  followBrowserLang: false,
  theme: 'auto',
  listOrder: 'newest',
  confirmClear: false,
  videosOnly: false,
  minResolution: 0,
  maxItems: 1500,
  diagEnabled: false,
};

const SETTINGS_KEY = 'settings';
const QUALITY: QualityPref[] = ['highest', 'lowest', 'ask'];
const ORDER: ListOrder[] = ['newest', 'oldest'];
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
    followBrowserLang: bool(r.followBrowserLang, DEFAULT_SETTINGS.followBrowserLang),
    theme: THEME.includes(r.theme as ThemePreference) ? (r.theme as ThemePreference) : DEFAULT_SETTINGS.theme,
    listOrder: ORDER.includes(r.listOrder as ListOrder) ? (r.listOrder as ListOrder) : DEFAULT_SETTINGS.listOrder,
    confirmClear: bool(r.confirmClear, DEFAULT_SETTINGS.confirmClear),
    videosOnly: bool(r.videosOnly, DEFAULT_SETTINGS.videosOnly),
    minResolution: num(r.minResolution, DEFAULT_SETTINGS.minResolution),
    maxItems: isNonNegativeSafeInteger(r.maxItems) ? r.maxItems : DEFAULT_SETTINGS.maxItems,
    diagEnabled: bool(r.diagEnabled, DEFAULT_SETTINGS.diagEnabled),
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

export type SettingsPatchWriter = (patch: Partial<Settings>) => Promise<Settings>;

/** Create one serialized read-modify-write lane. The service worker owns the
 * shared instance used by extension pages; direct writers are only a fallback
 * for tests or a temporarily unavailable/older worker. */
export function createSettingsPatchWriter(
  storage?: SettingsStorageArea,
): SettingsPatchWriter {
  let waitForPrevious: Promise<void> = Promise.resolve();

  return async (patch: Partial<Settings>): Promise<Settings> => {
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
      const next = normalizeSettings({ ...normalizeSettings(raw), ...pendingPatch });
      await area.set({ [SETTINGS_KEY]: next });
      return next;
    } finally {
      release();
    }
  };
}

const settingsPatchWriter = createSettingsPatchWriter();

function sanitizeSettingsPatch(raw: unknown): Partial<Settings> | undefined {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const normalized = normalizeSettings(raw);
  const patch: Partial<Settings> = {};
  const record = raw as Record<string, unknown>;
  // Carry every supplied field, coerced to a valid value: the worker write queue
  // must only ever persist a well-formed Settings, so a present-but-invalid field
  // is normalized to its default rather than rejecting the caller's whole patch.
  for (const field of SETTINGS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(record, field)) {
      (patch as Record<string, unknown>)[field] = normalized[field];
    }
  }
  return patch;
}

export interface SettingsRuntimeIdentity {
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

/** Route normal extension-page writes through the worker-owned queue. A direct
 * local write remains available when no runtime exists (unit tests) or when an
 * older worker has no receiver, but content scripts never get that bypass. */
export async function saveSettings(patch: Partial<Settings>): Promise<void> {
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

  // Deliberate, accepted tradeoff (not an oversight): this local fallback runs
  // only when the worker queue is unreachable — a unit-test context, or an old
  // worker with no receiver around an extension reload. In that narrow window two
  // extension pages could each write here without being serialized against one
  // another. We accept it because chrome.storage offers no cross-context lock (the
  // worker queue IS the serializer), and dropping the fallback would break every
  // legitimate no-worker write. A write that reaches here after the worker died
  // still fails safe via applySetting's rollback. Revisit only if a real
  // cross-page clobber is ever observed in practice.
  await settingsPatchWriter(pendingPatch);
}

export interface OptimisticSettingWrite {
  /** Persist the patch durably; a rejection triggers rollback. */
  save(patch: Partial<Settings>): Promise<void>;
  /** Reflect the optimistic value before the durable write resolves. */
  applyOptimistic?(next: Settings): void | Promise<void>;
  /** Effects that must happen only once the write is durable (re-render, etc.). */
  onCommitted?(next: Settings, patch: Partial<Settings>): void | Promise<void>;
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
  patch: Partial<Settings>,
  hooks: OptimisticSettingWrite,
): Promise<Settings> {
  const next = { ...previous, ...patch };
  await hooks.applyOptimistic?.(next);
  try {
    await hooks.save(patch);
  } catch (error) {
    await hooks.onRolledBack?.(previous);
    hooks.onError?.(error);
    return previous;
  }
  await hooks.onCommitted?.(next, patch);
  return next;
}
