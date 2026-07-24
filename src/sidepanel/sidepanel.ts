// FaceScrap side panel. Unlike a popup, it stays open while you browse and play
// videos, so it tracks the active tab of its window live and re-renders as media
// is captured (chrome.storage.session changes) or the tab switches.
//
// Three top-level views — Now Playing / Library / Saved — plus a Settings overlay.
// Now Playing is the live video, in focus, with its own quality picker and one
// Download. Library and Saved share a card grid: per-card download, multi-select,
// a bulk tray.

import {
  fbAssetKeys,
  imageDimensionsLabel,
  imagePixelArea,
  isFbcdn,
  legacyMediaId,
  mediaId,
  resolutionOf,
  videoGroupKey,
  type MediaItem,
  type MediaKind,
  type MediaSource,
} from '../shared/media';
import { fmt, getLang, setLang, t, type Lang, type MsgKey } from '../shared/i18n';
import { withHeartbeat } from '../shared/async';
import {
  getCaps,
  getDiagCounters,
  getFacebookTheme,
  getMedia,
  getSaved,
  facebookThemeKey,
  resetDiagCounters,
  type SavedEntry,
} from '../shared/storage';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  parseMaxItemsInput,
  sanitizeMaxItemsInput,
  saveSettings,
  writeSettingOptimistically,
  type Settings,
} from '../shared/settings';
import { resolveEffectiveTheme, type EffectiveTheme } from '../shared/theme';
import {
  DASH_UI_HARD_CAP_MS,
  DASH_UI_IDLE_MS,
  type ClearTabMsg,
  type DownloadDirectMsg,
  type DownloadDirectResponse,
  type DownloadDashMsg,
  type DownloadDashResponse,
} from '../shared/messages';
import {
  flushBindingsNow,
  getGroupCover,
  loadBindings,
  purgeTabBindings,
  selectPlaying,
} from '../shared/now-playing';
import { computePlayCenterY, createPlayPositionBatcher } from './play-position';

// Top-level view (the pill switch) and the Library/Saved sub-filter.
type View = 'now' | 'library' | 'saved';
type MediaFilter = 'all' | 'video' | 'image';

// User settings (loaded at startup, updated by the settings sheet). Behaviour reads
// this synchronously; the sheet writes it through applySetting() → saveSettings().
let settings: Settings = { ...DEFAULT_SETTINGS };
let systemThemeQuery: MediaQueryList | undefined;
let themeUpdateRevision = 0;

const SOURCE_KEY: Record<MediaSource, MsgKey> = {
  reel: 'sourceReel',
  story: 'sourceStory',
  highlight: 'sourceHighlight',
  video: 'sourceVideo',
  page: 'sourcePage',
};

function presentationKey(kind: MediaKind, source: MediaSource): MsgKey {
  return kind === 'image' && source === 'video' ? 'kindImage' : SOURCE_KEY[source];
}

const KIND_KEY: Record<MediaKind, MsgKey> = {
  video: 'kindVideo',
  image: 'kindImage',
  audio: 'kindAudio',
};

const KIND_ICON: Record<MediaKind, string> = {
  video: 'icons/nav-now.svg',
  image: 'icons/nav-library.svg',
  audio: 'icons/nav-saved.svg',
};

// Composition words for the tray's "video + image" line.
const COMPOSE_KEY: Record<MediaKind, MsgKey> = {
  video: 'composeVideo',
  image: 'composeImage',
  audio: 'composeAudio',
};

let view: View = 'now';
let mediaFilter: MediaFilter = 'all';
let tabId: number | undefined;
let windowId: number | undefined;
let ownPanelTabId: number | undefined;
const ownPanelUrl = chrome.runtime.getURL('sidepanel/sidepanel.html');

// Picked card ids (the tray cart). Kept outside the DOM so a pick survives the
// frequent full re-renders — every storage change plus the 2s tick rebuilds the
// grid, and a badge read back off the node would be lost. Cleared on tab switch:
// the cart points at the outgoing tab's cards.
const selected = new Set<string>();
// The per-tab state below is keyed `${tabId}:${cardId|groupKey}` (tabKey):
// content-derived ids collide across tabs (the same reel open twice), and
// namespacing lets the state SURVIVE tab switches — wiping it on onActivated
// used to repaint an in-flight download as idle, inviting a duplicate run.
const tabKey = (tid: number | undefined, id: string): string => `${tid ?? -1}:${id}`;
// A single card/Now-Playing download in flight, so its spinner and disabled
// state survive re-render AND tab switches. Any entry — any tab's — holds this
// panel's bulk tray closed; both paths drive the same offscreen document.
const cardBusy = new Set<string>();
// A bulk (tray) run is in flight IN THIS PANEL: render() must not paint over the
// button's progress label, and a second run must not start here. Cross-window and
// cross-card ordering is not this flag's job — the service worker serializes every
// DASH job on one chain (see downloadDash in service-worker.ts); panel flags only
// gate their own UI. `bulkTab` is which tab's cart is being downloaded, which
// decides who owns the button's label.
let bulkRunning = false;
let bulkTab: number | undefined;
/** This panel is already driving the offscreen document — a bulk run, or any
 *  single download whichever tab started it — so the tray must not start more.
 *  The one predicate shared by the tray's enablement and runBulk's entry guard. */
function offscreenBusyHere(): boolean {
  return bulkRunning || cardBusy.size > 0;
}
// Cards whose last download attempt failed. There is no retry button in the
// grid, so this only puts an honest tag on the card; the Now Playing button
// turns into "Retry".
const lastFailed = new Set<string>();
// The specific reason each failed card failed (expired URL, ffmpeg exit, timeout),
// shown as a tooltip on its 'Failed' tag. Kept in step with lastFailed.
const failReason = new Map<string, string>();

/** Drop one tab's entries from the tab-namespaced state: its media was wiped
 *  (navigation reset), its list was cleared, or the tab closed — a later
 *  recapture of the same content-derived id must not inherit a stale failure
 *  tag or quality pick. cardBusy is deliberately left alone: an in-flight
 *  download owns its entry and removes it when it settles. */
function pruneTabState(tid: number): void {
  tabResetGen.set(tid, (tabResetGen.get(tid) ?? 0) + 1);
  const prefix = `${tid}:`;
  for (const k of [...lastFailed]) if (k.startsWith(prefix)) lastFailed.delete(k);
  for (const k of [...failReason.keys()]) if (k.startsWith(prefix)) failReason.delete(k);
  for (const k of [...qualityChoice.keys()]) if (k.startsWith(prefix)) qualityChoice.delete(k);
}
// Bumped by pruneTabState. A download that settles AFTER its tab's state was
// pruned must not re-seed lastFailed: the failure belongs to wiped content
// (the navigation that pruned is often what killed the merge — expired fbcdn
// URLs), and the tag would resurface as a phantom on the next recapture of the
// same content-derived id. Settle paths snapshot the generation at start and
// skip their add when it moved. One counter per tab, never deleted: a closed
// tab's bump must stay visible to a download still draining.
const tabResetGen = new Map<number, number>();
const resetGen = (tid: number | undefined): number => (tid === undefined ? 0 : (tabResetGen.get(tid) ?? 0));
// Tabs closed while this panel document lived. A download or bulk queue that
// snapshotted its tid keeps draining after the tab closes, and writing its
// receipts would recreate the saved_ key purgeTab just removed — the serial
// chain orders enqueued tasks, not future ones. Consulted before every addSaved.
// Chosen quality per video (tabKey(tab, videoGroupKey) → item id), so a re-render
// (every storage change + the 2s tick) doesn't reset the Now Playing selector to
// the best — and a pick made in one tab never leaks into another.
const qualityChoice = new Map<string, string>();
// False only on a Chromium browser without the offscreen API: DASH remux is then
// impossible, so those options degrade to a direct video-only download. Defaults
// true; corrected once the SW's caps flag is read at startup.
let offscreenAvailable = true;

/** A count string: `{n}` is substituted, and one is a different string entirely. */
function tn(one: MsgKey, many: MsgKey, n: number): string {
  return fmt(n === 1 ? one : many, { n });
}

/** "video + image" — only the kinds actually present, in a fixed order so the line
 *  doesn't reshuffle as items arrive. */
