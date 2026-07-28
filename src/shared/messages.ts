// Typed chrome.runtime protocol shared by the four extension contexts
// (content script → service worker, side panel → service worker, service
// worker → offscreen). Senders annotate their literals against these shapes,
// so renaming or reshaping a message breaks compilation on both ends instead
// of failing silently across a context boundary. Receivers keep their runtime
// field validation where the sender is less trusted: a content script shares
// a process with the page, so the worker never believes these types blindly.

import type { DiagCounters } from './diag';
import type { DiagEvent } from './diag-log';
import type { MediaItem, MediaKind } from './media';
import type { SettingsPatch } from './settings';
import type { BindRecord, BindState } from './storage';
import type { SavedEntry } from './saved';
import type { EffectiveTheme } from './theme';

/** content script → service worker: sanitized captures relayed from the page. */
interface MediaFoundMsg {
  type: 'MEDIA_FOUND';
  items: MediaItem[];
  /** Per-content-context nonce; worker uses sender.documentId when available
   *  and this as a browser-compatibility fallback across navigation races. */
  documentToken?: string;
}

/** Shared ack shape: success, or failure with a retry hint and optional message. */
type RetryableAck = { ok: true } | { ok: false; retryable: boolean; error?: string };

/** Shared ack shape: success, or failure with a required message. */
type SimpleAck = { ok: true } | { ok: false; error: string };

/** The worker acknowledges MEDIA_FOUND only after addMedia has durably stored
 *  the sanitized batch. Content keeps an unacknowledged batch queued. */
export type MediaFoundAck = RetryableAck;

/** content script → service worker: the now-playing signal set. */
export interface NowPlayingMsg {
  type: 'NOW_PLAYING';
  /** mediaId()s of the media under the viewport centre. */
  ids: string[];
  hasVideo: boolean;
  /** URL/DOM-derived video id on reel/watch surfaces — the exact anchor. */
  vid?: string;
  /** Centered cover URLs (the worker re-validates fbcdn before storing). */
  covers?: string[];
  /** Opaque slide marker — compared only, never fetched. */
  mark?: string;
  /** Timestamp taken in the content script when the DOM signal was observed.
   *  The worker validates it before using it, so message-queue latency cannot
   *  move the slide boundary after the media requests it is meant to anchor. */
  detectedAt?: number;
  documentToken?: string;
}

/** Worker acknowledgement for NOW_PLAYING. Content commits its dedupe key only
 *  after ok:true; retryable failures preserve the original detectedAt. */
export type NowPlayingAck = RetryableAck;

/** content script → service worker: Facebook's currently rendered surface
 * theme, inferred without relying on private class names. */
export interface FacebookThemeMsg {
  type: 'FACEBOOK_THEME';
  theme: EffectiveTheme;
  at: number;
  documentToken?: string;
}

/** The worker answers ok:true only after the per-tab session record is durable. */
export type FacebookThemeAck = RetryableAck;

/** service worker → content script: liveness probe used before update recovery
 * injects another packaged detector into an already-open Facebook tab. */
export interface ContentScriptPingMsg {
  type: 'FACESCRAP_CONTENT_PING';
}

export interface ContentScriptPingAck {
  ok: true;
  documentToken: string;
}

/** extension page → service worker: merge one settings patch on the worker's
 * global write queue so separate panels/windows cannot overwrite each other. */
export interface SettingsUpdateMsg {
  type: 'FACESCRAP_UPDATE_SETTINGS';
  patch: SettingsPatch;
}

/** The worker acknowledges only after the merged settings object is durable. */
export type SettingsUpdateAck = SimpleAck;

// Preserve the detector's real boundary through ordinary renderer/IPC stalls.
// A delayed but valid timestamp is much safer than re-stamping it at receipt,
// which would make neighbour traffic look post-slide. The storage layer also
// rejects an older boundary once a newer one has landed for the same tab.
const MAX_PLAYING_MESSAGE_DELAY_MS = 30_000;
export const MAX_PLAYING_FUTURE_SKEW_MS = 1_000;
const PLAYING_TIME_EPSILON_MS = 0.001;

