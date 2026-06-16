/**
 * Typed wrappers around the app-internal Tauri IPC surface.
 *
 * Every command/event name from docs/app-ipc.md lives here exactly once, so the
 * rest of the frontend never hard-codes a string and tests can mock one module.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { BridgeError } from "@cutting-board/protocol";

/** Mirrors the Rust `Settings` struct (serde camelCase). */
export interface Settings {
  hotkey: string;
  autoHideOnBlur: boolean;
  exportScale: number;
}

// --- Commands (frontend → Rust) --------------------------------------------

export const getSettings = () => invoke<Settings>("get_settings");

export const setSettings = (settings: Settings) =>
  invoke<Settings>("set_settings", { settings });

export const loadBoard = () => invoke<string | null>("load_board");

export const saveBoard = (snapshot: string) =>
  invoke<void>("save_board", { snapshot });

export const clearSavedBoard = () => invoke<void>("clear_saved_board");

/** Bytes must already be PNG-encoded; Rust writes them to the pasteboard verbatim. */
export const copyPngToClipboard = (png: Uint8Array) =>
  invoke<void>("copy_png_to_clipboard", { png: Array.from(png) });

/** Returns a base64 PNG (no `data:` prefix) of the current clipboard image, or null. */
export const readClipboardImage = () => invoke<string | null>("read_clipboard_image");

export const hideMainWindow = () => invoke<void>("hide_main_window");

export const notifyAdapterReady = () => invoke<void>("notify_adapter_ready");

export const bridgeReply = (payload: {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: BridgeError;
}) => invoke<void>("bridge_reply", payload);

// --- Events (Rust → frontend) ----------------------------------------------

export interface McpRequestEvent {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export const onMcpRequest = (cb: (e: McpRequestEvent) => void): Promise<UnlistenFn> =>
  listen<McpRequestEvent>("mcp:request", (ev) => cb(ev.payload));

export const onOpenSettings = (cb: () => void): Promise<UnlistenFn> =>
  listen("ui:open-settings", () => cb());

export const onWindowShown = (cb: () => void): Promise<UnlistenFn> =>
  listen("window:shown", () => cb());
