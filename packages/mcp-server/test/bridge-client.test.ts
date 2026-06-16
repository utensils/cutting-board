import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PROTOCOL_VERSION, type BridgeInfo } from "@cutting-board/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AppNotRunningError,
  BridgeRequestError,
  WsBridgeClient,
  readBridgeInfo,
  type SocketLike,
} from "../src/bridge-client.js";

type Listener = (...args: unknown[]) => void;

/**
 * A scriptable in-memory socket that mimics the `ws` event surface. The test
 * drives it by emitting open/message/close/error events.
 */
class MockSocket implements SocketLike {
  private listeners = new Map<string, Listener[]>();
  sent: string[] = [];
  closed = false;
  /** Auto-respond to auth frames with a successful auth_result. */
  autoAuth = true;
  /** When set, the auth_result reports failure with this message. */
  authError: string | null = null;
  /**
   * Auto-emit "open" once the client has wired all its listeners (the client
   * registers the "message" handler last in connectOnce). This avoids the
   * race where the test emits before listeners attach.
   */
  autoOpen = true;

  on(event: string, listener: (...args: any[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as Listener);
    this.listeners.set(event, list);
    if (event === "message" && this.autoOpen) {
      queueMicrotask(() => this.emit("open"));
    }
  }

  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }

  send(data: string): void {
    this.sent.push(data);
    const frame = JSON.parse(data) as { kind: string };
    if (frame.kind === "auth" && this.autoAuth) {
      queueMicrotask(() => {
        // Real `ws` delivers raw bytes; emit a Buffer like the live socket.
        this.deliver({
          kind: "auth_result",
          ok: this.authError === null,
          error: this.authError ?? undefined,
          serverProtocolVersion: PROTOCOL_VERSION,
        });
      });
    }
  }

  close(): void {
    this.closed = true;
  }

  /** Emit a server frame as a Buffer, matching the real `ws` data shape. */
  private deliver(message: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(message), "utf8"));
  }

  reply(id: string, result: unknown): void {
    this.deliver({ kind: "response", id, ok: true, result });
  }

  replyError(id: string, code: string, message: string): void {
    this.deliver({ kind: "response", id, ok: false, error: { code, message } });
  }

  lastRequestId(): string {
    const reqs = this.sent
      .map((s) => JSON.parse(s) as { kind: string; id?: string })
      .filter((m) => m.kind === "request");
    return reqs[reqs.length - 1]!.id!;
  }
}

const INFO: BridgeInfo = { port: 9223, token: "secret-token", pid: 4242, protocolVersion: 1 };

describe("readBridgeInfo (discovery file)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "cb-bridge-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("parses a valid bridge.json", async () => {
    const file = path.join(dir, "bridge.json");
    await writeFile(file, JSON.stringify(INFO));
    await chmod(file, 0o600);
    expect(await readBridgeInfo(file)).toEqual(INFO);
  });

  it("returns null when the file is missing", async () => {
    expect(await readBridgeInfo(path.join(dir, "nope.json"))).toBeNull();
  });

  it("returns null for malformed JSON", async () => {
    const file = path.join(dir, "bridge.json");
    await writeFile(file, "{ not json");
    expect(await readBridgeInfo(file)).toBeNull();
  });

  it("returns null when required fields are missing", async () => {
    const file = path.join(dir, "bridge.json");
    await writeFile(file, JSON.stringify({ port: 9223 }));
    expect(await readBridgeInfo(file)).toBeNull();
  });
});

