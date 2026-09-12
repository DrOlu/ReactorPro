import { useEffect } from "react";

function dragEventHasFiles(event: globalThis.DragEvent) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/**
 * The browser's default behavior for an unhandled file drop is to open the
 * file directly in the current tab, which is equivalent to losing the entire
 * app state. Declared drop zones (the chat panel, the sidebar workspace area)
 * handle the event and preventDefault before window does; this only catches
 * every other drop target.
 */
export function useWindowFileDropGuard() {
  useEffect(() => {
    const handleDragOver = (event: globalThis.DragEvent) => {
      if (!dragEventHasFiles(event) || event.defaultPrevented) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "none";
      }
    };
    const handleDrop = (event: globalThis.DragEvent) => {
      if (!dragEventHasFiles(event) || event.defaultPrevented) return;
      event.preventDefault();
    };

    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("drop", handleDrop);
    return () => {
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("drop", handleDrop);
    };
  }, []);
}