/** True when a stored timestamp belongs to an older wall-clock epoch. This is
 * deliberately based on worker receive time, not another renderer timestamp:
 * ordinary out-of-order messages remain monotonic, while a system clock
 * rollback cannot strand a future PlayingRef until wall time catches up. */
export function playingTimestampIsFutureEpoch(storedAt: number, receivedAt: number): boolean {
  return Number.isFinite(storedAt) &&
    Number.isFinite(receivedAt) &&
    storedAt > receivedAt + MAX_PLAYING_FUTURE_SKEW_MS;
}

/** Date.now() has millisecond resolution, but two different slides can be
 *  observed within one event-loop millisecond. Give each emitted boundary a
 *  strictly increasing value so storage's monotonic guard can order them. */
export function nextPlayingDetectedAt(previous: number, wallNow: number): number {
  if (!Number.isFinite(previous)) return wallNow;
  // A manual/system clock rollback larger than the worker's accepted future
  // skew must not strand the content script emitting permanently-invalid
  // timestamps until wall time catches up.
  if (playingTimestampIsFutureEpoch(previous, wallNow)) return wallNow;
  return previous >= wallNow ? previous + PLAYING_TIME_EPSILON_MS : wallNow;
}

/** Validate an untrusted content-script timestamp against worker receive time. */
export function normalizePlayingDetectedAt(raw: unknown, receivedAt: number): number | undefined {
  // Compatibility with an older content script that has not reloaded yet.
  if (raw === undefined) return receivedAt;
  // A present-but-invalid timestamp must not be silently rewritten into a
  // plausible current boundary. Ignore that NOW_PLAYING message instead.
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  if (playingTimestampIsFutureEpoch(raw, receivedAt)) return undefined;
  if (receivedAt - raw > MAX_PLAYING_MESSAGE_DELAY_MS) return undefined;
  return raw;
}

/** How long the panel waits WITHOUT PROGRESS on FACESCRAP_DOWNLOAD_DASH before
 *  giving up. Idle, not wall-clock, for the same reason the worker's own budget
 *  is (see MUX_IDLE_MS in service-worker.ts): a large track on a slow link is
 *  healthy, and a fixed deadline reports it as failed while it is still
 *  downloading. The worker forwards mux progress here (MuxProgressMsg) to keep
 *  this clock alive. */
export const DASH_UI_IDLE_MS = 360_000;

/** One mux round-trip's hard backstop (service worker → offscreen): the case no
 *  idle timer can see, an offscreen document that died outright and sends
 *  neither progress nor an answer. Declared HERE, not in service-worker.ts
 *  (which is the only place that arms it), so DASH_UI_HARD_CAP_MS below can be
 *  DERIVED from it instead of merely asserted to sit above it —
 *  service-worker.ts imports this value rather than redeclaring it. */
export const MUX_HARD_CAP_MS = 30 * 60_000;

/** Ceiling on waiting for chrome.downloads to reach a terminal state once a mux
 *  has produced a blob — a download normally settles in well under a second
 *  (blob → disk), so this only bounds how long a download that never reports a
 *  terminal state can keep the worker pinned awake. The other component (with
 *  MUX_HARD_CAP_MS) of one worker job's worst case; declared here for the same
 *  reason as MUX_HARD_CAP_MS. */
export const SETTLE_CAP_MS = 5 * 60_000;

