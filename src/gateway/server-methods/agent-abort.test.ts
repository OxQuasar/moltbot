import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "./types.js";
import { agentHandlers } from "./agent.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  updateSessionStore: vi.fn(),
  agentCommand: vi.fn(),
  registerAgentRunContext: vi.fn(),
  stopSubagentByRunId: vi.fn(),
}));

vi.mock("../session-utils.js", () => ({
  loadSessionEntry: mocks.loadSessionEntry,
}));

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    updateSessionStore: mocks.updateSessionStore,
    resolveAgentIdFromSessionKey: () => "main",
    resolveExplicitAgentSessionKey: () => undefined,
    resolveAgentMainSessionKey: () => "agent:main:main",
  };
});

vi.mock("../../commands/agent.js", () => ({
  agentCommand: mocks.agentCommand,
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({ session: { scope: "per-sender", mainKey: "main" } }),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: () => ["main"],
}));

vi.mock("../../infra/agent-events.js", () => ({
  registerAgentRunContext: mocks.registerAgentRunContext,
  onAgentEvent: vi.fn(),
}));

vi.mock("../../sessions/send-policy.js", () => ({
  resolveSendPolicy: () => "allow",
}));

vi.mock("../../utils/delivery-context.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils/delivery-context.js")>(
    "../../utils/delivery-context.js",
  );
  return {
    ...actual,
    normalizeSessionDeliveryFields: () => ({}),
  };
});

// Mock the lazy-imported abort module
vi.mock("../../auto-reply/reply/abort.js", () => ({
  stopSubagentByRunId: (...args: unknown[]) => mocks.stopSubagentByRunId(...args),
}));

const makeContext = (): GatewayRequestContext =>
  ({
    dedupe: new Map(),
    addChatRun: vi.fn(),
    logGateway: { info: vi.fn(), error: vi.fn() },
  }) as unknown as GatewayRequestContext;

describe("agent.abort handler", () => {
  beforeEach(() => {
    mocks.stopSubagentByRunId.mockReset();
  });

  it("rejects invalid params (missing runId)", async () => {
    const respond = vi.fn();

    await agentHandlers["agent.abort"]({
      params: {},
      respond,
      context: makeContext(),
      req: { type: "req", id: "1", method: "agent.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
      }),
    );
  });

  it("stops a running subagent and returns stopped: true", async () => {
    mocks.stopSubagentByRunId.mockReturnValue({ stopped: true });

    const respond = vi.fn();

    await agentHandlers["agent.abort"]({
      params: { runId: "run-abc" },
      respond,
      context: makeContext(),
      req: { type: "req", id: "2", method: "agent.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        runId: "run-abc",
        stopped: true,
      }),
    );
    expect(mocks.stopSubagentByRunId).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-abc" }),
    );
  });

  it("returns stopped: false with reason when run not found", async () => {
    mocks.stopSubagentByRunId.mockReturnValue({ stopped: false, reason: "not_found" });

    const respond = vi.fn();

    await agentHandlers["agent.abort"]({
      params: { runId: "run-missing" },
      respond,
      context: makeContext(),
      req: { type: "req", id: "3", method: "agent.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        runId: "run-missing",
        stopped: false,
        reason: "not_found",
      }),
    );
  });

  it("returns stopped: false with reason when run already ended", async () => {
    mocks.stopSubagentByRunId.mockReturnValue({ stopped: false, reason: "already_ended" });

    const respond = vi.fn();

    await agentHandlers["agent.abort"]({
      params: { runId: "run-done" },
      respond,
      context: makeContext(),
      req: { type: "req", id: "4", method: "agent.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        stopped: false,
        reason: "already_ended",
      }),
    );
  });

  it("rejects empty string runId", async () => {
    const respond = vi.fn();

    await agentHandlers["agent.abort"]({
      params: { runId: "" },
      respond,
      context: makeContext(),
      req: { type: "req", id: "5", method: "agent.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    // Empty string should fail NonEmptyString validation
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
      }),
    );
    expect(mocks.stopSubagentByRunId).not.toHaveBeenCalled();
  });
});
