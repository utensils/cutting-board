import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/server.js";
import { FakeBridge } from "./fake-bridge.js";

interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

function textOf(result: CallToolResult): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

async function connect(bridge: FakeBridge): Promise<Client> {
  const server = createServer({ bridge });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe("cutting-board MCP server (in-process)", () => {
  let bridge: FakeBridge;
  let client: Client;

  beforeEach(async () => {
    bridge = new FakeBridge();
    client = await connect(bridge);
  });

  it("lists all tools and resources", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "add_connector",
        "add_shape",
        "add_sticky",
        "clear_board",
        "delete_shape",
        "get_board_image",
        "get_board_snapshot",
        "get_status",
        "list_shapes",
        "move_shape",
        "update_shape",
      ].sort(),
    );

    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri).sort();
    expect(uris).toEqual(["board://image", "board://snapshot"]);
  });

  it("add_sticky returns an id", async () => {
    const result = (await client.callTool({
      name: "add_sticky",
      arguments: { text: "hello", color: "yellow" },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/Added sticky note shape:note\d+/);
  });

  it("get_board_image returns an image content block with valid base64 and no data: prefix", async () => {
    const result = (await client.callTool({
      name: "get_board_image",
      arguments: {},
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const image = (result.content as Array<{ type: string }>).find(
      (c) => c.type === "image",
    ) as ImageBlock | undefined;
    expect(image).toBeDefined();
    expect(image!.mimeType).toBe("image/png");
    expect(image!.data.startsWith("data:")).toBe(false);
    // Valid base64 that round-trips.
    const decoded = Buffer.from(image!.data, "base64");
    expect(decoded.length).toBeGreaterThan(0);
    expect(decoded.toString("base64")).toBe(image!.data);
    // PNG magic bytes.
    expect(decoded.subarray(0, 4).toString("hex")).toBe("89504e47");
  });

  it("list_shapes reflects added shapes", async () => {
    await client.callTool({ name: "add_sticky", arguments: { text: "note A" } });
    await client.callTool({
      name: "add_shape",
      arguments: { shape: "rectangle", text: "box", x: 100, y: 200 },
    });

    const result = (await client.callTool({
      name: "list_shapes",
      arguments: {},
    })) as CallToolResult;
    const text = textOf(result);
    expect(text).toMatch(/2 shape\(s\)/);
    expect(text).toContain("note A");
    expect(text).toContain("rectangle");
    expect(text).toContain("@(100,200)");
  });

  it("add_connector binds two shapes", async () => {
    const a = (await client.callTool({ name: "add_sticky", arguments: {} })) as CallToolResult;
    const b = (await client.callTool({ name: "add_sticky", arguments: {} })) as CallToolResult;
    const fromId = textOf(a).match(/shape:\w+/)![0];
    const toId = textOf(b).match(/shape:\w+/)![0];

    const result = (await client.callTool({
      name: "add_connector",
      arguments: { fromId, toId },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain(`from ${fromId} to ${toId}`);
  });

  it("update/move/delete of an unknown shape returns a graceful no-op message", async () => {
    for (const name of ["update_shape", "move_shape", "delete_shape"]) {
      const args =
        name === "update_shape"
          ? { id: "shape:missing", text: "x" }
          : name === "move_shape"
            ? { id: "shape:missing", x: 1, y: 2 }
            : { id: "shape:missing" };
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toMatch(/no longer exists \(no-op\)/);
    }
  });

  it("get_status summarizes the board", async () => {
    const result = (await client.callTool({
      name: "get_status",
      arguments: {},
    })) as CallToolResult;
    expect(textOf(result)).toMatch(/Cutting Board v0\.1\.0-test/);
    expect(textOf(result)).toMatch(/ready/);
  });

  it("clear_board reports the deleted count", async () => {
    await client.callTool({ name: "add_sticky", arguments: {} });
    await client.callTool({ name: "add_sticky", arguments: {} });
    const result = (await client.callTool({
      name: "clear_board",
      arguments: {},
    })) as CallToolResult;
    expect(textOf(result)).toMatch(/2 shape\(s\) deleted/);
  });

  it("exposes board resources backed by the bridge", async () => {
    await client.callTool({ name: "add_sticky", arguments: { text: "resource test" } });

    const snapshot = (await client.readResource({
      uri: "board://snapshot",
    })) as ReadResourceResult;
    const snapText = (snapshot.contents[0] as { text: string }).text;
    expect(snapText).toContain("resource test");

    const image = (await client.readResource({ uri: "board://image" })) as ReadResourceResult;
    const blob = (image.contents[0] as { blob: string }).blob;
    expect(blob).toBeDefined();
    expect(blob.startsWith("data:")).toBe(false);
    expect(Buffer.from(blob, "base64").subarray(0, 4).toString("hex")).toBe("89504e47");
  });

  describe("when the app is not running", () => {
    beforeEach(() => {
      bridge.notRunning = true;
    });

    it("get_status yields isError with a friendly message", async () => {
      const result = (await client.callTool({
        name: "get_status",
        arguments: {},
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Cutting Board isn't running");
    });

    it("add_sticky yields isError without throwing", async () => {
      const result = (await client.callTool({
        name: "add_sticky",
        arguments: { text: "nope" },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Cutting Board isn't running");
    });
  });

  it("validates enum inputs (rejects an unknown color)", async () => {
    // The SDK validates against the zod input schema and returns a structured
    // input-validation error result rather than throwing.
    const result = (await client.callTool({
      name: "add_sticky",
      arguments: { color: "chartreuse" },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/validation|invalid/i);
  });
});

describe("typed bridge errors", () => {
  it("maps a BridgeRequestError to its documented code in tool output", async () => {
    const bridge = new FakeBridge();
    bridge.failWith = { code: "editor_not_ready", message: "no editor yet" };
    const client = await connect(bridge);
    const result = (await client.callTool({
      name: "add_sticky",
      arguments: { text: "x" },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Bridge error \(editor_not_ready\): no editor yet/);
  });

  it("surfaces the friendly message when a resource read fails", async () => {
    const bridge = new FakeBridge();
    bridge.failWith = { code: "timeout", message: "no response" };
    const client = await connect(bridge);
    await expect(client.readResource({ uri: "board://snapshot" })).rejects.toThrow(
      /Bridge error \(timeout\): no response/,
    );
  });
});