/** Absolute ceiling on one panel-side wait. DERIVED to sit strictly above one
 *  full worker job's own worst case (MUX_HARD_CAP_MS + SETTLE_CAP_MS) instead
 *  of merely asserting it does — a bare `35 * 60_000` here once equalled that
 *  sum exactly, so the panel could time out at the very instant the worker was
 *  still entitled to keep working on the SAME job. The extra margin covers
 *  IPC/round-trip slack neither constant accounts for. The worker always gets
 *  to report a real result first; this only fires if it died without
 *  answering at all.
 *
 *  Used as a REBASABLE window (see withRearmableHardCap below), not a single
 *  fixed deadline from send time: dashChain (service-worker.ts) serializes
 *  DASH jobs, so a request queued behind another long-running one can sit for
 *  an unbounded time before its OWN mux even starts. Arming this once at send
 *  time — as a plain withHeartbeat call once did — budgeted only for ONE
 *  job's worst case while actually covering "queue wait + that job", so a
 *  queued request could exhaust it while the worker was still entitled to
 *  keep working on that SAME request, then finish it and write a Saved
 *  receipt under a card the panel had already tagged Failed. The worker now
 *  broadcasts FACESCRAP_DASH_JOB_STARTED (addressed by dashDownloadKey, so a
 *  panel can never rebase off some OTHER window's job) the moment a request
 *  leaves dashChain; the panel restarts this SAME window from that moment.
 *  Until that signal arrives — including if it never does, e.g. the worker is
 *  reaped and restarted mid-queue — the original send-time deadline keeps
 *  running, so every path still terminates. */
export const DASH_UI_HARD_CAP_MS = MUX_HARD_CAP_MS + SETTLE_CAP_MS + 5 * 60_000;

/** Bounds ONE wait the same shape withHeartbeat (async.ts) does — an idle
 *  timer `beat()` restarts, plus a hard cap as the backstop for a peer that
 *  answers with neither progress nor a result — except the hard cap here can
 *  be RE-ARMED once, via `armStarted()`. withHeartbeat's own hard timer is
 *  armed exactly once and never exposed for a caller to reset, which is
 *  right for the single round-trip it guards in service-worker.ts (the
 *  offscreen mux call, never itself queued) but wrong for DASH_UI_HARD_CAP_MS's
 *  wait: that wait spans an unbounded dashChain queue PLUS one job, and
 *  re-arming lets the panel give the job its own full window once it actually
 *  starts (see FACESCRAP_DASH_JOB_STARTED below) instead of making it share a
 *  single send-time deadline with however long it sat queued. `armStarted()`
 *  is a no-op once the wait has already settled — the same guard `beat()`
 *  uses — so a late or duplicate signal can never re-arm a promise nobody is
 *  awaiting anymore, and a request that never starts (or never reaches this
 *  call at all) still terminates at the original send-time hardCapMs. Declared
 *  here, not async.ts: it exists only to make DASH_UI_HARD_CAP_MS's own
 *  contract honest, not as a general-purpose primitive. */
export function withRearmableHardCap<T>(
  work: Promise<T>,
  idleMs: number,
  hardCapMs: number,
  message: string,
): { promise: Promise<T>; beat: () => void; armStarted: () => void } {
  let settled = false;
  let idleTimer: ReturnType<typeof setTimeout>;
  let hardTimer: ReturnType<typeof setTimeout>;
  let fail: (e: Error) => void = () => {};
  const guard = new Promise<never>((_, reject) => {
    fail = reject;
  });
  const armIdle = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fail(new Error(message)), idleMs);
  };
  const armHard = (): void => {
    clearTimeout(hardTimer);
    hardTimer = setTimeout(() => fail(new Error(message)), hardCapMs);
  };
  armIdle();
  armHard(); // send-time cap: bounds the case where the job's own start signal never arrives
  const promise = Promise.race([work, guard]).finally(() => {
    settled = true;
    clearTimeout(idleTimer);
    clearTimeout(hardTimer);
  });
  return {
    promise,
    beat: () => {
      if (!settled) armIdle();
    },
    armStarted: () => {
      if (!settled) armHard();
    },
  };
}

/** service worker → side panel: mux progress, forwarded from the offscreen port.
 *  Fire-and-forget — with no panel open, sendMessage simply has no receiver. */
export interface MuxProgressMsg extends MuxProgress {
  type: 'FACESCRAP_MUX_PROGRESS';
}

