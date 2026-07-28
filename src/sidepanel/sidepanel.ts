// FaceScrap side panel. Unlike a popup, it stays open while you browse and play
// videos, so it tracks the active tab of its window live and re-renders as media
// is captured (chrome.storage.session changes) or the tab switches.
//
// Four nav surfaces — Now Playing / Library / Saved / Settings. Now Playing is the
// live video, in focus, with the resolution picker that floats over it and one Save.
// Library and Saved share a 9:16 tile grid where a tile does one thing — it selects —
// and selecting raises the tray that saves the picks.
//
// This file is the controller: it owns the panel's MODEL state — settings, view,
// filter, tracked tab, picks, render signatures — builds the card model, and decides
// when to repaint. The surfaces own their own INTERACTION state (which Settings page
// is showing, whether the picker is open, which key is being captured) and expose it
// as predicates this file reads, so no model state lives outside here:
//
//   card-view / now-view     paint a tile, paint the live post
//   settings-sheet           the four Settings pages, their search and their controls
//   download                 hand one item to the worker, report whether it landed
//   panel-theme              which theme is painted, and the signals that change it
//   media-play               thumbnail pairs and where the play glyph sits
//   panel-keys               the keyboard cursor and its shortcuts
//   marquee                  the long-title scroll
//   panel-background         the custom backdrop behind the panel's surfaces
//   tab-state, format        per-tab memory; presentation vocabulary

import {
  fbAssetKeys,
  legacyMediaId,
  mediaId,
  resolutionOf,
  videoGroupKey,
  type MediaItem,
  type MediaKind,
} from '../shared/media';
import { itemCardId, savedEntryForItem, videoCardId } from '../shared/download-naming';
import { belowMinResolution, defaultTarget, isDownloadable, videoOptions, willHaveAudio } from '../shared/video-options';
import { fmt, getLang, LANG_KEY, resolveLang, saveLang, setLang, t, type Lang, type MsgKey } from '../shared/i18n';
import { diagError, diagLogDrain, setDiagContext, setDiagLogEnabled } from '../shared/diag-log';
import { addDiagEvents } from '../shared/diag-store';
import { getCaps, getMedia } from '../shared/storage';
import { getSaved, type SavedEntry } from '../shared/saved';
import {
  COLUMN_CHOICES,
  DEFAULT_SETTINGS,
  loadSettings,
  normalizeSettings,
  saveSettings,
  writeSettingOptimistically,
  type KeyAction,
  type Settings,
  type SettingsPatch,
} from '../shared/settings';
import type { ClearTabMsg } from '../shared/messages';
import {
  flushBindingsNow,
  getGroupCover,
  loadBindings,
  purgeTabBindings,
  selectPlaying,
} from '../shared/now-playing';
import { schedulePlayPositions, setupPlayPositioning } from './media-play';
import { cardBusy, failReason, pruneTabState, resetGen, tabKey } from './tab-state';
import { byId, composeLine, estimatedBytes, formatBytes, pressOnly, tn } from './format';
import { downloadOne } from './download';
import { applyEffectiveTheme, setupPanelTheme } from './panel-theme';
import {
  applySearch,
  closeSettingsSheet,
  focusSettingsSearch,
  isDiagOpen,
  isSettingsOpen,
  reflectPanelBackground,
  reflectSettings,
  renderDiag,
  repaintTintSwatches,
  setupSettingsSheet,
  toggleSettingsSheet,
} from './settings-sheet';
import { applyPanelBackground, loadPanelBackground } from './panel-background';
import { restoreKeyCursor, setupPanelKeys } from './panel-keys';
import { setupMarquee } from './marquee';
import { paintCardPicked, renderCard, stubCard, type Card } from './card-view';
import {
  closeResolutionPicker,
  isResolutionPickerOpen,
  paintNow,
  setupResolutionPicker,
  type NowState,
} from './now-view';

// ── Panel state ───────────────────────────────────────────────────────────────

// Top-level view (the pill switch) and the Library/Saved sub-filter.
type View = 'now' | 'library' | 'saved';
type MediaFilter = 'all' | 'video' | 'image';

// User settings (loaded at startup, updated by the settings sheet). Behaviour reads
// this synchronously; the sheet writes it through applySetting() → saveSettings().
let settings: Settings = { ...DEFAULT_SETTINGS };

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
// A bulk (tray) run is in flight IN THIS PANEL: render() must not paint over the
// button's progress label, and a second run must not start here. Cross-window and
// cross-card ordering is not this flag's job — the service worker serializes every
// DASH job on one chain (see downloadDash in service-worker.ts); panel flags only
// gate their own UI. `bulkTab` is which tab's cart is being downloaded, which
// decides who owns the button's label.
let bulkRunning = false;
let bulkTab: number | undefined;

// False only on a Chromium browser without the offscreen API: DASH remux is then
// impossible, so those options degrade to a direct video-only download. Defaults true;
// corrected once the SW's caps flag is read at startup, and again whenever the worker
// republishes it — a panel opened on the same click that wakes a cold worker only ever
// sees the startup default until then.
let offscreenAvailable = true;

/** This panel is already driving the offscreen document — a bulk run, or any single
 *  download whichever tab started it — so nothing here may start more. The one
 *  predicate behind every download button's enablement and every entry guard. */
