// Per-tab CAPTURE state, backed by chrome.storage.session: the media list, the
// now-playing pointer, the recently-streamed tracks, the retention pin and the panel's
// learned bindings. Only trusted contexts (service worker, side panel) touch this —
// content scripts relay via messages instead.
//
// Durability lives in session-write.ts; the Saved ledger in saved.ts and the diagnostic
// counters in diag-store.ts are separate key spaces and separate files. One key here is
// NOT per-tab: `caps`, the runtime capability flags the worker publishes once and the
// panel reads back (last section of this file).
//
// Importing this module has effects. It reads Settings at evaluation and again on every
// change, caching maxItems — so there is no inert import of this file.
//
// Order here is dependency order: keys and readers first, then the retention rules that
// classify against them, then the writers that hold the lanes, then media and bindings.

import { createChainLock, keyedSerialQueue } from './async';
import { diagBump } from './diag';
import {
  activeMediaIds,
  fbAssetKeys,
  historicalAliasOwners,
  isFbcdn,
  matchesActiveMediaId,
  mediaId,
  MAX_MEDIA_URL_LEN,
  mergeMedia,
  videoGroupKey,
  type MediaItem,
} from './media';
import { playingTimestampIsFutureEpoch } from './playing-clock';
import { durableStoryMarkPortion, isProvisionalStoryMark, storyDomIdFromMark } from './story-mark';
import { dropSaved } from './saved';
import {
  dataValues,
  isStorageQuotaError,
  logWriteError,
  readKey,
  writeCaptureState,
} from './session-write';
import { DEFAULT_SETTINGS, loadSettings } from './settings';
import {
  facebookThemeKey,
  normalizeFacebookThemeRef,
  type FacebookThemeRef,
} from './theme';

export { facebookThemeKey } from './theme';

const keyFor = (tabId: number): string => `media_${tabId}`;

// Per-tab retention cap (Settings.maxItems). One reels-feed GraphQL burst can carry
// ~1200 reels (several DASH items each), so the cap must exceed a burst or oldest-first
// eviction drops the watched reel. Cached so addMedia doesn't read storage on every
// capture; refreshed when the setting changes. 0/unset → Infinity (unlimited).
let maxItemsCache: number = DEFAULT_SETTINGS.maxItems;
// Once a tab already sits AT its retention cap, shed this many EXTRA items (bounded
// to 10% of the cap) so the next several batches land under it without re-running
// partitionMediaForRetention's storage reads and O(n) scan. Never applied to the batch
// that crosses the cap for the first time — that one still trims to exactly the cap.
const MAX_ITEMS_HYSTERESIS = 50;
function refreshFromSettings(): void {
  loadSettings()
    .then((s) => {
      maxItemsCache = s.maxItems > 0 ? s.maxItems : Infinity;
    })
    .catch(() => {});
}
refreshFromSettings();
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'settings' in changes) refreshFromSettings();
  });
} catch {
  /* storage.onChanged unavailable — the cap stays at its default */
}
// --- "Now playing" pointer: which video is currently playing in the tab ---

interface PlayingRef {
  /** Asset ids of the media centered in the viewport (what you're watching). */
  ids: string[];
  /** True when a <video> is centered — enables the network-recency fallback. */
  hasVideo: boolean;
  /** Video id parsed from the page URL (/reel/<id>, /watch?v=<id>) — an exact,
   *  prefetch-proof anchor: it matches the efg `vid:` key of every representation
   *  of the watched video and nothing else. Absent on feed/story surfaces. */
  vid?: string;
  /** fbcdn URLs of the cover image(s) centered right now. The panel displays one
   *  as the playing group's thumbnail when the capture carried none, and LEARNS
   *  the cover↔video binding so returning to an already-buffered video (which
   *  fetches nothing) still matches instantly. */
  coverUrls?: string[];
  /** Opaque slide marker: a durable DOM story id (`u:`) or provisional pinned-
   *  path fallback (`p:`), combined with a per-video-load id when present (see
   *  content.ts). Never fetched; only compared/bound according to provenance. */
  mark?: string;
  at: number;
}

/** Bound an opaque PlayingRef.mark for persistence, cutting the STORY side only: the
 *  `#<videoMark>` suffix must survive whole or consecutive loads stop being distinct,
 *  and the story head must stay a stable prefix or the derived story portion stops
 *  re-matching the same card. The budgets are fixed, not remainder math — a head that
 *  flexed with suffix length would shift that portion between loads `:9` and `:10`.
 *  56 covers a whole synthetic `#vm:<uuid>:<seq>`. */
export function boundPlayingMark(mark: string): string {
  if (mark.length <= 256) return mark;
  const i = mark.lastIndexOf('#');
  if (i < 0) return mark.slice(0, 256);
  return mark.slice(0, Math.min(i, 200)) + mark.slice(i).slice(-56);
}

const playingKey = (tabId: number): string => `playing_${tabId}`;
export async function getPlaying(tabId: number): Promise<PlayingRef | null> {
  return readKey<PlayingRef | null>(playingKey(tabId), null);
}

// --- Recently requested fbcdn media tracks (the video being fetched now) ---

interface RecentTrack {
  /** Widened URL of a fetched track; the side panel derives match keys
   *  (fbAssetKeys/mediaId/trackKey) from it, since a single id can't survive
   *  fbcdn's base64 filenames and rotating origin prefixes. */
  url: string;
  at: number;
}

