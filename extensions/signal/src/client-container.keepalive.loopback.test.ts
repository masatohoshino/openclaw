// Real-TCP regression: a receive socket whose peer stops answering must reconnect.
import { once } from "node:events";
import http from "node:http";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { runSignalSseLoop } from "./sse-reconnect.js";

afterEach(() => vi.useRealTimers());

// A server ping/pong round trip fences real I/O after each injected clock tick.
async function roundTrip(socket: WebSocket) {
  const pong = once(socket, "pong");
  socket.ping();
  await pong;
}

it("reconnects when the receive socket peer stops answering pings, and only then", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  const server = http.createServer((_request, response) => response.end("ok"));
  // The first peer never pongs, like a path that died without a FIN.
  const silent = new WebSocketServer({ noServer: true, autoPong: false });
  const live = new WebSocketServer({ noServer: true });
  const sockets: WebSocket[] = [];
  server.on("upgrade", (request, socket, head) => {
    const wss = sockets.length === 0 ? silent : live;
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on("error", () => {});
      sockets.push(ws);
      if (wss === live) {
        ws.send(JSON.stringify({ envelope: { timestamp: 2 } }));
      }
    });
  });
  const port = await listenOnLoopback(server);
  const abort = new AbortController();
  const runtime = createRuntimeSpies();
  const statusSink = vi.fn();
  const events: number[] = [];
  const stream = runSignalSseLoop({
    baseUrl: `http://127.0.0.1:${port}`,
    account: "+15550001111",
    transportKind: "container",
    abortSignal: abort.signal,
    runtime,
    statusSink,
    policy: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
    onEvent: (event) => {
      const message = JSON.parse(event.data ?? "{}") as { envelope: { timestamp: number } };
      events.push(message.envelope.timestamp);
    },
  });
  try {
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await roundTrip(sockets[0]!);
    await vi.advanceTimersByTimeAsync(25_000);
    await roundTrip(sockets[0]!);
    await vi.advanceTimersByTimeAsync(25_000);
    await vi.waitFor(() => expect(events).toEqual([2]), { timeout: 3_000 });
    expect(runtime.error).toHaveBeenCalledWith("[signal-ws] heartbeat timed out; reconnecting");
    expect(statusSink).toHaveBeenCalledWith(
      expect.objectContaining({ connected: false, lifecycle: "recovering" }),
    );
    // A quiet peer that answers pings keeps its socket.
    for (let tick = 0; tick < 3; tick++) {
      await vi.advanceTimersByTimeAsync(25_000);
      await roundTrip(sockets[1]!);
    }
    expect(sockets).toHaveLength(2);
    expect(runtime.error).toHaveBeenCalledTimes(1);
  } finally {
    abort.abort();
    await stream;
    for (const ws of [...silent.clients, ...live.clients]) {
      ws.terminate();
    }
    await Promise.all([
      promisify(silent.close.bind(silent))(),
      promisify(live.close.bind(live))(),
      promisify(server.close.bind(server))(),
    ]);
  }
});