function composeLine(kinds: Iterable<MediaKind>): string {
  const present = new Set(kinds);
  return (['video', 'image', 'audio'] as const)
    .filter((k) => present.has(k))
    .map((k) => t(COMPOSE_KEY[k]))
    .join(' + ');
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

/** Resolve the active tab of the window this panel is docked in. */
function setTrackedTab(nextTabId: number | undefined): void {
  tabId = nextTabId;
  if (nextTabId === undefined) delete document.documentElement.dataset.trackedTab;
  else document.documentElement.dataset.trackedTab = String(nextTabId);
}

async function resolveActiveTab(): Promise<void> {
  const win = await chrome.windows.getCurrent();
  windowId = win.id;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  setTrackedTab(tab?.id);
}

const LANG_KEY = 'lang';

async function loadLang(): Promise<Lang> {
  const stored = (await chrome.storage.local.get(LANG_KEY))[LANG_KEY];
  return stored === 'es' ? 'es' : 'en';
}

async function saveLang(lang: Lang): Promise<void> {
  await chrome.storage.local.set({ [LANG_KEY]: lang });
}

function getSystemTheme(): EffectiveTheme {
  // Keep the established dark appearance on stripped/older Chromium forks
  // where matchMedia is unavailable. Manual light/dark still resolves above it.
  return systemThemeQuery == null || systemThemeQuery.matches ? 'dark' : 'light';
}

/** Resolve the preference into the one effective theme painted on <html>.
 * Revision + tab guards prevent a slow read for the outgoing tab from winning
 * after a tab switch or a manual preference change. */
// themeChoice defaults to the committed setting; the optimistic write path passes
// the pending value so the panel reflects a theme change before the durable write
// resolves (module-level `settings` is only reassigned once the write lands).
async function applyEffectiveTheme(themeChoice: Settings['theme'] = settings.theme): Promise<void> {
  const revision = ++themeUpdateRevision;
  const trackedTab = tabId;

  if (themeChoice !== 'auto') {
    document.documentElement.dataset.theme = resolveEffectiveTheme(themeChoice, undefined, getSystemTheme());
    return;
  }

  const facebookTheme = trackedTab === undefined ? null : await getFacebookTheme(trackedTab);
  if (revision !== themeUpdateRevision || trackedTab !== tabId || themeChoice !== 'auto') return;
  document.documentElement.dataset.theme = resolveEffectiveTheme(
    themeChoice,
    facebookTheme?.theme,
    getSystemTheme(),
  );
}

function setupSystemTheme(): void {
  if (typeof window.matchMedia !== 'function') return;
  systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const handleSystemThemeChange = (): void => {
    if (settings.theme === 'auto') void applyEffectiveTheme();
  };
  if (typeof systemThemeQuery.addEventListener === 'function') {
    systemThemeQuery.addEventListener('change', handleSystemThemeChange);
  } else if (typeof systemThemeQuery.addListener === 'function') {
    systemThemeQuery.addListener(handleSystemThemeChange);
  }
}

/** Register before the first storage read so a theme signal persisted during
 * startup cannot fall into a read/listener gap. applyEffectiveTheme's revision
 * guard makes overlapping initial/event reads settle on the newest result. */
function setupFacebookThemeStorageListener(): void {
  chrome.storage.session.onChanged.addListener((changes) => {
    if (settings.theme === 'auto' && tabId !== undefined && facebookThemeKey(tabId) in changes) {
      void applyEffectiveTheme();
    }
  });
}

/** The language to use: the browser's when "follow browser language" is on,
 *  otherwise the manually-saved choice. */
async function resolveLang(): Promise<Lang> {
  if (settings.followBrowserLang) {
    return (navigator.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en';
  }
  return loadLang();
}

/** Localize every static [data-i18n]/[data-i18n-title]/[data-i18n-aria] node and
 *  reflect the active language on the toggle. Dynamic nodes are (re)built by render(). */
function localize(): void {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n as MsgKey | undefined;
    if (key) el.textContent = t(key);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    const key = el.dataset.i18nTitle as MsgKey | undefined;
    if (key) el.title = t(key);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => {
    const key = el.dataset.i18nAria as MsgKey | undefined;
    if (key) el.setAttribute('aria-label', t(key));
  });
  document.querySelectorAll<HTMLButtonElement>('#lang [data-lang]').forEach((b) => {
    const active = b.dataset.lang === getLang();
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  // Keep the document language in sync so screen readers announce in the right one.
  document.documentElement.lang = getLang();
}

function setupLangToggle(): void {
  byId('lang').addEventListener('click', (e) => {
    if (settings.followBrowserLang) return; // manual toggle inert while following the browser
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-lang]');
    if (!btn) return;
    const lang: Lang = btn.dataset.lang === 'es' ? 'es' : 'en';
    if (lang === getLang()) return;
    setLang(lang);
    void saveLang(lang);
    localize();
    void render(); // the language is a signature term; render() sees the change
  });
}

/** Push the current settings into the sheet's controls. */
function reflectSettings(): void {
  byId<HTMLInputElement>('set-template').value = settings.filenameTemplate;
  byId<HTMLInputElement>('set-subfolder').checked = settings.subfolder;
  byId<HTMLSelectElement>('set-quality').value = settings.defaultQuality;
  byId<HTMLInputElement>('set-direct').checked = settings.directDownload;
  byId<HTMLInputElement>('set-followlang').checked = settings.followBrowserLang;
  byId<HTMLSelectElement>('set-theme').value = settings.theme;
  byId<HTMLSelectElement>('set-order').value = settings.listOrder;
  byId<HTMLInputElement>('set-confirmclear').checked = settings.confirmClear;
  byId<HTMLInputElement>('set-videosonly').checked = settings.videosOnly;
  byId<HTMLSelectElement>('set-minres').value = String(settings.minResolution);
  byId<HTMLInputElement>('set-maxitems').value = String(settings.maxItems);
  byId<HTMLInputElement>('set-diag').checked = settings.diagEnabled;
  // The manual EN/ES toggle is inert while the language follows the browser.
  const langToggle = byId('lang');
  langToggle.classList.toggle('is-disabled', settings.followBrowserLang);
  langToggle.setAttribute('aria-disabled', String(settings.followBrowserLang));
  langToggle.querySelectorAll<HTMLButtonElement>('[data-lang]').forEach((button) => {
    button.disabled = settings.followBrowserLang;
  });
}

/** Persist one setting, then re-apply anything it affects (language + re-render).
 * The rollback contract (a rejected durable write must not leave the panel
 * showing an unsaved value) lives in writeSettingOptimistically, unit-tested
 * without a DOM; this adapter only wires it to the renderer. */
async function applySetting(patch: Partial<Settings>): Promise<void> {
  settings = await writeSettingOptimistically(settings, patch, {
    save: saveSettings,
    applyOptimistic: async (next) => {
      if ('theme' in patch) await applyEffectiveTheme(next.theme);
    },
    onRolledBack: async (previous) => {
      if ('theme' in patch) await applyEffectiveTheme(previous.theme);
      reflectSettings();
    },
    onError: (error) => console.error('[FaceScrap] setting write failed', error),
    onCommitted: async () => {
      if ('followBrowserLang' in patch) {
        setLang(await resolveLang());
        localize();
      }
      reflectSettings();
      // No signature reset: every render-relevant setting is already a signature
      // term, so render() rebuilds exactly when something visible changed.
      await render();
    },
  });
}

let settingsFocusFrame: number | undefined;

/** Treat Settings as the fourth panel surface and keep keyboard focus inside it. */
function setSettingsOpen(open: boolean, restoreFocus = true): void {
  const sheet = byId('settings');
  const trigger = byId<HTMLButtonElement>('settings-open');
  const nav = byId('views');
  const hadFocus = sheet.contains(document.activeElement);
  if (settingsFocusFrame !== undefined) {
    window.cancelAnimationFrame(settingsFocusFrame);
    settingsFocusFrame = undefined;
  }
  sheet.hidden = !open;
  byId('app').classList.toggle('is-settings', open);
  trigger.setAttribute('aria-expanded', String(open));
  if (open) {
    pressOnly(nav, trigger);
    settingsFocusFrame = window.requestAnimationFrame(() => {
      settingsFocusFrame = undefined;
      if (!sheet.hidden) byId<HTMLInputElement>('set-template').focus();
    });
    return;
  }
  const route = nav.querySelector<HTMLButtonElement>(`[data-view="${view}"]`);
  if (route != null) pressOnly(nav, route);
  if (restoreFocus && hadFocus) trigger.focus();
}

/** Open/close the settings surface and wire every control to applySetting(). */
function setupSettings(): void {
  byId('settings-open').addEventListener('click', () => setSettingsOpen(true));
  byId('settings-close').addEventListener('click', () => setSettingsOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !byId('settings').hidden) {
      e.preventDefault();
      setSettingsOpen(false);
    }
  });

  const onCheck = (id: string, key: keyof Settings): void => {
    byId<HTMLInputElement>(id).addEventListener('change', (e) => {
      void applySetting({ [key]: (e.target as HTMLInputElement).checked } as Partial<Settings>);
    });
  };
  const onSelect = (id: string, apply: (v: string) => Partial<Settings>): void => {
    byId<HTMLSelectElement>(id).addEventListener('change', (e) => {
      void applySetting(apply((e.target as HTMLSelectElement).value));
    });
  };

  byId<HTMLInputElement>('set-template').addEventListener('change', (e) => {
    void applySetting({ filenameTemplate: (e.target as HTMLInputElement).value });
  });
  onCheck('set-subfolder', 'subfolder');
  onSelect('set-quality', (v) => ({ defaultQuality: v as Settings['defaultQuality'] }));
  onCheck('set-direct', 'directDownload');
  onCheck('set-followlang', 'followBrowserLang');
  onSelect('set-theme', (v) => ({ theme: v as Settings['theme'] }));
  onSelect('set-order', (v) => ({ listOrder: v as Settings['listOrder'] }));
  onCheck('set-confirmclear', 'confirmClear');
  onCheck('set-videosonly', 'videosOnly');
  onSelect('set-minres', (v) => ({ minResolution: Number(v) }));
  const maxItemsInput = byId<HTMLInputElement>('set-maxitems');
  maxItemsInput.addEventListener('input', () => {
    const digits = sanitizeMaxItemsInput(maxItemsInput.value);
    if (digits !== maxItemsInput.value) maxItemsInput.value = digits;
  });
  maxItemsInput.addEventListener('change', () => {
    const maxItems = parseMaxItemsInput(maxItemsInput.value);
    if (maxItems === undefined) {
      maxItemsInput.value = String(settings.maxItems);
      return;
    }
    maxItemsInput.value = String(maxItems);
    if (maxItems !== settings.maxItems) void applySetting({ maxItems });
  });
  maxItemsInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    maxItemsInput.blur();
  });
  onCheck('set-diag', 'diagEnabled');

  byId('diag-reset').addEventListener('click', () => {
    void resetDiagCounters().then(renderDiag);
  });
  // Only when opened: the counters are a maintenance detail, not worth a
  // storage read on every settings render.
  byId('diag-details').addEventListener('toggle', () => {
    if ((byId('diag-details') as HTMLDetailsElement).open) void renderDiag();
  });

  reflectSettings();
}

/** Counter names are printed RAW (jsonLineTooLarge, …) rather than translated:
 *  they are maintenance terms whose whole value is grepping straight to the
 *  discard site in the code, and a localized label would break that link. */
