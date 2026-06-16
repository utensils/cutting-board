/**
 * The "Done" actions, shared by the split-button and the ⌘⏎ keyboard shortcut
 * so they can never diverge.
 */
import type { Editor } from "tldraw";
import { copyBoardToClipboard } from "./clipboard";
import { clearBoard } from "./tldraw-ops";
import { hideMainWindow, clearSavedBoard } from "../lib/ipc";

export type DoneVariant = "dismiss" | "discard" | "keep";

/**
 * Copy the board to the clipboard, then apply the variant's window/board action:
 * - dismiss: hide the window, keep the board (default).
 * - discard: clear the board + delete the autosave, then hide.
 * - keep:    copy only, leave the window open.
 *
 * Returns "empty" without side effects when there is nothing to copy.
 */
export async function performDone(
  editor: Editor,
  variant: DoneVariant,
  exportScale: number,
): Promise<"copied" | "empty"> {
  const copied = await copyBoardToClipboard(editor, exportScale);
  if (!copied) return "empty";

  if (variant === "discard") {
    clearBoard(editor);
    await clearSavedBoard();
  }
  if (variant !== "keep") {
    await hideMainWindow();
  }
  return "copied";
}