interface RecentRef {
  /** Fetched tracks, oldest→newest. Normally a 24-entry tail; a bounded 4s
   *  transition burst and two boundary-near groups may temporarily widen it. */
  tracks: RecentTrack[];
}

const recentKey = (tabId: number): string => `recent_${tabId}`;
export async function getRecent(tabId: number): Promise<RecentRef | null> {
  const key = recentKey(tabId);
  const raw = (await chrome.storage.session.get(key))[key] as RecentRef | undefined;
  return raw && Array.isArray(raw.tracks) ? raw : null;
}

// A short request burst can be much wider than the steady recent-track ring: the Story
// viewer preloads several cards while the 300 ms DOM detector is still settling. Keep
// that burst briefly, then collapse back to the steady budget while reserving the two
// groups closest to the current slide boundary. Retention only — selectPlaying still
// decides whether the evidence is trustworthy enough to display or learn from.
const RECENT_STEADY_MAX = 24;
const RECENT_BURST_MAX = 96;
const RECENT_BURST_MS = 4_000;
const RECENT_BOUNDARY_MS = 12_000;
const RECENT_PER_BOUNDARY_GROUP_MAX = 8;
// Two, because a slide boundary has exactly two sides: the card being left and the one
// being entered. A third would start reserving whatever the viewer preloaded past them.
const RECENT_BOUNDARY_GROUPS = 2;

function recentGroupKey(track: RecentTrack): string {
  return fbAssetKeys(track.url)[0] ?? mediaId(track.url);
}

function boundaryRecentGroups(
  tracks: readonly RecentTrack[] | undefined,
  ref: PlayingRef | null,
): Map<string, number> {
  if (ref?.hasVideo !== true || tracks == null) return new Map();
  const distanceByGroup = new Map<string, number>();
  for (const track of tracks) {
    const distance = Math.abs(track.at - ref.at);
    if (distance > RECENT_BOUNDARY_MS) continue;
    const group = recentGroupKey(track);
    distanceByGroup.set(group, Math.min(distance, distanceByGroup.get(group) ?? Infinity));
  }
  return new Map([...distanceByGroup].sort((a, b) => a[1] - b[1]).slice(0, RECENT_BOUNDARY_GROUPS));
}

function retainRecentTracks(tracks: RecentTrack[], at: number, ref: PlayingRef | null): RecentTrack[] {
  if (tracks.length <= RECENT_STEADY_MAX) return tracks;
  const boundary = boundaryRecentGroups(tracks, ref);
  const chosen = new Set<number>();

  // Reserve a bounded number of observations for each boundary-near group.
  for (const group of boundary.keys()) {
    const indices: number[] = [];
    tracks.forEach((track, index) => {
      if (recentGroupKey(track) === group) indices.push(index);
    });
    for (const index of indices.slice(-RECENT_PER_BOUNDARY_GROUP_MAX)) chosen.add(index);
  }

  // Keep the entire short transition burst (up to the hard cap). This is what
  // prevents request 1 from disappearing merely because requests 2..25 landed
  // before PlayingRef and the panel could correlate them.
  for (let index = tracks.length - 1; index >= 0 && chosen.size < RECENT_BURST_MAX; index--) {
    if (at - tracks[index].at <= RECENT_BURST_MS) chosen.add(index);
  }

  // Once the burst cools, retain the ordinary newest tail as a backstop.
  for (let index = tracks.length - 1; index >= 0 && chosen.size < RECENT_STEADY_MAX; index--) {
    chosen.add(index);
  }

  return tracks.filter((_track, index) => chosen.has(index));
}

/** Identity of the media surface the user is actually viewing. A DOM-proven
 *  Story card or exact reel id outranks per-load MSE markers; those markers are
 *  only needed on surfaces that expose no durable media identity. */
export function playingIdentity(ref: PlayingRef | null | undefined): string {
  if (ref == null) return '';
  const story = durableStoryMarkPortion(ref.mark);
  if (story != null) return `story:${story}`;
  if (ref.vid != null) return `video:${ref.vid}`;
  return `${ref.hasVideo ? 'video' : 'media'}|${[...ref.ids].sort().join(',')}|${ref.mark ?? ''}`;
}

/** Identity strong enough to reserve Library rows. A provisional Story path is
 *  tray-wide and must never pin data; direct ids/reel ids are already protected
 *  by isExactPlayingItem, so only a DOM-proven Story needs this extra ledger. */
export function playingRetentionIdentity(ref: PlayingRef | null | undefined): string | undefined {
  const story = durableStoryMarkPortion(ref?.mark);
  return ref?.hasVideo === true && story != null ? `story:${story}` : undefined;
}

const PLAYING_PIN_GROUP_MAX = 8;
const playingPinKey = (tabId: number): string => `playing_pin_${tabId}`;

interface PlayingMediaPin {
  identity: string;
  groups: string[];
  playingAt: number;
}

function sanitizePlayingMediaPin(value: unknown): PlayingMediaPin | null {
  if (value == null || typeof value !== 'object') return null;
  const pin = value as Partial<PlayingMediaPin>;
  if (typeof pin.identity !== 'string' || pin.identity.length === 0 || pin.identity.length > 8192) return null;
  if (!Array.isArray(pin.groups)) return null;
  if (typeof pin.playingAt !== 'number' || !Number.isFinite(pin.playingAt) || pin.playingAt < 0) return null;
  const groups = [...new Set(pin.groups.filter((group): group is string => typeof group === 'string' && group.length <= 512))]
    .slice(0, PLAYING_PIN_GROUP_MAX);
  return groups.length > 0 ? { identity: pin.identity, groups, playingAt: pin.playingAt } : null;
}

