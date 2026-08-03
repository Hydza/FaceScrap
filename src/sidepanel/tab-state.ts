// What the panel remembers per tab.
//
// Key by tab because content-derived ids can collide across tabs. Preserve state
// across tab switches so in-flight downloads remain busy.
//
// All `const`: an ES import is a read-only binding, so a `let` could not be
// reassigned from another module. That is why the panel's own flags (bulkRunning,
// offscreenAvailable) stay in sidepanel.ts.

export const tabKey = (tid: number | undefined, id: string): string => `${tid ?? -1}:${id}`;

/** Downloads in flight. Any entry — any tab's — holds this panel's bulk tray closed;
 *  both paths drive the same offscreen document. */
export const cardBusy = new Set<string>();

/** cardKey → why the last attempt failed, shown as a tooltip on the card's tag. The
 *  key's presence is the "failed" flag: every producer returns a non-empty reason. */
export const failReason = new Map<string, string>();

/** tabKey(tab, videoGroupKey) → chosen item id, so a re-render does not reset the
 *  Now Playing selector, and a pick in one tab never leaks into another. */
export const qualityChoice = new Map<string, string>();

/** Per-tab counter, bumped by pruneTabState, never deleted — a closed tab's bump must
 *  stay visible to a download still draining. */
const tabResetGen = new Map<number, number>();

export const resetGen = (tid: number | undefined): number =>
  tid === undefined ? 0 : (tabResetGen.get(tid) ?? 0);

/**
 * Drop one tab's entries after its media was wiped, its list cleared, or the tab
 * closed — otherwise recapturing the same content-derived id inherits a stale failure
 * tag or quality pick. Two asymmetries are deliberate:
 *
 * - cardBusy is untouched: an in-flight download owns its entry and clears it itself.
 * - The generation bump stops a download settling AFTER the prune from re-seeding
 *   failReason, where it would resurface as a phantom tag. Settle paths snapshot
 *   resetGen at start and skip their write if it moved.
 */
export function pruneTabState(tid: number): void {
  tabResetGen.set(tid, (tabResetGen.get(tid) ?? 0) + 1);
  const prefix = `${tid}:`;
  for (const k of [...failReason.keys()]) if (k.startsWith(prefix)) failReason.delete(k);
  for (const k of [...qualityChoice.keys()]) if (k.startsWith(prefix)) qualityChoice.delete(k);
}
