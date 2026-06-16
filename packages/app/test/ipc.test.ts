import { describe, it, expect, afterEach } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import * as ipc from "../src/lib/ipc";

afterEach(() => clearMocks());

/** Capture every invoke() the wrappers make, returning safe defaults. */
function recordCalls() {
  const calls: Array<{ cmd: string; args: unknown }> = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "get_settings" || cmd === "set_settings") {
      return { hotkey: "CmdOrCtrl+Shift+Space", autoHideOnBlur: false, exportScale: 2 };
    }
    return undefined;
  });
  return calls;
}

describe("ipc command wrappers", () => {
  it("copyPngToClipboard sends the bytes as a number[] under `png`", async () => {
    const calls = recordCalls();
    await ipc.copyPngToClipboard(new Uint8Array([1, 2, 3]));
    expect(calls).toEqual([{ cmd: "copy_png_to_clipboard", args: { png: [1, 2, 3] } }]);
  });

  it("setSettings wraps the settings object", async () => {
    const calls = recordCalls();
    const s = { hotkey: "CmdOrCtrl+Alt+B", autoHideOnBlur: true, exportScale: 3 };
    await ipc.setSettings(s);
    expect(calls[0]).toEqual({ cmd: "set_settings", args: { settings: s } });
  });

  it("saveBoard sends the snapshot string", async () => {
    const calls = recordCalls();
    await ipc.saveBoard("{}");
    expect(calls[0]).toEqual({ cmd: "save_board", args: { snapshot: "{}" } });
  });

  it("bridgeReply forwards id/ok/result", async () => {
    const calls = recordCalls();
    await ipc.bridgeReply({ id: "r1", ok: true, result: { id: "shape:x" } });
    expect(calls[0]).toEqual({
      cmd: "bridge_reply",
      args: { id: "r1", ok: true, result: { id: "shape:x" } },
    });
  });

  it("no-arg commands invoke the right names", async () => {
    const calls = recordCalls();
    await ipc.loadBoard();
    await ipc.clearSavedBoard();
    await ipc.hideMainWindow();
    await ipc.notifyAdapterReady();
    expect(calls.map((c) => c.cmd)).toEqual([
      "load_board",
      "clear_saved_board",
      "hide_main_window",
      "notify_adapter_ready",
    ]);
  });

  it("readClipboardImage returns the base64 from Rust", async () => {
    mockIPC((cmd) => (cmd === "read_clipboard_image" ? "AAAA" : undefined));
    await expect(ipc.readClipboardImage()).resolves.toBe("AAAA");
  });
});