async function getPlayingMediaPin(tabId: number): Promise<PlayingMediaPin | null> {
  return sanitizePlayingMediaPin(await readKey<unknown>(playingPinKey(tabId), null));
}

/** Build `owners` and `active` once from the same batch as `item`. Sharing this
 *  expanded matching contract with panel selection protects every displayed row
 *  from retention eviction. */
function isExactPlayingItem(
  item: MediaItem,
  ref: PlayingRef | null,
  active: ReadonlySet<string>,
  owners: ReadonlyMap<string, Set<string>>,
): boolean {
  if (ref == null) return false;
  if (matchesActiveMediaId(item, active, owners)) return true;
  if (item.thumbUrl != null && active.has(mediaId(item.thumbUrl))) return true;
  const storyId = storyDomIdFromMark(ref.mark);
  if (storyId != null && item.kind === 'video' && item.storyIds?.includes(storyId) === true) return true;
  if (ref.vid == null || item.kind !== 'video') return false;
  const wanted = `vid:${ref.vid}`;
  return fbAssetKeys(item.url).includes(wanted) ||
    (item.audioUrl != null && fbAssetKeys(item.audioUrl).includes(wanted));
}

/** Control state to classify against, when the caller already holds a snapshot.
 *  An absent field is read from storage; an explicit null means "no such state". */
interface RetentionOverrides {
  ref?: PlayingRef | null;
  recent?: RecentRef | null;
  pin?: PlayingMediaPin | null;
}

interface RetentionPartition {
  ordinary: MediaItem[];
  reserved: MediaItem[];
}

/** Split a tab's media so exact/current-boundary captures sit at the retained end of
 *  the FIFO. This never marks them live; it only ensures selectPlaying still has an
 *  item to return after the retention cap or a quota reclaim sheds unrelated ones. */
async function partitionMediaForRetention(
  tabId: number,
  items: MediaItem[],
  overrides: RetentionOverrides = {},
): Promise<RetentionPartition> {
  const [storedRef, storedRecent, storedPin] = await Promise.all([
    overrides.ref === undefined ? getPlaying(tabId) : Promise.resolve(null),
    overrides.recent === undefined ? getRecent(tabId) : Promise.resolve(null),
    overrides.pin === undefined ? getPlayingMediaPin(tabId) : Promise.resolve(null),
  ]);
  const ref = overrides.ref === undefined ? storedRef : overrides.ref;
  const recent = overrides.recent === undefined ? storedRecent : overrides.recent;
  const pin = overrides.pin === undefined ? storedPin : overrides.pin;
  const boundary = boundaryRecentGroups(recent?.tracks, ref);
  const retentionIdentity = playingRetentionIdentity(ref);
  const pinnedGroups = pin != null && pin.identity === retentionIdentity ? new Set(pin.groups) : new Set<string>();
  // Built once per batch and reused for every item below: matchesActiveMediaId's
  // alias branch needs whole-batch ownership to know an alias is unambiguous,
  // and re-deriving that per item would be quadratic in batch size.
  const aliasOwners = historicalAliasOwners(items);
  // Same one-per-batch rule: expanding the ref's ids re-canonicalizes each one
  // (URL parsing per alias id), so it must not run once per item either.
  const activeIds = activeMediaIds(ref?.ids);
  const ordinary: MediaItem[] = [];
  const protectedItems: { item: MediaItem; priority: number }[] = [];
  for (const item of items) {
    const group = item.kind === 'video' ? videoGroupKey(item) : undefined;
    const distance = group == null ? undefined : boundary.get(group);
    const priority = isExactPlayingItem(item, ref, activeIds, aliasOwners)
      ? 3_000_000
      : group != null && pinnedGroups.has(group)
        ? 2_000_000
      : distance == null
        ? 0
        : 1_000_000 - distance;
    if (priority > 0) protectedItems.push({ item, priority });
    else ordinary.push(item);
  }
  protectedItems.sort((a, b) => a.priority - b.priority);
  return { ordinary, reserved: protectedItems.map(({ item }) => item) };
}

const enqueueCaptureState = keyedSerialQueue();

export async function getFacebookTheme(tabId: number): Promise<FacebookThemeRef | null> {
  return normalizeFacebookThemeRef(await readKey<unknown>(facebookThemeKey(tabId), null)) ?? null;
}

/** Persist a content-observed theme on the tab capture lane. Resolving true is
 * the durable acknowledgement consumed by the content script. */
