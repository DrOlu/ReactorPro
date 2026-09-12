import { startTransition, useCallback, useRef, useState } from "react";

// Base UI's Dialog does not enter starting-style when open is already true at mount (no enter transition),
// and unmounting Root directly on close also loses ending-style (no exit transition).
// The drawer therefore must stay mounted: open is driven by "whether there is content"; after close the
// parent immediately clears the content, and here we keep the last snapshot to finish rendering the exit
// animation (onOpenChangeComplete(false)) before releasing.
// entered becomes true only after the enter animation completes; callers use a skeleton to stand in for
// heavy content first, avoiding dropped frames during the animation.
export function useDrawerPresence<T>(current: T | null): {
  open: boolean;
  snapshot: T | null;
  entered: boolean;
  handleOpenChangeComplete: (nextOpen: boolean) => void;
} {
  const open = current !== null;
  const retainedRef = useRef<T | null>(null);
  if (current !== null) {
    retainedRef.current = current;
  }
  const [entered, setEntered] = useState(false);
  const handleOpenChangeComplete = useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      startTransition(() => setEntered(true));
    } else {
      retainedRef.current = null;
      setEntered(false);
    }
  }, []);
  return {
    open,
    snapshot: current ?? retainedRef.current,
    entered,
    handleOpenChangeComplete,
  };
}
