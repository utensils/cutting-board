/**
 * Clipboard helpers. Writing goes through Rust (`copy_png_to_clipboard`) so the
 * PNG lands on the macOS pasteboard with a real PNG type; reading also goes
 * through Rust because WKWebView's clipboard image reads are unreliable.
 */
import { type Editor, AssetRecordType, createShapeId } from "tldraw";
import { copyPngToClipboard, readClipboardImage } from "../lib/ipc";
import { exportBoardPng } from "./tldraw-ops";

/** Export the board and copy it to the clipboard. Returns false if empty. */
export async function copyBoardToClipboard(editor: Editor, scale: number): Promise<boolean> {
  const exported = await exportBoardPng(editor, { scale });
  if (!exported) return false;
  await copyPngToClipboard(exported.bytes);
  return true;
}

function loadImageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("failed to decode clipboard image"));
    img.src = src;
  });
}

/**
 * Read an image from the system clipboard (via Rust) and place it on the board,
 * scaled to fit. Returns false when the clipboard holds no image. The image is
 * embedded as a data URL so it survives board persistence.
 */
export async function pasteImageFromClipboard(editor: Editor): Promise<boolean> {
  const b64 = await readClipboardImage();
  if (!b64) return false;

  const src = `data:image/png;base64,${b64}`;
  const { width, height } = await loadImageSize(src);

  const MAX = 600;
  const scale = Math.min(1, MAX / Math.max(width, height));
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const center = editor.getViewportPageBounds().center;

  const assetId = AssetRecordType.createId();
  const shapeId = createShapeId();
  editor.run(() => {
    editor.createAssets([
      {
        id: assetId,
        type: "image",
        typeName: "asset",
        props: {
          name: "pasted.png",
          src,
          w: width,
          h: height,
          mimeType: "image/png",
          isAnimated: false,
        },
        meta: {},
      },
    ]);
    editor.createShape({
      id: shapeId,
      type: "image",
      x: center.x - w / 2,
      y: center.y - h / 2,
      props: { assetId, w, h },
    });
  });
  editor.select(shapeId);
  return true;
}