export function setFacebookTheme(tabId: number, raw: unknown): Promise<boolean> {
  const next = normalizeFacebookThemeRef(raw);
  if (next == null) return Promise.resolve(false);
  let completed = false;
  return enqueueCaptureState(
    tabId,
    async () => {
      const current = await getFacebookTheme(tabId);
      // Mirror setPlaying's rollback escape: `at` is stamped from the worker's
      // OWN clock at receipt, so after a wall-clock rollback every later signal
      // has next.at < current.at and this guard would wedge here forever —
      // ACKing ok:true while silently discarding every valid observation until
      // the stale future timestamp caught up. A stored value from a
      // pre-rollback epoch (implausibly ahead of a freshly read "now") loses
      // the ordering guard instead of blocking the repaired clock's evidence.
      const resetClockEpoch = current != null && playingTimestampIsFutureEpoch(current.at, Date.now());
      if (current != null && current.at > next.at && !resetClockEpoch) {
        completed = true;
        return;
      }
      if (current?.theme === next.theme && current.at === next.at) {
        completed = true;
        return;
      }
      await writeCaptureState({ [facebookThemeKey(tabId)]: next });
      completed = true;
    },
    logWriteError('Facebook theme'),
  ).then(() => completed);
}

// storage.session's quota is shared by every Facebook tab. Per-tab capture
// queues prevent lost updates within one key, but they cannot make a global
// quota snapshot/reclaim safe: tab B could otherwise prune a stale snapshot of
// tab A while tab A is writing. Serialize every media read-merge-write and tab
// media removal through one additional lane. Playing/recent/pin remain on their
// per-tab lane and are re-read when retention is classified.
const withMediaGlobalLock = createChainLock();

// A global quota reclaim classifies foreign tabs from playing/recent/pin and
// then deletes ordinary media. Those control pointers must not advance between
// classification and the atomic media write, or a just-activated row in tab A
// could still look ordinary to tab B's older snapshot. Normal media writes do
// not need this barrier; only quota reclaim and retention-control mutations do.
const withRetentionSnapshotLock = createChainLock();

/** Persist only the bounded group ids that selectPlaying has already confirmed.
 *  Retention consults this pin, but selection never does: a stale or corrupt pin
 *  can keep a few Library rows, never make them appear as currently playing. */
export function setPlayingMediaPin(
  tabId: number,
  identity: string,
  groups: Iterable<string>,
  playingAt: number,
  receivedAt?: number,
): Promise<boolean> {
  if (
    receivedAt !== undefined &&
    (!Number.isFinite(receivedAt) || playingTimestampIsFutureEpoch(playingAt, receivedAt))
  ) {
    return Promise.resolve(false);
  }
  const pin = sanitizePlayingMediaPin({ identity, groups: [...groups], playingAt });
  if (pin == null) return Promise.resolve(false);
  let completed = false;
  return enqueueCaptureState(
    tabId,
    async () => {
      if (receivedAt !== undefined && playingTimestampIsFutureEpoch(pin.playingAt, Date.now())) return;
      await withRetentionSnapshotLock(async () => {
        // selectPlaying may finish after the user has already advanced. Refuse to
        // attach its confirmed group to a different Story identity. This is a
        // completed stale request, not a storage failure worth retrying.
        if (playingRetentionIdentity(await getPlaying(tabId)) !== pin.identity) {
          completed = true;
          return;
        }
        const current = await getPlayingMediaPin(tabId);
        if (current != null && current.playingAt > pin.playingAt) {
          completed = true;
          return;
        }
        if (
          current?.identity === pin.identity &&
          current.playingAt === pin.playingAt &&
          current.groups.length === pin.groups.length &&
          current.groups.every((group, index) => group === pin.groups[index])
        ) {
          completed = true;
          return;
        }
        await writeCaptureState({ [playingPinKey(tabId)]: pin }, { retryTransient: false });
        completed = true;
      });
    },
    logWriteError('playing pin'),
  ).then(() => completed);
}

interface GlobalMediaRow {
  key: string;
  tabId: number;
  item: MediaItem;
}

/** Recover shared session quota without crossing the retention boundary of any
 *  tab. The first failed set was atomic, so this starts from a fresh area-wide
 *  snapshot, replaces the current tab with its pending merge, and progressively
 *  removes globally-oldest ordinary rows. Every retry includes the pending
 *  current array, every changed foreign array, and the full control reserve in
 *  one storage.set. A failure therefore leaves the prior store untouched. */
