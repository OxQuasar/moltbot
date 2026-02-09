import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ status: "timeout" })),
}));

vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn(async () => true),
  buildSubagentSystemPrompt: vi.fn(() => ""),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn(() => () => {}),
}));

import {
  addSubagentRunForTests,
  getSubagentRun,
  resetSubagentRegistryForTests,
  type SubagentRunRecord,
} from "./subagent-registry.js";

describe("getSubagentRun", () => {
  afterEach(() => {
    resetSubagentRegistryForTests();
  });

  it("returns undefined for a nonexistent runId", () => {
    expect(getSubagentRun("nonexistent")).toBeUndefined();
  });

  it("returns the record for an existing runId", () => {
    const record: SubagentRunRecord = {
      runId: "run-abc",
      childSessionKey: "agent:main:subagent:child-1",
      requesterSessionKey: "telegram:parent",
      requesterDisplayKey: "telegram:parent",
      task: "do some work",
      cleanup: "keep",
      createdAt: Date.now(),
    };

    addSubagentRunForTests(record);

    const result = getSubagentRun("run-abc");
    expect(result).toBeDefined();
    expect(result?.runId).toBe("run-abc");
    expect(result?.childSessionKey).toBe("agent:main:subagent:child-1");
    expect(result?.task).toBe("do some work");
  });

  it("returns undefined after run is released", () => {
    const record: SubagentRunRecord = {
      runId: "run-released",
      childSessionKey: "agent:main:subagent:child-2",
      requesterSessionKey: "telegram:parent",
      requesterDisplayKey: "telegram:parent",
      task: "temporary work",
      cleanup: "delete",
      createdAt: Date.now(),
    };

    addSubagentRunForTests(record);
    expect(getSubagentRun("run-released")).toBeDefined();

    resetSubagentRegistryForTests();
    expect(getSubagentRun("run-released")).toBeUndefined();
  });
});
