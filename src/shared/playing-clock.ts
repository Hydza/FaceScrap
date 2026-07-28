// The now-playing boundary's clock policy: how the content script mints a detector
// timestamp, and what makes one arriving at the worker believable.
//
// A leaf on purpose — no local imports. The storage layer enforces the monotonic
// boundary with these rules on every read and write, and it must not have to reach
// into the protocol module to do it: the timestamp is the policy, NOW_PLAYING is
// only what carries it.

// Preserve the detector's real boundary through ordinary renderer/IPC stalls.
// A delayed but valid timestamp is much safer than re-stamping it at receipt,
// which would make neighbour traffic look post-slide. The storage layer also
// rejects an older boundary once a newer one has landed for the same tab.
const MAX_PLAYING_MESSAGE_DELAY_MS = 30_000;
const MAX_PLAYING_FUTURE_SKEW_MS = 1_000;
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
