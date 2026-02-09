import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { stopSubagentByRunId } from "../../auto-reply/reply/abort.js";
import { loadConfig } from "../../config/config.js";
import { jsonResult, readStringParam } from "./common.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

const SessionsStopToolSchema = Type.Object({
  runId: Type.String(),
});

export function createSessionsStopTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_stop",
    description: "Stop a running sub-agent by its runId (returned from sessions_spawn).",
    parameters: SessionsStopToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const runId = readStringParam(params, "runId");
      if (!runId) {
        return jsonResult({ status: "error", error: "runId is required" });
      }

      const cfg = loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const requesterSessionKey = opts?.agentSessionKey
        ? resolveInternalSessionKey({ key: opts.agentSessionKey, alias, mainKey })
        : undefined;

      const result = stopSubagentByRunId({ cfg, runId, requesterSessionKey });

      if (!result.stopped) {
        return jsonResult({
          status: result.reason ?? "not_found",
          runId,
        });
      }

      return jsonResult({
        status: "stopped",
        runId,
      });
    },
  };
}
