import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "tldraw";
import { Board } from "./board/Board";
import { SettingsPanel } from "./settings/SettingsPanel";
import { useSettings } from "./settings/useSettings";
import { performDone } from "./board/actions";
import { pasteImageFromClipboard } from "./board/clipboard";
import { hideMainWindow, onOpenSettings, onWindowShown } from "./lib/ipc";

export default function App() {
  const { settings, update } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const editorRef = useRef<Editor | null>(null);
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  const exportScaleRef = useRef(settings.exportScale);
  exportScaleRef.current = settings.exportScale;

  const handleEditorReady = useCallback((editor: Editor) => {
    editorRef.current = editor;
  }, []);

  // Tray "Settings…" opens the panel.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onOpenSettings(() => setSettingsOpen(true)).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  // Focus the canvas when the window pops via hotkey/tray.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onWindowShown(() => editorRef.current?.focus()).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  // Global keyboard: Esc dismisses (or closes settings), ⌘⏎ = Done,
  // ⌘⇧V = force-paste a system clipboard image.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const editor = editorRef.current;
      const meta = e.metaKey || e.ctrlKey;

      if (e.key === "Escape") {
        if (settingsOpenRef.current) {
          e.preventDefault();
          setSettingsOpen(false);
          return;
        }
        if (!editor || editor.getEditingShapeId()) return; // let tldraw cancel editing
        e.preventDefault();
        e.stopPropagation();
        void hideMainWindow();
        return;
      }

      if (settingsOpenRef.current || !editor) return;

      if (meta && e.key === "Enter") {
        e.preventDefault();
        void performDone(editor, "dismiss", exportScaleRef.current).then((result) => {
          // On an empty board there's nothing to copy; still dismiss like Esc.
          if (result === "empty") void hideMainWindow();
        });
      } else if (meta && e.shiftKey && e.code === "KeyV") {
        e.preventDefault();
        void pasteImageFromClipboard(editor);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // Paste: when WKWebView exposes no web clipboard data (the usual image case),
  // route the system clipboard image through Rust.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const editor = editorRef.current;
      if (!editor || settingsOpenRef.current) return;
      const types = Array.from(e.clipboardData?.types ?? []);
      if (types.length === 0) {
        e.preventDefault();
        e.stopPropagation();
        void pasteImageFromClipboard(editor);
      }
    };
    window.addEventListener("paste", onPaste, true);
    return () => window.removeEventListener("paste", onPaste, true);
  }, []);

  return (
    <>
      {/* The window is borderless; this strip drags it (the OS title bar is gone). */}
      <div className="cb-drag" data-tauri-drag-region title="Drag to move" />
      <Board exportScale={settings.exportScale} onEditorReady={handleEditorReady} />
      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSave={async (s) => {
            await update(s);
          }}
        />
      )}
    </>
  );
}
