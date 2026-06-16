# Architecture

Cutting Board is a macOS menu-bar whiteboard. Under the hood it is **three
cooperating processes**:

1. **The Tauri (Rust) shell** — `packages/app/src-tauri`. Owns the OS surface:
   the single retained window, the menu-bar tray, the global hotkey, settings
   and board persistence, the macOS PNG clipboard integration, and the loopback
   WebSocket bridge that the MCP server drives.
2. **The WebView frontend** — `packages/app/src`. React 18 + TypeScript +
   [tldraw](https://tldraw.dev) 3.15, running in the system WebView (WKWebView).
   This is the actual board; it owns the tldraw `Editor`, the **Done** button,
   the in-window settings panel, paste-in, autosave, and the bridge adapter.
3. **The standalone MCP server** — `packages/mcp-server`. A Node process that
   speaks MCP over stdio to an AI client (e.g. Claude) and relays
   protocol-typed requests to the app over the loopback bridge. It is launched
   and managed by the MCP client, not by the app. See [`mcp.md`](./mcp.md).

A third workspace package, `packages/protocol`, holds the shared TypeScript
types for the bridge and is the single source of truth for those wire shapes
(the Rust side mirrors them with `serde`).

```
┌──────────────────────────────┐        ┌──────────────────────────────┐
│  AI client (e.g. Claude)      │        │  macOS                        │
│                               │        │  • menu-bar tray icon         │
│         │ stdio JSON-RPC      │        │  • NSPasteboard (clipboard)   │
│         ▼                     │        │  • global hotkey (Carbon)     │
│  MCP server (Node)            │        └──────────────┬───────────────┘
│  packages/mcp-server          │                       │
└─────────┬─────────────────────┘                       │ AppKit / OS APIs
          │ WebSocket (127.0.0.1, token-auth)            │
          ▼                                              ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  Tauri Rust shell  (packages/app/src-tauri)                   │
   │  window · tray · hotkey · settings · persistence · clipboard  │
   │  · loopback bridge server (pure relay)                        │
   └───────────────────────────┬───────────────────────────────────┘
                Tauri commands  │  Tauri events
                                ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  WebView frontend  (packages/app/src) — React + tldraw        │
   │  Board · DoneButton · SettingsPanel · paste-in · autosave     │
   │  · bridge adapter ──► tldraw Editor (the live board)          │
   └─────────────────────────────────────────────────────────────┘
```

The app-internal command/event surface between the Rust shell and the WebView is
specified in [`app-ipc.md`](./app-ipc.md); the MCP-server ↔ app channel is
specified in [`bridge-protocol.md`](./bridge-protocol.md).

## Window model

There is exactly **one retained window** (label `main`), configured in
`tauri.conf.json` as borderless (`decorations: false`), `transparent`,
`alwaysOnTop`, `skipTaskbar`, and initially `visible: false`. It is never
destroyed — closing it is intercepted (`CloseRequested` → `prevent_close` +
hide) so the board and the tldraw editor stay warm between uses.

The app's baseline is a **menu-bar-only** agent: `Info.plist` sets
`LSUIElement = true`, so at idle there is no Dock icon or App Switcher entry.
When the board is shown, the Rust shell flips the macOS activation policy to
`Regular` (so the window can reliably take key focus), and back to `Accessory`
when it is hidden. See `window.rs`.

Because the OS title bar is gone, a thin drag strip at the top of the frontend
(`data-tauri-drag-region`) moves the window.

## Key data flows

### Hotkey / tray → window

The global hotkey is registered entirely in Rust (`shortcut.rs`) via
`tauri-plugin-global-shortcut`, which uses Carbon `RegisterEventHotKey`. The
handler fires on key *press* (it ignores the release event) and calls
`window::toggle`. Showing the window centers it on the monitor under the cursor
(falling back to the primary monitor), shows it, focuses it, and emits
`window:shown` so the frontend can focus the canvas.

The menu-bar tray (`tray.rs`) provides the same toggle on a left-click, plus a
menu: **Open Cutting Board** (toggle), **Settings…** (emits `ui:open-settings`
to the frontend), and **Quit**. The tray "Open" item is the permanent fallback
if the hotkey is unavailable.

No Accessibility/Input-Monitoring permission is required (Carbon hotkeys, same
as Slack/VS Code). If the chosen accelerator is already claimed by another app,
registration fails silently and is logged; the user picks another in Settings.

### Done → PNG → clipboard

The **Done** button (and **⌘⏎**) call a shared `performDone` action so the
button and the shortcut can never diverge. It:

1. exports the current page to a PNG via tldraw at the configured export scale
   (1×–3×), returning early as a no-op if the board is empty;
2. hands the **already-encoded PNG bytes** to the Rust command
   `copy_png_to_clipboard`, which writes them to the general `NSPasteboard` as
   `NSPasteboardTypePNG` — no re-encoding, for best paste fidelity in
   Slack/Figma/Preview;
3. applies the variant: **dismiss** hides the window (board kept), **discard**
   clears the board and deletes the autosave then hides, **keep** leaves the
   window open.

All AppKit clipboard work runs on the main thread (`run_on_main_thread`), and
auto-hide-on-blur is suppressed during clipboard writes via an RAII
`SuppressGuard` so a transient focus shuffle doesn't hide the window.

### Clipboard image paste-in

**⌘⇧V**, or a plain paste with no web-clipboard data (the usual case for images
in WKWebView), routes through the Rust command `read_clipboard_image`. Rust
reads the pasteboard, preferring `NSPasteboardTypePNG` and falling back to
converting a `NSPasteboardTypeTIFF` via `NSBitmapImageRep`, and returns base64
PNG. The frontend embeds it as a data-URL image asset (so it survives
persistence) scaled to fit, centered in the viewport, and selected.

### The retained board + autosave

There is **one** board. tldraw's document snapshot is autosaved (throttled by
the frontend) to `board.tldr` via the `save_board` command, and reloaded on
mount via `load_board`. **Copy & Discard** clears the board and calls
`clear_saved_board` to delete the file. The snapshot is opaque to Rust — it just
stores the string verbatim.

