// Bounded in-memory ring buffer of recent gateway WS close events, so health
// can explain recent reconnect failures without persisting anything to disk.
// Entries hold only classification fields, never headers/addresses/reason text.
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

export type GatewayWsCloseEvent = {
  ts: number;
  code: number | undefined;
  cause: string | undefined;
  handshake: "pending" | "connected" | "failed";
  durationMs: number;
};

const MAX_WS_CLOSE_EVENTS = 20;
const GATEWAY_WS_CLOSE_EVENTS_KEY = Symbol.for("openclaw.gateway.wsCloseEvents");

const events = resolveGlobalSingleton<GatewayWsCloseEvent[]>(GATEWAY_WS_CLOSE_EVENTS_KEY, () => []);

export function recordGatewayWsCloseEvent(event: GatewayWsCloseEvent): void {
  events.push(event);
  if (events.length > MAX_WS_CLOSE_EVENTS) {
    events.shift();
  }
}

export function listRecentGatewayWsCloseEvents(): GatewayWsCloseEvent[] {
  return events.slice();
}

export function resetGatewayWsCloseEventsForTest(): void {
  events.length = 0;
}
