import { beforeEach, describe, expect, it, vi } from "vitest";

const stopSubagentByRunIdMock = vi.fn();

vi.mock("../../auto-reply/reply/abort.js", () => ({
  stopSubagentByRunId: (...args: unknown[]) => stopSubagentByRunIdMock(...args),
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () =>
      ({
        session: { scope: "per-sender", mainKey: "main" },
      }) as never,
  };
});

import { createSessionsStopTool } from "./sessions-stop-tool.js";

describe("sessions_stop tool", () => {
  beforeEach(() => {
    stopSubagentByRunIdMock.mockReset();
  });

  it("returns stopped status on success", async () => {
    stopSubagentByRunIdMock.mockReturnValue({ stopped: true });

    const tool = createSessionsStopTool({ agentSessionKey: "agent:main:main" });
    const result = await tool.execute("call1", { runId: "run-abc" });

    expect(result.details).toMatchObject({ status: "stopped", runId: "run-abc" });
    expect(stopSubagentByRunIdMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-abc" }),
    );
  });

  it("returns not_found when run does not exist", async () => {
    stopSubagentByRunIdMock.mockReturnValue({ stopped: false, reason: "not_found" });

    const tool = createSessionsStopTool({ agentSessionKey: "agent:main:main" });
    const result = await tool.execute("call1", { runId: "run-missing" });

    expect(result.details).toMatchObject({ status: "not_found", runId: "run-missing" });
  });

  it("returns already_ended when run has completed", async () => {
    stopSubagentByRunIdMock.mockReturnValue({ stopped: false, reason: "already_ended" });

    const tool = createSessionsStopTool({ agentSessionKey: "agent:main:main" });
    const result = await tool.execute("call1", { runId: "run-done" });

    expect(result.details).toMatchObject({ status: "already_ended", runId: "run-done" });
  });

  it("returns forbidden when requester does not own the run", async () => {
    stopSubagentByRunIdMock.mockReturnValue({ stopped: false, reason: "forbidden" });

    const tool = createSessionsStopTool({ agentSessionKey: "agent:main:main" });
    const result = await tool.execute("call1", { runId: "run-other" });

    expect(result.details).toMatchObject({ status: "forbidden", runId: "run-other" });
  });

  it("returns error when runId is missing", async () => {
    const tool = createSessionsStopTool({ agentSessionKey: "agent:main:main" });
    const result = await tool.execute("call1", {});

    expect(result.details).toMatchObject({ status: "error", error: "runId is required" });
    expect(stopSubagentByRunIdMock).not.toHaveBeenCalled();
  });

  it("passes requesterSessionKey for ownership verification", async () => {
    stopSubagentByRunIdMock.mockReturnValue({ stopped: true });

    const tool = createSessionsStopTool({ agentSessionKey: "agent:main:main" });
    await tool.execute("call1", { runId: "run-abc" });

    const callArg = stopSubagentByRunIdMock.mock.calls[0]?.[0] as {
      requesterSessionKey?: string;
    };
    expect(callArg.requesterSessionKey).toBeDefined();
  });
});
