import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { preparePublishedModelRuntimeChoice } from "./model-runtime-choice.js";
import { createModelRuntimeChoiceOwnerFixture } from "./model-runtime-choice.test-support.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";

const published = vi.hoisted((): { owner?: PreparedModelRuntimeSnapshot } => ({}));
vi.mock("./prepared-model-catalog.js", () => ({
  getPublishedPreparedModelCatalogOwnerSnapshot: () => published.owner,
  materializePreparedModelCatalogOwner: (owner: PreparedModelRuntimeSnapshot) => owner,
}));

describe("colliding catalog display keys", () => {
  // One provider publishes two literal rows whose display key collapses to the
  // same string: `modelKey("vendor", "gpt-5.4") === modelKey("vendor", "vendor/gpt-5.4")`.
  // Each row carries its own native runtime, and each harness serves only its row.
  const plainRow = {
    provider: "vendor",
    id: "gpt-5.4",
    name: "Plain",
    nativeRuntime: "vendor-plain",
  };
  const namespacedRow = {
    provider: "vendor",
    id: "vendor/gpt-5.4",
    name: "Namespaced",
    nativeRuntime: "vendor-cli",
  };
  const harnessConfig: OpenClawConfig = {
    plugins: { entries: { "vendor-cli": { enabled: true }, "vendor-plain": { enabled: true } } },
  };

  function publishRows(entries: readonly (typeof plainRow)[]) {
    const pluginRegistry = createEmptyPluginRegistry();
    for (const row of [plainRow, namespacedRow]) {
      pluginRegistry.agentHarnesses.push({
        pluginId: row.nativeRuntime,
        source: "fixture",
        harness: {
          id: row.nativeRuntime,
          label: row.name,
          authBootstrap: "harness",
          supports: (context) => ({ supported: context.modelId === row.id }),
          readModelCatalogReadiness: () => ({ accountType: "oauth", authMode: "oauth" }),
          async runAttempt() {
            throw new Error("Catalog reads must not execute a model");
          },
        },
      });
    }
    published.owner = createModelRuntimeChoiceOwnerFixture(harnessConfig, () => true, {
      authModes: {
        "vendor-cli": { source: "native", mode: "oauth" },
        "vendor-plain": { source: "native", mode: "oauth" },
      },
      metadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [
          { id: "vendor-cli", providers: ["vendor"], syntheticAuthRefs: ["vendor-cli"] },
          { id: "vendor-plain", providers: ["vendor"], syntheticAuthRefs: ["vendor-plain"] },
        ],
      }),
      modelCatalog: { entries: [...entries], routeVariants: [...entries] },
      pluginRegistry,
    });
  }

  const select = (model: string, runtimeId: string) =>
    preparePublishedModelRuntimeChoice({
      cfg: harnessConfig,
      agentId: "main",
      provider: "vendor",
      model,
      runtimeId,
    });

  const orders = [
    ["plain row first", [plainRow, namespacedRow]],
    ["namespaced row first", [namespacedRow, plainRow]],
  ] as const;

  it.each(orders)("keeps each row's own native runtime available (%s)", async (_label, entries) => {
    publishRows(entries);
    for (const row of [plainRow, namespacedRow]) {
      const choice = await select(row.id, row.nativeRuntime);
      expect(choice.kind).toBe("ready");
      if (choice.kind !== "ready") {
        throw new Error(`Expected ${row.nativeRuntime} to serve ${row.id}`);
      }
      expect(choice.validate()).toBeUndefined();
    }
  });

  it.each(orders)(
    "refuses a runtime only the sibling row carries (%s)",
    async (_label, entries) => {
      publishRows(entries);
      expect(await select(plainRow.id, namespacedRow.nativeRuntime)).toMatchObject({
        kind: "unavailable",
      });
      expect(await select(namespacedRow.id, plainRow.nativeRuntime)).toMatchObject({
        kind: "unavailable",
      });
    },
  );

  it("resolves a provider-prefixed selection against the bare published row", async () => {
    // `resolveSessionModelRef` keeps the self-provider prefix for a selection that
    // was resolved through the catalog, so the display-key comparison stays the
    // fallback when no literal row carries the prefixed id.
    publishRows([plainRow]);
    const choice = await select(`vendor/${plainRow.id}`, plainRow.nativeRuntime);
    expect(choice.kind).toBe("ready");
    if (choice.kind !== "ready") {
      throw new Error("Expected the prefixed spelling to select the published row");
    }
    expect(choice.validate()).toBeUndefined();
  });
});
