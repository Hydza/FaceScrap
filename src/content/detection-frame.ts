export interface FrameCoalescer {
  request(): void;
  cancel(): void;
}

/**
 * Collapse a burst of equivalent DOM signals into one read on the next frame.
 * The caller supplies the browser scheduler so this helper stays deterministic
 * in unit tests and can fall back to setTimeout in partial DOM environments.
 */
export function createFrameCoalescer(
  run: () => void,
  requestFrame: (callback: () => void) => number,
  cancelFrame: (handle: number) => void,
): FrameCoalescer {
  let pending: number | undefined;

  return {
    request(): void {
      if (pending !== undefined) return;
      pending = requestFrame(() => {
        pending = undefined;
        run();
      });
    },
    cancel(): void {
      if (pending === undefined) return;
      const handle = pending;
      pending = undefined;
      cancelFrame(handle);
    },
  };
}
