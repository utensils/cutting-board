import { Tldraw, type Editor, type TLComponents } from "tldraw";
import "tldraw/tldraw.css";
import { useCallback, useEffect, useRef } from "react";
import { DoneButton } from "./DoneButton";
import { BoardConfigContext } from "./BoardConfigContext";
import { installAutosave, loadSavedBoard } from "./persistence";
import { registerBridgeAdapter } from "../bridge/adapter";

// Single-board capture tool: keep the Done button, drop the multi-page menu.
const components: TLComponents = { SharePanel: DoneButton, PageMenu: null };

// Optional tldraw license key removes the watermark; unset = free watermarked build.
const licenseKey = import.meta.env.VITE_TLDRAW_LICENSE_KEY;

export interface BoardProps {
  exportScale: number;
  onEditorReady?: (editor: Editor) => void;
}

export function Board({ exportScale, onEditorReady }: BoardProps) {
  const disposers = useRef<Array<() => void>>([]);
  const unmounted = useRef(false);

  const handleMount = useCallback(
    (editor: Editor) => {
      onEditorReady?.(editor);
      void (async () => {
        await loadSavedBoard(editor);
        const stopAutosave = installAutosave(editor);
        const stopBridge = await registerBridgeAdapter(editor);
        // If the board unmounted while the awaits were pending, dispose now —
        // the cleanup effect already ran against an empty list.
        if (unmounted.current) {
          stopAutosave();
          stopBridge();
          return;
        }
        disposers.current.push(stopAutosave, stopBridge);
      })();
    },
    [onEditorReady],
  );

  useEffect(
    () => () => {
      unmounted.current = true;
      disposers.current.forEach((dispose) => dispose());
      disposers.current = [];
    },
    [],
  );

  return (
    <BoardConfigContext.Provider value={{ exportScale }}>
      <div className="cb-board">
        <Tldraw onMount={handleMount} components={components} licenseKey={licenseKey} />
      </div>
    </BoardConfigContext.Provider>
  );
}
