import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const abortEmbeddedMock = vi.fn().mockReturnValue(true);
vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: (...args: unknown[]) => abortEmbeddedMock(...args),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));

vi.mock("../../process/command-queue.js", () => ({
  clearCommandLane: vi.fn(),
}));

const subagentRegistryMocks = vi.hoisted(() => ({
  getSubagentRun: vi.fn(),
  listSubagentRunsForRequester: vi.fn(() => []),
}));

vi.mock("../../agents/subagent-registry.js", () => ({
  getSubagentRun: subagentRegistryMocks.getSubagentRun,
  listSubagentRunsForRequester: subagentRegistryMocks.listSubagentRunsForRequester,
}));

import { stopSubagentByRunId } from "./abort.js";

describe("stopSubagentByRunId", () => {
  let root: string;
  let storePath: string;
  let cfg: OpenClawConfig;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-abort-runid-"));
    storePath = path.join(root, "sessions.json");
    cfg = { session: { store: storePath } } as OpenClawConfig;
    abortEmbeddedMock.mockClear();
    subagentRegistryMocks.getSubagentRun.mockReset();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns not_found when run does not exist", () => {
    subagentRegistryMocks.getSubagentRun.mockReturnValue(undefined);

    const result = stopSubagentByRunId({ cfg, runId: "nonexistent" });

    expect(result.stopped).toBe(false);
    expect(result.reason).toBe("not_found");
    expect(abortEmbeddedMock).not.toHaveBeenCalled();
  });

  it("returns already_ended when run has endedAt set", () => {
    subagentRegistryMocks.getSubagentRun.mockReturnValue({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:child-1",
      requesterSessionKey: "telegram:parent",
      requesterDisplayKey: "telegram:parent",
      task: "do work",
      cleanup: "keep",
      createdAt: Date.now(),
      endedAt: Date.now(),
    });

    const result = stopSubagentByRunId({ cfg, runId: "run-1" });

    expect(result.stopped).toBe(false);
    expect(result.reason).toBe("already_ended");
    expect(abortEmbeddedMock).not.toHaveBeenCalled();
  });

  it("stops an active subagent run and calls abortEmbeddedPiRun", async () => {
    const childKey = "agent:main:subagent:child-1";
    const childSessionId = "session-child";

    await fs.writeFile(
      storePath,
      JSON.stringify({
        [childKey]: {
          sessionId: childSessionId,
          updatedAt: Date.now(),
        },
      }),
    );

    subagentRegistryMocks.getSubagentRun.mockReturnValue({
      runId: "run-1",
      childSessionKey: childKey,
      requesterSessionKey: "telegram:parent",
      requesterDisplayKey: "telegram:parent",
      task: "do work",
      cleanup: "keep",
      createdAt: Date.now(),
    });

    const result = stopSubagentByRunId({ cfg, runId: "run-1" });

    expect(result.stopped).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(abortEmbeddedMock).toHaveBeenCalledWith(childSessionId);
  });

  it("returns forbidden when requesterSessionKey does not match", () => {
    subagentRegistryMocks.getSubagentRun.mockReturnValue({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:child-1",
      requesterSessionKey: "telegram:owner",
      requesterDisplayKey: "telegram:owner",
      task: "do work",
      cleanup: "keep",
      createdAt: Date.now(),
    });

    const result = stopSubagentByRunId({
      cfg,
      runId: "run-1",
      requesterSessionKey: "telegram:someone-else",
    });

    expect(result.stopped).toBe(false);
    expect(result.reason).toBe("forbidden");
    expect(abortEmbeddedMock).not.toHaveBeenCalled();
  });

  it("allows stop when requesterSessionKey matches", async () => {
    const childKey = "agent:main:subagent:child-1";
    const childSessionId = "session-child";

    await fs.writeFile(
      storePath,
      JSON.stringify({
        [childKey]: {
          sessionId: childSessionId,
          updatedAt: Date.now(),
        },
      }),
    );

    subagentRegistryMocks.getSubagentRun.mockReturnValue({
      runId: "run-1",
      childSessionKey: childKey,
      requesterSessionKey: "telegram:owner",
      requesterDisplayKey: "telegram:owner",
      task: "do work",
      cleanup: "keep",
      createdAt: Date.now(),
    });

    const result = stopSubagentByRunId({
      cfg,
      runId: "run-1",
      requesterSessionKey: "telegram:owner",
    });

    expect(result.stopped).toBe(true);
    expect(abortEmbeddedMock).toHaveBeenCalledWith(childSessionId);
  });

  it("returns no_child_session when childSessionKey is empty", () => {
    subagentRegistryMocks.getSubagentRun.mockReturnValue({
      runId: "run-1",
      childSessionKey: "",
      requesterSessionKey: "telegram:parent",
      requesterDisplayKey: "telegram:parent",
      task: "do work",
      cleanup: "keep",
      createdAt: Date.now(),
    });

    const result = stopSubagentByRunId({ cfg, runId: "run-1" });

    expect(result.stopped).toBe(false);
    expect(result.reason).toBe("no_child_session");
  });
});