async function renderDiag(): Promise<void> {
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

function isDownloadable(item: MediaItem): boolean {
  // Only fbcdn media is downloadable — never a URL that slipped in from the page.
  return isFbcdn(item.url);
}

function extFor(kind: MediaKind): string {
  return kind === 'image' ? 'jpg' : kind === 'audio' ? 'm4a' : 'mp4';
}

/** Seconds → "M:SS" (or "H:MM:SS" past an hour). */
function formatDuration(sec: number): string {
  const s = Math.round(sec);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** Bitrate (bytes/s) parsed from a fbcdn URL's `bitrate=` param, 0 if absent. */
function bitrate(url: string): number {
  const m = url.match(/[?&]bitrate=(\d+)/);
  return m ? Number(m[1]) : 0;
}

function filenameFor(item: MediaItem): string {
  const stamp = new Date(item.addedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const id = item.id.replace(/[^a-z0-9]/gi, '').slice(-8) || 'file';
  const base = (settings.filenameTemplate || DEFAULT_SETTINGS.filenameTemplate)
    .replace(/\{source\}/g, item.source)
    .replace(/\{date\}/g, stamp)
    .replace(/\{id\}/g, id)
    // Collapse anything not filename-safe: blocks path traversal (../), CRLF, and
    // reserved characters, so a template can't escape the download directory.
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 120) || 'facescrap';
  const name = `${base}.${extFor(item.kind)}`;
  return settings.subfolder ? `FaceScrap/${name}` : name;
}

/** Whether downloads should open the browser's Save-As dialog (quality = 'ask'). */
function askOnSave(): boolean {
  return settings.defaultQuality === 'ask';
}

/** Append " · tag" to a card's meta line. The separator is the caller's because
 *  the meta line owns its own punctuation. */
function appendTag(meta: HTMLElement, text: string, cls?: string, title?: string): void {
  const s = document.createElement('span');
  s.className = cls ? `tag ${cls}` : 'tag';
  s.textContent = text;
  if (title) s.title = title;
  meta.append(' · ', s);
}

/** DASH pairs lose their audio track — and with it the remux — when the browser
 *  can't remux at all, or the user asked for direct downloads. Everything
 *  downstream already handles audio-less items: they pick up the "may lack audio"
 *  tag. It is a setting, not a property of the item, so it has to be re-applied
 *  wherever a stored item is turned back into a download. */
function stripAudio(): boolean {
  return !offscreenAvailable || settings.directDownload;
}

/** Remux a DASH pair via the offscreen doc. The SW dedups by track pair. Resolves
 *  either way — a bulk run must survive one bad item — and reports whether it
 *  landed. Failure/saved bookkeeping is the caller's: it is keyed by CARD, and an
 *  item does not know which card is downloading it. */
// DASH_UI_IDLE_MS (shared, messages.ts) is a UI hang backstop only — it fires
// if the SW dies without closing the message port. Correctness timeouts live in
// the SW. It counts IDLE time, not elapsed: the worker forwards mux progress
// (FACESCRAP_MUX_PROGRESS) and every report restarts this clock, so a download
// that legitimately runs for many minutes is never tagged failed here while the
// worker is still finishing it — which is exactly what a fixed deadline did.
// Jobs are serialized worker-side, and a queued job reports no progress yet;
// the window is wide enough to cover that wait, and offscreenBusyHere() gates
// every download entry point so this panel can only ever have one job pending.

/** Beat function of the download currently awaiting a merge, if any. Only one
 *  can exist at a time (see offscreenBusyHere), so a single slot suffices. */
let muxBeat: (() => void) | null = null;
chrome.runtime.onMessage.addListener((msg) => {
  const m = msg as { type?: string } | undefined;
  if (m?.type === 'FACESCRAP_MUX_PROGRESS') {
    muxBeat?.();
  }
});

async function startDashDownload(tid: number, item: MediaItem, receipt: SavedEntry): Promise<string | null> {
  const audioUrl = item.audioUrl;
  if (audioUrl == null) return 'No audio track.'; // callers gate on audioUrl; narrow it for the typed message
  try {
    const guarded = withHeartbeat(
      chrome.runtime.sendMessage({
        type: 'FACESCRAP_DOWNLOAD_DASH',
        tabId: tid,
        videoUrl: item.url,
        audioUrl,
        filename: filenameFor(item),
        saveAs: askOnSave(),
        receipt,
      } satisfies DownloadDashMsg),
      DASH_UI_IDLE_MS,
      DASH_UI_HARD_CAP_MS,
      'The merge timed out.',
    );
    muxBeat = guarded.beat;
    let r: DownloadDashResponse | undefined;
    try {
      r = (await guarded.promise) as DownloadDashResponse | undefined;
    } finally {
      muxBeat = null;
    }
    if (!r?.ok) throw new Error(r?.error || 'Merge failed.');
    return null;
  } catch (e: unknown) {
    console.error('[FaceScrap]', e);
    return (e as Error)?.message || 'Merge failed.';
  }
}

/** Direct download of a progressive/complete media URL (already has audio).
 *  Resolves either way, for the same reason as startDashDownload. Returns null
 *  on success, or the failure reason to surface on the card. */
async function startDirectDownload(tid: number, item: MediaItem, receipt: SavedEntry): Promise<string | null> {
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'FACESCRAP_DOWNLOAD_DIRECT',
      tabId: tid,
      url: item.url,
      filename: filenameFor(item),
      saveAs: askOnSave(),
      receipt,
    } satisfies DownloadDirectMsg)) as DownloadDirectResponse | undefined;
    if (!response?.ok) throw new Error(response?.error || 'Download failed.');
    return null;
  } catch (e) {
    console.error('[FaceScrap]', e);
    return (e as Error)?.message || 'Download failed.';
  }
}

/** Freeze a download receipt at click time: the download can await minutes
 *  (DASH_UI_TIMEOUT_MS), during which a tab switch or navigation wipe may
 *  rebuild `cardsById` with other content — the receipt must describe what was
 *  actually saved. */
function savedEntryFor(cardId: string, item: MediaItem): SavedEntry {
  const card = cardsById.get(cardId);
  return {
    id: cardId,
    kind: item.kind,
    source: item.source,
    savedAt: Date.now(),
    thumbUrl: card?.thumbUrl ?? (item.kind === 'image' ? item.url : item.thumbUrl),
    resLabel: item.kind === 'video' ? resolutionOf(item).label : undefined,
    durationSec: card?.durationSec ?? item.durationSec,
  };
}

/** The one download core shared by single-card and bulk paths. Both routes go
 * through the worker, which waits for Chrome's terminal state and persists the
 * receipt only on `complete`; closing this panel cannot lose that bookkeeping. */
async function downloadOne(
  tid: number | undefined,
  item: MediaItem,
  receipt: SavedEntry,
): Promise<string | null> {
  if (tid === undefined) return 'Invalid tab.';
  return item.audioUrl != null
    ? startDashDownload(tid, item, receipt)
    : startDirectDownload(tid, item, receipt);
}

/** Download one item (a card's or Now Playing's chosen target). Sequential with
 *  EVERYTHING this panel starts — bulk runs and other singles alike: the SW runs
 *  DASH jobs one at a time, so stacked clicks would sit queued while each one's
 *  UI backstop burned, and the queue's tail would be tagged failed (receipt
 *  dropped) over work that then landed. One at a time keeps the backstop honest.
 *  Busy + failed state are keyed by card id and survive re-render. */
async function downloadCard(cardId: string, item: MediaItem): Promise<void> {
  // Snapshot the tab AND the receipt: the merge can await minutes, and
  // onActivated flips module `tabId` on a tab switch — the save belongs to the
  // tab and the card that were clicked.
  const tid = tabId;
  const bkey = tabKey(tid, cardId);
  if (offscreenBusyHere()) return;
  const receipt = savedEntryFor(cardId, item);
  const gen = resetGen(tid);
  cardBusy.add(bkey);
  lastFailed.delete(bkey);
  failReason.delete(bkey);
  await render(); // busy/failed are signature terms; render() sees them flip
  const err = await downloadOne(tid, item, receipt);
  const ok = err === null;
  // Busy/failed are tab-namespaced, so this bookkeeping can never tag another
  // tab's card (the old clear-on-switch model instead dropped it, leaving a
  // phantom busy entry). The failure tag additionally checks the reset
  // generation: a prune during the await (nav reset, Clear, tab close) means
  // this failure belongs to wiped content and must not re-seed the tag it just
  // removed. Only the repaint is scoped: a panel showing another tab repaints
  // just the globally-gated tray.
  cardBusy.delete(bkey);
  if (!ok && resetGen(tid) === gen) {
    lastFailed.add(bkey);
    if (err) failReason.set(bkey, err);
  }
  if (tid === tabId) {
    await render();
  } else {
    paintTray();
  }
}

// ── Card model (Library / Saved grid) ────────────────────────────────────────

/** One grid card: an image/audio item, or a whole video collapsed to the single
 *  representation the quality setting picks. */
interface Card {
  /** The card's identity in `selected`, `lastFailed`, `cardBusy` and the saved
   *  list. For a video this is the GROUP key, never `target.id`: which
   *  representation wins is recomputed every render, so it moves when a better one
   *  is captured or when the quality/direct-download settings flip — and a pick, a
   *  failure tag or a saved mark keyed to it would evaporate under a card still on
   *  screen. Prefixed because a group key and an item id are different namespaces
   *  that must never be able to collide. */
  id: string;
  /** Newest capture in the card, for the list order. */
  at: number;
  kind: MediaKind;
  source: MediaSource;
  /** Absent when nothing here is downloadable (an MSE blob:, a non-fbcdn URL). */
  target?: MediaItem;
  thumbUrl?: string;
  /** mediaId of thumbUrl — lets doRender drop an image card that is only a shown
   *  video's cover. */
  thumbId?: string;
  resLabel?: string;
  durationSec?: number;
  /** The target is a video-only DASH track: it will download muted. */
  mayLackAudio: boolean;
  /** This card is what the tab is playing right now. */
  live: boolean;
  /** Hidden from the LIBRARY grid by a declutter setting (videosOnly,
   *  minResolution). A flag, not a drop: the Saved history and the cart must
   *  keep seeing the card. */
  libraryHidden?: boolean;
  /** This image is the cover of a Library-visible video: a dupe under "All"
   *  (the video card already wears it), but the real, downloadable item under
   *  the explicit "Images" sub-filter — hiding it there would make a captured
   *  cover unreachable in every view. */
  coverOfShown?: boolean;
  /** A Saved receipt with no live capture behind it (media_ was wiped). Renders
   *  with honest disabled controls; revives when a replay re-captures the same
   *  content-derived id. */
  stale?: boolean;
}

/** Card-id scheme — a persisted format: saved_ receipts store these ids, so it
 *  changes only with a migration (see SavedEntry in storage.ts). Prefixed
 *  because group keys and item ids are namespaces that must never collide. */
const videoCardId = (gkey: string): string => `v:${gkey}`;
const itemCardId = (itemId: string): string => `i:${itemId}`;

