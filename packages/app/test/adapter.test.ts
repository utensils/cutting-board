import { describe, it, expect } from "vitest";
import { toBridgeError } from "../src/bridge/adapter";
import { BridgeOpError } from "../src/board/tldraw-ops";

describe("toBridgeError", () => {
  it("preserves a BridgeOpError's code and message", () => {
    expect(toBridgeError(new BridgeOpError("not_found", "missing shape"))).toEqual({
      code: "not_found",
      message: "missing shape",
    });
  });

  it("collapses a plain Error to the internal code", () => {
    expect(toBridgeError(new Error("boom"))).toEqual({ code: "internal", message: "boom" });
  });

  it("stringifies a non-Error throwable under the internal code", () => {
    expect(toBridgeError("weird")).toEqual({ code: "internal", message: "weird" });
  });
});