async function reclaimGlobalMediaQuota(
  currentTabId: number,
  currentItems: MediaItem[],
  incomingIds: ReadonlySet<string>,
): Promise<{ count: number; evicted: number }> {
  const snapshot = await chrome.storage.session.get(null);
  const itemsByKey = new Map<string, MediaItem[]>();
  const tabByKey = new Map<string, number>();
  const currentKey = keyFor(currentTabId);

  for (const [key, value] of Object.entries(snapshot)) {
    const match = /^media_(\d+)$/.exec(key);
    if (match == null || !Array.isArray(value)) continue;
    const tabId = Number(match[1]);
    if (!Number.isSafeInteger(tabId)) continue;
    itemsByKey.set(key, value as MediaItem[]);
    tabByKey.set(key, tabId);
  }
  itemsByKey.set(currentKey, currentItems);
  tabByKey.set(currentKey, currentTabId);

  const candidates: GlobalMediaRow[] = [];
  for (const [key, tabItems] of itemsByKey) {
    const tabId = tabByKey.get(key);
    if (tabId == null || tabItems.length <= 1) continue;
    // Every playing/recent/pin key this classification needs is already in
    // `snapshot`; reuse it instead of re-reading storage per tab.
    const rawRecent = snapshot[recentKey(tabId)] as RecentRef | undefined;
    const overrides: RetentionOverrides = {
      ref: (snapshot[playingKey(tabId)] as PlayingRef | undefined) ?? null,
      recent: rawRecent && Array.isArray(rawRecent.tracks) ? rawRecent : null,
      pin: sanitizePlayingMediaPin(snapshot[playingPinKey(tabId)] ?? null),
    };
    const { ordinary } = await partitionMediaForRetention(tabId, tabItems, overrides);
    const ordinaryItems = new Set(ordinary);
    const removable = tabItems.filter((item) =>
      ordinaryItems.has(item) && !(tabId === currentTabId && incomingIds.has(item.id)),
    );
    // Precompute only rows that can truly be removed. If there is no reserved
    // or incoming row to keep this tab represented, exclude its newest ordinary
    // row from the candidate list. This also guarantees the final candidate is
    // a real final retry point instead of a runtime-skipped "leave one" row.
    const alreadyKept = tabItems.length - removable.length;
    removable.sort((a, b) => {
      const aAt = Number.isFinite(a.addedAt) ? a.addedAt : 0;
      const bAt = Number.isFinite(b.addedAt) ? b.addedAt : 0;
      return aAt - bAt;
    });
    const removableCount = alreadyKept > 0 ? removable.length : Math.max(0, removable.length - 1);
    for (const item of removable.slice(0, removableCount)) candidates.push({ key, tabId, item });
  }
  candidates.sort((a, b) => {
    const aAt = Number.isFinite(a.item.addedAt) ? a.item.addedAt : 0;
    const bAt = Number.isFinite(b.item.addedAt) ? b.item.addedAt : 0;
    return aAt - bAt;
  });

  const working = new Map<string, MediaItem[]>();
  for (const [key, tabItems] of itemsByKey) working.set(key, [...tabItems]);
  const changedKeys = new Set<string>([currentKey]);
  let evicted = 0;
  let nextAttemptAt = 1;

  // A quota-shaped error can be a one-shot backend race (for example another
  // context just released bytes). Retry the intact pending merge once from the
  // fresh global snapshot before deleting anything. Persistent quota proceeds
  // to the safe candidates below; no-candidate quota still rejects unchanged.
  try {
    await chrome.storage.session.set(dataValues({ [currentKey]: currentItems }));
    return { count: currentItems.length, evicted: 0 };
  } catch (err) {
    if (!isStorageQuotaError(err)) throw err;
  }

  for (const candidate of candidates) {
    const tabItems = working.get(candidate.key);
    if (tabItems == null || tabItems.length <= 1) continue;
    const index = tabItems.indexOf(candidate.item);
    if (index < 0) continue;
    tabItems.splice(index, 1);
    changedKeys.add(candidate.key);
    evicted++;

    // Try after 1, 2, 4, ... cumulative removals, and always after the last
    // safe candidate. This bounds write amplification while still finding the
    // smallest practical reclaim instead of immediately deleting half a tab.
    const isLast = candidate === candidates[candidates.length - 1];
    if (evicted < nextAttemptAt && !isLast) continue;
    const values: Record<string, unknown> = {};
    for (const key of changedKeys) values[key] = working.get(key) ?? [];
    try {
      await chrome.storage.session.set(dataValues(values));
      return { count: working.get(currentKey)?.length ?? 0, evicted };
    } catch (err) {
      if (!isStorageQuotaError(err)) throw err;
      nextAttemptAt *= 2;
    }
  }

  // Reject when safe reclamation cannot satisfy the atomic write.
  // This preserves all stored rows and Saved history.
  throw quotaErrorForGlobalReclaim();
}

function quotaErrorForGlobalReclaim(): Error {
  const error = new Error('storage.session quota exhausted with no safe media rows to reclaim');
  error.name = 'QuotaExceededError';
  return error;
}

/** Merge new captures for a tab; resolves with the stored item count (for the
 *  badge) so callers don't re-read the whole array right after writing it. */
export function addMedia(tabId: number, items: MediaItem[]): Promise<number> {
  let count = 0;
  let failure: unknown;
  return enqueueCaptureState(
    tabId,
    async () => {
      await withMediaGlobalLock(async () => {
        const key = keyFor(tabId);
        const stored = await readKey<MediaItem[]>(key, []);
        const [merged, changed] = mergeMedia(stored, items);
        if (changed && merged.length > maxItemsCache) {
          const { ordinary, reserved } = await partitionMediaForRetention(tabId, merged);
          merged.splice(0, merged.length, ...ordinary, ...reserved);
          // Spend the hysteresis margin only when `stored` (the durable count BEFORE
          // this batch) was already at or over the cap; see MAX_ITEMS_HYSTERESIS.
          const hysteresis =
            stored.length >= maxItemsCache ? Math.min(MAX_ITEMS_HYSTERESIS, Math.floor(maxItemsCache / 10)) : 0;
          const target = maxItemsCache - hysteresis;
          // Oldest first, but never past the reserved tail: the splice cuts from the
          // FRONT, and `ordinary` is all that sits there. Reserved rows are what the
          // user is watching or what a confirmed Story pinned; a small enough maxItems
          // would otherwise let the cut run straight through them into the very item
          // the partition exists to protect. reclaimGlobalMediaQuota, the other
          // eviction path in this file, already refuses to touch them.
          const evict = Math.min(merged.length - target, ordinary.length);
          if (evict > 0) {
            diagBump('storageMaxItemsEvicted', evict);
            merged.splice(0, evict);
          }
        }
        // Default the badge count to what is ALREADY stored: a failed set() is an
        // atomic no-op, so a rejected write cannot make the badge claim an empty
        // Library. Raise it only after a write actually lands.
        count = stored.length;
        if (!changed) return;
        try {
          await chrome.storage.session.set(dataValues({ [key]: merged }));
          count = merged.length;
        } catch (err) {
          if (!isStorageQuotaError(err)) {
            // A renderer/backend hiccup must not consume a one-shot GraphQL
            // capture. Retry the identical merge once before surfacing failure.
            await chrome.storage.session.set(dataValues({ [key]: merged }));
            count = merged.length;
            return;
          }
          const incomingIds = new Set(items.map((item) => item.id));
          const recovered = await withRetentionSnapshotLock(() =>
            reclaimGlobalMediaQuota(tabId, merged, incomingIds),
          );
          count = recovered.count;
          diagBump('storageQuotaEvicted', recovered.evicted);
        }
      });
    },
    (err) => {
      failure = err;
      console.error('[FaceScrap] storage write failed', err);
    },
  ).then(() => {
    if (failure !== undefined) throw failure;
    return count;
  });
}

