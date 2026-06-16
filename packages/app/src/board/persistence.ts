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
 * Cancellers for any pending (throttled) autosave write, keyed by editor. Lets
 * the "Copy & Discard" flow stop a scheduled write before it resurrects the
 * file it just deleted.
 */
const pendingCancellers = new WeakMap<Editor, () => void>();

/** Cancel a scheduled-but-not-yet-written autosave for this editor, if any. */
export function cancelPendingAutosave(editor: Editor): void {
  pendingCancellers.get(editor)?.();
}

/**
 * Persist the document (not camera/selection) whenever the user changes it,
 * throttled. Returns a disposer.
 */
export function installAutosave(editor: Editor, throttleMs = 800): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

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

  pendingCancellers.set(editor, cancel);

  return () => {
    cancel();
    unlisten();
    pendingCancellers.delete(editor);
  };
}
