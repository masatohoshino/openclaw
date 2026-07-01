// Gateway WebSocket connection tests cover handshake auth, shared sessions, and message-handler attachment.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGatewayAuth } from "../auth.js";
import { MAX_BUFFERED_BYTES } from "../server-constants.js";
import {
  listRecentGatewayWsCloseEvents,
  resetGatewayWsCloseEventsForTest,
} from "./ws-close-diagnostics.js";
import {
  attachGatewayWsForTest,
  createGatewayWsTestRequestContext,
  createGatewayWsTestSocket,
  createResolvedGatewayTokenAuth,
  type GatewayWsTestSocket,
} from "./ws-connection.test-helpers.js";

const { attachGatewayWsMessageHandlerMock, broadcastPresenceSnapshotMock, upsertPresenceMock } =
  vi.hoisted(() => ({
    attachGatewayWsMessageHandlerMock: vi.fn(),
    broadcastPresenceSnapshotMock: vi.fn(),
    upsertPresenceMock: vi.fn(),
  }));

vi.mock("./ws-connection/message-handler.js", () => ({
  attachGatewayWsMessageHandler: attachGatewayWsMessageHandlerMock,
}));
vi.mock("../../infra/system-presence.js", () => ({
  upsertPresence: upsertPresenceMock,
}));
vi.mock("./presence-events.js", () => ({
  broadcastPresenceSnapshot: broadcastPresenceSnapshotMock,
}));

import { attachGatewayWsConnectionHandler } from "./ws-connection.js";
import { resolveSharedGatewaySessionGeneration } from "./ws-shared-generation.js";

async function waitForLazyMessageHandler() {
  await vi.dynamicImportSettled();
}

function firstAttachedHandlerParams(): unknown {
  return attachGatewayWsMessageHandlerMock.mock.calls[0]?.[0];
}

async function connectTestWs(
  params: {
    host?: string;
    headers?: Record<string, string>;
    socket?: GatewayWsTestSocket;
    clients?: Set<unknown>;
    options?: Partial<Parameters<typeof attachGatewayWsConnectionHandler>[0]>;
  } = {},
) {
  const connected = attachGatewayWsForTest({
    attach: attachGatewayWsConnectionHandler,
    clients: params.clients,
    headers: params.headers,
    host: params.host,
    options: params.options,
    socket: params.socket,
  });
  await waitForLazyMessageHandler();

  return {
    clients: connected.clients,
    socket: connected.socket,
    passed: firstAttachedHandlerParams(),
  };
}