// Every write lane in this file is an in-memory promise chain local to ONE JS context,
// so a write from the side panel holds no lock against the worker's concurrent
// addMedia: its read-modify-write could straddle it and drop a capture, or resurrect a
// tab the worker just cleared. getMedia's self-repair write below is therefore
// worker-only. An MV3 service worker has no document; the panel is a page and has one.
const isServiceWorkerContext = typeof document === 'undefined';

export async function getMedia(tabId: number): Promise<MediaItem[]> {
  const stored = await readKey<MediaItem[]>(keyFor(tabId), []);
  const [normalized, changed] = mergeMedia(stored, []);
  if (changed && isServiceWorkerContext) {
    // Return the repaired view immediately so an already-buffered video can
    // match NOW_PLAYING without waiting for new network traffic. Persist via
    // addMedia's serialized read/merge/write lane; never overwrite a concurrent
    // capture from this read path. Every caller still gets the repaired
    // value below — only the write is restricted to the worker.
    void addMedia(tabId, []).catch((error) => console.error('[FaceScrap] media id migration failed', error));
  }
  return normalized;
}

/**
 * The SLIDE a PlayingRef describes, as opposed to the observation that carried it.
 *
 * `mark` advances on a real slide change (a new story card, a new MSE load) and `vid` names the
 * reel; `ids` does not belong here — it keeps growing as more of the same slide's
 * representations are captured, and on an MSE surface it flickers between the cover and nothing
 * at all as the video moves in and out of the centre hit-test.
 *
 * Empty means the surface exposes no identity, and there `at` must keep moving: with nothing to
 * compare, holding a timestamp would freeze the anchor on the first thing ever seen.
 */
function playingSlideIdentity(ref: PlayingRef): string {
  const identity = `${ref.mark ?? ''}|${ref.vid ?? ''}`;
  return identity === '|' ? '' : identity;
}

export function setPlaying(tabId: number, ref: PlayingRef, receivedAt?: number): Promise<boolean> {
  let completed = false;
  return enqueueCaptureState(
    tabId,
    async () => {
      await withRetentionSnapshotLock(async () => {
        const key = playingKey(tabId);
        const current = await getPlaying(tabId);
        const resetClockEpoch =
          current != null &&
          receivedAt !== undefined &&
          playingTimestampIsFutureEpoch(current.at, receivedAt);
        // sendMessage calls can settle out of order under a renderer stall. Once a
        // newer DOM boundary is stored, an older message must never move the tab
        // back to the previous Story. The one exception is a stored value from a
        // pre-rollback wall-clock epoch; keeping it would ACK-but-ignore every
        // valid observation until the old future timestamp caught up.
        if (current != null && current.at > ref.at && !resetClockEpoch) {
          completed = true;
          return;
        }
        // `at` marks the slide boundary, not its latest observation. Preserve it while
        // video and cover observations resolve to the same slide identity so track
        // evidence remains anchored to that boundary.
        const identity = playingSlideIdentity(ref);
        const stamped =
          current != null && identity !== '' && identity === playingSlideIdentity(current)
            ? { ...ref, at: current.at }
            : ref;
        if (!resetClockEpoch) {
          await writeCaptureState({ [key]: stamped });
          completed = true;
          return;
        }

        // Recent requests and the retention pin carry timestamps from the same
        // clock. Repair the whole control snapshot in one durable write so old
        // future evidence cannot immediately re-select or reserve the previous
        // Story after the PlayingRef itself has recovered.
        const storedRecent = await getRecent(tabId);
        const repairedRecent: RecentRef | null =
          storedRecent == null
            ? null
            : {
                tracks: storedRecent.tracks.filter(
                  (track) =>
                    track != null &&
                    typeof track.url === 'string' &&
                    typeof track.at === 'number' &&
                    !playingTimestampIsFutureEpoch(track.at, receivedAt),
                ),
              };
        const values: Record<string, unknown> = {
          [key]: ref,
          [playingPinKey(tabId)]: null,
        };
        if (repairedRecent != null) values[recentKey(tabId)] = repairedRecent;
        await writeCaptureState(values);
        completed = true;
      });
    },
    logWriteError('playing'),
  ).then(() => completed);
}