/** Will the download have sound? audioUrl → gets remuxed; non-`dash` → muxed
 *  progressive; a `dash` track without audioUrl is video-only (muted). */
function willHaveAudio(i: MediaItem): boolean {
  return i.audioUrl != null || !i.dash;
}

interface VideoOptions {
  options: MediaItem[]; // downloadable representations, highest-resolution first
  gkey: string;
  thumbUrl?: string;
  durationSec?: number;
}

/** Collapse a video group's representations into a deduped, ranked option list —
 *  shared by the grid card (which takes one) and Now Playing (which keeps them all
 *  for the quality selector). */
function videoOptions(group: MediaItem[], tid: number | undefined): VideoOptions {
  const src = stripAudio()
    ? group.map((i) => (i.audioUrl != null ? { ...i, audioUrl: undefined } : i))
    : group;
  // Downloadable options: any fbcdn representation — including the network
  // capture, the always-present baseline. Deduplicated by resolution: for each
  // height prefer the one that will produce sound (muxed progressive or DASH pair
  // with audioUrl) over a muted DASH track of the same size.
  const downloadable = src.filter(isDownloadable);
  const score = (i: MediaItem): number => (willHaveAudio(i) ? 2 : 0) + (i.audioUrl == null ? 1 : 0);
  const byRes = new Map<string, MediaItem>();
  for (const i of downloadable) {
    const { label } = resolutionOf(i);
    if (label === 'Video') {
      byRes.set(`Video:${i.id}`, i); // unknown: don't collapse
      continue;
    }
    const prev = byRes.get(label);
    if (!prev) {
      byRes.set(label, i);
      continue;
    }
    const ds = score(i) - score(prev);
    if (ds > 0 || (ds === 0 && bitrate(i.url) > bitrate(prev.url))) byRes.set(label, i);
  }
  const options = [...byRes.values()].sort(
    (a, b) => resolutionOf(b).rank - resolutionOf(a).rank || bitrate(b.url) - bitrate(a.url),
  );
  const gkey = videoGroupKey(src[0]);
  return {
    options,
    gkey,
    // Captured poster first; else the on-screen cover learned while it played.
    thumbUrl:
      src.find((i) => i.thumbUrl != null)?.thumbUrl ??
      (tid !== undefined ? getGroupCover(tid, gkey) : undefined),
    durationSec: src.find((i) => i.durationSec != null)?.durationSec,
  };
}

/** The setting's preselected representation from an option list: 'highest' takes
 *  the top, 'lowest' the bottom, 'ask' the top (it only opens the Save-As dialog). */
function defaultTarget(options: MediaItem[]): MediaItem | undefined {
  return settings.defaultQuality === 'lowest' ? options[options.length - 1] : options[0];
}

function buildVideoCard(group: MediaItem[], tid: number | undefined, playing: Set<string>): Card {
  const { options, gkey, thumbUrl, durationSec } = videoOptions(group, tid);
  const target = defaultTarget(options);
  return {
    id: videoCardId(gkey),
    at: Math.max(...group.map((i) => i.addedAt)),
    kind: 'video',
    source: group[0].source,
    target,
    thumbUrl,
    thumbId: thumbUrl != null ? mediaId(thumbUrl) : undefined,
    resLabel: target != null ? resolutionOf(target).label : undefined,
    durationSec,
    mayLackAudio: target != null && !willHaveAudio(target),
    live: group.some((i) => playing.has(i.id)),
  };
}

/** Card for a non-video item. Videos always go through buildVideoCard — doRender
 *  splits them off before reaching here. */
function buildItemCard(item: MediaItem, playing: Set<string>): Card {
  return {
    id: itemCardId(item.id),
    at: item.addedAt,
    kind: item.kind,
    source: item.source,
    target: isDownloadable(item) ? item : undefined,
    // Images preview themselves; audio has no preview and falls to the icon.
    thumbUrl: item.kind === 'image' ? item.url : item.thumbUrl,
    mayLackAudio: false,
    live: playing.has(item.id),
  };
}

/** The card's second line: "0:14 · 720p" for a video, "Photo" (with dimensions
 *  when known) for an image, plus any tag it has earned. */
function cardMeta(card: Card): HTMLElement {
  const meta = document.createElement('p');
  meta.className = 'card-meta';
  let base: string;
  if (card.kind === 'video') {
    const parts = [
      card.durationSec != null ? formatDuration(card.durationSec) : undefined,
      card.resLabel ?? undefined,
    ].filter((p): p is string => p != null);
    base = parts.length > 0 ? parts.join(' · ') : t('kindVideo');
  } else if (card.kind === 'image') {
    base = t('cardPhoto');
  } else {
    base = t('kindAudio');
  }
  meta.textContent = base;

  if (card.target == null) appendTag(meta, t(card.stale ? 'tagSavedGone' : 'unavailable'));
  if (card.kind === 'audio') appendTag(meta, t('tagAudioTrack'));
  if (card.mayLackAudio) appendTag(meta, t('tagMayLackAudio'));
  // No retry button in the grid, so a dead download would otherwise vanish
  // silently. The pick stays put; the card's own Download button re-tries.
  // Never on a stub: a receipt IS a success, and a failure recorded under the
  // same content-derived id belongs to the live card, not the history row.
  if (!card.stale && lastFailed.has(tabKey(tabId, card.id)))
    appendTag(meta, t('tagFailed'), 'tag-fail', failReason.get(tabKey(tabId, card.id)));
  return meta;
}

const PORTRAIT_COVER_MAX_ASPECT = 0.7;
const PREVIEW_PLAY_SIZE = 50;
const CARD_PLAY_SIZE = 30;
const PLAY_CLEARANCE = 12;
let playResizeObserver: ResizeObserver | undefined;

interface MediaPlayTarget {
  container: HTMLElement,
  image: HTMLImageElement | null,
  obstruction: HTMLElement | null,
  badgeSize: number,
}

interface MediaPlayMeasurement {
  container: HTMLElement;
  centerY: number | null;
}

function measureMediaPlay(target: MediaPlayTarget): MediaPlayMeasurement {
  const { container, image, obstruction, badgeSize } = target;
  const frame = container.getBoundingClientRect();
  const obstructionRect = obstruction?.getBoundingClientRect();
  const centerY = computePlayCenterY({
    frameWidth: frame.width,
    frameHeight: frame.height,
    mediaWidth: image?.naturalWidth,
    mediaHeight: image?.naturalHeight,
    fit: image == null || image.classList.contains('media-fit-cover') ? 'cover' : 'contain',
    unobscuredBottom:
      obstructionRect != null && obstructionRect.height > 0 ? obstructionRect.top - frame.top : undefined,
    badgeSize,
    clearance: PLAY_CLEARANCE,
  });

  return { container, centerY };
}

function applyMediaPlay({ container, centerY }: MediaPlayMeasurement): void {
  container.classList.toggle('play-obstructed', centerY == null);
  if (centerY == null) container.style.removeProperty('--play-y');
  else container.style.setProperty('--play-y', `${centerY.toFixed(2)}px`);
}

function describeMediaPlay(container: HTMLElement): MediaPlayTarget | null {
  if (!container.isConnected) return null;
  if (container.id === 'now-preview') {
    return {
      container,
      image: container.querySelector<HTMLImageElement>(':scope > img:not(.thumb-bg)'),
      obstruction: document.getElementById('now-title'),
      badgeSize: PREVIEW_PLAY_SIZE,
    };
  }
  if (!container.matches('.card-thumb.is-video')) return null;
  return {
    container,
    image: container.querySelector<HTMLImageElement>(':scope > img:not(.thumb-bg)'),
    obstruction: container.closest('.card')?.querySelector<HTMLElement>('.card-title') ?? null,
    badgeSize: CARD_PLAY_SIZE,
  };
}

function updatePlayPositions(requested: readonly HTMLElement[] | null): void {
  const containers =
    requested ??
    [
      document.getElementById('now-preview'),
      ...document.querySelectorAll<HTMLElement>('.card-thumb.is-video'),
    ].filter((element): element is HTMLElement => element instanceof HTMLElement);
  const targets = containers
    .map(describeMediaPlay)
    .filter((target): target is MediaPlayTarget => target != null);
  // All geometry reads complete before any class/style mutation, preventing a
  // read-write-read layout cascade during global resize passes.
  const measurements = targets.map(measureMediaPlay);
  measurements.forEach(applyMediaPlay);
}

const playPositionBatcher = createPlayPositionBatcher<HTMLElement>(
  (callback) => window.requestAnimationFrame(callback),
  updatePlayPositions,
);

function schedulePlayPositions(container?: HTMLElement): void {
  playPositionBatcher.schedule(container);
}

function setupPlayPositioning(): void {
  playResizeObserver = new ResizeObserver(() => schedulePlayPositions());
  for (const element of [
    document.getElementById('now-preview'),
    document.querySelector('.now-overlay'),
    document.getElementById('list'),
  ]) {
    if (element instanceof Element) playResizeObserver.observe(element);
  }
  window.addEventListener('resize', () => schedulePlayPositions());
  void document.fonts.ready.then(() => schedulePlayPositions());
  schedulePlayPositions();
}

/** Keep Story-like portrait art immersive, but preserve the full composition
 *  of square, 4:5 and landscape posts. The blurred sibling fills any bars. */
function applyMediaFit(image: HTMLImageElement, container: HTMLElement): void {
  if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
  image.classList.toggle('media-fit-cover', image.naturalWidth / image.naturalHeight <= PORTRAIT_COVER_MAX_ASPECT);
  schedulePlayPositions(container);
}

