/**
 * Bridge adapter: listens for `mcp:request` events relayed by the Rust bridge,
 * executes them against the live tldraw editor, and replies via `bridge_reply`.
 * This is the only place the WebView talks to the MCP world.
 */
import type { Editor } from "tldraw";
import type { BridgeError } from "@cutting-board/protocol";
import { onMcpRequest, bridgeReply, notifyAdapterReady, type McpRequestEvent } from "../lib/ipc";
import { executeBridgeOp, BridgeOpError } from "../board/tldraw-ops";

/**
 * Map a thrown error to the wire `BridgeError`: a {@link BridgeOpError} keeps its
 * specific code; anything else collapses to `internal`. Exported for testing.
 */
export function toBridgeError(err: unknown): BridgeError {
  if (err instanceof BridgeOpError) return { code: err.code, message: err.message };
  return { code: "internal", message: err instanceof Error ? err.message : String(err) };
}

/**
 * Wire an editor to the bridge. Returns a disposer that stops listening.
 * Safe to call once per editor lifetime.
 */
export async function registerBridgeAdapter(editor: Editor): Promise<() => void> {
  const handle = async (req: McpRequestEvent): Promise<void> => {
    try {
      const result = await executeBridgeOp(editor, req.method, req.params ?? {});
      await bridgeReply({ id: req.id, ok: true, result });
    } catch (err) {
      await bridgeReply({ id: req.id, ok: false, error: toBridgeError(err) });
    }
  };

  const unlisten = await onMcpRequest((req) => void handle(req));
  await notifyAdapterReady();
  return unlisten;
}
