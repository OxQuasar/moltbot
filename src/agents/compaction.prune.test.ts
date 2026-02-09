import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  estimateMessagesTokens,
  pruneToolOutputs,
  PRUNE_MINIMUM_TOKENS,
  PRUNE_PROTECT_TOKENS,
  PRUNE_PROTECTED_TOOLS,
} from "./compaction.js";

function makeToolResult(toolName: string, output: string): AgentMessage {
  return {
    role: "toolResult",
    toolName,
    toolCallId: `call-${Math.random().toString(36).slice(2)}`,
    content: [{ type: "text", text: output }],
  } as unknown as AgentMessage;
}

function makeUserMessage(text: string): AgentMessage {
  return {
    role: "user",
    content: text,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function makeAssistantMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

// Generate a large string of approximately N tokens (assuming ~4 chars/token)
function generateLargeOutput(tokens: number): string {
  const chars = tokens * 4;
  return "x".repeat(chars);
}

/**
 * Pad realistic content to reach a target token count (~4 chars/token).
 * Keeps the realistic prefix visible and fills the rest with padding.
 */
function padToTokens(realisticContent: string, tokens: number): string {
  const targetChars = tokens * 4;
  if (realisticContent.length >= targetChars) {
    return realisticContent;
  }
  return realisticContent + "\n" + "·".repeat(targetChars - realisticContent.length - 1);
}

type MessageSnapshot = {
  role: string;
  tool?: string;
  contentPreview: string;
  pruned: boolean;
};

/** Extract a compact, readable snapshot of the message list for assertions. */
function snapshotMessages(messages: AgentMessage[]): MessageSnapshot[] {
  return messages.map((msg) => {
    const m = msg as Record<string, unknown>;
    const role = String(m.role);
    const tool = m.toolName ? String(m.toolName) : undefined;
    const pruned = typeof m.prunedAt === "number";

    let contentPreview: string;
    if (typeof m.content === "string") {
      contentPreview = m.content.slice(0, 80);
    } else if (Array.isArray(m.content)) {
      const first = m.content[0] as { text?: string } | undefined;
      contentPreview = first?.text?.slice(0, 80) ?? "(empty)";
    } else {
      contentPreview = "(no content)";
    }

    return { role, ...(tool ? { tool } : {}), contentPreview, pruned };
  });
}

describe("pruneToolOutputs", () => {
  it("exports default constants", () => {
    expect(PRUNE_PROTECT_TOKENS).toBe(40_000);
    expect(PRUNE_MINIMUM_TOKENS).toBe(20_000);
    expect(PRUNE_PROTECTED_TOOLS).toContain("memory_search");
    expect(PRUNE_PROTECTED_TOOLS).toContain("gandiva_recall");
    expect(PRUNE_PROTECTED_TOOLS).not.toContain("skill");
  });

  it("does not prune when below minimum threshold", () => {
    const messages: AgentMessage[] = [
      makeUserMessage("hello"),
      makeAssistantMessage("hi"),
      makeToolResult("exec", "small output"),
      makeUserMessage("ok"),
      makeAssistantMessage("done"),
    ];

    const result = pruneToolOutputs(messages, {
      protectTokens: 100,
      minimumTokens: 1000, // Require 1000 tokens minimum
    });

    expect(result.didPrune).toBe(false);
    expect(result.prunedCount).toBe(0);
  });

  it("prunes old tool outputs beyond protect threshold", () => {
    // Create messages with large tool outputs
    const messages: AgentMessage[] = [
      makeUserMessage("start"),
      makeToolResult("exec", generateLargeOutput(30_000)), // Old, should be pruned
      makeUserMessage("middle"),
      makeToolResult("exec", generateLargeOutput(30_000)), // Old, should be pruned
      makeUserMessage("recent 1"),
      makeToolResult("exec", generateLargeOutput(30_000)), // Recent, protected
      makeUserMessage("recent 2"),
      makeAssistantMessage("done"),
    ];

    const result = pruneToolOutputs(messages, {
      protectTokens: 40_000,
      minimumTokens: 20_000,
    });

    expect(result.didPrune).toBe(true);
    expect(result.prunedCount).toBeGreaterThan(0);
    expect(result.prunedTokens).toBeGreaterThan(0);
  });

  it("respects protected tools", () => {
    const messages: AgentMessage[] = [
      makeUserMessage("start"),
      makeToolResult("skill", generateLargeOutput(50_000)), // Protected
      makeUserMessage("recent 1"),
      makeUserMessage("recent 2"),
    ];

    const result = pruneToolOutputs(messages, {
      protectTokens: 1000,
      minimumTokens: 1000,
      protectedTools: ["skill"],
    });

    expect(result.didPrune).toBe(false);
  });

  it("user-configured extra protected tools merge with defaults", () => {
    // Simulates the additive merge: PRUNE_PROTECTED_TOOLS + user-configured extras
    const userExtra = ["my_custom_tool"];
    const merged = [...PRUNE_PROTECTED_TOOLS, ...userExtra];

    const messages: AgentMessage[] = [
      makeUserMessage("start"),
      makeToolResult("my_custom_tool", generateLargeOutput(50_000)), // User-protected
      makeToolResult("exec", generateLargeOutput(50_000)), // Not protected
      makeToolResult("gandiva_recall", generateLargeOutput(50_000)), // Built-in protected
      makeUserMessage("recent 1"),
      makeUserMessage("recent 2"),
    ];

    const result = pruneToolOutputs(messages, {
      protectTokens: 1000,
      minimumTokens: 10_000,
      protectedTools: merged,
    });

    expect(result.didPrune).toBe(true);
    // Only exec should be pruned; my_custom_tool and gandiva_recall are protected
    expect(result.prunedCount).toBe(1);
    const execMsg = messages[2] as { content?: Array<{ text?: string }>; prunedAt?: number };
    expect(execMsg.prunedAt).toBeDefined();
    // User-configured tool stays intact
    const customMsg = messages[1] as { content?: Array<{ text?: string }>; prunedAt?: number };
    expect(customMsg.prunedAt).toBeUndefined();
    // Built-in gandiva_recall stays intact
    const gandivaMsg = messages[3] as { content?: Array<{ text?: string }>; prunedAt?: number };
    expect(gandivaMsg.prunedAt).toBeUndefined();
  });

  it("protects last 2 user turns", () => {
    const messages: AgentMessage[] = [
      makeUserMessage("old"),
      makeToolResult("exec", generateLargeOutput(50_000)), // Should be pruned
      makeUserMessage("recent 1"), // Protected turn
      makeToolResult("exec", generateLargeOutput(50_000)), // Protected (within last 2 turns)
      makeUserMessage("recent 2"), // Protected turn
    ];

    const result = pruneToolOutputs(messages, {
      protectTokens: 1000,
      minimumTokens: 10_000,
    });

    // Only the first tool result should be prunable
    expect(result.prunableCount).toBe(1);
  });

  it("stops at summary boundary", () => {
    const messages: AgentMessage[] = [
      makeUserMessage("old"),
      makeToolResult("exec", generateLargeOutput(50_000)), // Before summary
      { ...makeAssistantMessage("summary"), summary: true } as AgentMessage, // Boundary
      makeUserMessage("new"),
      makeToolResult("exec", generateLargeOutput(50_000)), // After summary
      makeUserMessage("recent 1"),
      makeUserMessage("recent 2"),
    ];

    const result = pruneToolOutputs(messages, {
      protectTokens: 1000,
      minimumTokens: 10_000,
    });

    // Should only consider tool results after the summary
    expect(result.prunableCount).toBe(1);
  });

  it("respects pruneProtect field on messages", () => {
    const protectedMsg = makeToolResult("exec", generateLargeOutput(50_000));
    (protectedMsg as { pruneProtect?: boolean }).pruneProtect = true;

    const messages: AgentMessage[] = [
      makeUserMessage("start"),
      protectedMsg, // pruneProtect: true — should NOT be pruned
      makeToolResult("exec", generateLargeOutput(50_000)), // No tag — should be pruned
      makeUserMessage("recent 1"),
      makeUserMessage("recent 2"),
    ];

    const result = pruneToolOutputs(messages, {
      protectTokens: 1000,
      minimumTokens: 10_000,
    });

    expect(result.didPrune).toBe(true);
    // Only the unprotected exec should be pruned
    expect(result.prunedCount).toBe(1);
    const taggedMsg = messages[1] as { prunedAt?: number };
    expect(taggedMsg.prunedAt).toBeUndefined();
    const untaggedMsg = messages[2] as { prunedAt?: number };
    expect(untaggedMsg.prunedAt).toBeDefined();
  });

  it("pruneProtect works alongside tool name protection", () => {
    const protectedByTag = makeToolResult("exec", generateLargeOutput(50_000));
    (protectedByTag as { pruneProtect?: boolean }).pruneProtect = true;

    const messages: AgentMessage[] = [
      makeUserMessage("start"),
      protectedByTag, // Protected by tag
      makeToolResult("memory_search", generateLargeOutput(50_000)), // Protected by name
      makeToolResult("exec", generateLargeOutput(50_000)), // Not protected
      makeUserMessage("recent 1"),
      makeUserMessage("recent 2"),
    ];

    const result = pruneToolOutputs(messages, {
      protectTokens: 1000,
      minimumTokens: 10_000,
    });

    expect(result.didPrune).toBe(true);
    expect(result.prunedCount).toBe(1);
    // Only index 3 (unprotected exec) should be pruned
    expect((messages[1] as { prunedAt?: number }).prunedAt).toBeUndefined();
    expect((messages[2] as { prunedAt?: number }).prunedAt).toBeUndefined();
    expect((messages[3] as { prunedAt?: number }).prunedAt).toBeDefined();
  });

  it("replaces pruned content with placeholder", () => {
    const messages: AgentMessage[] = [
      makeUserMessage("start"),
      makeToolResult("exec", generateLargeOutput(60_000)),
      makeUserMessage("recent 1"),
      makeUserMessage("recent 2"),
      makeAssistantMessage("done"),
    ];

    const result = pruneToolOutputs(messages, {
      protectTokens: 1000,
      minimumTokens: 10_000,
      placeholder: "[PRUNED]",
    });

    expect(result.didPrune).toBe(true);

    // Check the pruned message
    const prunedMsg = messages[1] as { content?: Array<{ text?: string }> };
    expect(prunedMsg.content?.[0]?.text).toBe("[PRUNED]");
  });
});

// =============================================================================
// Realistic before/after prune scenarios
// =============================================================================

describe("pruneToolOutputs – realistic before/after scenarios", () => {
  // Low thresholds so realistic-size content is enough to trigger pruning
  const opts = {
    protectTokens: 2_000,
    minimumTokens: 1_000,
    protectedTools: ["memory_search"],
  };

  it("coding session: old file reads + bash get pruned, recent stay intact", () => {
    const oldFileContent = padToTokens(
      `// src/server.ts\nimport express from "express";\nconst app = express();\napp.get("/health", (_, res) => res.send("ok"));\napp.listen(3000);`,
      3_000,
    );
    const oldBashOutput = padToTokens(
      `$ npm test\n\n PASS  src/server.test.ts\n  ✓ health endpoint returns 200 (4ms)\n  ✓ handles missing routes (2ms)\n\nTest Suites: 1 passed, 1 total\nTests:       2 passed, 2 total`,
      2_500,
    );
    const recentGrepOutput = padToTokens(
      `src/server.ts:4:app.get("/health", (_, res) => res.send("ok"));\nsrc/routes.ts:12:router.get("/api/users", listUsers);`,
      1_500,
    );
    const recentFileContent = padToTokens(
      `// src/routes.ts\nimport { Router } from "express";\nexport const router = Router();\nrouter.get("/api/users", listUsers);`,
      1_200,
    );

    const messages: AgentMessage[] = [
      // --- Turn 1 (old) ---
      makeUserMessage("Read the server file and run tests"),
      makeAssistantMessage("I'll read the file and run the test suite."),
      makeToolResult("read_file", oldFileContent),
      makeToolResult("exec", oldBashOutput),
      makeAssistantMessage("All tests pass. The server listens on port 3000."),
      // --- Turn 2 (old) ---
      makeUserMessage("Find the health endpoint and the routes file"),
      makeAssistantMessage("Let me search for those."),
      makeToolResult("grep", recentGrepOutput),
      makeToolResult("read_file", recentFileContent),
      makeAssistantMessage("Found the health endpoint in server.ts and the routes in routes.ts."),
      // --- Turn 3 (recent, within last 2 user turns) ---
      makeUserMessage("Add a DELETE /api/users/:id route"),
      makeAssistantMessage("I'll add that route now."),
      makeToolResult("write_file", "File written: src/routes.ts"),
      // --- Turn 4 (recent) ---
      makeUserMessage("Run the tests again"),
      makeAssistantMessage("Running tests."),
      makeToolResult("exec", "$ npm test\n\n PASS\nTests: 3 passed, 3 total"),
    ];

    const before = snapshotMessages(messages);
    const tokensBefore = estimateMessagesTokens(messages);

    const result = pruneToolOutputs(messages, opts);

    const after = snapshotMessages(messages);
    const tokensAfter = estimateMessagesTokens(messages);

    // --- Before state: no messages pruned ---
    expect(before.every((m) => !m.pruned)).toBe(true);

    // --- After state: old tool results pruned, recent ones intact ---
    expect(result.didPrune).toBe(true);
    expect(tokensAfter).toBeLessThan(tokensBefore);

    // The old file read (index 2) and bash output (index 3) should be pruned
    expect(after[2]).toEqual({
      role: "toolResult",
      tool: "read_file",
      contentPreview: "[output pruned for context]",
      pruned: true,
    });
    expect(after[3]).toEqual({
      role: "toolResult",
      tool: "exec",
      contentPreview: "[output pruned for context]",
      pruned: true,
    });

    // Recent tool results (within last 2 user turns) should NOT be pruned
    expect(after[12]!.pruned).toBe(false); // write_file
    expect(after[14]!.pruned).toBe(false); // recent exec
    expect(after[12]!.contentPreview).toBe("File written: src/routes.ts");

    // User and assistant messages are never pruned
    for (const snap of after) {
      if (snap.role === "user" || snap.role === "assistant") {
        expect(snap.pruned).toBe(false);
      }
    }
  });

  it("mixed tools: memory_search protected, exec/read pruned, pruneProtect-tagged protected", () => {
    const memoryOutput = padToTokens(
      `Found 3 memories:\n1. User prefers dark mode\n2. Project uses PostgreSQL\n3. Deploy target is fly.io`,
      3_000,
    );
    const execOutput = padToTokens(
      `$ docker ps\nCONTAINER ID  IMAGE         STATUS       PORTS\nabc123        postgres:16   Up 2 hours   0.0.0.0:5432->5432/tcp\ndef456        redis:7       Up 2 hours   0.0.0.0:6379->6379/tcp`,
      3_000,
    );
    const readOutput = padToTokens(
      `// docker-compose.yml\nversion: "3.8"\nservices:\n  db:\n    image: postgres:16\n    ports:\n      - "5432:5432"\n  redis:\n    image: redis:7`,
      3_000,
    );
    const skillReadOutput = padToTokens(`# Deploy Skill\nDeploy to fly.io using flyctl.`, 2_500);

    // Simulate a skill read tagged with pruneProtect by the handler
    const skillReadMsg = makeToolResult("read", skillReadOutput);
    (skillReadMsg as { pruneProtect?: boolean }).pruneProtect = true;

    const messages: AgentMessage[] = [
      // --- Turn 1 (old) ---
      makeUserMessage("Check what's running and read the docker compose"),
      makeAssistantMessage("Let me check."),
      makeToolResult("memory_search", memoryOutput), // protected by name
      makeToolResult("exec", execOutput), // should be pruned
      makeToolResult("read_file", readOutput), // should be pruned
      makeAssistantMessage("PostgreSQL and Redis are running."),
      // --- Turn 2 (old) ---
      makeUserMessage("Deploy using the deploy skill"),
      makeAssistantMessage("Running the deploy skill now."),
      skillReadMsg, // protected by pruneProtect tag
      makeAssistantMessage("Deployed successfully to fly.io."),
      // --- Turn 3 (recent) ---
      makeUserMessage("Check the deployment status"),
      makeAssistantMessage("Checking."),
      makeToolResult("exec", "$ flyctl status\napp: my-app\nStatus: running"),
      // --- Turn 4 (recent) ---
      makeUserMessage("Looks good, thanks"),
    ];

    const before = snapshotMessages(messages);
    const result = pruneToolOutputs(messages, opts);
    const after = snapshotMessages(messages);

    expect(result.didPrune).toBe(true);

    // Before: nothing was pruned
    expect(before.filter((m) => m.pruned)).toHaveLength(0);

    // memory_search (index 2) stays intact – protected tool
    expect(after[2]).toMatchObject({ tool: "memory_search", pruned: false });
    expect(after[2]!.contentPreview).toContain("Found 3 memories");

    // exec (index 3) and read_file (index 4) – pruned
    expect(after[3]).toMatchObject({ tool: "exec", pruned: true });
    expect(after[3]!.contentPreview).toBe("[output pruned for context]");
    expect(after[4]).toMatchObject({ tool: "read_file", pruned: true });
    expect(after[4]!.contentPreview).toBe("[output pruned for context]");

    // skill read (index 8) stays intact – protected by pruneProtect tag
    expect(after[8]).toMatchObject({ tool: "read", pruned: false });
    expect(after[8]!.contentPreview).toContain("Deploy Skill");

    // Recent exec (index 12) stays intact – within last 2 user turns
    expect(after[12]).toMatchObject({ tool: "exec", pruned: false });
    expect(after[12]!.contentPreview).toContain("flyctl status");
  });

  it("long debugging session: only oldest tool outputs pruned, recent window preserved", () => {
    // Simulate a debugging session with many tool calls accumulating
    const messages: AgentMessage[] = [
      // --- Turn 1: initial investigation (old) ---
      makeUserMessage("The app is crashing on startup. Can you investigate?"),
      makeAssistantMessage("Let me look at the logs and the main entry file."),
      makeToolResult(
        "exec",
        padToTokens(
          `$ journalctl -u myapp --since "5 min ago"\nERROR: Cannot read properties of undefined (reading 'split')\n  at parseConfig (/app/src/config.ts:42)\n  at main (/app/src/index.ts:8)`,
          2_000,
        ),
      ),
      makeToolResult(
        "read_file",
        padToTokens(
          `// src/config.ts\nexport function parseConfig(raw: string) {\n  const lines = raw.split("\\n");\n  return Object.fromEntries(lines.map(l => l.split("=")));\n}`,
          2_000,
        ),
      ),
      makeAssistantMessage(
        "The crash is in parseConfig – it's called with undefined. Let me check the caller.",
      ),
      // --- Turn 2: deeper investigation (old) ---
      makeUserMessage("Check index.ts where parseConfig is called"),
      makeAssistantMessage("Reading the file."),
      makeToolResult(
        "read_file",
        padToTokens(
          `// src/index.ts\nimport { parseConfig } from "./config.js";\nconst cfg = parseConfig(process.env.APP_CONFIG);\nconsole.log("Starting with", cfg);`,
          1_500,
        ),
      ),
      makeAssistantMessage(
        "Found it – process.env.APP_CONFIG is undefined. We need a fallback or validation.",
      ),
      // --- Turn 3: fix applied (old) ---
      makeUserMessage("Add a guard for missing APP_CONFIG"),
      makeAssistantMessage("I'll add validation before parsing."),
      makeToolResult("write_file", padToTokens(`File written: src/index.ts (added guard)`, 200)),
      makeToolResult(
        "exec",
        padToTokens(
          `$ npm test\n\n PASS  src/config.test.ts\n  ✓ handles undefined input\nTests: 1 passed`,
          1_500,
        ),
      ),
      makeAssistantMessage("Fix applied and tests pass."),
      // --- Turn 4 (recent) ---
      makeUserMessage("Run it again and check if the crash is gone"),
      makeAssistantMessage("Starting the app."),
      makeToolResult(
        "exec",
        padToTokens(
          `$ node dist/index.js\nWarning: APP_CONFIG not set, using defaults\nServer listening on :3000`,
          800,
        ),
      ),
      // --- Turn 5 (recent) ---
      makeUserMessage("It works now"),
    ];

    const before = snapshotMessages(messages);
    const tokensBefore = estimateMessagesTokens(messages);

    const result = pruneToolOutputs(messages, opts);

    const after = snapshotMessages(messages);
    const tokensAfter = estimateMessagesTokens(messages);

    // Before: nothing was pruned
    expect(before.filter((m) => m.pruned)).toHaveLength(0);

    expect(result.didPrune).toBe(true);
    expect(result.prunedCount).toBeGreaterThanOrEqual(2);
    expect(tokensAfter).toBeLessThan(tokensBefore);

    // --- Verify the oldest tool outputs were pruned ---
    // Turn 1 tool results (indices 2, 3) – old, large
    expect(after[2]).toMatchObject({ tool: "exec", pruned: true });
    expect(after[3]).toMatchObject({ tool: "read_file", pruned: true });

    // --- Verify recent turn tool outputs are intact ---
    // Turn 4 exec (index 16)
    expect(after[16]).toMatchObject({ tool: "exec", pruned: false });
    expect(after[16]!.contentPreview).toContain("APP_CONFIG not set");

    // --- Token reduction is significant ---
    expect(tokensBefore - tokensAfter).toBeGreaterThan(1_000);

    // --- All user/assistant messages untouched ---
    for (const snap of after) {
      if (snap.role !== "toolResult") {
        expect(snap.pruned).toBe(false);
      }
    }
  });

  it("session with summary boundary: only prunes after the boundary", () => {
    // A session that was previously compacted (has a summary message),
    // then continued with new interactions.
    const messages: AgentMessage[] = [
      // --- Pre-summary messages (should be ignored by pruner) ---
      makeUserMessage("old question from before compaction"),
      makeToolResult(
        "exec",
        padToTokens(`$ old-command\nold output that was already summarized`, 4_000),
      ),
      // --- Summary boundary ---
      {
        ...makeAssistantMessage(
          "Summary: User investigated a crash in parseConfig. Fixed by adding env var guard. All tests passing.",
        ),
        summary: true,
      } as unknown as AgentMessage,
      // --- Post-summary turn 1 (old) ---
      makeUserMessage("Now let's add logging"),
      makeAssistantMessage("I'll add structured logging."),
      makeToolResult(
        "read_file",
        padToTokens(
          `// src/logger.ts\nimport pino from "pino";\nexport const log = pino({ level: "info" });`,
          2_500,
        ),
      ),
      makeToolResult("exec", padToTokens(`$ npm install pino\nadded 3 packages in 2s`, 2_000)),
      makeAssistantMessage("Added pino logger."),
      // --- Post-summary turn 2 (old) ---
      makeUserMessage("Add logging to the request handler"),
      makeAssistantMessage("Adding request logging middleware."),
      makeToolResult(
        "write_file",
        padToTokens(`File written: src/middleware/request-logger.ts`, 200),
      ),
      // --- Turn 3 (recent) ---
      makeUserMessage("Test the logging"),
      makeToolResult("exec", padToTokens(`$ curl localhost:3000/health\n{"status":"ok"}`, 500)),
      // --- Turn 4 (recent) ---
      makeUserMessage("Perfect"),
    ];

    const result = pruneToolOutputs(messages, opts);
    const after = snapshotMessages(messages);

    expect(result.didPrune).toBe(true);

    // Pre-summary tool result (index 1) – NOT pruned (pruner stops at summary boundary)
    expect(after[1]).toMatchObject({ tool: "exec", pruned: false });
    expect(after[1]!.contentPreview).toContain("old-command");

    // Post-summary old tool results (indices 5, 6) – pruned
    expect(after[5]).toMatchObject({ tool: "read_file", pruned: true });
    expect(after[5]!.contentPreview).toBe("[output pruned for context]");
    expect(after[6]).toMatchObject({ tool: "exec", pruned: true });

    // Recent tool result (index 12) – intact
    expect(after[12]).toMatchObject({ tool: "exec", pruned: false });
    expect(after[12]!.contentPreview).toContain("curl");
  });
});
