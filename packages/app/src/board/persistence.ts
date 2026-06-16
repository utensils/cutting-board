/**
 * Board persistence. The single retained board is autosaved (throttled) to a
 * file on the Rust side and restored on mount, so it survives app restarts
 * and the "Copy & Dismiss" flow.
 */
import { type Editor, getSnapshot, loadSnapshot } from "tldraw";
import { loadBoard, saveBoard } from "../lib/ipc";

/** Restore the previously saved board, if any. */
export async function loadSavedBoard(editor: Editor): Promise<void> {
  const json = await loadBoard();
  if (!json) return;
  try {
    const snapshot = JSON.parse(json);
    loadSnapshot(editor.store, snapshot);
  } catch (err) {
    console.error("[cutting-board] failed to restore saved board:", err);
  }
}

/**
 * Persist the document (not camera/selection) whenever the user changes it,
 * throttled. Returns a disposer.
 */
export function installAutosave(editor: Editor, throttleMs = 800): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    const { document } = getSnapshot(editor.store);
    void saveBoard(JSON.stringify({ document })).catch((err) =>
      console.error("[cutting-board] autosave failed:", err),
    );
  };

  const unlisten = editor.store.listen(
    () => {
      if (timer === null) timer = setTimeout(flush, throttleMs);
    },
    { source: "user", scope: "document" },
  );

  return () => {
    if (timer !== null) clearTimeout(timer);
    unlisten();
  };
}
