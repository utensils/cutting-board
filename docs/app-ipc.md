# App-internal IPC contract

This is the Tauri command/event surface between the Rust shell
(`packages/app/src-tauri`) and the WebView frontend (`packages/app/src`). It is
distinct from the [bridge protocol](./bridge-protocol.md) (which is the
MCP-server ↔ app channel). Both the Rust side and the frontend must agree on
these names exactly.

## Commands (frontend → Rust, via `invoke`)

| command                  | args                                                      | returns                 | purpose |
| ------------------------ | --------------------------------------------------------- | ----------------------- | ------- |
| `get_settings`           | —                                                         | `Settings`              | Read persisted settings. |
| `set_settings`           | `{ settings: Settings }`                                  | `Settings`              | Persist settings; re-registers the global hotkey if it changed. Returns the effective settings. |
| `load_board`             | —                                                         | `string \| null`        | Read the autosaved tldraw snapshot JSON (`board.tldr`), or null. |
| `save_board`             | `{ snapshot: string }`                                    | `void`                  | Write the tldraw snapshot JSON (called throttled by the frontend). |
| `clear_saved_board`      | —                                                         | `void`                  | Delete the autosaved snapshot (used by "Copy & Discard"). |
| `copy_png_to_clipboard`  | `{ png: number[] }`                                       | `void`                  | Write PNG bytes to the macOS pasteboard as `NSPasteboardTypePNG`. |
| `read_clipboard_image`   | —                                                         | `string \| null`        | Return the current clipboard image as a base64 PNG (no `data:` prefix), or null. |
| `hide_main_window`       | —                                                         | `void`                  | Hide the board window (Done variants, Esc). |
| `notify_adapter_ready`   | —                                                         | `void`                  | The frontend calls this once the tldraw editor + bridge adapter are mounted. |
| `bridge_reply`           | `{ id: string, ok: boolean, result?: unknown, error?: { code: string, message: string } }` | `void` | The bridge adapter returns the result of an `mcp:request`. |

`Settings` (serde `rename_all = "camelCase"`):

```ts
interface Settings {
  /** Global hotkey accelerator, e.g. "CmdOrCtrl+Shift+Space". */
  hotkey: string;
  /** Auto-hide the board when it loses focus. Default false. */
  autoHideOnBlur: boolean;
  /** PNG export resolution multiplier (1–3). Default 2. */
  exportScale: number;
}
```

## Events (Rust → frontend, via `emit`)

| event              | payload                                          | purpose |
| ------------------ | ------------------------------------------------ | ------- |
| `mcp:request`      | `{ id: string, method: string, params: object }` | A bridge request to execute against the live editor; the adapter replies with the `bridge_reply` command. |
| `ui:open-settings` | —                                                | Tray "Settings" was chosen; the frontend opens the settings panel. |
| `window:shown`     | —                                                | The window was just shown (the frontend can focus the canvas). |

## Notes

- The frontend opens settings as an in-window panel (no second window), driven
  by `ui:open-settings`.
- `copy_png_to_clipboard` takes the tldraw PNG export bytes verbatim; the Rust
  side does NOT re-encode (the bytes are already PNG).
- The global hotkey is owned entirely by Rust; the frontend only captures a
  desired accelerator string in the settings panel and sends it via
  `set_settings`.
