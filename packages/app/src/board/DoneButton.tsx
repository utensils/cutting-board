import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, useValue } from "tldraw";
import { useBoardConfig } from "./BoardConfigContext";
import { performDone, type DoneVariant } from "./actions";

/**
 * The custom "Done" split-button, rendered into tldraw's SharePanel slot.
 * Primary action copies + dismisses; the caret opens discard / keep-open.
 */
export function DoneButton() {
  const editor = useEditor();
  const { exportScale } = useBoardConfig();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const isEmpty = useValue("cb-empty", () => editor.getCurrentPageShapeIds().size === 0, [editor]);

  const run = useCallback(
    async (variant: DoneVariant) => {
      if (busy) return;
      setOpen(false);
      setBusy(true);
      try {
        const result = await performDone(editor, variant, exportScale);
        if (result === "copied" && variant === "keep") {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }
      } catch (err) {
        console.error("[cutting-board] Done failed:", err);
      } finally {
        setBusy(false);
      }
    },
    [busy, editor, exportScale],
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const disabled = busy || isEmpty;

  return (
    <div className="cb-done" ref={ref}>
      <button
        className="cb-done__main"
        disabled={disabled}
        onClick={() => run("dismiss")}
        title="Copy to clipboard and hide — the board is kept (⌘⏎)"
      >
        {copied ? "Copied!" : busy ? "Copying…" : "Done"}
      </button>
      <button
        className="cb-done__caret"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More copy options"
        onClick={() => setOpen((v) => !v)}
      >
        ▾
      </button>
      {open && (
        <div className="cb-done__menu" role="menu">
          <button role="menuitem" onClick={() => run("dismiss")}>
            Copy &amp; Dismiss
          </button>
          <button role="menuitem" onClick={() => run("discard")}>
            Copy &amp; Discard
          </button>
          <button role="menuitem" onClick={() => run("keep")}>
            Copy &amp; Keep Open
          </button>
        </div>
      )}
    </div>
  );
}