function renderCard(card: Card): HTMLElement {
  const el = document.createElement('article');
  el.className = 'card';
  if (card.live) el.classList.add('is-live');

  const thumb = document.createElement('div');
  thumb.className = 'card-thumb';
  if (card.kind === 'video') thumb.classList.add('is-video');

  // The fallback is an external SVG mask, never `thumb.textContent`: the pick and
  // download controls live inside the thumb and must survive a broken preview.
  const icon = document.createElement('span');
  icon.className = 'kind-fallback';
  icon.style.setProperty('--kind-icon', `url("${KIND_ICON[card.kind]}")`);
  const showIcon = (): void => {
    thumb.classList.remove('is-video'); // the play badge is ::after on .is-video
    thumb.prepend(icon);
  };

  if (card.thumbUrl != null) {
    // Blurred cover-fit underlay + sharp contain-fit image: vertical stories
    // show whole in the portrait thumb instead of cropped (see .card-thumb).
    const bg = document.createElement('img');
    bg.className = 'thumb-bg';
    bg.alt = '';
    bg.loading = 'lazy';
    bg.addEventListener('error', () => bg.remove());
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('load', () => applyMediaFit(img, thumb));
    img.addEventListener('error', () => {
      img.remove();
      bg.remove();
      showIcon();
    });
    bg.src = card.thumbUrl;
    img.src = card.thumbUrl;
    thumb.append(bg, img);
  } else {
    showIcon();
  }

  // Selection check (top-right) — feeds the tray.
  const pick = document.createElement('button');
  pick.className = 'pick';
  pick.type = 'button';
  pick.setAttribute('aria-pressed', String(selected.has(card.id)));
  if (card.target != null) {
    pick.title = t('selectItem');
    pick.setAttribute('aria-label', t('selectItem'));
    pick.addEventListener('click', () => {
      if (selected.has(card.id)) selected.delete(card.id);
      else selected.add(card.id);
      // Paint in place instead of re-rendering: a rebuild would tear this very
      // button out from under the click and drop keyboard focus with it.
      pick.setAttribute('aria-pressed', String(selected.has(card.id)));
      paintTray();
    });
  } else {
    // Two distinct honest excuses: a stub is a downloaded receipt whose capture
    // is gone (replaying revives it); anything else is undownloadable media.
    pick.disabled = true;
    const why = t(card.stale ? 'titleSavedGone' : 'titleBlobUnavailable');
    pick.title = why;
    pick.setAttribute('aria-label', why);
  }
  thumb.appendChild(pick);

  // Per-card download (bottom-right) — downloads this one immediately.
  const dl = document.createElement('button');
  dl.className = 'card-dl';
  dl.type = 'button';
  const busy = cardBusy.has(tabKey(tabId, card.id));
  if (card.target != null) {
    dl.title = t('downloadItem');
    dl.setAttribute('aria-label', t('downloadItem'));
    dl.classList.toggle('busy', busy);
    // Any in-flight download gates every button (not just this card's): the SW
    // serializes jobs, so a stack of singles would outrun the UI backstop.
    dl.disabled = offscreenBusyHere();
    const target = card.target;
    dl.addEventListener('click', () => void downloadCard(card.id, target));
  } else {
    dl.disabled = true;
    dl.title = t(card.stale ? 'titleSavedGone' : 'titleBlobUnavailable');
    dl.setAttribute('aria-label', t(card.stale ? 'tagSavedGone' : 'unavailable'));
  }
  thumb.appendChild(dl);

  const title = document.createElement('h3');
  title.className = 'card-title';
  title.textContent = t(presentationKey(card.kind, card.source));

  el.append(thumb, title, cardMeta(card));
  return el;
}

// ── Now Playing model ─────────────────────────────────────────────────────────

interface NowState {
  id: string; // the card id (v:gkey / i:id), so a Now Playing save shows in the grid
  kind: MediaKind;
  source: MediaSource;
  thumbUrl?: string;
  durationSec?: number;
  pieces: number; // total captured pieces in this post
  options: MediaItem[]; // quality options (video); a single entry for image/audio
  gkey: string; // qualityChoice key
}

/** The playing item, focused. Prefers a playing video group (with its full quality
 *  ladder); falls back to a playing image. Null when nothing downloadable plays. */
function buildNowState(
  items: MediaItem[],
  groups: Map<string, MediaItem[]>,
  tid: number | undefined,
  playing: Set<string>,
  pieces: number,
): NowState | null {
  const playingItems = items.filter((i) => playing.has(i.id));
  if (playingItems.length === 0) return null;

  // The playing set often carries only the streamed baseline track, not the video's
  // full quality ladder. Take the playing video's GROUP key and look up the whole
  // group doRender already built — so Now Playing gets the same duration,
  // resolution and quality options the grid card gets (the DASH reps that carry
  // them aren't necessarily in the playing set).
  const playingVideo = playingItems.find((i) => i.kind === 'video');
  if (playingVideo) {
    const key = videoGroupKey(playingVideo);
    const group = groups.get(key) ?? [playingVideo];
    // The declutter settings apply here exactly as in the Library grid — the
    // two views must agree on what the minimum-resolution filter hides.
    if (settings.minResolution > 0) {
      const maxH = Math.max(0, ...group.map((i) => i.height ?? 0));
      if (maxH > 0 && maxH < settings.minResolution) return null;
    }
    const { options, gkey, thumbUrl, durationSec } = videoOptions(group, tid);
    if (options.length === 0) return null;
    return {
      id: videoCardId(gkey),
      kind: 'video',
      source: playingVideo.source,
      thumbUrl,
      durationSec,
      pieces,
      options,
      gkey,
    };
  }
  // "Videos only" hides images/audio from every view, this one included.
  if (settings.videosOnly) return null;
  const firstImage = playingItems.find((i) => i.kind === 'image' && isDownloadable(i));
  // The first active image anchors the visible resource. Rank only equivalent
  // canonical variants so a larger photo buried in another overlay can never
  // replace what the centre detector actually selected.
  const img = firstImage == null
    ? undefined
    : playingItems
        .filter((i) => i.kind === 'image' && isDownloadable(i) && i.id === firstImage.id)
        .reduce<MediaItem | undefined>((best, candidate) => {
          if (best == null) return candidate;
          const areaDelta = imagePixelArea(candidate) - imagePixelArea(best);
          return areaDelta > 0 || (areaDelta === 0 && candidate.addedAt > best.addedAt)
            ? candidate
            : best;
        }, undefined);
  if (!img) return null;
  return {
    id: itemCardId(img.id),
    kind: 'image',
    source: img.source,
    thumbUrl: img.url,
    pieces,
    options: [img],
    gkey: itemCardId(img.id),
  };
}

/** Format the Now Playing / card download label, e.g. "Download MP4 · 1080p". */
function downloadLabel(target: MediaItem): string {
  const ext = extFor(target.kind).toUpperCase();
  const res = resolutionOf(target).label;
  const label = target.kind === 'video' && res !== 'Video' ? `${ext} · ${res}` : ext;
  return fmt('downloadKind', { label });
}

/** Paint the Now Playing view from a NowState. Wires the quality selector (which
 *  repaints the metadata + button in place) and the single Download button. */
