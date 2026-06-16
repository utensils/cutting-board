/**
 * Translate a browser keyboard event into a Tauri global-shortcut accelerator
 * string (e.g. "CmdOrCtrl+Shift+Space") and validate accelerators.
 */

export interface KeyChord {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  code: string;
  key: string;
}

const PURE_MODIFIER_CODES = new Set([
  "MetaLeft",
  "MetaRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
]);

/** Map a KeyboardEvent `code` to a Tauri key token, or null if it is a modifier. */
export function normalizeKey(code: string): string | null {
  if (PURE_MODIFIER_CODES.has(code)) return null;
  if (code.startsWith("Key")) return code.slice(3); // KeyA -> A
  if (code.startsWith("Digit")) return code.slice(5); // Digit1 -> 1
  if (code.startsWith("Numpad")) return `Num${code.slice(6)}`;
  if (code.startsWith("Arrow")) return code.slice(5); // ArrowUp -> Up
  if (/^F\d{1,2}$/.test(code)) return code; // F1..F12
  const direct: Record<string, string> = {
    Space: "Space",
    Enter: "Enter",
    Tab: "Tab",
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Escape: "Escape",
  };
  return direct[code] ?? null;
}

/** Build an accelerator string from a key chord, or null if it is not a valid combo. */
export function chordToAccelerator(chord: KeyChord): string | null {
  const key = normalizeKey(chord.code);
  if (!key) return null;

  const mods: string[] = [];
  if (chord.metaKey || chord.ctrlKey) mods.push("CmdOrCtrl");
  if (chord.altKey) mods.push("Alt");
  if (chord.shiftKey) mods.push("Shift");

  // Require at least one modifier so the hotkey does not steal plain keystrokes,
  // except for function keys which are reasonable on their own.
  if (mods.length === 0 && !/^F\d{1,2}$/.test(key)) return null;

  return [...mods, key].join("+");
}

const ACCELERATOR_SYMBOLS: Record<string, string> = {
  CmdOrCtrl: "⌘",
  Cmd: "⌘",
  Command: "⌘",
  Meta: "⌘",
  Super: "⌘",
  Ctrl: "⌃",
  Control: "⌃",
  Alt: "⌥",
  Option: "⌥",
  Shift: "⇧",
  Enter: "⏎",
  Tab: "⇥",
  Escape: "⎋",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
};

/** Render an accelerator with Mac symbols, e.g. "CmdOrCtrl+Shift+Space" → "⌘⇧Space". */
export function prettyAccelerator(accelerator: string): string {
  return accelerator
    .split("+")
    .filter(Boolean)
    .map((token) => ACCELERATOR_SYMBOLS[token] ?? token)
    .join(" ");
}

/** Validate an accelerator string: at least one non-modifier token. */
export function isValidAccelerator(accelerator: string): boolean {
  const parts = accelerator.split("+").filter(Boolean);
  if (parts.length === 0) return false;
  const modifiers = new Set(["CmdOrCtrl", "Cmd", "Command", "Ctrl", "Control", "Alt", "Option", "Shift", "Super", "Meta"]);
  const nonMods = parts.filter((p) => !modifiers.has(p));
  return nonMods.length === 1;
}
