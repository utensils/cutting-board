import { Tldraw, type Editor, type TLComponents } from "tldraw";
import "tldraw/tldraw.css";
import { useCallback, useEffect, useRef } from "react";
import { DoneButton } from "./DoneButton";
import { BoardConfigContext } from "./BoardConfigContext";
import { installAutosave, loadSavedBoard } from "./persistence";
import { registerBridgeAdapter } from "../bridge/adapter";

const components: TLComponents = { SharePanel: DoneButton };

// Optional tldraw license key removes the watermark; unset = free watermarked build.
const licenseKey = import.meta.env.VITE_TLDRAW_LICENSE_KEY;

export interface BoardProps {
  exportScale: number;
  onEditorReady?: (editor: Editor) => void;
}

export function Board({ exportScale, onEditorReady }: BoardProps) {
  const disposers = useRef<Array<() => void>>([]);

  const handleMount = useCallback(
    (editor: Editor) => {
      onEditorReady?.(editor);
      void (async () => {
        await loadSavedBoard(editor);
        disposers.current.push(installAutosave(editor));
        disposers.current.push(await registerBridgeAdapter(editor));
      })();
    },
    [onEditorReady],
  );

  useEffect(
    () => () => {
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
