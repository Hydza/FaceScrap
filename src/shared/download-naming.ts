// Download filename and Saved-receipt construction.
//
// Both of these used to be panel-only, which was fine while the panel was the
// only thing that could start a download. The in-page button routes through the
// SERVICE WORKER instead (a content script may not hand the downloader a URL —
// see the FACESCRAP_DOWNLOAD_DASH handler), so the worker has to build the same
// filename and the same receipt. Sharing them is what keeps the two entry points
// from writing different names for the same media, or two Saved rows for one
// download because their card ids disagreed.

import { fileExtensionFor, resolutionOf, type MediaItem } from './media';
import { DEFAULT_SETTINGS, type Settings } from './settings';
import type { SavedEntry } from './storage';

/** Card id namespaces. Group keys and item ids are separate namespaces that must
 *  never collide, and the receipt id IS the card id — so the worker has to derive
 *  it exactly the way the panel does or Saved ends up with two rows for one
 *  download. */
export const videoCardId = (gkey: string): string => `v:${gkey}`;
export const itemCardId = (itemId: string): string => `i:${itemId}`;

export function downloadFilename(
  item: MediaItem,
  settings: Pick<Settings, 'filenameTemplate' | 'subfolder'>,
): string {
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
  const name = `${base}.${fileExtensionFor(item)}`;
  return settings.subfolder ? `FaceScrap/${name}` : name;
}

/** Cover and duration the caller may already know better than the item does —
 *  the panel reads them off its card model, the worker off videoOptions(). */
interface ReceiptHints {
  thumbUrl?: string;
  durationSec?: number;
}

export function savedEntryForItem(
  cardId: string,
  item: MediaItem,
  hints: ReceiptHints = {},
  now: number = Date.now(),
): SavedEntry {
  return {
    id: cardId,
    kind: item.kind,
    source: item.source,
    savedAt: now,
    thumbUrl: hints.thumbUrl ?? (item.kind === 'image' ? item.url : item.thumbUrl),
    resLabel: item.kind === 'video' ? resolutionOf(item).label : undefined,
    durationSec: hints.durationSec ?? item.durationSec,
  };
}
