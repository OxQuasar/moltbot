import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  createPruneProtectHandler,
  isProtectedRead,
  pruneProtectHandler,
} from "./prune-protect-handler.js";

function makeToolResultMessage(toolName: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolName,
    toolCallId: `call-${Math.random().toString(36).slice(2)}`,
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

describe("isProtectedRead", () => {
  it("matches SKILL.md paths", () => {
    expect(isProtectedRead("read", { path: "/skills/deploy/SKILL.md" })).toBe(true);
    expect(isProtectedRead("read", { file_path: "/home/user/skills/SKILL.md" })).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isProtectedRead("read", { path: "/skills/Skill.MD" })).toBe(true);
    expect(isProtectedRead("read", { path: "/skills/skill.md" })).toBe(true);
  });

  it("rejects non-read tools", () => {
    expect(isProtectedRead("exec", { path: "/skills/SKILL.md" })).toBe(false);
  });

  it("rejects non-skill paths", () => {
    expect(isProtectedRead("read", { path: "/src/main.ts" })).toBe(false);
    expect(isProtectedRead("read", { path: "/docs/README.md" })).toBe(false);
  });

  it("handles missing args", () => {
    expect(isProtectedRead("read", undefined)).toBe(false);
    expect(isProtectedRead("read", {})).toBe(false);
  });
});

describe("pruneProtectHandler (stateless)", () => {
  it("tags SKILL.md reads", () => {
    const msg = makeToolResultMessage("read", "# My Skill");
    const result = pruneProtectHandler(
      { toolName: "read", toolArgs: { path: "/skills/SKILL.md" }, message: msg },
      { toolName: "read", toolArgs: { path: "/skills/SKILL.md" } },
    );
    expect(result).toBeDefined();
    expect((result!.message as { pruneProtect?: boolean }).pruneProtect).toBe(true);
  });

  it("skips non-skill reads", () => {
    const msg = makeToolResultMessage("read", "some content");
    const result = pruneProtectHandler(
      { toolName: "read", toolArgs: { path: "/src/main.ts" }, message: msg },
      { toolName: "read", toolArgs: { path: "/src/main.ts" } },
    );
    expect(result).toBeUndefined();
  });

  it("skips synthetic results", () => {
    const msg = makeToolResultMessage("read", "content");
    const result = pruneProtectHandler(
      { toolName: "read", toolArgs: { path: "/skills/SKILL.md" }, message: msg, isSynthetic: true },
      { toolName: "read", toolArgs: { path: "/skills/SKILL.md" } },
    );
    expect(result).toBeUndefined();
  });
});

describe("createPruneProtectHandler (turn-based)", () => {
  it("tags SKILL.md reads and activates turn protection", () => {
    const { handler } = createPruneProtectHandler();
    const msg = makeToolResultMessage("read", "# My Skill");
    const result = handler(
      { toolName: "read", toolArgs: { path: "/skills/SKILL.md" }, message: msg },
      { toolName: "read", toolArgs: { path: "/skills/SKILL.md" } },
    );
    expect(result).toBeDefined();
    expect((result!.message as { pruneProtect?: boolean }).pruneProtect).toBe(true);
  });

  it("tags subsequent reads in same turn after a skill read", () => {
    const { handler } = createPruneProtectHandler();

    // First: skill read
    const skillMsg = makeToolResultMessage("read", "# My Skill");
    handler(
      { toolName: "read", toolArgs: { path: "/skills/deploy/SKILL.md" }, message: skillMsg },
      { toolName: "read", toolArgs: { path: "/skills/deploy/SKILL.md" } },
    );

    // Second: reference file in a completely different directory
    const refMsg = makeToolResultMessage("read", "API spec content");
    const result = handler(
      { toolName: "read", toolArgs: { path: "/docs/api-spec.md" }, message: refMsg },
      { toolName: "read", toolArgs: { path: "/docs/api-spec.md" } },
    );
    expect(result).toBeDefined();
    expect((result!.message as { pruneProtect?: boolean }).pruneProtect).toBe(true);
  });

  it("does NOT tag non-read tools even during active turn protection", () => {
    const { handler } = createPruneProtectHandler();

    // Activate with skill read
    const skillMsg = makeToolResultMessage("read", "# Skill");
    handler(
      { toolName: "read", toolArgs: { path: "/skills/SKILL.md" }, message: skillMsg },
      { toolName: "read", toolArgs: { path: "/skills/SKILL.md" } },
    );

    // exec result should NOT be protected
    const execMsg = makeToolResultMessage("exec", "command output");
    const result = handler(
      { toolName: "exec", toolArgs: { command: "ls" }, message: execMsg },
      { toolName: "exec", toolArgs: { command: "ls" } },
    );
    expect(result).toBeUndefined();
  });

  it("resets turn protection on resetTurn()", () => {
    const { handler, resetTurn } = createPruneProtectHandler();

    // Activate with skill read
    const skillMsg = makeToolResultMessage("read", "# Skill");
    handler(
      { toolName: "read", toolArgs: { path: "/skills/SKILL.md" }, message: skillMsg },
      { toolName: "read", toolArgs: { path: "/skills/SKILL.md" } },
    );

    // Reset (simulates user message)
    resetTurn();

    // Subsequent read should NOT be protected
    const otherMsg = makeToolResultMessage("read", "random file");
    const result = handler(
      { toolName: "read", toolArgs: { path: "/tmp/random.txt" }, message: otherMsg },
      { toolName: "read", toolArgs: { path: "/tmp/random.txt" } },
    );
    expect(result).toBeUndefined();
  });

  it("protects multiple reads across the turn until reset", () => {
    const { handler, resetTurn } = createPruneProtectHandler();

    // Skill read
    handler(
      {
        toolName: "read",
        toolArgs: { path: "/skills/research/SKILL.md" },
        message: makeToolResultMessage("read", "skill"),
      },
      { toolName: "read", toolArgs: { path: "/skills/research/SKILL.md" } },
    );

    // Multiple follow-up reads in different directories
    for (const path of ["/docs/guide.md", "/src/config.ts", "/references/paper.md"]) {
      const msg = makeToolResultMessage("read", `content of ${path}`);
      const result = handler(
        { toolName: "read", toolArgs: { path }, message: msg },
        { toolName: "read", toolArgs: { path } },
      );
      expect(result).toBeDefined();
      expect((result!.message as { pruneProtect?: boolean }).pruneProtect).toBe(true);
    }

    // Reset
    resetTurn();

    // No longer protected
    const afterReset = handler(
      {
        toolName: "read",
        toolArgs: { path: "/docs/guide.md" },
        message: makeToolResultMessage("read", "guide"),
      },
      { toolName: "read", toolArgs: { path: "/docs/guide.md" } },
    );
    expect(afterReset).toBeUndefined();
  });

  it("does not activate protection for non-skill reads", () => {
    const { handler } = createPruneProtectHandler();

    // Non-skill read
    handler(
      {
        toolName: "read",
        toolArgs: { path: "/src/main.ts" },
        message: makeToolResultMessage("read", "main"),
      },
      { toolName: "read", toolArgs: { path: "/src/main.ts" } },
    );

    // Next read should NOT be protected
    const result = handler(
      {
        toolName: "read",
        toolArgs: { path: "/src/utils.ts" },
        message: makeToolResultMessage("read", "utils"),
      },
      { toolName: "read", toolArgs: { path: "/src/utils.ts" } },
    );
    expect(result).toBeUndefined();
  });
});