/** service worker → side panel: this specific queued DASH job has left
 *  dashChain (service-worker.ts) and its mux has started. Fire-and-forget,
 *  like MuxProgressMsg above — with no panel open, sendMessage simply has no
 *  receiver.
 *
 *  `key` is dashDownloadKey's own value for the job (download-settlement.ts):
 *  reusing it, rather than minting a new id, means the panel can compute the
 *  SAME value from the request it is about to send and match this signal to
 *  it without any extra round trip. MuxProgressMsg carries no job identity at
 *  all — every panel's heartbeat fires on ANY job's progress, queued or not,
 *  which is fine for an idle timer that only needs to see SOME liveness — but
 *  reusing that for a hard-cap rebase would rebase the WRONG panel's clock off
 *  someone else's job, reproducing the very bug this message exists to fix.
 *  See withRearmableHardCap and DASH_UI_HARD_CAP_MS above. */
export interface DashJobStartedMsg {
  type: 'FACESCRAP_DASH_JOB_STARTED';
  key: string;
}

/** side panel → service worker: remux a DASH pair and download the result. */
export interface DownloadDashMsg {
  type: 'FACESCRAP_DOWNLOAD_DASH';
  tabId: number;
  videoUrl: string;
  audioUrl: string;
  filename: string;
  saveAs?: boolean;
  receipt: SavedEntry;
}
export type DownloadDashResponse = SimpleAck;

/** Direct downloads use the same worker-owned terminal settlement + durable
 * receipt path as DASH, so closing the panel cannot lose success/failure. */
export interface DownloadDirectMsg {
  type: 'FACESCRAP_DOWNLOAD_DIRECT';
  tabId: number;
  url: string;
  filename: string;
  saveAs?: boolean;
  receipt: SavedEntry;
}
export type DownloadDirectResponse = DownloadDashResponse;

/**
 * content script → service worker: what could the media playing in MY tab be
 * downloaded as?
 *
 * Answers with LABELS ONLY. No fbcdn URL ever crosses into the page's process,
 * so the in-page button cannot leak one and cannot be tricked into asking for
 * one. `tabId` is deliberately absent: the worker reads it from `sender.tab`,
 * which the page cannot forge.
 */
interface PlayingDownloadOptionsMsg {
  type: 'FACESCRAP_PLAYING_DOWNLOAD_OPTIONS';
}
export type PlayingDownloadOptionsResponse =
  | {
      ok: true;
      /** Absent when nothing downloadable is playing — the button hides itself. */
      media?: {
        kind: MediaKind;
        /** Resolution labels, highest first. Empty for an image: nothing to pick. */
        labels: string[];
      };
    }
  | { ok: false; error: string };

/**
 * content script → service worker: download what is playing in MY tab, at this
 * resolution label.
 *
 * An intent, not a command with a payload. FACESCRAP_DOWNLOAD_DASH and
 * _DIRECT carry a URL and are therefore refused outright when `sender.tab` is
 * set (a compromised page must not be able to aim the extension's downloader at
 * an arbitrary URL). This message carries no URL: the worker resolves one from
 * the capture state it already holds for the sending tab. The worst a hostile
 * page can do with it is re-download the media the user is already watching.
 */
export interface RequestPlayingDownloadMsg {
  type: 'FACESCRAP_REQUEST_PLAYING_DOWNLOAD';
  /** One of the labels from PlayingDownloadOptionsResponse. An unknown or absent
   *  label falls back to the Settings default quality, so a menu left open while
   *  the representations changed still downloads something sensible. */
  label?: string;
}
export type RequestPlayingDownloadResponse = SimpleAck;

/** service worker → offscreen: fetch and remux one (video, audio) track pair.
 *
 *  `diag` and the events on the way back exist because an offscreen document has
 *  `chrome.runtime` and NOTHING else — `chrome.storage` is undefined in it, so it
 *  can neither read the diagnostics setting nor persist what it recorded. Reading
 *  the flag from the message it was already being sent, and handing its trace back
 *  in the answer it was already returning, keeps the whole thing on the one API
 *  that context actually has. */
export interface MuxMsg {
  type: 'FACESCRAP_MUX';
  videoUrl: string;
  audioUrl: string;
  /** Diagnostics are on: record a trace and return it below. */
  diag?: boolean;
}
export type MuxResponse = ({ ok: true; blobUrl: string } | { ok: false; error: string }) & {
  /** This job's trace. Present only when `diag` was set on the request. */
  events?: DiagEvent[];
};

