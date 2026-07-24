export interface PlayCenterInput {
  frameWidth: number;
  frameHeight: number;
  mediaWidth?: number;
  mediaHeight?: number;
  fit: 'contain' | 'cover';
  unobscuredBottom?: number;
  badgeSize: number;
  clearance: number;
}

export interface PlayPositionBatcher<T> {
  /** Omit target for a global layout pass; otherwise only queued targets flush. */
  schedule(target?: T): void;
}

/** Coalesce thumbnail loads into one frame without turning them into a global scan. */
export function createPlayPositionBatcher<T>(
  requestFrame: (callback: () => void) => number,
  flush: (targets: readonly T[] | null) => void,
): PlayPositionBatcher<T> {
  let framePending = false;
  let globalPass = false;
  const pendingTargets = new Set<T>();

  return {
    schedule(target?: T): void {
      if (target === undefined) {
        globalPass = true;
        pendingTargets.clear();
      } else if (!globalPass) {
        pendingTargets.add(target);
      }

      if (framePending) return;
      framePending = true;
      requestFrame(() => {
        framePending = false;
        const targets = globalPass ? null : [...pendingTargets];
        globalPass = false;
        pendingTargets.clear();
        flush(targets);
      });
    },
  };
}

function positive(value: number | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

/** Center a play badge inside the visible media that remains above UI content. */
export function computePlayCenterY(input: PlayCenterInput): number | null {
  const { frameWidth, frameHeight, mediaWidth, mediaHeight, fit, badgeSize, clearance } = input;
  if (!positive(frameWidth) || !positive(frameHeight) || !positive(badgeSize) || clearance < 0) return null;

  let mediaTop = 0;
  let mediaBottom = frameHeight;
  if (fit === 'contain' && positive(mediaWidth) && positive(mediaHeight)) {
    const scale = Math.min(frameWidth / mediaWidth, frameHeight / mediaHeight);
    const renderedHeight = mediaHeight * scale;
    mediaTop = (frameHeight - renderedHeight) / 2;
    mediaBottom = mediaTop + renderedHeight;
  }

  const unobscuredBottom = Number.isFinite(input.unobscuredBottom)
    ? Math.max(0, Math.min(frameHeight, input.unobscuredBottom!))
    : frameHeight;
  const visibleTop = Math.max(0, mediaTop);
  const visibleBottom = Math.min(frameHeight, mediaBottom, unobscuredBottom);
  const radius = badgeSize / 2;

  if (visibleBottom - visibleTop < badgeSize + clearance * 2) return null;
  const center = (visibleTop + visibleBottom) / 2;
  return Math.max(visibleTop + radius + clearance, Math.min(visibleBottom - radius - clearance, center));
}
