/**
 * captureVisibleTab photographs whichever tab is active in the window. Checking the tab only before and after is not
 * enough: someone could switch away and back inside the capture. This records ANY tab activation while it is running,
 * so the result can be thrown away.
 */
export interface ActivationWatch {
  changed(): boolean;
  stop(): void;
}

export function watchActivation(): ActivationWatch {
  let changed = false;
  const on = () => {
    changed = true;
  };
  const ev = (globalThis as any).chrome?.tabs?.onActivated;
  ev?.addListener?.(on);
  return {
    changed: () => changed,
    stop: () => ev?.removeListener?.(on),
  };
}
