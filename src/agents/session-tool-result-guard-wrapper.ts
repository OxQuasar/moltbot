import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createPruneProtectHandler } from "./prune-protect-handler.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";

export type GuardedSessionManager = SessionManager & {
  /** Flush any synthetic tool results for pending tool calls. Idempotent. */
  flushPendingToolResults?: () => void;
};

/**
 * Apply the tool-result guard to a SessionManager exactly once and expose
 * a flush method on the instance for easy teardown handling.
 */
export function guardSessionManager(
  sessionManager: SessionManager,
  opts?: {
    agentId?: string;
    sessionKey?: string;
    allowSyntheticToolResults?: boolean;
  },
): GuardedSessionManager {
  if (typeof (sessionManager as GuardedSessionManager).flushPendingToolResults === "function") {
    return sessionManager as GuardedSessionManager;
  }

  const hookRunner = getGlobalHookRunner();
  const { handler: builtInProtectHandler, resetTurn } = createPruneProtectHandler();

  // oxlint-disable-next-line typescript/no-explicit-any
  const transform = (
    message: any,
    meta: {
      toolCallId?: string;
      toolName?: string;
      toolArgs?: Record<string, unknown>;
      isSynthetic?: boolean;
    },
  ) => {
    const event = {
      toolName: meta.toolName,
      toolCallId: meta.toolCallId,
      toolArgs: meta.toolArgs,
      message,
      isSynthetic: meta.isSynthetic,
    };
    const ctx = {
      agentId: opts?.agentId,
      sessionKey: opts?.sessionKey,
      toolName: meta.toolName,
      toolCallId: meta.toolCallId,
      toolArgs: meta.toolArgs,
    };

    // 1. Apply built-in pruneProtect handler (turn-aware)
    let current = message;
    const builtInResult = builtInProtectHandler(event, ctx);
    if (builtInResult?.message) {
      current = builtInResult.message;
    }

    // 2. Then run plugin hooks (if any)
    if (hookRunner?.hasHooks("tool_result_persist")) {
      const out = hookRunner.runToolResultPersist({ ...event, message: current }, ctx);
      if (out?.message) {
        current = out.message;
      }
    }

    return current;
  };

  const guard = installSessionToolResultGuard(sessionManager, {
    transformToolResultForPersistence: transform,
    onUserMessage: resetTurn,
    allowSyntheticToolResults: opts?.allowSyntheticToolResults,
  });
  (sessionManager as GuardedSessionManager).flushPendingToolResults = guard.flushPendingToolResults;
  return sessionManager as GuardedSessionManager;
}