export function setRecent(tabId: number, url: string, at: number, receivedAt?: number): Promise<boolean> {
  if (
    url.length > MAX_MEDIA_URL_LEN ||
    !isFbcdn(url) ||
    !Number.isFinite(at) ||
    at < 0 ||
    (receivedAt !== undefined &&
      (!Number.isFinite(receivedAt) || playingTimestampIsFutureEpoch(at, receivedAt)))
  ) {
    return Promise.resolve(false);
  }
  let completed = false;
  return enqueueCaptureState(
    tabId,
    async () => {
      if (receivedAt !== undefined && playingTimestampIsFutureEpoch(at, Date.now())) return;
      await withRetentionSnapshotLock(async () => {
        const key = recentKey(tabId);
        // getRecent, not a raw read: it validates `tracks` is an array, so a corrupt
        // value degrades to empty instead of throwing inside this write lane.
        const cur = [...((await getRecent(tabId))?.tracks ?? [])];
        // A worker can lose the ACK after storage accepted the write, then retry
        // the same observation. Keep that retry idempotent so one network segment
        // cannot occupy the bounded ring twice.
        if (!cur.some((track) => track.url === url && track.at === at)) cur.push({ url, at });
        const ref = await getPlaying(tabId);
        const retained = retainRecentTracks(cur, at, ref);
        const compact = retained.slice(-RECENT_STEADY_MAX);
        const value = { tracks: retained } satisfies RecentRef;
        const compactValue = { tracks: compact } satisfies RecentRef;
        await writeCaptureState({ [key]: value }, { compactValues: { [key]: compactValue } });
        completed = true;
      });
    },
    logWriteError('recent'),
  ).then(() => completed);
}

// --- Learned now-playing bindings, persisted so a reopened panel re-matches ---
// The panel learns cover→group, group→cover and mark→group while it runs; those
// live in panel-local memory wiped on panel close. Persist per tab so reopening on
// an already-buffered video re-matches WITHOUT new fbcdn traffic. The worker owns
// durable writes and clear tombstones; panels only submit versioned snapshots. lastLive is
// intentionally NOT persisted — restoring it resurrects a stale/neighbour video on
// reopen (the reopen should re-derive from live evidence + these bindings instead).

export interface BindState {
  coverBind: [string, string][];
  groupCover: [string, string][];
  markBind: [string, string][];
}

export interface BindRecord {
  version: 1;
  generation: number;
  revision: number;
  state: BindState | null;
}

export interface PersistBindingsRequest {
  generation: number;
  baseRevision: number;
  state: BindState;
}

export type PersistBindingsResult =
  | { ok: true; generation: number; revision: number }
  | { ok: false; conflict: true; record: BindRecord };

const BIND_VERSION = 1;
const BIND_MAX_ENTRIES = 300;
const BIND_MAX_BYTES = 96 * 1024;
const BIND_TEXT_MAX = 8 * 1024;
const bindKey = (tabId: number): string => `bind_${tabId}`;

function sanitizeBindEntries(raw: unknown, provisionalMarks = false): [string, string][] {
  if (!Array.isArray(raw)) return [];
  const deduped = new Map<string, string>();
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [key, value] = entry;
    if (
      typeof key !== 'string' ||
      typeof value !== 'string' ||
      key.length === 0 ||
      value.length === 0 ||
      key.length > BIND_TEXT_MAX ||
      value.length > BIND_TEXT_MAX ||
      (provisionalMarks && isProvisionalStoryMark(key))
    ) {
      continue;
    }
    if (deduped.has(key)) deduped.delete(key);
    deduped.set(key, value);
  }
  return [...deduped.entries()].slice(-BIND_MAX_ENTRIES);
}

function bindBytes(state: BindState): number {
  return new TextEncoder().encode(JSON.stringify(state)).byteLength;
}

export function sanitizeBindState(raw: unknown): BindState | null {
  if (raw == null || typeof raw !== 'object') return null;
  const candidate = raw as Partial<BindState>;
  const state: BindState = {
    coverBind: sanitizeBindEntries(candidate.coverBind),
    groupCover: sanitizeBindEntries(candidate.groupCover),
    markBind: sanitizeBindEntries(candidate.markBind, true),
  };
  // Preserve the durable mark mapping longest. Cover thumbnails are recoverable
  // from captures, and groupCover is the least important of the three maps.
  while (bindBytes(state) > BIND_MAX_BYTES) {
    if (state.groupCover.length > 0) state.groupCover.shift();
    else if (state.coverBind.length > 0) state.coverBind.shift();
    else if (state.markBind.length > 0) state.markBind.shift();
    else return null;
  }
  return state;
}

function isCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

const EMPTY_BIND_RECORD: BindRecord = { version: BIND_VERSION, generation: 0, revision: 0, state: null };

function parseBindRecord(raw: unknown): BindRecord {
  if (raw == null || typeof raw !== 'object') return EMPTY_BIND_RECORD;
  const record = raw as Partial<BindRecord>;
  if (record.version === BIND_VERSION && isCounter(record.generation) && isCounter(record.revision)) {
    // Sanitized once: it JSON-round-trips the state to measure bytes, so calling it
    // twice (to test, then to keep) paid for that twice.
    const state = record.state === null ? null : sanitizeBindState(record.state);
    if (record.state === null || state != null) {
      return { version: BIND_VERSION, generation: record.generation, revision: record.revision, state };
    }
  }
  // Normalize an unversioned or invalid record at generation and revision zero so
  // the next durable update can preserve valid learned mappings.
  const legacy = sanitizeBindState(raw);
  return legacy != null ? { version: BIND_VERSION, generation: 0, revision: 0, state: legacy } : EMPTY_BIND_RECORD;
}

