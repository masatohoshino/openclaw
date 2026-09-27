import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerDevicesCli } from "./devices-cli.js";

// With --json, devices refusals go to the root CLI failure owner, which writes
// the documented failure envelope; nothing reaches stderr or exit directly.

const mocks = vi.hoisted(() => ({
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn(), writeJson: vi.fn() },
  callGateway: vi.fn(),
  listDevicePairing: vi.fn(),
}));
const { runtime, callGateway } = mocks;

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
  formatGatewayTransportErrorJson: () => null,
  buildGatewayConnectionDetails: () => ({
    url: "ws://127.0.0.1:18789",
    urlSource: "local loopback",
    message: "",
  }),
}));
vi.mock("./progress.js", () => ({
  withProgress: async (_opts: unknown, fn: () => Promise<unknown>) => await fn(),
}));
vi.mock("../infra/device-pairing.js", () => ({ listDevicePairing: mocks.listDevicePairing }));
vi.mock("../infra/device-pairing-approval.js", () => ({ approveDevicePairing: vi.fn() }));
vi.mock("../infra/device-pairing-tokens.js", () => ({ summarizeDeviceTokens: vi.fn() }));
vi.mock("../runtime.js", () => ({ defaultRuntime: mocks.runtime, writeRuntimeJson: vi.fn() }));

async function failureOf(argv: string[]): Promise<string> {
  const program = new Command().exitOverride();
  registerDevicesCli(program);
  const error = await program.parseAsync(["devices", ...argv], { from: "user" }).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  expect(runtime.error).not.toHaveBeenCalled();
  expect(runtime.exit).not.toHaveBeenCalled();
  expect(runtime.writeJson).not.toHaveBeenCalled();
  return (error as Error).message;
}

function pairedNode(operatorLabel: string, pendingNodeSurface: Record<string, unknown>) {
  return {
    deviceId: "android-node",
    displayName: "Colin's S25",
    operatorLabel,
    remoteIp: "192.168.0.202",
    roles: ["node"],
    scopes: ["operator.read"],
    nodeSurface: { displayName: "Colin's S25", createdAtMs: 1, approvedAtMs: 1 },
    pendingNodeSurface,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("devices --json failures", () => {
  it("refuses clear without --yes", async () => {
    expect(await failureOf(["clear", "--json"])).toBe(
      "Refusing to clear pairing table without --yes",
    );
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("reports approve with no pending request", async () => {
    callGateway.mockResolvedValueOnce({ pending: [] });

    expect(await failureOf(["approve", "--json"])).toBe(
      "No pending device pairing requests to approve",
    );
  });

  it("keeps the node approval guidance and redacts connection secrets", async () => {
    callGateway
      .mockResolvedValueOnce({
        pending: [],
        paired: [
          pairedNode("Kitchen Mac", {
            requestId: "node-req-1",
            revision: "revision-1",
            displayName: "Colin's S25",
            remoteIp: "192.168.0.202",
            ts: 2,
          }),
        ],
      })
      .mockRejectedValueOnce(new Error("device pairing approval denied"))
      .mockRejectedValueOnce({ message: "unknown requestId", gatewayCode: "INVALID_REQUEST" });

    const message = await failureOf([
      "approve",
      "192.168.0.202",
      "--url",
      "ws://gateway-user:url-secret@gateway.example:18789/openclaw?cluster=qa",
      "--token",
      "secret-token",
      "--json",
    ]);

    expect(message).toContain("No pending device request matches");
    expect(message).toContain("Node reapproval pending for Kitchen Mac. Run");
    expect(message).toContain("openclaw nodes approve node-req-1");
    expect(message).toContain("Reuse the same connection options when rerunning: --url, --token.");
    for (const secret of ["gateway-user", "url-secret", "gateway.example", "secret-token"]) {
      expect(message).not.toContain(secret);
    }
  });

  it("does not suggest node approval when the query only matches an operator label", async () => {
    callGateway
      .mockResolvedValueOnce({
        pending: [],
        paired: [
          {
            ...pairedNode("Kitchen Mac", {
              requestId: "node-req-alias",
              displayName: "Declared Phone",
            }),
            deviceId: "paired-node",
            displayName: "Client Phone",
            remoteIp: undefined,
          },
        ],
      })
      .mockRejectedValueOnce({ message: "unknown requestId", gatewayCode: "INVALID_REQUEST" });

    const message = await failureOf(["approve", "Kitchen Mac", "--json"]);

    expect(message).toContain("No pending device request matches Kitchen Mac");
    expect(message).not.toContain("node-req-alias");
    expect(message).not.toContain("openclaw nodes approve");
  });
});