/** offscreen → service worker: a long-lived port carrying mux progress.
 *
 *  A one-shot sendMessage gives the worker exactly one event — the answer — so
 *  its only way to notice a wedged job was a wall-clock deadline, which cannot
 *  tell "wedged" from "large file on a slow link" and killed the latter. A port
 *  turns progress into events the worker can time against, and its disconnect
 *  reports an offscreen document that died outright, which no timer detects. */
export const MUX_PORT = 'facescrap-mux';

/** One progress report. `bytes` is cumulative for the whole job. */
export interface MuxProgress {
  phase: 'fetch' | 'remux';
  bytes: number;
}

/** How often the offscreen reports. Must stay well under MUX_IDLE_MS. */
export const MUX_PROGRESS_MS = 2_000;

/** service worker → offscreen: release a published blob once its download settled. */
export interface RevokeMsg {
  type: 'FACESCRAP_REVOKE';
  blobUrl: string;
}

/**
 * side panel → service worker: wipe all captured state for a tab. Routed through
 * the worker on purpose — a panel-side clearTab() runs in a SEPARATE JS context
 * whose serial write queue cannot order against the worker's in-flight capture
 * writes, so a removal could land between an addMedia read and its write and the
 * wiped list would resurrect. Handling it in the worker puts the removal on the
 * same enqueueWrite chain as addMedia.
 */
export interface ClearTabMsg {
  type: 'FACESCRAP_CLEAR_TAB';
  tabId: number;
}

/** side panel -> service worker: commit one immutable learned-binding snapshot.
 * The worker acknowledges only after the versioned record is durable. */
export interface PersistBindingsMsg {
  type: 'FACESCRAP_PERSIST_BINDINGS';
  tabId: number;
  generation: number;
  baseRevision: number;
  state: BindState;
}

export type PersistBindingsAck =
  | { ok: true; generation: number; revision: number }
  | { ok: false; retryable: boolean; error?: string; conflict?: BindRecord };

/** side panel → service worker: reserve groups that selectPlaying confirmed for
 *  one DOM-proven Story. The worker serializes this with addMedia so a cap/quota
 *  eviction cannot race ahead of the confirmation. The pin is retention-only. */
export interface PinPlayingMediaMsg {
  type: 'FACESCRAP_PIN_PLAYING_MEDIA';
  tabId: number;
  identity: string;
  groups: string[];
  playingAt: number;
}

/** content script → service worker: discard counts and the event trace drained
 *  from the page hook and the DOM scan. Only the worker can persist them —
 *  neither the MAIN world nor a content script may write the extension's storage
 *  directly. Both payloads ride ONE message because they are drained together at
 *  the same flush point; splitting them would double the IPC for one flush and
 *  let a counter land without the events that explain it. */
interface DiagReportMsg {
  type: 'DIAG_REPORT';
  counters: DiagCounters;
  events?: DiagEvent[];
  documentToken?: string;
}

/** The global shortcut's outcome, pushed to the tab it downloaded from. The shortcut starts a
 *  download the in-page button did not, so without this a failure is indistinguishable from a
 *  keypress that never arrived; the button shows it on the glyph it already has. */
export interface ShortcutResultMsg {
  type: 'FACESCRAP_SHORTCUT_RESULT';
  ok: boolean;
}

export type RuntimeMessage =
  | MediaFoundMsg
  | NowPlayingMsg
  | FacebookThemeMsg
  | ContentScriptPingMsg
  | SettingsUpdateMsg
  | DownloadDashMsg
  | DownloadDirectMsg
  | MuxMsg
  | MuxProgressMsg
  | DashJobStartedMsg
  | RevokeMsg
  | ClearTabMsg
  | PersistBindingsMsg
  | PinPlayingMediaMsg
  | PlayingDownloadOptionsMsg
  | RequestPlayingDownloadMsg
  | DiagReportMsg
  | ShortcutResultMsg;