async function readBindRecord(tabId: number): Promise<BindRecord> {
  return parseBindRecord(await readKey<unknown>(bindKey(tabId), null));
}

function sameBindState(left: BindState | null, right: BindState): boolean {
  return left != null && JSON.stringify(left) === JSON.stringify(right);
}

/** Worker-owned CAS write. It shares the tab's capture lane with clearTab, so a
 * clear cannot be overtaken by an older panel write. The baseRevision+1 equality
 * case is a lost-ACK retry and returns the already-durable acknowledgement. */
export function persistBindings(tabId: number, request: PersistBindingsRequest): Promise<PersistBindingsResult> {
  const state = sanitizeBindState(request.state);
  if (!isCounter(request.generation) || !isCounter(request.baseRevision) || state == null) {
    return Promise.reject(new TypeError('Invalid binding persistence request.'));
  }
  let result: PersistBindingsResult | undefined;
  let failure: unknown;
  return enqueueCaptureState(
    tabId,
    async () => {
      const current = await readBindRecord(tabId);
      if (current.generation !== request.generation) {
        result = { ok: false, conflict: true, record: current };
        return;
      }
      if (current.revision === request.baseRevision + 1 && sameBindState(current.state, state)) {
        result = { ok: true, generation: current.generation, revision: current.revision };
        return;
      }
      if (current.revision !== request.baseRevision) {
        result = { ok: false, conflict: true, record: current };
        return;
      }
      const next: BindRecord = {
        version: BIND_VERSION,
        generation: current.generation,
        revision: current.revision + 1,
        state,
      };
      await writeCaptureState({ [bindKey(tabId)]: next });
      result = { ok: true, generation: next.generation, revision: next.revision };
    },
    (error) => {
      failure = error;
    },
  ).then(() => {
    if (failure !== undefined) throw failure;
    return result as PersistBindingsResult;
  });
}

export function getBindRecord(tabId: number): Promise<BindRecord> {
  return readBindRecord(tabId);
}

export async function getBind(tabId: number): Promise<BindState | null> {
  return (await readBindRecord(tabId)).state;
}

/** Remove the per-tab CAPTURE state (media list + now-playing + recent + bindings).
 *  Each key's removal is serialized through the SAME chain that writes it: an
 *  in-flight read-merge-write that started before the wipe must not land after
 *  it (resurrecting cleared items), nor may a late clear erase captures from
 *  the page just navigated to.
 *
 *  saved_ is deliberately NOT touched: it is the tab's download history, which
 *  outlives both a page navigation and the "Clear captured list" button (whose
 *  UI promises "Saved stays"). It is byte-budgeted and, being in
 *  storage.session, cleared when the browser session ends. A CLOSED tab is the
 *  one lifecycle where the history must go too — that path is purgeTab. */
export function clearTab(
  tabId: number,
  { preserveFacebookTheme = false }: { preserveFacebookTheme?: boolean } = {},
): Promise<void> {
  let failure: unknown;
  return enqueueCaptureState(
    tabId,
    async () => {
      const current = await readBindRecord(tabId);
      const tombstone: BindRecord = {
        version: BIND_VERSION,
        generation: current.generation + 1,
        revision: 0,
        state: null,
      };
      // Land the generation barrier first. If the following capture removal
      // fails, callers see the failure, but an old panel callback still cannot
      // resurrect bindings from the generation that was just cleared.
      await writeCaptureState({ [bindKey(tabId)]: tombstone });
      const captureKeys = [keyFor(tabId), playingKey(tabId), recentKey(tabId), playingPinKey(tabId)];
      if (!preserveFacebookTheme) captureKeys.push(facebookThemeKey(tabId));
      await withMediaGlobalLock(() => chrome.storage.session.remove(captureKeys));
    },
    (error) => {
      failure = error;
    },
  ).then(() => {
    if (failure !== undefined) throw failure;
  });
}
/** Full teardown for a CLOSED tab: the capture state AND the download history. Chrome
 *  does not reuse tab ids within a session, so a dead tab can never render its Saved
 *  view again — leaving saved_ would orphan the key until the browser exits. */
export function purgeTab(tabId: number): Promise<void> {
  const removeBindRecord = (): Promise<void> => {
    let failure: unknown;
    return enqueueCaptureState(
      tabId,
      () => chrome.storage.session.remove(bindKey(tabId)),
      (error) => {
        failure = error;
      },
    ).then(() => {
      if (failure !== undefined) throw failure;
    });
  };
  return Promise.all([
    clearTab(tabId).then(removeBindRecord),
    dropSaved(tabId),
  ]).then(() => undefined);
}

// --- Runtime capability flags (published by the SW, read by the panel/popup) ---

interface Caps {
  sidePanel: boolean;
  offscreen: boolean;
}

const CAPS_KEY = 'caps';

export async function setCaps(caps: Caps): Promise<void> {
  await chrome.storage.session.set(dataValues({ [CAPS_KEY]: caps }));
}

export async function getCaps(): Promise<Caps | null> {
  return readKey<Caps | null>(CAPS_KEY, null);
}