Persistence locations (the app data dir,
`~/Library/Application Support/com.utensils.cutting-board/`):

| File           | Contents                                            |
| -------------- | --------------------------------------------------- |
| `board.tldr`   | the autosaved tldraw document snapshot (JSON)       |
| `settings.json`| user settings (hotkey, auto-hide, export scale)     |
| `bridge.json`  | per-launch bridge discovery (port, token, pid) — `0600`, removed on graceful shutdown |

### MCP ↔ bridge ↔ WebView ↔ editor

On launch the Rust shell binds a WebSocket server to `127.0.0.1` (starting at
port 9223, scanning upward) and writes `bridge.json` with a per-launch token.
The MCP server reads that file, connects, and authenticates. The Rust bridge is
a **pure relay**: an authenticated `request` becomes an `mcp:request` Tauri
event; the WebView's **bridge adapter** executes it against the live tldraw
`Editor` and replies via the `bridge_reply` command, which the bridge forwards
back over the socket. Only one controller is active at a time (newest
authenticated socket wins). The live tldraw store is always the source of truth,
so shape ids must be re-resolved (via `list_shapes`) rather than cached. Full
wire format: [`bridge-protocol.md`](./bridge-protocol.md).

## Packaging

The bundle (`tauri.conf.json` → `bundle`) targets `.app` and `.dmg`, category
`public.app-category.productivity`, minimum macOS 12.0, with **hardened
runtime** enabled.

It is **not** sandboxed (no App Sandbox entitlement). Cutting Board needs broad
general-pasteboard read/write to copy PNGs out and read pasted screenshots in,
and it binds a loopback WebSocket bridge for the MCP server — both of which the
App Sandbox restricts. The app is distributed outside the Mac App Store, where
the hardened runtime (not the sandbox) is the relevant notarization
requirement. There is no Accessibility/Input-Monitoring requirement because the
hotkey uses Carbon `RegisterEventHotKey`.

### Signing & notarization

Signing and notarization are **scaffolded but disabled by default** — they are
driven entirely by environment variables and stay inert until configured. To
enable, set:

- `APPLE_SIGNING_IDENTITY` — a Developer ID Application identity. For local
  sharing without a Developer ID, an ad-hoc `-` identity works (no
  notarization).

…**plus** one of the notarization credential sets:

- **Apple ID:** `APPLE_ID`, `APPLE_PASSWORD` (an *app-specific* password), and
  `APPLE_TEAM_ID`; **or**
- **App Store Connect API key:** `APPLE_API_KEY`, `APPLE_API_ISSUER`, and
  `APPLE_API_KEY_PATH`.

In CI (`.github/workflows/ci.yml`), the `test` job runs the TS + Rust suites on
macOS on every push/PR. The `bundle` job (a full, slow `tauri build`) is gated
to tags and manual dispatch, and builds an **unsigned** `.app`; the signing
`env:` block is present but commented out — uncomment it and add the credentials
above as repository secrets to produce a signed, notarized build.