function offscreenBusyHere(): boolean {
  return bulkRunning || cardBusy.size > 0;
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

/** Localize every static [data-i18n]/[data-i18n-title]/[data-i18n-aria] node. Dynamic nodes are
 *  (re)built by render(), and the Settings sheet's JS-built rows by reflectSettings — including
 *  which language pill is lit, which only reflectSettings can decide: Auto is a choice getLang()
 *  cannot express, since while it is on getLang() holds the browser's language, not the pick. */
function localize(): void {
  const nodes = document.querySelectorAll<HTMLElement>(
    '[data-i18n], [data-i18n-title], [data-i18n-aria], [data-i18n-placeholder]',
  );
  for (const el of nodes) {
    const { i18n, i18nTitle, i18nAria, i18nPlaceholder } = el.dataset;
    if (i18n) el.textContent = t(i18n as MsgKey);
    if (i18nTitle) el.title = t(i18nTitle as MsgKey);
    if (i18nAria) el.setAttribute('aria-label', t(i18nAria as MsgKey));
    if (i18nPlaceholder) el.setAttribute('placeholder', t(i18nPlaceholder as MsgKey));
  }
  // Keep the document language in sync so screen readers announce in the right one.
  document.documentElement.lang = getLang();
  // Every [data-search] row was just rewritten: an active query filtered against the
  // previous language's text would go on hiding rows that now match.
  applySearch();
}

/** Auto / EN / ES, which is one control over two stored facts: whether to follow the
 *  browser, and the manual choice underneath. Auto leaves that choice on record, so turning
 *  Auto back off returns to the language the user actually picked. */
async function chooseLang(choice: 'auto' | Lang): Promise<void> {
  if (choice !== 'auto') {
    setLang(choice);
    await saveLang(choice);
  }
  // Through applySetting, so the write is durable-or-rolled-back like every other setting,
  // and so its onCommitted re-resolves the language and repaints the sheet.
  await applySetting({ followBrowserLang: choice === 'auto' });
}

/** Persist one setting, then re-apply anything it affects (language + re-render).
 * The rollback contract (a rejected durable write must not leave the panel showing an
 * unsaved value) lives in writeSettingOptimistically, unit-tested without a DOM; this
 * adapter only wires it to the sheet and the renderer. */
async function applySetting(patch: SettingsPatch): Promise<void> {
  settings = await writeSettingOptimistically(settings, patch, {
    save: saveSettings,
    applyOptimistic: async (next) => {
      if ('theme' in patch) await applyEffectiveTheme(next.theme);
    },
    onRolledBack: async (previous) => {
      if ('theme' in patch) await applyEffectiveTheme(previous.theme);
      reflectSettings(settings);
    },
    onError: (error) => console.error('[FaceScrap] setting write failed', error),
    onCommitted: async (next) => {
      // Adopted here, not at the assignment below: `settings = await writeSettingOptimistically(…)`
      // only lands once that promise resolves, and this hook runs inside it. Everything below
      // reads `settings`, and applyAppearance in particular has to see the new value.
      settings = next;
      if ('followBrowserLang' in patch) {
        setLang(await resolveLang(settings.followBrowserLang));
        localize();
      }
      reflectSettings(settings);
      applyAppearance();
      // No signature reset: every render-relevant setting is already a signature
      // term, so render() rebuilds exactly when something visible changed.
      await render();
    },
  });
}

// ── Downloads ─────────────────────────────────────────────────────────────────

/** The two panel-only inputs shared/video-options.ts takes as parameters: the
 *  audio-stripping setting (see VideoOptionsContext there for why it is re-applied
 *  per download) and the on-screen cover cache, which only exists in this process. */
function videoOptionsContext(tid: number | undefined): {
  stripAudio: boolean;
  groupCover: (gkey: string) => string | undefined;
} {
  return {
    stripAudio: !offscreenAvailable || settings.directDownload,
    groupCover: (gkey) => (tid !== undefined ? getGroupCover(tid, gkey) : undefined),
  };
}

/** Freeze a download receipt at click time: the download can await minutes, during
 *  which a tab switch or navigation wipe may rebuild `cardsById` with other content —
 *  the receipt must describe what was actually saved. */
function savedEntryFor(cardId: string, item: MediaItem): SavedEntry {
  const card = cardsById.get(cardId);
  return savedEntryForItem(cardId, item, { thumbUrl: card?.thumbUrl, durationSec: card?.durationSec });
}

/** Download one item (a card's or Now Playing's chosen target). Sequential with
 *  EVERYTHING this panel starts — bulk runs and other singles alike: the SW runs
 *  DASH jobs one at a time, so stacked clicks would sit queued while each one's
 *  UI backstop burned, and the queue's tail would be tagged failed (receipt
 *  dropped) over work that then landed. One at a time keeps the backstop honest.
 *  Busy + failed state are keyed by card id and survive re-render. */
async function downloadCard(cardId: string, item: MediaItem, saveAs?: boolean): Promise<void> {
  // Snapshot the tab AND the receipt: the merge can await minutes, and
  // onActivated flips module `tabId` on a tab switch — the save belongs to the
  // tab and the card that were clicked.
  const tid = tabId;
  const bkey = tabKey(tid, cardId);
  if (offscreenBusyHere()) return;
  const receipt = savedEntryFor(cardId, item);
  const gen = resetGen(tid);
  // A fresh counter per download: the previous one's final byte total must not be the
  // first thing the next save's overlay shows.
  muxPhase = undefined;
  muxBytes = 0;
  cardBusy.add(bkey);
  failReason.delete(bkey);
  // try/finally is mandatory, not tidiness: render() reaches an unguarded
  // storage.session.get, and a dead extension context throws straight past the
  // cleanup. offscreenBusyHere() is global, so one leaked busy key disables EVERY
  // download button until the panel is reopened — and pruneTabState never clears it.
  try {
    await render(); // busy/failed are signature terms; render() sees them flip
    const err = await downloadOne(tid, item, receipt, settings, saveAs);
    // The reset generation gates the tag: a prune during the await (nav reset,
    // Clear, tab close) means this failure belongs to content that is now wiped.
    if (err && resetGen(tid) === gen) failReason.set(bkey, err);
  } finally {
    // The repaint targets the VIEWED tab, not `tid`: offscreenBusyHere() is global,
    // so a settle on a backgrounded tab still has to unstick the visible buttons.
    cardBusy.delete(bkey);
    await render();
  }
}

// ── Card model (Library / Saved grid) ────────────────────────────────────────

function buildVideoCard(group: MediaItem[], tid: number | undefined, playing: Set<string>): Card {
  const { options, gkey, thumbUrl, durationSec } = videoOptions(group, videoOptionsContext(tid));
  const target = defaultTarget(options, settings.defaultQuality);
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

// ── Now Playing model ─────────────────────────────────────────────────────────

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
    if (belowMinResolution(group, settings.minResolution)) return null;
    const { options, gkey, thumbUrl, durationSec } = videoOptions(group, videoOptionsContext(tid));
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
  // The first active image is the one the centre detector selected, and there is
  // nothing to rank it against: `items` comes from getMedia, which merges by id, so
  // no two entries here are variants of the same photo.
  const img = playingItems.find((i) => i.kind === 'image' && isDownloadable(i));
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

// ── Selection tray (Library / Saved) ──────────────────────────────────────────

// The last render's cards, keyed by card id. The pick handler and the bulk run
// have to get from a picked id back to the item to download, and neither can read
// it off the DOM — a rebuild will have replaced the node by then.
const cardsById = new Map<string, Card>();
// The grid cards currently on screen, for the Select all toggle.
let visibleCards: Card[] = [];
// Whether the last render saw a live card. The live bit decays by CLOCK, not by
// storage event, so while any card glows the tick has to keep re-evaluating even in
// the grid views or the ring never turns off.
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
  // The second line is what the picks WEIGH and how many of them need the offscreen
  // merge — the two facts that decide how long pressing Save will take. Both are real:
  // the size is estimatedBytes' manifest-derived guess, the remux count is exact.
  const kinds: MediaKind[] = [];
  let bytes = 0;
  let remux = 0;
  for (const id of selected) {
    const c = cardsById.get(id);
    if (c == null) continue;
    kinds.push(c.kind);
    if (c.target == null) continue;
    bytes += estimatedBytes(c.target, c.durationSec);
    if (c.target.audioUrl != null) remux += 1;
  }
  byId('tray-meta').textContent = [
    formatBytes(bytes) || composeLine(kinds),
    remux > 0 ? tn('trayRemuxOne', 'trayRemux', remux) : undefined,
  ]
    .filter((part) => part != null && part !== '')
    .join(' · ');

  // Only past three picks, the point at which deselecting one at a time becomes
  // tedious — below it the dots are right there.
  byId('clear-picks').hidden = n <= 3;

  const btn = byId<HTMLButtonElement>('bulk-dl');
  // Enablement is global (offscreenBusyHere); only the label is tab-scoped — a
  // run painting "Saving 2/3…" in its own tab must not be stamped over here.
  btn.disabled = offscreenBusyHere();
  if (!bulkRunning || bulkTab !== tabId) btn.textContent = fmt('traySave', { n });
  syncSelectAll();
}

/** How many items this panel's queue still owes, for the header pill. 0 outside a run;
 *  a single download counts as one. */
let queueRemaining = 0;

// What the offscreen document last reported for the merge in flight. The report carries
// a phase and the bytes done, and NO total — nothing upstream knows one, because
// learning it would mean the extension originating a HEAD request for media the user is
// not watching. So the bar sweeps rather than filling: a determinate one here would be
// a number we invented.
let muxPhase: 'fetch' | 'remux' | undefined;
let muxBytes = 0;

chrome.runtime.onMessage.addListener((message) => {
  const m = message as { type?: string; phase?: 'fetch' | 'remux'; bytes?: number } | undefined;
  if (m?.type !== 'FACESCRAP_MUX_PROGRESS') return;
  muxPhase = m.phase;
  muxBytes = typeof m.bytes === 'number' ? m.bytes : 0;
  paintNowProgress();
});

/** The saving state, drawn ON the media over a veil so the picker and the button under
 *  it never move while a download runs. */
function paintNowProgress(): void {
  const running = offscreenBusyHere() && !byId('now-content').hidden;
  byId('now-veil').hidden = !running;
  byId('now-progress').hidden = !running;
  // The two overlays share the bottom of the frame; only one can be there.
  byId('now-foot').hidden = running;
  if (!running) return;
  byId('now-progress-label').textContent = t(muxPhase === 'remux' ? 'downloadMerging' : 'downloadSaving');
  byId('now-progress-pct').textContent = formatBytes(muxBytes, true);
}

/** The header pill has three things to say and says exactly one: the panel is working,
 *  something is playing, or neither. Never hidden — a header that loses a control when
 *  nothing is happening reads as broken chrome. */
function paintStatusPill(capturing: boolean): void {
  const pill = byId('now-live');
  const text = byId('now-live-text');
  const busy = offscreenBusyHere();
  pill.classList.toggle('is-busy', busy);
  pill.classList.toggle('is-idle', !busy && !capturing);
  const pending = Math.max(queueRemaining, 1);
  text.textContent = busy
    ? fmt(pending === 1 ? 'statusQueueOne' : 'statusQueue', { n: pending })
    : t(capturing ? 'statusCapturing' : 'statusWatching');
}

/** Toggle one card's pick and repaint the tray. Returns the new state for the button
 *  that was clicked, which repaints itself rather than forcing a grid rebuild. */
function togglePick(cardId: string): boolean {
  const picked = !selected.has(cardId);
  if (picked) selected.add(cardId);
  else selected.delete(cardId);
  paintTray();
  return picked;
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
  // Snapshot the tab, and freeze every receipt now: the queue can await minutes per
  // item, and by an item's turn a tab switch or a navigation wipe may have rebuilt
  // cardsById. These picks belong to the tab that made them.
  const tid = tabId;
  const gen = resetGen(tid);
  const queue: { id: string; item: MediaItem; receipt: SavedEntry }[] = [];
  for (const id of selected) {
    const target = cardsById.get(id)?.target;
    if (target != null) queue.push({ id, item: target, receipt: savedEntryFor(id, target) });
  }
  if (queue.length === 0) return;

  const btn = byId<HTMLButtonElement>('bulk-dl');
  bulkRunning = true;
  bulkTab = tid;
  queueRemaining = queue.length;
  btn.disabled = true;
  const done: string[] = [];
  const failed: Array<{ id: string; err: string }> = [];
  try {
    for (const [i, { id, item, receipt }] of queue.entries()) {
      // Only in the tab this run belongs to: elsewhere the panel shows a different
      // cart, and #bulk-dl is one shared node — this label would report our queue
      // over their picks.
      queueRemaining = queue.length - i;
      if (bulkTab === tabId && view !== 'now') {
        btn.textContent = fmt('bulkBusy', { i: i + 1, n: queue.length });
      }
      const err = await downloadOne(tid, item, receipt, settings);
      if (err === null) done.push(id);
      else failed.push({ id, err });
    }
  } finally {
    bulkRunning = false;
    bulkTab = undefined;
    queueRemaining = 0;
    // Unpick only what landed, so pressing Download again retries exactly what
    // didn't — and only while the panel still shows this queue's tab: `selected` is
    // NOT tab-namespaced and content-derived ids collide across tabs, so after a
    // switch these deletes would empty picks just made in the OTHER tab. Failure
    // tags are tab-namespaced and always safe to delete; adding one checks the reset
    // generation (see tabResetGen).
    for (const id of done) {
      if (tid === tabId) selected.delete(id);
      failReason.delete(tabKey(tid, id));
    }
    if (resetGen(tid) === gen) {
      for (const { id, err } of failed) failReason.set(tabKey(tid, id), err);
    }
    if (tid === tabId) {
      invalidateRenderCache(); // the saved list and the failure tags feed the cards
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
// Cheap proxy for `sig` (see doRender), computed from raw inputs alone so an
// unchanged tick can bail before the card-model rebuild. Must be reset everywhere
// lastRenderSig is: out of step, it would short-circuit a forced rebuild — which is
// why every forced rebuild clears the pair through one function rather than by hand.
let lastCheapSig = '';

/** Force the next render to rebuild instead of bailing on an unchanged signature. */
function invalidateRenderCache(): void {
  lastRenderSig = '';
  lastCheapSig = '';
}

// Hold signature-changing rebuilds while the quality picker is open — paintNow
// rebuilds its options, tearing them out from under the open list, and capture bursts
// churn the signature exactly while the user is picking. See qualityPickerRenderHoldMs
// below for how "open" is tested.
let renderBlockedSince = 0;
let renderRetryTimer: number | undefined;
const RENDER_HOLD_MAX_MS = 10_000;
const RENDER_HOLD_RETRY_MS = 500;

/** The picker has closed (committed or dismissed): let the deferred render through. */
function finishQualityPickerInteraction(): void {
  if (renderBlockedSince === 0) return;
  renderBlockedSince = 0;
  if (renderRetryTimer !== undefined) {
    window.clearTimeout(renderRetryTimer);
    renderRetryTimer = undefined;
  }
  void render();
}

/** How long a render may be held off while the resolution list is open. The list is
 *  our own DOM, so "is it open" is simply whether it is hidden — no `:open` probe and
 *  no gesture fallback, both of which existed only because this used to be a native
 *  <select> that could close emitting nothing observable. The cap still stands: a
 *  panel left open on a busy tab must eventually repaint. */
function qualityPickerRenderHoldMs(): number {
  return isResolutionPickerOpen() ? RENDER_HOLD_MAX_MS : 0;
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

  // Cheap early-out BEFORE the card-model build below. Every value `sig` can hold is
  // a pure function of the raw inputs listed here — items, playing, savedEntries, the
  // settings subset, view/filter/lang, the busy flags, and getGroupCover, the only
  // model input this function doesn't already hold. Unchanged inputs therefore mean
  // an unchanged sig, so the rebuild would only reproduce what is on screen.
  //
  // The storage reads above still run: selectPlaying's time-decayed windows must
  // re-evaluate every tick (see the tick interval). Only the CPU work is skipped.
  const tabPrefix = tabKey(tid, '');
  const settingsSig = JSON.stringify([
    settings.listOrder,
    settings.videosOnly,
    settings.minResolution,
    settings.directDownload,
    settings.defaultQuality,
  ]);
  const coveredGroupKeys = new Set<string>();
  for (const it of items) if (it.kind === 'video') coveredGroupKeys.add(videoGroupKey(it));
  const savedSig = view === 'saved' ? savedEntries.map((e) => e.id).join(',') : '';
  const cheapSig = [
    tabPrefix,
    view,
    mediaFilter,
    getLang(),
    String(offscreenAvailable),
    String(offscreenBusyHere()),
    settingsSig,
    items
      .map(
        (i) =>
          `${i.id}|${i.url}|${i.kind}|${i.source}|${i.audioUrl ?? ''}|${i.dash ? 1 : 0}|${i.thumbUrl ?? ''}|${
            i.width ?? ''
          }x${i.height ?? ''}|${i.durationSec ?? ''}|${i.addedAt}`,
      )
      .join('\n'),
    [...playing].sort().join(','),
    [...coveredGroupKeys]
      .sort()
      .map((k) => `${k}=${tid !== undefined ? (getGroupCover(tid, k) ?? '') : ''}`)
      .join(','),
    savedSig,
    [...cardBusy].filter((k) => k.startsWith(tabPrefix)).sort().join(','),
    [...failReason.keys()].filter((k) => k.startsWith(tabPrefix)).sort().join(','),
  ].join('\n');
  if (cheapSig === lastCheapSig) {
    // The same outcome the sig compare below would reach, including `pruned` staying
    // false: nothing in `selected` can go stale without `items` moving cheapSig.
    renderBlockedSince = 0;
    return;
  }

  // Group videos by asset (one card per video); images/audio are one card each.
  const groups = new Map<string, MediaItem[]>();
  const others: MediaItem[] = [];
  for (const it of items) {
    if (it.kind !== 'video') {
      others.push(it);
      continue;
    }
    const key = videoGroupKey(it);
    const group = groups.get(key);
    if (group) group.push(it);
    else groups.set(key, [it]);
  }

  // The declutter settings (videosOnly, minResolution) and the cover dedupe hide
  // cards from the LIBRARY only — flags, not drops: the Saved history must keep
  // rendering a receipt whose card a Library filter hides, and the cart relies
  // on cardsById holding every real card.
  const cards: Card[] = [];
  for (const group of groups.values()) {
    const card = buildVideoCard(group, tid, playing);
    if (belowMinResolution(group, settings.minResolution)) card.libraryHidden = true;
    cards.push(card);
  }
  // An image that is only a Library-VISIBLE video's cover is a dupe under "All" — but
  // only there. It stays reachable under the "Images" sub-filter, its receipt still
  // renders in Saved, and a cover whose video is hidden keeps its own Library slot.
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
  // Library hides the declutter-flagged cards. Saved renders the ledger in download
  // order: the live card while the capture exists (a real re-download with fresh
  // URLs), else a stub frozen from the receipt, which revives once a replay
  // re-captures the same id. Both views then narrow by the media sub-filter.
  const orderedSaved = settings.listOrder === 'oldest' ? savedEntries : [...savedEntries].reverse();
  const base =
    view === 'saved'
      ? orderedSaved.map((e) => cardsById.get(e.id) ?? stubCard(e))
      : cards.filter((c) => !c.libraryHidden && !(c.coverOfShown && mediaFilter !== 'image'));
  const gridCards =
    view === 'now' ? [] : base.filter((c) => mediaFilter === 'all' || c.kind === mediaFilter);

  // Skip the DOM rebuild when nothing VISIBLE changed: tearing the grid down every
  // ≤2s drops focus and re-announces the aria-live region. Covers everything painted
  // except `selected` and the chosen quality, which paint in place (paintTray,
  // paintNow). cheapSig above catches the common no-op earlier; this catches the
  // rarer case where the model build ran but produced the same visible result.
  const nowSig =
    now == null
      ? 'none'
      : `${now.id}|${now.source}|${now.thumbUrl ?? ''}|${now.durationSec ?? ''}|${now.pieces}|${now.kind}|${now.options
          .map((o) => `${o.id}:${o.url}:${o.width ?? ''}x${o.height ?? ''}`)
          .join('~')}|${cardBusy.has(tabKey(tid, now.id)) ? 1 : 0}|${failReason.has(tabKey(tid, now.id)) ? 1 : 0}`;
  const sig = [
    view,
    mediaFilter,
    getLang(),
    String(offscreenAvailable),
    // The whole busy predicate, not just bulkRunning: every download button gates on
    // it, so a download settling while its own card is filtered out of the view must
    // still move the signature, or the visible buttons stay stuck on a quiet tab.
    String(offscreenBusyHere()),
    settingsSig, // shared with cheapSig above — the two must never drift apart
    view === 'now' ? nowSig : '',
    savedSig,
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
              }|${c.mayLackAudio ? 1 : 0}|${c.live ? 1 : 0}|${failReason.has(tabKey(tid, c.id)) ? 1 : 0}|${
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
  lastCheapSig = cheapSig;

  byId('view-now').hidden = view !== 'now';
  byId('view-grid').hidden = view === 'now';

  paintStatusPill(now != null);

  if (view === 'now') {
    paintNow(now, {
      tid,
      defaultQuality: settings.defaultQuality,
      subfolder: settings.subfolder,
      downloadsDisabled: offscreenBusyHere(),
      onDownload: (cardId, target, saveAs) => void downloadCard(cardId, target, saveAs),
      onQualityCommitted: finishQualityPickerInteraction,
    });
    paintNowProgress();
    paintTray();
    return;
  }

  const saved = view === 'saved';
  // Grid heading + counts, per Library vs Saved.
  byId('grid-title').textContent = saved ? t('savedTitle') : t('libraryTitle');
  const count = byId('grid-count');
  count.hidden = gridCards.length === 0;
  count.textContent = saved
    ? tn('filesCountOne', 'filesCount', gridCards.length)
    : tn('onThisTabOne', 'onThisTab', gridCards.length);

  const empty = byId('grid-empty');
  empty.hidden = gridCards.length > 0;
  // Both header actions would read oddly above an empty-state message.
  byId('select-all').hidden = saved || gridCards.length === 0;
  byId('open-folder').hidden = !saved || gridCards.length === 0;
  // The two grids' empty states get their own glyph, so "nothing captured" and
  // "nothing downloaded" are not the same picture with different words.
  if (gridCards.length === 0) {
    const mark = empty.querySelector<HTMLElement>('.empty-mark');
    mark?.style.setProperty('--empty-icon', `url("icons/${saved ? 'nav-saved' : 'nav-library'}.svg")`);
    byId('grid-empty-title').textContent = saved ? t('savedEmptyTitle') : t('libraryEmptyTitle');
    byId('grid-empty-body').textContent = saved ? t('savedEmptyBody') : t('libraryEmptyBody');
  }

  // ponytail: full teardown/rebuild on every sig change, including a single card's
  // busy bit flipping twice per download. Cheap at this list size, and no longer
  // audible now that #list is not a live region (the count is). Upgrade path if it
  // ever matters: paint state per tile in place, the way paintTray() already does for
  // selection, and reconcile instead of replacing.
  const list = byId('list');
  list.textContent = '';
  for (const c of gridCards) {
    const key = tabKey(tid, c.id);
    list.appendChild(
      renderCard(c, {
        picked: selected.has(c.id),
        saved,
        // Never on a stub: a receipt IS a success, and a failure recorded under the
        // same content-derived id belongs to the live card, not the history row.
        failure: c.stale ? undefined : failReason.get(key),
        onPick: () => togglePick(c.id),
        onReveal: revealDownloads,
      }),
    );
  }

  paintTray();
  restoreKeyCursor();
  schedulePlayPositions();
  paintScrollPill();
}

/** Chrome will not point at one file without its download id, and receipts store none
 *  (they are content-derived, and a file can be renamed or moved after the fact). The
 *  folder is the honest target for both the header link and a tile's corner button. */
function revealDownloads(): void {
  chrome.downloads?.showDefaultFolder?.();
}

/** The pill that sits on the grid's fade. Shown only when there is actually more below:
 *  the fade alone reads as the end of the list, and a pill over a list that does not
 *  scroll reads as a broken one. */
function paintScrollPill(): void {
  const list = byId('list');
  const more = list.scrollHeight - list.clientHeight - list.scrollTop > 8;
  byId('scroll-more').hidden = !more;
}

// ── View + filter wiring ──────────────────────────────────────────────────────

/** Delegate one nav's clicks: adopt the pressed button's `data-<attr>`, mark it
 *  pressed, re-render. Both the view and the sub-filter are signature terms, so the
 *  render always sees the change. */
function setupNav(navId: string, attr: 'view' | 'filter', adopt: (value: string | undefined) => void): void {
  const nav = byId(navId);
  nav.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(`[data-${attr}]`);
    if (btn == null || !nav.contains(btn)) return;
    adopt(btn.dataset[attr]);
    pressOnly(nav, btn);
    void render();
  });
}

/** Push every appearance choice into CSS. None of these is a render signature term: they retune
 *  layout vars and colours on the DOM already on screen without changing the card model.
 *
 *  Accent and tint go on the ROOT, not on #app, for two reasons. The marquee is appended to
 *  <body>, a sibling of #app, so a token scoped to #app would never reach it — and both
 *  palettes resolve DIFFERENTLY per theme, which is also a root attribute. Written as
 *  attributes rather than as JS custom properties so the pair can never land in the wrong
 *  order: the theme arrives from its own async path, and CSS re-resolves both the moment it
 *  changes.
 *
 *  The three below stay on #app because the stylesheet selects them there. */
function applyAppearance(): void {
  const app = byId('app');
  app.dataset.cols = String(settings.columns);
  app.dataset.corners = settings.panelCorners;
  app.dataset.backdrop = settings.panelBackdrop;
  const root = document.documentElement;
  root.dataset.accent = settings.accent;
  root.dataset.tint = settings.panelTint;
}

function setupViews(): void {
  byId('app').dataset.view = view;
  applyAppearance();
  setupNav('views', 'view', (value) => {
    view = (value as View | undefined) ?? 'now';
    byId('app').dataset.view = view;
    // The list floats over the media at z-index 30; left open across a view switch it
    // would hang over the grid that replaced it.
    closeResolutionPicker();
    closeSettingsSheet();
  });
  setupNav('filters', 'filter', (value) => {
    mediaFilter = (value as MediaFilter | undefined) ?? 'all';
  });
}

function setupSelectAll(): void {
  byId('select-all').addEventListener('click', () => {
    const { targets, allPicked } = pickableState();
    for (const c of targets) {
      if (allPicked) selected.delete(c.id);
      else selected.add(c.id);
    }
    invalidateRenderCache(); // picks paint in place and are not a signature term — force the rebuild
    void render();
  });
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

/** Run one bound key's action. Every case routes through the control the mouse would
 *  have clicked, rather than reimplementing what that control does — a second path to
 *  "switch view" or "open Settings" is a second path to get out of step with the first.
 *
 *  The two exceptions are the per-card actions, which have no control to click because
 *  the card under the cursor is not the card under the pointer. */
function runKeyAction(action: KeyAction, cursor: HTMLElement | undefined): void {
  const cursorCard = cursor?.dataset.cardId != null ? cardsById.get(cursor.dataset.cardId) : undefined;
  switch (action) {
    case 'togglePick':
      if (cursor == null || cursorCard?.target == null) return;
      paintCardPicked(cursor, togglePick(cursorCard.id));
      return;
    case 'downloadCard':
      if (cursorCard?.target == null || offscreenBusyHere()) return;
      void downloadCard(cursorCard.id, cursorCard.target);
      return;
    case 'selectAll':
      byId('select-all').click();
      return;
    case 'downloadPicks':
      // Only when the tray is actually up: the bound key must not start a bulk run the
      // button would have refused, and the button is hidden when nothing is picked.
      if (!byId('tray').hidden) byId('bulk-dl').click();
      return;
    case 'viewNow':
    case 'viewLibrary':
    case 'viewSaved': {
      const target = { viewNow: 'now', viewLibrary: 'library', viewSaved: 'saved' }[action];
      byId('views').querySelector<HTMLButtonElement>(`[data-view="${target}"]`)?.click();
      return;
    }
    case 'cycleFilter': {
      // Only where the filter is on screen: the segmented control sits inside the grid
      // view, and a programmatic click reaches a hidden button perfectly well.
      if (byId('view-grid').hidden) return;
      const segments = [...byId('filters').querySelectorAll<HTMLButtonElement>('[data-filter]')];
      const at = segments.findIndex((button) => button.getAttribute('aria-pressed') === 'true');
      segments[(at + 1) % segments.length]?.click();
      return;
    }
    case 'openSettings':
      toggleSettingsSheet();
      return;
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

/** Hand the app over to the user, or to showFatal. Boot leaves #app inert so a
 *  half-initialised panel cannot be clicked; both outcomes must release it. */
function finishPanelBoot(state: 'ready' | 'error'): void {
  document.documentElement.dataset.boot = state;
  const app = document.getElementById('app');
  if (!app) return;
  app.removeAttribute('inert');
  app.removeAttribute('aria-hidden');
  app.removeAttribute('aria-busy');
}

/** A browser missing an API the panel needs (chrome.storage.session on a stripped
 *  fork) would otherwise leave it blank with no clue. */
function showFatal(e: unknown): void {
  finishPanelBoot('error');
  const el = document.getElementById('fatal');
  if (el) {
    el.hidden = false;
    const v = chrome.runtime?.getManifest?.().version;
    // Localised — a boot failure is when the message matters most. A throw that beat
    // setLang() falls back to English.
    el.textContent =
      fmt('fatalStartup', { message: (e as Error)?.message ?? String(e) }) +
      (v ? fmt('fatalStartupVersion', { version: v }) : '');
  }
  // Written to the log as well as the console: a panel that failed to boot cannot
  // show its own Export button, but the worker's console (faceScrapDiag.log()) and
  // the NEXT successful panel's export both still find this.
  diagError('panel init failed', e);
  void addDiagEvents(diagLogDrain()).catch(() => {});
}

setDiagContext('panel');
document.addEventListener('DOMContentLoaded', () => void init());

async function init(): Promise<void> {
  try {
    ownPanelTabId = (await chrome.tabs.getCurrent())?.id;
    await resolveActiveTab();
    // Before the first storage read: a theme signal persisted during startup must not
    // fall into a read/listener gap.
    setupPanelTheme({ theme: () => settings.theme, trackedTab: () => tabId });
    settings = await loadSettings();
    setDiagLogEnabled(settings.diagEnabled);
    await applyEffectiveTheme();
    setLang(await resolveLang(settings.followBrowserLang));
    localize();
    const caps = await getCaps();
    offscreenAvailable = caps?.offscreen ?? true;
    byId('degraded').hidden = offscreenAvailable;
    setupViews();
    setupSelectAll();
    setupPanelKeys({
      // Read per keypress, not captured: the master switch and the bindings are both live
      // settings, so flipping either takes effect without re-registering anything.
      enabled: () => settings.keysEnabled,
      keymap: () => settings.keymap,
      settingsOpen: isSettingsOpen,
      run: runKeyAction,
    });
    setupMarquee((card) => {
      const id = card.dataset.cardId;
      const model = id != null ? cardsById.get(id) : undefined;
      // Already picked, or nothing to pick: the band adds, it never toggles.
      if (model?.target == null || selected.has(model.id)) return;
      paintCardPicked(card, togglePick(model.id));
    });
    setupSettingsSheet({
      settings: () => settings,
      currentView: () => view,
      apply: (patch) => void applySetting(patch),
      chooseLang: (choice) => void chooseLang(choice),
    });
    // After the sheet is wired, so its Remove button and its state line reflect what was
    // stored. storage.local, so this is the image from before the browser was last closed.
    applyPanelBackground(await loadPanelBackground());
    reflectPanelBackground();
    setupResolutionPicker();
    setupPlayPositioning();
    // The tint swatches paint the RESOLVED theme's canvas, and the theme can flip from
    // panel-theme.ts's own signals (the Facebook tab, the OS) with no settings write to
    // hang a repaint on. Watch the attribute those signals land on instead.
    new MutationObserver(repaintTintSwatches).observe(document.documentElement, {
      attributeFilter: ['data-theme'],
    });

    // The density button walks the four column counts, so the Library can be retuned
    // without a trip to Settings. Same setting, same write path.
    byId('density').addEventListener('click', () => {
      const at = COLUMN_CHOICES.indexOf(settings.columns);
      void applySetting({ columns: COLUMN_CHOICES[(at + 1) % COLUMN_CHOICES.length]! });
    });
    byId('open-folder').addEventListener('click', revealDownloads);
    byId('now-empty-lib').addEventListener('click', () => {
      byId('views').querySelector<HTMLButtonElement>('[data-view="library"]')?.click();
    });
    const clearPicks = (): void => {
      if (selected.size === 0) return;
      selected.clear();
      invalidateRenderCache(); // picks paint in place and are not a signature term
      void render();
    };
    byId('clear-picks').addEventListener('click', clearPicks);
    // Clicking the empty space around the tiles drops the selection, the way every
    // file manager does it. Only when the grid ITSELF is the target: a click that
    // landed on a tile bubbles up here too, and dropping the selection on the way
    // out of a tile press would make selecting anything impossible.
    byId('list').addEventListener('click', (event) => {
      if (event.target === event.currentTarget) clearPicks();
    });
    // The pill has to follow the scroll, not just the render that drew the list.
    byId('list').addEventListener('scroll', paintScrollPill, { passive: true });
    window.addEventListener('resize', paintScrollPill);
    // Ctrl/Cmd K, as the field's own hint promises. Not a rebindable action: it is a
    // browser-wide idiom for "search this surface", and the keymap is for panel verbs.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'k' && e.key !== 'K') return;
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      focusSettingsSearch();
    });

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
        try {
          // Route through the worker so the wipe serializes on the same write chain as
          // capture writes (a panel-side clearTab can't, and the list would resurrect).
          // The worker also resets the badge once the removal lands.
          await chrome.runtime.sendMessage({ type: 'FACESCRAP_CLEAR_TAB', tabId } satisfies ClearTabMsg);
        } catch (e) {
          // A rejected send (extension context invalidated, receiving end gone)
          // must not strand the panel showing the pre-click list over the
          // already-cleared state above — fall through to the render below
          // regardless. Same catch-and-log style as the download senders.
          console.error('[FaceScrap]', e);
        }
      }
      invalidateRenderCache();
      await render();
    });

    // New media captured (or cleared) for the tracked tab → re-render live. Only keys
    // for OUR tab force a render — but hard resets are honored for EVERY tab.
    chrome.storage.session.onChanged.addListener((changes) => {
      // A clearTab reset removes a tab's keys, and it hits BACKGROUND tabs too — any
      // top-level Facebook navigation wipes a tab nobody is looking at. Treat every
      // such deletion as a hard reset for ITS tab: purge its bindings (so a debounced
      // write cannot resurrect bind_) and its failure tags and picks, because a
      // recapture of the same id after a navigation is a NEW item and a phantom
      // "failed" tag lies. This state survives tab switches, so a wipe missed here
      // resurfaces when the user switches back.
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
      // caps is global, so it is handled ahead of the tab-scoped gate below. Re-read
      // it exactly as init() does: render() alone would not help, because doRender
      // never reads caps and the signature check would skip the repaint.
      if ('caps' in changes) {
        void getCaps().then((caps) => {
          offscreenAvailable = caps?.offscreen ?? true;
          byId('degraded').hidden = offscreenAvailable;
          void render(); // offscreenAvailable is a signature term; render() sees it flip
        });
      }
      if (tabId === undefined) return;
      const tid = tabId;
      if (
        `media_${tid}` in changes ||
        `playing_${tid}` in changes ||
        `recent_${tid}` in changes ||
        `saved_${tid}` in changes
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
      if (('diag_counters' in changes || 'diag_log' in changes) && isDiagOpen()) void renderDiag();
      const next = changes[LANG_KEY]?.newValue;
      if ((next === 'en' || next === 'es') && next !== getLang()) {
        setLang(next);
        localize();
        void render(); // language is a signature term
      }
      if ('settings' in changes) {
        // Where a change made anywhere else arrives: a second panel, or another extension page.
        // This panel's own writes are already applied by applySetting's onCommitted, and their
        // echo carries a value identical to what is in memory — skipped, so one change costs one
        // render rather than two.
        const echo = changes.settings?.newValue;
        if (echo != null && JSON.stringify(normalizeSettings(echo)) === JSON.stringify(settings)) return;
        void (async () => {
          settings = await loadSettings();
          setDiagLogEnabled(settings.diagEnabled);
          await applyEffectiveTheme();
          reflectSettings(settings);
          applyAppearance();
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
      // A failed tabs.get is NOT a reason to bail: some forks transiently reject it
      // during a rapid switch, and the event's tabId is still authoritative. Freezing
      // on the previous tab would be worse than trusting it.
      flushBindingsNow(); // persist the OUTGOING tab's learning before switching
      setTrackedTab(info.tabId);
      await applyEffectiveTheme();
      if (revision !== activationRevision || tabId !== info.tabId) return;
      // Only the cart empties — it points at the outgoing tab's cards. Busy, failure
      // and quality state STAY: they are tab-namespaced, so an in-flight download
      // keeps its spinner for when the user switches back. lastRenderSig goes because
      // two empty tabs share a signature, and a skipped render would leave the
      // outgoing tab's grid on screen.
      selected.clear();
      invalidateRenderCache();
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

    // Safety net for clock-decayed state: now-playing's freshness gates, grace and
    // takeover timers expire BETWEEN storage events — playback stopping on a quiet tab
    // writes nothing — so only a tick observes the expiry. It runs for the live view,
    // and for a grid while a live ring is still lit; otherwise the grids are
    // storage-driven and ticking them would re-read the tab's keys for nothing.
    //
    // 500ms for Now Playing because selectPlaying's shortest relay hold is 1.5s, and
    // a slower tick stretched it past 2.5s of perceived handover — that is what made
    // rapid story switching feel laggy. The grids paint nothing that decays faster
    // than the ring, so every 4th tick (2s) is enough. An unchanged tick costs two
    // storage reads and cheapSig, which then skips the rebuild AND the DOM work.
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