function paintNow(now: NowState | null): void {
  byId('now-empty').hidden = now != null;
  byId('now-content').hidden = now == null;
  byId('now-live').hidden = now == null;
  if (now == null) return;

  const isImage = now.kind === 'image';
  // Chosen representation: the user's pick for this video in this tab, else the setting.
  let target =
    now.options.find((o) => o.id === qualityChoice.get(tabKey(tabId, now.gkey))) ?? defaultTarget(now.options)!;
  let imageResolutionLabel = imageDimensionsLabel(target);
  const paintImageResolution = (image: HTMLImageElement): void => {
    if (now.kind !== 'image' || !image.isConnected || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
    imageResolutionLabel = `${image.naturalWidth}×${image.naturalHeight}`;
    byId('m-resolution').textContent = imageResolutionLabel;
  };

  const preview = byId('now-preview');
  preview.classList.toggle('is-video', now.kind === 'video');
  // A real poster as an <img> pair — a blurred cover-fit underlay plus the
  // sharp contain-fit image, so a vertical story shows whole instead of
  // cropped (an expired/blocked fbcdn URL falls back to the gradient wash on
  // error); rebuilt each paint.
  preview.querySelectorAll('img').forEach((el) => el.remove());
  if (now.thumbUrl != null) {
    const bg = document.createElement('img');
    bg.className = 'thumb-bg';
    bg.alt = '';
    bg.addEventListener('error', () => bg.remove());
    bg.src = now.thumbUrl;
    const img = document.createElement('img');
    img.alt = '';
    img.addEventListener('load', () => {
      applyMediaFit(img, preview);
      paintImageResolution(img);
    });
    img.addEventListener('error', () => {
      img.remove();
      bg.remove();
    });
    img.src = now.thumbUrl;
    preview.prepend(bg, img);
    if (img.complete) paintImageResolution(img);
  }
  byId('now-badge').textContent = t(presentationKey(now.kind, now.source));
  byId('now-dur').textContent = isImage ? '' : now.durationSec != null ? formatDuration(now.durationSec) : '';

  byId('now-title').textContent = t(presentationKey(now.kind, now.source));
  // The post-piece count belongs to the view heading; the line under the title
  // describes the media itself ("Video · downloadable").
  byId('now-pieces').textContent = tn('piecesInPostOne', 'piecesInPost', now.pieces);
  byId('now-sub').textContent = `${t(KIND_KEY[now.kind])} · ${t('nowDownloadable')}`;

  byId('m-format').textContent = extFor(target.kind).toUpperCase();
  byId('m-duration-metric').hidden = isImage;
  byId('m-duration').textContent = isImage ? '' : now.durationSec != null ? formatDuration(now.durationSec) : '—';

  const dl = byId<HTMLButtonElement>('now-download');
  const paintMeta = (): void => {
    byId('m-resolution').textContent =
      target.kind === 'video' ? resolutionOf(target).label : imageResolutionLabel ?? '—';
    const busy = cardBusy.has(tabKey(tabId, now.id));
    dl.disabled = offscreenBusyHere(); // same gate as the grid: one download at a time
    dl.textContent = busy
      ? target.audioUrl != null
        ? t('downloadMerging')
        : t('downloadSaving')
      : lastFailed.has(tabKey(tabId, now.id))
        ? t('downloadRetry')
        : downloadLabel(target);
  };

  // Quality selector — a native select, present for every video (disabled when
  // there is only one representation) and hidden for images/audio.
  const quality = byId('now-quality');
  const select = byId<HTMLSelectElement>('now-qselect');
  quality.hidden = now.kind !== 'video';
  if (now.kind === 'video') {
    byId('now-qcount').textContent = now.options.length > 1
      ? tn('qualityOptionsOne', 'qualityOptions', now.options.length)
      : '';
    byId('now-qcount').hidden = now.options.length <= 1;
    quality.classList.toggle('is-single-option', now.options.length <= 1);
    select.classList.toggle('is-single-option', now.options.length <= 1);
    select.textContent = '';
    for (const opt of now.options) {
      const o = document.createElement('option');
      o.value = opt.id;
      o.textContent = resolutionOf(opt).label;
      select.appendChild(o);
    }
    select.value = target.id;
    select.disabled = now.options.length <= 1;
    select.onchange = (): void => {
      target = now.options.find((o) => o.id === select.value) ?? now.options[0];
      qualityChoice.set(tabKey(tabId, now.gkey), target.id);
      paintMeta();
      finishQualityPickerInteraction();
    };
  }

  dl.onclick = (): void => void downloadCard(now.id, target);
  paintMeta();
  schedulePlayPositions();
}

// ── Selection tray (Library / Saved) ──────────────────────────────────────────

// The last render's cards, keyed by card id. The pick handler and the bulk run
// have to get from a picked id back to the item to download, and neither can read
// it off the DOM — a rebuild will have replaced the node by then.
const cardsById = new Map<string, Card>();
// The grid cards currently on screen, for the Select all toggle.
let visibleCards: Card[] = [];
// Whether the last render saw any live card. The live bit decays by CLOCK
// (selectPlaying's freshness/grace windows), not by storage event — playback
// stopping on a quiet tab writes nothing — so while any card glows, the 2s
// tick must keep re-evaluating even in the grid views or the ring never
// turns off. Updated every doRender, before any early return.
let anyLiveCards = false;

/** Paint the tray, which reads `selected`. Deliberately NOT part of the render
 *  signature — toggling a pick repaints these nodes instead of tearing the grid
 *  down under the user's cursor. Hidden entirely outside the grid views. */
function paintTray(): void {
  const n = selected.size;
  const tray = byId('tray');
  // The cart is global across Library/Saved, but the tray must not float over a
  // view with nothing in it — an empty grid (or Now Playing) hides it; the picks
  // survive and reappear when a grid with cards is shown again.
  if (view === 'now' || n === 0 || visibleCards.length === 0) {
    tray.hidden = true;
    syncSelectAll();
    return;
  }
  tray.hidden = false;
  byId('tray-count').textContent = tn('selectedCountOne', 'selectedCount', n);
  const kinds: MediaKind[] = [];
  for (const id of selected) {
    const c = cardsById.get(id);
    if (c) kinds.push(c.kind);
  }
  byId('tray-meta').textContent = composeLine(kinds);

  const btn = byId<HTMLButtonElement>('bulk-dl');
  // Enablement is global (offscreenBusyHere); only the label is tab-scoped — a
  // run painting "Saving 2/3…" in its own tab must not be stamped over here.
  btn.disabled = offscreenBusyHere();
  if (!bulkRunning || bulkTab !== tabId) btn.textContent = fmt('downloadSelected', { n });
  syncSelectAll();
}

/** Downloadable visible cards and whether every one is already picked — shared
 *  by the Select-all label and its click handler so the two can't drift. */
function pickableState(): { targets: Card[]; allPicked: boolean } {
  const targets = visibleCards.filter((c) => c.target != null);
  return { targets, allPicked: targets.length > 0 && targets.every((c) => selected.has(c.id)) };
}

/** Keep the "Select all" / "Clear picks" link in step with whether every
 *  downloadable visible card is already picked. */
function syncSelectAll(): void {
  byId('select-all').textContent = pickableState().allPicked ? t('deselectAll') : t('selectAll');
}

/** Download every pick, one at a time. Sequential on purpose: parallel DASH merges
 *  would fight over the single offscreen document, and the tray's progress label
 *  counts a queue, not a race. */
async function runBulk(): Promise<void> {
  if (offscreenBusyHere()) return;
  // Snapshot the tab. The queue below can await minutes per item, and onActivated
  // flips module `tabId` on a tab switch — these picks, and the saved marks they
  // earn, belong to the tab that made them.
  const tid = tabId;
  const gen = resetGen(tid);
  // Receipts freeze at queue-build time too: by the time an item's turn comes,
  // a navigation wipe may have rebuilt cardsById empty and the receipt would
  // lose its thumb/duration.
  const queue: { id: string; item: MediaItem; receipt: SavedEntry }[] = [];
  for (const id of selected) {
    const target = cardsById.get(id)?.target;
    if (target != null) queue.push({ id, item: target, receipt: savedEntryFor(id, target) });
  }
  if (queue.length === 0) return;

  const btn = byId<HTMLButtonElement>('bulk-dl');
  bulkRunning = true;
  bulkTab = tid;
  btn.disabled = true;
  const done: string[] = [];
  const failed: Array<{ id: string; err: string }> = [];
  try {
    for (const [i, { id, item, receipt }] of queue.entries()) {
      // Only in the tab this run belongs to: elsewhere the panel shows a different
      // cart, and #bulk-dl is one shared node — this label would report our queue
      // over their picks.
      if (bulkTab === tabId && view !== 'now') {
        btn.textContent = fmt('bulkBusy', { i: i + 1, n: queue.length });
      }
      const err = await downloadOne(tid, item, receipt);
      if (err === null) done.push(id);
      else failed.push({ id, err });
    }
  } finally {
    bulkRunning = false;
    bulkTab = undefined;
    // Unpick only what landed — a failure keeps its pick, so pressing Download
    // again retries exactly the items that didn't make it — and only while the
    // panel still shows the tab that ran this queue: `selected` is NOT
    // tab-namespaced and content-derived ids collide across tabs, so after a
    // switch these deletes would silently empty picks the user just made in the
    // OTHER tab. Failure tags are tab-namespaced (always safe to delete), but
    // their adds check the reset generation: a nav reset/Clear mid-queue means
    // the failures belong to wiped content — see tabResetGen.
    for (const id of done) {
      if (tid === tabId) selected.delete(id);
      lastFailed.delete(tabKey(tid, id));
      failReason.delete(tabKey(tid, id));
    }
    if (resetGen(tid) === gen) {
      for (const { id, err } of failed) {
        lastFailed.add(tabKey(tid, id));
        failReason.set(tabKey(tid, id), err);
      }
    }
    if (tid === tabId) {
      lastRenderSig = ''; // the saved list and the failure tags feed the cards
      await render();
    }
    // Unconditional: `bulkRunning` held every tab's tray button disabled, so every
    // tab's button needs the release painted.
    paintTray();
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

// render() is invoked from overlapping async sources (storage events, the 2s tick,
// tab switches); serialize it so two in-flight renders can't append duplicate
// cards, and coalesce bursts into one trailing rerun.
let renderRunning = false;
let renderQueued = false;
let lastRenderSig = '';
// Hold signature-changing DOM rebuilds only while the QUALITY picker is open:
// paintNow rebuilds its options, tearing them out from under the popup, and
// capture bursts churn the signature exactly while the user is picking.
// Current Chromium exposes `:open`; the gesture flag is the conservative
// fallback for older supported builds that do not parse it. Blur, Escape and a
// committed change release that fallback immediately instead of leaving a
// focused-but-closed selector stale; its shorter cap also covers a native
// picker that closes without emitting any observable value or focus event.
let renderBlockedSince = 0;
let renderRetryTimer: number | undefined;
let qualityPickerFallbackEngaged = false;
const RENDER_HOLD_MAX_MS = 10_000;
const RENDER_FALLBACK_HOLD_MAX_MS = 1_500;
const RENDER_HOLD_RETRY_MS = 500;

function finishQualityPickerInteraction(): void {
  qualityPickerFallbackEngaged = false;
  if (renderBlockedSince === 0) return;
  renderBlockedSince = 0;
  if (renderRetryTimer !== undefined) {
    window.clearTimeout(renderRetryTimer);
    renderRetryTimer = undefined;
  }
  void render();
}

function toggleQualityPickerFallback(): void {
  if (qualityPickerFallbackEngaged) {
    finishQualityPickerInteraction();
    return;
  }
  qualityPickerFallbackEngaged = true;
}

function setupQualityPickerRenderHold(): void {
  const select = byId<HTMLSelectElement>('now-qselect');
  select.addEventListener('pointerdown', toggleQualityPickerFallback);
  select.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      window.setTimeout(finishQualityPickerInteraction, 0);
      return;
    }
    if (
      event.key === ' ' ||
      event.key === 'Enter' ||
      event.key === 'F4' ||
      (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp'))
    ) {
      toggleQualityPickerFallback();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      qualityPickerFallbackEngaged = true;
    }
  });
  select.addEventListener('blur', finishQualityPickerInteraction);
}

function qualityPickerRenderHoldMs(): number {
  const select = document.activeElement;
  if (!(select instanceof HTMLSelectElement) || select.id !== 'now-qselect') return 0;
  try {
    return select.matches(':open') ? RENDER_HOLD_MAX_MS : 0;
  } catch {
    return qualityPickerFallbackEngaged ? RENDER_FALLBACK_HOLD_MAX_MS : 0;
  }
}

async function render(): Promise<void> {
  if (renderRunning) {
    renderQueued = true;
    return;
  }
  renderRunning = true;
  try {
    await doRender();
  } finally {
    renderRunning = false;
    if (renderQueued) {
      renderQueued = false;
      void render();
    }
  }
}

/** A Saved card rendered from its receipt alone — the live capture is gone.
 *  No target on purpose: receipts store no media URLs (fbcdn signatures rotate),
 *  so there is nothing truthful for a download button to fetch. */
function stubCard(e: SavedEntry): Card {
  return {
    id: e.id,
    at: e.savedAt,
    kind: e.kind,
    source: e.source,
    target: undefined,
    thumbUrl: e.thumbUrl,
    resLabel: e.resLabel,
    durationSec: e.durationSec,
    mayLackAudio: false,
    live: false,
    stale: true,
  };
}

async function doRender(): Promise<void> {
  // Snapshot the tab once: doRender yields at every await, and onActivated can flip
  // module `tabId` mid-render — reading it twice would mix tab A's items with tab
  // B's now-playing. The queued rerun renders the newly-active tab.
  const tid = tabId;
  const [items, savedEntries] = await Promise.all([
    tid === undefined ? Promise.resolve<MediaItem[]>([]) : getMedia(tid),
    // The ledger only feeds the Saved view (its cards and its signature term);
    // the other views skip the read.
    view !== 'saved' || tid === undefined ? Promise.resolve<SavedEntry[]>([]) : getSaved(tid),
  ]);
  const playing =
    tid === undefined ? new Set<string>() : new Set((await selectPlaying(tid, items)).map((i) => i.id));

  // Group videos by asset (one card per video); images/audio are one card each.
  const groups = new Map<string, MediaItem[]>();
  const others: MediaItem[] = [];
  for (const it of items) {
    if (it.kind === 'video') {
      const key = videoGroupKey(it);
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(it);
    } else {
      others.push(it);
    }
  }

  // The declutter settings (videosOnly, minResolution) and the cover dedupe hide
  // cards from the LIBRARY only — flags, not drops: the Saved history must keep
  // rendering a receipt whose card a Library filter hides, and the cart relies
  // on cardsById holding every real card.
  const cards: Card[] = [];
  for (const group of groups.values()) {
    const card = buildVideoCard(group, tid, playing);
    if (settings.minResolution > 0) {
      const maxH = Math.max(0, ...group.map((i) => i.height ?? 0));
      if (maxH > 0 && maxH < settings.minResolution) card.libraryHidden = true;
    }
    cards.push(card);
  }
  // An image card that is only the cover of a Library-VISIBLE video is a dupe
  // under "All" — but only there: it stays reachable under the "Images"
  // sub-filter (its own flag below), its receipt still renders in Saved, and a
  // cover whose video is itself hidden keeps its Library slot exactly as before.
  const shownCovers = new Set(
    cards.filter((c) => !c.libraryHidden).map((c) => c.thumbId).filter((x): x is string => x != null),
  );
  for (const it of others) {
    const card = buildItemCard(it, playing);
    if (it.kind === 'image' && shownCovers.has(it.id)) card.coverOfShown = true;
    if (settings.videosOnly && it.kind !== 'video') card.libraryHidden = true;
    cards.push(card);
  }
  cards.sort((a, b) => (settings.listOrder === 'oldest' ? a.at - b.at : b.at - a.at));
  anyLiveCards = cards.some((c) => c.live);

  cardsById.clear();
  for (const c of cards) cardsById.set(c.id, c);
  // Re-link pre-canonical Saved receipts to their current live cards. New
  // receipts always use canonical ids; these aliases disappear with the
  // browser session once the legacy ledger ages out.
  for (const group of groups.values()) {
    const card = cardsById.get(videoCardId(videoGroupKey(group[0])));
    if (card == null) continue;
    for (const item of group) {
      const legacy = legacyMediaId(item.url);
      if (legacy != null) cardsById.set(videoCardId(fbAssetKeys(item.url)[0] ?? legacy), card);
    }
  }
  for (const item of others) {
    const legacy = legacyMediaId(item.url);
    const card = cardsById.get(itemCardId(item.id));
    if (legacy != null && card != null) cardsById.set(itemCardId(legacy), card);
  }
  // Forget picks whose card is gone: evicted from storage or left behind by a
  // tab switch. Neither a sub-filter nor a declutter setting drops one — the
  // picks are a cart, and hiding a card from the Library must not empty it.
  let pruned = false;
  for (const id of [...selected]) {
    if (cardsById.has(id)) continue;
    selected.delete(id);
    pruned = true;
  }

  // Pieces = the cards of the post on screen right now (the live ones), not the
  // whole tab's capture count. Now Playing state is only built for its own view.
  const now =
    view === 'now' ? buildNowState(items, groups, tid, playing, cards.filter((c) => c.live).length) : null;
  // Library hides the declutter-flagged cards. Saved renders the receipt ledger
  // in download order: the live card when the capture still exists (a real
  // re-download with fresh URLs), a stub frozen from the receipt when it does
  // not — the stub revives by itself once a replay re-captures the same
  // content-derived id. Both views then narrow by the media sub-filter.
  const orderedSaved = settings.listOrder === 'oldest' ? savedEntries : [...savedEntries].reverse();
  const base =
    view === 'saved'
      ? orderedSaved.map((e) => cardsById.get(e.id) ?? stubCard(e))
      : cards.filter((c) => !c.libraryHidden && !(c.coverOfShown && mediaFilter !== 'image'));
  const gridCards =
    view === 'now' ? [] : base.filter((c) => mediaFilter === 'all' || c.kind === mediaFilter);

  // Skip the DOM rebuild when nothing visible changed: tearing the grid or the
  // Now Playing selector down every ≤2s drops focus and re-announces the aria-live
  // region. The signature covers everything painted — except `selected` (paints in
  // place, see paintTray) and the chosen quality (paints in place, see paintNow).
  const nowSig =
    now == null
      ? 'none'
      : `${now.id}|${now.source}|${now.thumbUrl ?? ''}|${now.durationSec ?? ''}|${now.pieces}|${now.kind}|${now.options
          .map((o) => `${o.id}:${o.url}:${o.width ?? ''}x${o.height ?? ''}`)
          .join('~')}|${cardBusy.has(tabKey(tid, now.id)) ? 1 : 0}|${lastFailed.has(tabKey(tid, now.id)) ? 1 : 0}`;
  const sig = [
    view,
    mediaFilter,
    getLang(),
    String(offscreenAvailable),
    // The whole busy predicate, not just bulkRunning: EVERY download button's
    // enablement gates on it, so a single download settling while its own card
    // is filtered out of the view must still move the signature — otherwise the
    // visible buttons (and the tray doRender repaints) stay stuck in the busy
    // era on a quiet tab.
    String(offscreenBusyHere()),
    JSON.stringify([
      settings.listOrder,
      settings.videosOnly,
      settings.minResolution,
      settings.directDownload,
      settings.defaultQuality,
    ]),
    view === 'now' ? nowSig : '',
    view === 'saved' ? savedEntries.map((e) => e.id).join(',') : '',
    view === 'now'
      ? ''
      : gridCards
          .map(
            (c) =>
              // source paints the card title, so it must move the signature: a
              // group's first item (its source authority) can change under a
              // stable card id when the retention cap evicts it.
              `${c.id}|${c.source}|${c.thumbUrl ?? ''}|${c.resLabel ?? ''}|${c.durationSec ?? ''}|${
                c.target != null ? 1 : 0
              }|${c.mayLackAudio ? 1 : 0}|${c.live ? 1 : 0}|${lastFailed.has(tabKey(tid, c.id)) ? 1 : 0}|${
                cardBusy.has(tabKey(tid, c.id)) ? 1 : 0
              }|${c.stale ? 1 : 0}`, // stale bit: a stub→live revival must repaint
          )
          .join('\n'),
  ].join('\n');
  visibleCards = gridCards;
  if (sig === lastRenderSig) {
    // `selected` is out of the signature (it paints in place), but the prune above
    // is storage-driven, not a click — a pick the active filter hides can be
    // dropped without moving the signature, leaving the tray offering a gone item.
    if (pruned) paintTray();
    renderBlockedSince = 0;
    return;
  }
  const renderHoldMaxMs = qualityPickerRenderHoldMs();
  if (renderHoldMaxMs > 0) {
    const nowMs = Date.now();
    if (renderBlockedSince === 0) renderBlockedSince = nowMs;
    if (nowMs - renderBlockedSince < renderHoldMaxMs) {
      if (renderRetryTimer === undefined) {
        renderRetryTimer = window.setTimeout(() => {
          renderRetryTimer = undefined;
          void render();
        }, RENDER_HOLD_RETRY_MS);
      }
      return; // deferred — lastRenderSig stays put, so the retry re-detects the change
    }
  }
  renderBlockedSince = 0;
  lastRenderSig = sig;

  byId('view-now').hidden = view !== 'now';
  byId('view-grid').hidden = view === 'now';

  if (view === 'now') {
    paintNow(now);
    paintTray();
    return;
  }

  // Grid heading + counts, per Library vs Saved.
  byId('grid-title').textContent = view === 'saved' ? t('savedTitle') : t('libraryTitle');
  byId('grid-sub').textContent = view === 'saved' ? t('savedSubtitle') : t('librarySubtitle');
  const count = byId('grid-count');
  count.hidden = gridCards.length === 0;
  count.textContent = tn('foundCountOne', 'foundCount', gridCards.length);

  const empty = byId('grid-empty');
  empty.hidden = gridCards.length > 0;
  // "Your picks / Select all" would read oddly above an empty-state message.
  byId('picks-head').hidden = gridCards.length === 0;
  if (gridCards.length === 0) {
    byId('grid-empty-title').textContent = view === 'saved' ? t('savedEmptyTitle') : t('libraryEmptyTitle');
    byId('grid-empty-body').textContent = view === 'saved' ? t('savedEmptyBody') : t('libraryEmptyBody');
  }

  const list = byId('list');
  list.textContent = '';
  for (const c of gridCards) list.appendChild(renderCard(c));

  paintTray();
  schedulePlayPositions();
}

// ── View + filter wiring ──────────────────────────────────────────────────────

function pressOnly(nav: HTMLElement, active: HTMLElement): void {
  nav.querySelectorAll<HTMLButtonElement>('[aria-pressed]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b === active));
  });
}

