import {
  isFbcdn,
  isStaticFbAsset,
  makeItem,
  MAX_MEDIA_DIMENSION,
  MAX_MEDIA_URL_LEN,
  type MediaItem,
  type MediaSource,
} from '../shared/media';

export interface VisibleMediaSignal {
  hasVideo: boolean;
  videoUrl?: string;
  videoHeight?: number;
  imageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
}

function naturalDimension(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_MEDIA_DIMENSION
    ? value
    : undefined;
}

/**
 * Convert only the media proven visible at the viewport centre into a capture.
 * A blob video deliberately suppresses its poster here: the poster is evidence
 * for that video, not a standalone photo.
 */
export function visibleMediaCandidate(
  signal: VisibleMediaSignal,
  source: MediaSource,
  now: number,
): MediaItem | undefined {
  if (signal.hasVideo) {
    const url = signal.videoUrl;
    if (
      url == null ||
      url.length > MAX_MEDIA_URL_LEN ||
      url.startsWith('blob:') ||
      !isFbcdn(url) ||
      isStaticFbAsset(url)
    ) {
      return undefined;
    }
    const item = makeItem(url, 'video', source, 'dom', now);
    const height = naturalDimension(signal.videoHeight);
    if (height != null) item.height = height;
    return item;
  }

  const url = signal.imageUrl;
  if (url == null || url.length > MAX_MEDIA_URL_LEN || !isFbcdn(url) || isStaticFbAsset(url)) {
    return undefined;
  }
  const item = makeItem(url, 'image', source, 'dom', now);
  const width = naturalDimension(signal.imageWidth);
  const height = naturalDimension(signal.imageHeight);
  if (width != null) item.width = width;
  if (height != null) item.height = height;
  return item;
}
