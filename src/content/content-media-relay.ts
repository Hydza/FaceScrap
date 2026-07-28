// The outbound media queue: everything captured here reaches the worker through it.
//
// Acknowledged and bounded, because a capture is a one-shot event. A sleeping worker,
// a busy storage lane or a full ingress budget must not consume one, so the queue
// retries with backoff and only drops when it is genuinely over its own cap.

import { createAckedBatch } from '../shared/acked-batch';
import { exponentialBackoffMs, withTimeout } from '../shared/async';
import {
  MAX_MEDIA_BATCH_BYTES,
  mediaItemWeight,
  mergeMedia,
  type MediaItem,
} from '../shared/media';
import type { MediaFoundAck } from '../shared/messages';
import type { ContentRuntime } from './content-runtime';

const MEDIA_ACK_TIMEOUT_MS = 5_000;
const MEDIA_RETRY_BASE_MS = 500;
const MEDIA_RETRY_MAX_MS = 10_000;
const MEDIA_BATCH_MAX_ITEMS = 64;
export const MEDIA_QUEUE_MAX_ITEMS = 2_000;
export const MEDIA_QUEUE_MAX_BYTES = 8 * 1024 * 1024;

interface MediaRelay {
  relay: (items: MediaItem[]) => void;
  /** Chrome injects this script into a PRERENDERED document, but the worker only
   *  accepts capture from an ACTIVE one — so a genuine capture made before activation
   *  is answered retryable:false exactly like a dead tab. Tracking it here keeps the
   *  kill switch from mistaking "not activated yet" for "dead". */
  setPrerendering: (value: boolean) => void;
  /** Activation makes an already-queued batch acceptable: reset the backoff and pump
   *  now rather than waiting out whatever interval the rejection last armed. */
  pumpNow: () => void;
}

export function setupMediaRelay(runtime: ContentRuntime, prerendering: boolean): MediaRelay {
  let isPrerendering = prerendering;
  let retryTimer: number | undefined;
  let retryFailures = 0;

  const delivery = createAckedBatch<MediaItem, string>({
    maxBatch: MEDIA_BATCH_MAX_ITEMS,
    maxPending: MEDIA_QUEUE_MAX_ITEMS,
    weight: mediaItemWeight,
    maxBatchWeight: MAX_MEDIA_BATCH_BYTES,
    maxPendingWeight: MEDIA_QUEUE_MAX_BYTES,
    splitOnFailure: true,
    rotateAfterFailures: 3,
    // Prefer the newest cards (including the one the user just opened) over old prefetches.
    overflow: 'drop-oldest',
    key: (item) => item.id,
    merge: (queued, incoming) => mergeMedia([queued], [incoming])[0][0] ?? incoming,
  });

  const deliver = async (items: readonly MediaItem[]): Promise<boolean> => {
    if (runtime.isDisposed() || !runtime.alive()) {
      runtime.teardown();
      return false;
    }
    try {
      const response = (await withTimeout(
        chrome.runtime.sendMessage({ type: 'MEDIA_FOUND', items: [...items], documentToken: runtime.documentToken }),
        MEDIA_ACK_TIMEOUT_MS,
        'MEDIA_FOUND acknowledgement timed out.',
      )) as MediaFoundAck | undefined;
      if (response?.ok === true) return true;
      // The only permanent rejection is a closed/invalid sender tab, whose content
      // context has no recovery path. A still-prerendering document is rejected the
      // identical way but is not dead — activation alone makes the very same queued
      // batch acceptable, so leave the retry loop to keep it.
      if (response?.retryable === false && !isPrerendering) runtime.teardown();
      return false;
    } catch {
      if (!runtime.alive()) runtime.teardown();
      return false;
    }
  };

  async function pump(): Promise<void> {
    // A scheduled retry owns the next attempt. Fresh page traffic may add newer work
    // behind the failed entry, but must not defeat the backoff by calling relay() again.
    if (runtime.isDisposed() || retryTimer !== undefined) return;
    const before = delivery.pending;
    const drained = await delivery.pump(deliver);
    if (drained || runtime.isDisposed() || delivery.pending === 0) {
      retryFailures = 0;
      return;
    }
    // Concurrent callers share AckedBatch's one pump. Only the first continuation
    // schedules; the rest see this timer and return.
    if (retryTimer !== undefined) return;
    retryFailures = delivery.pending < before ? 0 : Math.min(retryFailures + 1, 16);
    const retryMs = exponentialBackoffMs(retryFailures - 1, MEDIA_RETRY_BASE_MS, MEDIA_RETRY_MAX_MS);
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined;
      void pump();
    }, retryMs);
  }

  runtime.onTeardown(() => {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
  });

  return {
    relay: (items) => {
      if (items.length === 0) return;
      const result = delivery.enqueueMany(items);
      if (result.dropped > 0) console.warn(`[FaceScrap] media relay queue dropped ${result.dropped} items`);
      void pump();
    },
    setPrerendering: (value) => {
      isPrerendering = value;
    },
    pumpNow: () => {
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      retryFailures = 0;
      void pump();
    },
  };
}