function setupViews(): void {
  const nav = byId('views');
  byId('app').dataset.view = view;
  nav.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-view]');
    if (btn == null || !nav.contains(btn)) return;
    view = (btn.dataset.view as View | undefined) ?? 'now';
    byId('app').dataset.view = view;
    setSettingsOpen(false, false);
    pressOnly(nav, btn);
    void render(); // the view is a signature term
  });
}

function setupFilters(): void {
  const nav = byId('filters');
  nav.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-filter]');
    if (btn == null || !nav.contains(btn)) return;
    mediaFilter = (btn.dataset.filter as MediaFilter | undefined) ?? 'all';
    pressOnly(nav, btn);
    void render(); // the sub-filter is a signature term
  });
}

function setupSelectAll(): void {
  byId('select-all').addEventListener('click', () => {
    const { targets, allPicked } = pickableState();
    for (const c of targets) {
      if (allPicked) selected.delete(c.id);
      else selected.add(c.id);
    }
    lastRenderSig = ''; // picks paint in place and are not a signature term — force the rebuild
    void render();
  });
}

// A browser missing an API the panel needs (e.g. chrome.storage.session on a
// stripped Chromium fork) would otherwise leave the panel blank with no clue.
// Show a readable, hardcoded message instead — i18n may not have loaded yet.
function finishPanelBoot(state: 'ready' | 'error'): void {
  document.documentElement.dataset.boot = state;
  const app = document.getElementById('app');
  if (!app) return;
  app.removeAttribute('inert');
  app.removeAttribute('aria-hidden');
  app.removeAttribute('aria-busy');
}

