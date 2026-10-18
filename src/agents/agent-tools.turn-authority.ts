import {
  gateAgentToolExecution,
  markAgentToolExecutionUnavailable,
} from "./agent-tool-availability.js";
import { copyAgentToolMetadata } from "./agent-tool-metadata.js";
import { toolPolicyRestrictsTools, type ToolPolicyLike } from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";

type TurnNarrowing = "completion-handoff" | "sender";

/**
 * Names the per-turn policy that narrows the session's tool surface. Global and agent
 * tools.toolsBySender follow the sender of each message; group-level toolsBySender stays
 * inside the group policy and still filters.
 */
export function resolveTurnNarrowing(policy: {
  requesterPolicySource: string;
  senderPolicy?: ToolPolicyLike;
}): TurnNarrowing | undefined {
  if (policy.requesterPolicySource === "completion-handoff") {
    return "completion-handoff";
  }
  return toolPolicyRestrictsTools(policy.senderPolicy) ? "sender" : undefined;
}

/**
 * Offers the session's tool surface on every turn, so the provider prompt prefix
 * stays cacheable, and gates the calls this turn's authority does not cover.
 * Owner-only tools, a completion handoff's replayed requester policy and the
 * sender's tools.toolsBySender entry are per-turn authority; they never hide a
 * tool definition.
 */
export function resolveTurnToolSurface(params: {
  /** Tools the full per-turn policy admits. */
  turnTools: AnyAgentTool[];
  /** The session surface, when per-turn policy narrows it; defaults to `turnTools`. */
  sessionTools?: AnyAgentTool[];
  /** The per-turn policy that narrows `sessionTools`; names it in the refusal. */
  narrowedBy?: TurnNarrowing;
  ownerOnlyDenied: ReadonlySet<string>;
  /** A tool exported to descendants but never offered on this turn. */
  withheld?: AnyAgentTool;
}) {
  const turnAuthorizedNames = new Set(
    params.turnTools
      .filter((tool) => !params.ownerOnlyDenied.has(tool.name))
      .map((tool) => tool.name),
  );
  const turnAuthorized = (tool: { name: string }) => turnAuthorizedNames.has(tool.name);
  const offered = (params.sessionTools ?? params.turnTools).filter(
    (tool) => tool !== params.withheld,
  );
  const tools = offered.map((tool) => {
    if (turnAuthorized(tool)) {
      return tool;
    }
    const gated = gateAgentToolExecution(
      tool,
      params.ownerOnlyDenied.has(tool.name)
        ? `${tool.name} needs the owner's authority, and this turn was not started by the owner. Do not retry ${tool.name}.`
        : params.narrowedBy === "sender"
          ? `${tool.name} is not allowed for the sender of this message (tools.toolsBySender). Do not retry ${tool.name}.`
          : `${tool.name} is outside the authority this completion turn carries from its requester. Do not retry ${tool.name}.`,
    );
    // Copying hook metadata also copies the availability binding; re-mark the denial
    // so dependent affordances (for example collector spawns) never treat it as callable.
    return markAgentToolExecutionUnavailable(copyAgentToolMetadata(tool, gated));
  });
  return {
    tools,
    turnAuthorized,
    /** Policy-approved tools for descendant snapshots, including a withheld tool. */
    exportedTools: params.turnTools.filter(turnAuthorized),
    /** Tools this turn may call. */
    callableTools: offered.filter(turnAuthorized),
  };
}
