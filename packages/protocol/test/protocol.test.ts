import { describe, it, expect } from "vitest";
import {
  BRIDGE_METHODS,
  TLDRAW_COLORS,
  GEO_SHAPES,
  FILL_STYLES,
  isBridgeMethod,
  isTldrawColor,
  clampPixelRatio,
  PROTOCOL_VERSION,
  DEFAULT_BRIDGE_PORT,
} from "../src/index";

const noDuplicates = (arr: readonly string[]) => new Set(arr).size === arr.length;

describe("vocabularies", () => {
  it("have no duplicate entries", () => {
    expect(noDuplicates(BRIDGE_METHODS)).toBe(true);
    expect(noDuplicates(TLDRAW_COLORS)).toBe(true);
    expect(noDuplicates(GEO_SHAPES)).toBe(true);
    expect(noDuplicates(FILL_STYLES)).toBe(true);
  });

  it("expose the expected core methods", () => {
    expect(BRIDGE_METHODS).toContain("get_board_image");
    expect(BRIDGE_METHODS).toContain("add_sticky");
    expect(BRIDGE_METHODS).toContain("add_connector");
    expect(BRIDGE_METHODS).toContain("clear_board");
  });
});

describe("isBridgeMethod", () => {
  it("accepts known methods and rejects everything else", () => {
    expect(isBridgeMethod("add_sticky")).toBe(true);
    expect(isBridgeMethod("clear_board")).toBe(true);
    expect(isBridgeMethod("not_a_method")).toBe(false);
    expect(isBridgeMethod(42)).toBe(false);
    expect(isBridgeMethod(undefined)).toBe(false);
  });
});

describe("isTldrawColor", () => {
  it("accepts known colors and rejects unknown ones", () => {
    expect(isTldrawColor("red")).toBe(true);
    expect(isTldrawColor("light-green")).toBe(true);
    expect(isTldrawColor("mauve")).toBe(false);
    expect(isTldrawColor(null)).toBe(false);
  });
});

describe("clampPixelRatio", () => {
  it("clamps to [1, 2] and falls back on missing/NaN input", () => {
    expect(clampPixelRatio(undefined)).toBe(2);
    expect(clampPixelRatio(NaN)).toBe(2);
    expect(clampPixelRatio(5)).toBe(2);
    expect(clampPixelRatio(0.5)).toBe(1);
    expect(clampPixelRatio(1.5)).toBe(1.5);
    expect(clampPixelRatio(undefined, 1)).toBe(1);
  });
});

describe("constants", () => {
  it("are sane", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_BRIDGE_PORT).toBeGreaterThan(1024);
  });
});