function showFatal(e: unknown): void {
  finishPanelBoot('error');
  const el = document.getElementById('fatal');
  if (el) {
    el.hidden = false;
    const v = chrome.runtime?.getManifest?.().version;
    el.textContent =
      `FaceScrap couldn't start on this browser (${(e as Error)?.message ?? String(e)}). ` +
      `It needs a Chromium browser with the storage, tabs and side-panel APIs — try Chrome or Edge.` +
      (v ? ` [v${v}]` : '');
  }
  console.error('[FaceScrap] init failed', e);
}

document.addEventListener('DOMContentLoaded', () => void init());

async function init(): Promise<void> {
  try {
    ownPanelTabId = (await chrome.tabs.getCurrent())?.id;
    await resolveActiveTab();
    setupFacebookThemeStorageListener();
    settings = await loadSettings();
    setupSystemTheme();
    await applyEffectiveTheme();
    setLang(await resolveLang());
    localize();
    const caps = await getCaps();
    offscreenAvailable = caps?.offscreen ?? true;
    byId('degraded').hidden = offscreenAvailable;
    setupViews();
    setupFilters();
    setupSelectAll();
    setupLangToggle();
    setupSettings();
    setupQualityPickerRenderHold();
    setupPlayPositioning();

    // Cosmetic: never let a missing getManifest (odd fork) break the init tail.
    const version = chrome.runtime?.getManifest?.().version;
    const versionEl = document.getElementById('version');
    if (versionEl && version) versionEl.textContent = `v${version}`;

    byId('bulk-dl').addEventListener('click', () => void runBulk());

    byId('clear').addEventListener('click', async () => {
      if (settings.confirmClear && !window.confirm(t('confirmClearPrompt'))) return;
      // The picks, failure tags and quality choices point at items about to stop
      // existing; drop them here rather than leaving render() to prune a cart
      // whose contents went away. Only this tab's — Clear is a per-tab action.
      selected.clear();
      if (tabId !== undefined) {
        pruneTabState(tabId);
        // Route through the worker so the wipe serializes on the same write chain as
        // capture writes (a panel-side clearTab can't, and the list would resurrect).
        // The worker also resets the badge once the removal lands.
        await chrome.runtime.sendMessage({ type: 'FACESCRAP_CLEAR_TAB', tabId } satisfies ClearTabMsg);
      }
      lastRenderSig = '';
      await render();
    });

    // New media captured (or cleared) for the tracked tab → re-render live. Only keys
    // for OUR tab force a render — but hard resets are honored for EVERY tab.
    chrome.storage.session.onChanged.addListener((changes) => {
      // A nav/close reset (clearTab) removes media_/playing_/recent_/bind_ for a
      // tab (newValue undefined) — and it hits BACKGROUND tabs too: any top-level
      // Facebook navigation (a tab-strip reload, a redirect) wipes a tab the user
      // isn't looking at. Treat every such deletion as a hard reset for ITS tab,
      // not just the tracked one: purge that tab's in-memory bindings + last-live
      // and cancel any pending flush, so a debounced write can't resurrect bind_
      // after it was wiped — and drop its failure tags and quality picks, because
      // a recapture of the same content-derived id after the navigation is a NEW
      // item and a phantom "failed" tag or stale pick lies. This state survives
      // tab switches by design, so a background wipe missed here would resurface
      // when the user switches back.
      const wipedTabs = new Set<number>();
      for (const [key, ch] of Object.entries(changes)) {
        const captureRemoval = ch.newValue === undefined ? /^(?:media|playing)_(\d+)$/.exec(key) : null;
        const bindChange = /^bind_(\d+)$/.exec(key);
        const bindRecord = ch.newValue as { state?: unknown } | undefined;
        const bindingReset = bindChange != null && (ch.newValue === undefined || bindRecord?.state === null);
        const match = captureRemoval ?? (bindingReset ? bindChange : null);
        if (match != null) wipedTabs.add(Number(match[1]));
      }
      for (const wiped of wipedTabs) {
        purgeTabBindings(wiped);
        pruneTabState(wiped);
        // Load the tombstone generation after the purge. A new binding learned on
        // the still-open page then writes against the worker's current generation
        // instead of being discarded as an old-generation conflict.
        void loadBindings(wiped);
      }
      if (tabId === undefined) return;
      const tid = tabId;
      if (
        `media_${tid}` in changes ||
        `playing_${tid}` in changes ||
        `recent_${tid}` in changes ||
        `saved_${tid}` in changes ||
        'caps' in changes
      ) {
        void render();
      }
    });

    // The reset listener must exist before this first asynchronous read. A clear
    // that lands while bind_<tabId> is loading otherwise goes unseen and the
    // just-cleared mapping is restored into panel memory.
    if (tabId !== undefined) await loadBindings(tabId);

    // Forget a closed tab's panel-local memory. Worker-owned terminal settlement
    // serializes Saved receipts with its own purge and cannot resurrect this tab.
    chrome.tabs.onRemoved.addListener((id) => {
      purgeTabBindings(id);
      pruneTabState(id);
    });

    // Keep language and settings in sync if another view (a second panel in another
    // window, or the popup) changes them.
    chrome.storage.local.onChanged.addListener((changes) => {
      // Live-update the counters while the section is open, so a scroll session in
      // the Facebook tab shows discards accumulating without reopening settings.
      if ('diag_counters' in changes && (byId('diag-details') as HTMLDetailsElement).open) void renderDiag();
      const next = changes[LANG_KEY]?.newValue;
      if ((next === 'en' || next === 'es') && next !== getLang()) {
        setLang(next);
        localize();
        void render(); // language is a signature term
      }
      if ('settings' in changes) {
        void (async () => {
          settings = await loadSettings();
          await applyEffectiveTheme();
          reflectSettings();
          // No signature reset: the render-relevant settings are signature terms,
          // so the echo of this panel's own applySetting() write stays a cheap
          // no-op instead of a full rebuild.
          await render();
        })();
      }
    });

    // Follow the active tab within this window as the user switches tabs. The
    // revision prevents a slow tabs.get/theme read for A from landing after a
    // later activation of B. A post-registration query closes the startup gap
    // between resolveActiveTab() and installing this listener.
    let activationRevision = 0;
    const followActivatedTab = async (info: { tabId: number; windowId: number }): Promise<void> => {
      if (windowId !== undefined && info.windowId !== windowId) return;
      if (info.tabId === ownPanelTabId) return;
      const revision = ++activationRevision;
      const activatedTab = await chrome.tabs.get(info.tabId).catch(() => undefined);
      if (revision !== activationRevision) return;
      // The production side panel is not a tab. Ignore only this extension page
      // when it is opened as one (for diagnostics/QA) so it cannot replace the
      // Facebook tab the panel is meant to observe.
      if (activatedTab?.url === ownPanelUrl || activatedTab?.pendingUrl === ownPanelUrl) return;
      // Some Chromium forks expose activation events but transiently reject
      // tabs.get() during a rapid switch. The event's tabId is still authoritative;
      // ownPanelTabId above already excludes the only extension tab we must ignore.
      // Falling through keeps capture/Now Playing attached to the real active tab
      // instead of silently freezing on the previous one.
      flushBindingsNow(); // persist the OUTGOING tab's learning before switching
      setTrackedTab(info.tabId);
      await applyEffectiveTheme();
      if (revision !== activationRevision || tabId !== info.tabId) return;
      // Only the cart empties: it points at the outgoing tab's cards. Busy, failure
      // and quality state STAY — they are tab-namespaced (tabKey), so the incoming
      // tab renders its own entries and an in-flight download keeps its spinner for
      // when the user switches back (clearing it here used to repaint a running
      // merge as idle and invite a duplicate). lastRenderSig goes: two empty tabs
      // share a signature, and a skipped render would leave the outgoing tab's
      // grid on screen.
      selected.clear();
      lastRenderSig = '';
      await loadBindings(info.tabId); // restore the incoming tab's bindings before its first render
      if (revision !== activationRevision || tabId !== info.tabId) return;
      void render();
    };
    chrome.tabs.onActivated.addListener((info) => {
      void followActivatedTab(info).catch((error) => {
        console.error('[FaceScrap] active-tab update failed', error);
      });
    });
    if (windowId !== undefined) {
      const [currentTab] = await chrome.tabs.query({ active: true, windowId });
      if (currentTab?.id !== undefined && currentTab.id !== tabId) {
        await followActivatedTab({ tabId: currentTab.id, windowId });
      }
    }

    // Safety net for time-decayed state: now-playing inference carries clock-based
    // windows (freshness gates, grace, takeover timers) that must re-evaluate even
    // when no storage event fires — playback stopping on a quiet tab writes
    // nothing. That state feeds Now Playing AND the grid cards' live ring, so the
    // tick runs for the live view and for any grid currently showing a live card
    // (until the ring expires and turns itself off). Otherwise the grids are
    // storage-driven — ticking them too would re-read the tab's keys for nothing.
    //
    // Now Playing ticks at 500ms, the grids every 4th tick (2s): selectPlaying's
    // relay holds (the 1.5s pre-slide-evidence hold, the 4s capture wait) expire
    // BETWEEN storage events, so the tick is what observes the expiry — a slow
    // tick stretches a 1.5s hold well past 2.5s of perceived handover, which is
    // exactly where rapid story/reel switching felt laggy. The cost is two
    // storage reads and a signature compute per tick, only while the live view
    // is open; the sig short-circuits all DOM work. The grids paint nothing
    // that decays faster than the live ring, so their cadence stays 2s.
    let tickN = 0;
    window.setInterval(() => {
      tickN++;
      if (view === 'now' || (anyLiveCards && tickN % 4 === 0)) void render();
    }, 500);

    // Best-effort: persist learning captured within the 1s debounce window when the
    // panel is torn down.
    window.addEventListener('pagehide', flushBindingsNow);

    await render();
    finishPanelBoot('ready');
  } catch (e) {
    showFatal(e);
  }
}
