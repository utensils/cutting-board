import { describe, it, expect } from "vitest";
import {
  chordToAccelerator,
  normalizeKey,
  isValidAccelerator,
  prettyAccelerator,
} from "../src/lib/accelerator";
import { uint8ToBase64, base64ToUint8 } from "../src/lib/base64";
import { plainTextFromRichText } from "../src/lib/richtext";

describe("normalizeKey", () => {
  it("maps codes to Tauri key tokens", () => {
    expect(normalizeKey("KeyA")).toBe("A");
    expect(normalizeKey("Digit1")).toBe("1");
    expect(normalizeKey("Space")).toBe("Space");
    expect(normalizeKey("ArrowUp")).toBe("Up");
    expect(normalizeKey("F5")).toBe("F5");
    expect(normalizeKey("Comma")).toBe(",");
  });

  it("returns null for pure modifier keys", () => {
    expect(normalizeKey("ShiftLeft")).toBeNull();
    expect(normalizeKey("MetaRight")).toBeNull();
  });
});

describe("chordToAccelerator", () => {
  const chord = (over: Partial<Parameters<typeof chordToAccelerator>[0]>) =>
    chordToAccelerator({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, code: "KeyK", key: "k", ...over });

  it("builds modifier+key accelerators", () => {
    expect(chord({ metaKey: true, shiftKey: true })).toBe("CmdOrCtrl+Shift+K");
    expect(chord({ ctrlKey: true, altKey: true, code: "Space", key: " " })).toBe("CmdOrCtrl+Alt+Space");
  });

  it("requires a modifier except for function keys", () => {
    expect(chord({})).toBeNull();
    expect(chord({ code: "F5", key: "F5" })).toBe("F5");
  });

  it("returns null for a modifier-only chord", () => {
    expect(chord({ metaKey: true, code: "MetaLeft", key: "Meta" })).toBeNull();
  });
});

describe("isValidAccelerator", () => {
  it("requires exactly one non-modifier token", () => {
    expect(isValidAccelerator("CmdOrCtrl+Shift+Space")).toBe(true);
    expect(isValidAccelerator("CmdOrCtrl")).toBe(false);
    expect(isValidAccelerator("CmdOrCtrl+Shift")).toBe(false);
    expect(isValidAccelerator("CmdOrCtrl+A+B")).toBe(false);
  });
});

describe("prettyAccelerator", () => {
  it("renders modifiers as Mac symbols", () => {
    expect(prettyAccelerator("CmdOrCtrl+Shift+Space")).toBe("⌘ ⇧ Space");
    expect(prettyAccelerator("CmdOrCtrl+Alt+B")).toBe("⌘ ⌥ B");
    expect(prettyAccelerator("F5")).toBe("F5");
  });
});

describe("base64", () => {
  it("round-trips bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 64]);
    expect(base64ToUint8(uint8ToBase64(bytes))).toEqual(bytes);
  });
});

describe("plainTextFromRichText", () => {
  it("joins paragraphs with newlines", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
        { type: "paragraph", content: [{ type: "text", text: "World" }] },
      ],
    };
    expect(plainTextFromRichText(doc)).toBe("Hello\nWorld");
  });

  it("returns empty string for non-objects", () => {
    expect(plainTextFromRichText(null)).toBe("");
    expect(plainTextFromRichText("nope")).toBe("");
  });
});
