# Manual test checklist

Per-release smoke test for the OS-level behaviors that **can't** be unit-tested.
Run through this against a release build (`pnpm tauri:build`) on real hardware
before tagging a release. Unit/integration tests cover the rest (`pnpm test`
and `cargo test --manifest-path packages/app/src-tauri/Cargo.toml`).

## Global hotkey

- [ ] With another app focused (e.g. a browser or terminal), pressing the
      hotkey (default `⌘⇧Space`) brings the board to the front and focuses it.
- [ ] Pressing the hotkey again while the board is visible dismisses it.
- [ ] No macOS Accessibility / Input-Monitoring permission prompt appears.
- [ ] If the chosen combo is taken by another app, the board does **not** toggle
      (silent), and the tray "Open Cutting Board" item still works.

## Menu-bar tray

- [ ] The tray icon is present in the menu bar.
- [ ] Left-clicking the tray icon toggles the board.
- [ ] Tray menu shows **Open Cutting Board**, **Settings…**, **Quit**.
- [ ] **Open Cutting Board** toggles the window.
- [ ] **Settings…** opens the in-window settings panel.
- [ ] **Quit** exits the app and removes the tray icon.

## Done variants → clipboard (paste targets)

For each variant, confirm a PNG actually lands on the clipboard and pastes
correctly into both **Slack** and **Preview** (File → New from Clipboard).

- [ ] **Copy & Dismiss** (primary click and **⌘⏎**): copies, hides the window;
      reopening shows the board still present.
- [ ] **Copy & Discard** (caret menu): copies, then the board is empty on reopen
      (autosave deleted).
- [ ] **Copy & Keep Open** (caret menu): copies, window stays open; button shows
      a brief "Copied!" confirmation.
- [ ] Pasted PNG is crisp at the configured export scale and has no clipping.
- [ ] **Done** is disabled when the board is empty (nothing to copy).

## Paste-in image

- [ ] Take a screenshot to the clipboard (e.g. `⌘⇧⌃4`), then press **⌘⇧V** on the
      board — the image appears centered, scaled to fit, and selected.
- [ ] A plain paste (`⌘V`) of a clipboard image also places it on the board.
- [ ] Pasting with no image on the clipboard does nothing (no crash/error).

## Dismiss without copying

- [ ] **Esc** hides the window **without** copying anything to the clipboard.
- [ ] After Esc, reopening shows the board unchanged (kept).
- [ ] **Esc** while editing a shape's text cancels editing (does not dismiss).
- [ ] **Esc** with the settings panel open closes the panel (does not dismiss).

## Persistence

- [ ] Draw shapes, hide via the hotkey, reopen — the board is unchanged.
- [ ] Draw shapes, **Quit** the app, relaunch — the board is restored.
- [ ] After **Copy & Discard** then relaunch, the board is empty.

## Settings

- [ ] Rebind the global hotkey to a new chord; **Save**; the old hotkey no
      longer toggles and the new one does (no relaunch needed).
- [ ] Invalid chord (no modifier) shows the validation error and blocks Save.
- [ ] Toggle "Hide automatically when the window loses focus": with it on,
      clicking another app hides the board; with it off, the board stays.
- [ ] Change export resolution (1×/2×/3×); a subsequent Done produces a
      PNG at the expected pixel scale.
- [ ] Settings survive an app relaunch.

## Multi-monitor

- [ ] With multiple displays, open the board while the cursor is on a secondary
      monitor — the window centers on **that** monitor.
- [ ] Move the cursor to the other monitor and reopen — it centers there.

## MCP round-trip

(Build + register per [`mcp.md`](./mcp.md); app must be running.)

- [ ] Register the server with `claude mcp add … node …/dist/index.js`; it
      connects.
- [ ] `get_board_image` returns an image of the current board.
- [ ] `add_sticky` (e.g. yellow, with text) — the sticky appears **live** on the
      board without reopening.
- [ ] `add_shape` ×2 then `add_connector` between them — moving one shape
      re-routes the arrow.
- [ ] With the app **not** running (and `CUTTING_BOARD_AUTO_LAUNCH` unset), a
      tool call returns a friendly "isn't running" error rather than crashing.
