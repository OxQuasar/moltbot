import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  PluginHookToolResultPersistContext,
  PluginHookToolResultPersistEvent,
  PluginHookToolResultPersistResult,
} from "../plugins/types.js";

/**
 * Path patterns that should be protected from pruning.
 * Tool results reading these files get tagged with `pruneProtect: true`.
 */
const PROTECTED_PATH_PATTERNS = [/SKILL\.md$/i];

/** @internal Exported for testing. */
export function isProtectedRead(toolName?: string, toolArgs?: Record<string, unknown>): boolean {
  if (toolName !== "read") {
    return false;
  }
  const path = (toolArgs?.path ?? toolArgs?.file_path) as string | undefined;
  if (!path) {
    return false;
  }
  return PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Creates a stateful prune-protect handler scoped to a single session.
 *
 * When a SKILL.md read is detected, it activates turn-based protection:
 * all subsequent `read` tool results in the same assistant turn are also
 * tagged with `pruneProtect: true`. This covers the common pattern where
 * a skill instructs the agent to read additional reference files.
 *
 * Call `resetTurn()` when a new user message arrives to end the
 * protection scope.
 */
export function createPruneProtectHandler(): {
  handler: (
    event: PluginHookToolResultPersistEvent,
    ctx: PluginHookToolResultPersistContext,
  ) => PluginHookToolResultPersistResult | void;
  resetTurn: () => void;
} {
  let skillReadActive = false;

  function handler(
    event: PluginHookToolResultPersistEvent,
    ctx: PluginHookToolResultPersistContext,
  ): PluginHookToolResultPersistResult | void {
    if (event.isSynthetic) {
      return;
    }

    // Direct SKILL.md read — tag and activate turn protection
    if (isProtectedRead(ctx.toolName, event.toolArgs)) {
      skillReadActive = true;
      return {
        message: { ...event.message, pruneProtect: true } as unknown as AgentMessage,
      };
    }

    // Turn-based protection: tag all reads following a skill read
    if (skillReadActive && ctx.toolName === "read") {
      return {
        message: { ...event.message, pruneProtect: true } as unknown as AgentMessage,
      };
    }
  }

  function resetTurn(): void {
    skillReadActive = false;
  }

  return { handler, resetTurn };
}

/**
 * Stateless handler for contexts that don't need turn-based protection.
 * Only protects direct SKILL.md reads.
 */
export function pruneProtectHandler(
  event: PluginHookToolResultPersistEvent,
  ctx: PluginHookToolResultPersistContext,
): PluginHookToolResultPersistResult | void {
  if (event.isSynthetic) {
    return;
  }

  if (isProtectedRead(ctx.toolName, event.toolArgs)) {
    return {
      message: { ...event.message, pruneProtect: true } as unknown as AgentMessage,
    };
  }
}
