// Gateway WS close diagnostics ring buffer tests cover bounding and reset.
import { beforeEach, describe, expect, it } from "vitest";
import {
  listRecentGatewayWsCloseEvents,
  recordGatewayWsCloseEvent,
  resetGatewayWsCloseEventsForTest,
} from "./ws-close-diagnostics.js";

describe("gateway ws close diagnostics", () => {
  beforeEach(() => {
    resetGatewayWsCloseEventsForTest();
  });

  it("records a close event with only the sanitized classification fields", () => {
    recordGatewayWsCloseEvent({
      ts: 1_000,
      code: 1008,
      cause: "outbound-buffer-exceeded",
      handshake: "connected",
      durationMs: 5_000,
    });

    const recent = listRecentGatewayWsCloseEvents();
    expect(recent).toEqual([
      {
        ts: 1_000,
        code: 1008,
        cause: "outbound-buffer-exceeded",
        handshake: "connected",
        durationMs: 5_000,
      },
    ]);
    expect(Object.keys(recent[0])).toEqual(["ts", "code", "cause", "handshake", "durationMs"]);
  });

  it("bounds the buffer to the most recent 20 entries", () => {
    for (let i = 0; i < 25; i += 1) {
      recordGatewayWsCloseEvent({
        ts: i,
        code: 1000,
        cause: `cause-${i}`,
        handshake: "connected",
        durationMs: i,
      });
    }

    const recent = listRecentGatewayWsCloseEvents();
    expect(recent).toHaveLength(20);
    expect(recent[0].cause).toBe("cause-5");
    expect(recent[recent.length - 1].cause).toBe("cause-24");
  });

  it("resets cleanly for test isolation", () => {
    recordGatewayWsCloseEvent({
      ts: 1,
      code: 1000,
      cause: "handshake-timeout",
      handshake: "pending",
      durationMs: 1,
    });
    resetGatewayWsCloseEventsForTest();
    expect(listRecentGatewayWsCloseEvents()).toEqual([]);
  });
});