describe("WsBridgeClient framing / correlation / auth", () => {
  function makeClient(socket: MockSocket, overrides = {}) {
    return new WsBridgeClient({
      loadBridgeInfo: async () => INFO,
      createSocket: () => socket,
      log: () => {},
      requestTimeoutMs: 200,
      ...overrides,
    });
  }

  it("sends the auth frame first and correlates a response by id", async () => {
    const socket = new MockSocket();
    const client = makeClient(socket);

    const promise = client.request("add_sticky", { text: "hi" });
    // The mock auto-opens once listeners are wired; the handshake then settles.
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThanOrEqual(2));

    const authFrame = JSON.parse(socket.sent[0]!) as Record<string, unknown>;
    expect(authFrame).toMatchObject({
      kind: "auth",
      token: "secret-token",
      protocolVersion: PROTOCOL_VERSION,
      clientName: "cutting-board-mcp",
    });

    const reqFrame = JSON.parse(socket.sent[1]!) as Record<string, unknown>;
    expect(reqFrame).toMatchObject({ kind: "request", method: "add_sticky", params: { text: "hi" } });

    socket.reply(socket.lastRequestId(), { id: "shape:abc" });
    await expect(promise).resolves.toEqual({ id: "shape:abc" });
    client.close();
  });

  it("generates unique request ids", async () => {
    const socket = new MockSocket();
    const client = makeClient(socket);

    const p1 = client.request("get_status", {});
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThanOrEqual(2));
    const id1 = socket.lastRequestId();
    socket.reply(id1, { ready: true, windowVisible: true, shapeCount: 0, productVersion: "x" });
    await p1;

    const p2 = client.request("get_status", {});
    await vi.waitFor(() => {
      const ids = socket.sent
        .map((s) => JSON.parse(s) as { kind: string; id?: string })
        .filter((m) => m.kind === "request");
      expect(ids.length).toBe(2);
    });
    const id2 = socket.lastRequestId();
    expect(id2).not.toBe(id1);
    socket.reply(id2, { ready: true, windowVisible: true, shapeCount: 0, productVersion: "x" });
    await p2;
    client.close();
  });

  it("rejects with BridgeRequestError on an error response", async () => {
    const socket = new MockSocket();
    const client = makeClient(socket);

    const promise = client.request("delete_shape", { id: "shape:x" });
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThanOrEqual(2));
    socket.replyError(socket.lastRequestId(), "not_found", "no shape shape:x");

    await expect(promise).rejects.toBeInstanceOf(BridgeRequestError);
    await promise.catch((e: BridgeRequestError) => {
      expect(e.code).toBe("not_found");
    });
    client.close();
  });

  it("rejects with a timeout error when no response arrives", async () => {
    const socket = new MockSocket();
    const client = makeClient(socket, { requestTimeoutMs: 50 });

    const promise = client.request("get_status", {});
    await expect(promise).rejects.toThrow(/timed out/);
    client.close();
  });

  it("surfaces AppNotRunningError when the discovery file is missing", async () => {
    const client = new WsBridgeClient({
      loadBridgeInfo: async () => null,
      createSocket: () => new MockSocket(),
      log: () => {},
      requestTimeoutMs: 100,
    });
    await expect(client.request("get_status", {})).rejects.toBeInstanceOf(AppNotRunningError);
    client.close();
  });

  it("treats a connection error as app-not-running", async () => {
    const socket = new MockSocket();
    socket.autoOpen = false;
    const client = makeClient(socket);
    const promise = client.request("get_status", {});
    // Simulate connection refused before the handshake completes.
    await vi.waitFor(() => expect(socket.sent.length).toBe(0));
    socket.emit("error", new Error("ECONNREFUSED"));
    await expect(promise).rejects.toBeInstanceOf(AppNotRunningError);
    client.close();
  });

  it("treats a failed auth_result as app-not-running", async () => {
    const socket = new MockSocket();
    socket.authError = "unauthorized";
    const client = makeClient(socket);
    const promise = client.request("get_status", {});
    await expect(promise).rejects.toBeInstanceOf(AppNotRunningError);
    client.close();
  });

  it("reconnects after the socket drops between requests", async () => {
    let created = 0;
    const sockets: MockSocket[] = [];
    const client = new WsBridgeClient({
      loadBridgeInfo: async () => INFO,
      createSocket: () => {
        created += 1;
        const s = new MockSocket();
        sockets.push(s);
        return s;
      },
      log: () => {},
      requestTimeoutMs: 200,
    });

    // First request over socket #0.
    const p1 = client.request("get_status", {});
    await vi.waitFor(() => expect(sockets[0]?.sent.length ?? 0).toBeGreaterThanOrEqual(2));
    sockets[0]!.reply(sockets[0]!.lastRequestId(), {
      ready: true,
      windowVisible: true,
      shapeCount: 0,
      productVersion: "x",
    });
    await p1;
    expect(created).toBe(1);

    // Socket drops.
    sockets[0]!.emit("close");

    // Next request should create a fresh socket and reconnect.
    const p2 = client.request("get_status", {});
    await vi.waitFor(() => expect(created).toBe(2));
    await vi.waitFor(() => expect(sockets[1]?.sent.length ?? 0).toBeGreaterThanOrEqual(2));
    sockets[1]!.reply(sockets[1]!.lastRequestId(), {
      ready: true,
      windowVisible: true,
      shapeCount: 1,
      productVersion: "x",
    });
    await expect(p2).resolves.toMatchObject({ shapeCount: 1 });
    client.close();
  });
});