describe("attachGatewayWsConnectionHandler", () => {
  beforeEach(() => {
    attachGatewayWsMessageHandlerMock.mockReset();
    broadcastPresenceSnapshotMock.mockReset();
    upsertPresenceMock.mockReset();
    resetGatewayWsCloseEventsForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("threads current auth getters into the handshake handler instead of a stale snapshot", async () => {
    const initialAuth = createResolvedGatewayTokenAuth("token-before");
    let currentAuth = initialAuth;

    const { passed } = await connectTestWs({
      options: {
        resolvedAuth: initialAuth,
        getResolvedAuth: () => currentAuth,
      },
    });

    expect(attachGatewayWsMessageHandlerMock).toHaveBeenCalledTimes(1);
    const handlerParams = passed as {
      getResolvedAuth: () => ResolvedGatewayAuth;
      getRequiredSharedGatewaySessionGeneration?: () => string | undefined;
    };

    currentAuth = createResolvedGatewayTokenAuth("token-after");

    expect(handlerParams.getResolvedAuth().token).toBe("token-after");
    expect(handlerParams.getRequiredSharedGatewaySessionGeneration?.()).toBe(
      resolveSharedGatewaySessionGeneration(currentAuth),
    );
  });

  it("threads generic plugin surface URLs into the handshake handler", async () => {
    const { passed } = await connectTestWs({
      host: "gateway.example.com",
      options: {
        port: 18789,
        pluginSurfaceScheme: "https",
        getPluginNodeCapabilities: () => [{ surface: "canvas", ttlMs: 1234 }],
      },
    });

    const handlerParams = passed as {
      pluginSurfaceBaseUrl?: string;
      pluginNodeCapabilities?: Array<{ surface: string; ttlMs?: number }>;
    };
    expect(handlerParams.pluginSurfaceBaseUrl).toBe("https://gateway.example.com:443");
    expect(handlerParams.pluginNodeCapabilities).toEqual([{ surface: "canvas", ttlMs: 1234 }]);
  });

  it("prefers forwarded host over bind host for generic plugin surface URLs", async () => {
    const { passed } = await connectTestWs({
      host: "10.0.0.2:18789",
      headers: {
        "x-forwarded-host": "gateway.example.com",
        "x-forwarded-proto": "https",
      },
      options: {
        gatewayHost: "10.0.0.2",
        port: 18789,
        pluginSurfaceScheme: "http",
        getPluginNodeCapabilities: () => [{ surface: "canvas" }],
      },
    });

    const handlerParams = passed as {
      pluginSurfaceBaseUrl?: string;
    };
    expect(handlerParams.pluginSurfaceBaseUrl).toBe("https://gateway.example.com:443");
  });

  it("rejects late client registration after a pre-connect socket close", async () => {
    const clients = new Set();
    const { passed, socket } = await connectTestWs({ clients });
    const handlerParams = passed as {
      setClient: (client: unknown) => boolean;
    };
    socket.emit("close", 1001, Buffer.from("client left"));

    const registered = handlerParams.setClient({
      socket,
      connect: { client: { id: "openclaw-control-ui", mode: "webchat" } },
      connId: "late-client",
      usesSharedGatewayAuth: false,
    });

    expect(registered).toBe(false);
    expect(clients.size).toBe(0);
  });

  it("sends protocol pings until the connection closes", async () => {
    vi.useFakeTimers();
    const socket = createGatewayWsTestSocket({ ping: true });
    const { passed } = await connectTestWs({ socket });
    const handlerParams = passed as {
      setClient: (client: unknown) => boolean;
    };
    expect(
      handlerParams.setClient({
        socket,
        connect: { client: { id: "openclaw-control-ui", mode: "webchat" } },
        connId: "ping-client",
        usesSharedGatewayAuth: false,
      }),
    ).toBe(true);

    vi.advanceTimersByTime(25_000);
    expect(socket.ping).toHaveBeenCalledTimes(1);

    socket.emit("close", 1000, Buffer.from("done"));
    vi.advanceTimersByTime(25_000);
    expect(socket.ping).toHaveBeenCalledTimes(1);
  });

  it("closes slow consumers before writing direct response frames", async () => {
    const socket = createGatewayWsTestSocket();
    const { passed } = await connectTestWs({ socket });
    const handlerParams = passed as {
      send: (frame: unknown) => void;
    };
    socket.send.mockClear();
    socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;

    handlerParams.send({ type: "res", id: "req-slow", ok: true, payload: { ok: true } });

    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(1008, "slow consumer");
  });

  it("skips node presence disconnects for stale reconnected sockets", async () => {
    const unregister = vi.fn(() => null);
    const { socket } = attachGatewayWsForTest({
      attach: attachGatewayWsConnectionHandler,
      options: {
        refreshHealthSnapshot: vi.fn(),
        buildRequestContext: () =>
          createGatewayWsTestRequestContext({ nodeRegistry: { unregister } }) as never,
      },
    });
    await waitForLazyMessageHandler();

    const passed = firstAttachedHandlerParams() as {
      setClient: (client: unknown) => boolean;
    };
    expect(
      passed.setClient({
        socket,
        connect: {
          role: "node",
          client: { id: "openclaw-macos", mode: "node" },
          device: { id: "node-1" },
        },
        connId: "conn-old",
        presenceKey: "node-1",
        usesSharedGatewayAuth: false,
      }),
    ).toBe(true);

    socket.emit("close", 1000, Buffer.from("stale"));

    expect(unregister).toHaveBeenCalledTimes(1);
    expect(upsertPresenceMock).not.toHaveBeenCalled();
    expect(broadcastPresenceSnapshotMock).not.toHaveBeenCalled();
  });

  it("records a sanitized, bounded diagnostic event on a classified close without headers or reason text", async () => {
    const socket = createGatewayWsTestSocket();
    const { passed } = await connectTestWs({
      socket,
      headers: {
        "user-agent": "sensitive-ua/1.0",
        "x-forwarded-for": "203.0.113.7",
        origin: "https://attacker.example",
      },
    });
    const handlerParams = passed as { send: (frame: unknown) => void };
    socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    // Triggers setCloseCause("outbound-buffer-exceeded", ...) + close(1008, ...);
    // the mock socket.close() doesn't itself emit "close", so simulate the
    // underlying transport actually closing.
    handlerParams.send({ type: "res", id: "req-slow", ok: true, payload: { ok: true } });
    socket.emit("close", 1008, Buffer.from("secret-token=abc123"));

    const recent = listRecentGatewayWsCloseEvents();
    expect(recent).toHaveLength(1);
    expect(recent[0]).toEqual({
      ts: expect.any(Number),
      code: 1008,
      cause: "outbound-buffer-exceeded",
      handshake: "pending",
      durationMs: expect.any(Number),
    });
    expect(Object.keys(recent[0])).toEqual(["ts", "code", "cause", "handshake", "durationMs"]);
    const serialized = JSON.stringify(recent);
    expect(serialized).not.toContain("sensitive-ua");
    expect(serialized).not.toContain("203.0.113.7");
    expect(serialized).not.toContain("attacker.example");
    expect(serialized).not.toContain("secret-token");
  });

  it("does not record a close with no classified cause, so routine disconnects can't self-seed the diagnostic buffer", async () => {
    const { socket } = await connectTestWs();

    // No setCloseCause() call happened before this — a normal disconnect,
    // e.g. a one-shot CLI command closing its own connection after a
    // successful request.
    socket.emit("close", 1000, Buffer.from("done"));

    expect(listRecentGatewayWsCloseEvents()).toEqual([]);
  });
});
