import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { repairStaleAgentModelRefs } from "./stale-agent-model-ref-repair.js";

describe("repairStaleAgentModelRefs", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("reads agent-local providers from a models.json with comments and trailing commas", () => {
    const stateDir = tempDirs.make("openclaw-stale-model-ref-");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      '{\n  // Added by hand.\n  "providers": { "agent-local": { "models": [] }, },\n}\n',
    );

    const result = repairStaleAgentModelRefs(
      {
        agents: {
          defaults: { model: { primary: "agent-local/model", fallbacks: ["deleted/model"] } },
          entries: { main: {} },
        },
      },
      { env: { OPENCLAW_STATE_DIR: stateDir }, pluginProviderIds: new Set() },
    );

    expect(result.warnings).toEqual([]);
    expect(result.config.agents?.defaults?.model).toEqual({
      primary: "agent-local/model",
      fallbacks: [],
    });
    expect(result.changes).toEqual([
      'Removed stale agents.defaults.model fallback "deleted/model" (provider "deleted" is unavailable).',
    ]);
  });
});
