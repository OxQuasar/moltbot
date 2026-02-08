import type { TUI } from "@mariozechner/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { ChatLog } from "./components/chat-log.js";
import type { AgentEvent, ChatEvent, TuiStateAccess } from "./tui-types.js";
import { createEventHandlers } from "./tui-event-handlers.js";

type MockChatLog = Pick<
  ChatLog,
  "startTool" | "updateToolResult" | "addSystem" | "updateAssistant" | "finalizeAssistant"
>;
type MockTui = Pick<TUI, "requestRender">;

describe("tui-event-handlers: handleAgentEvent", () => {
  const makeState = (overrides?: Partial<TuiStateAccess>): TuiStateAccess => ({
    agentDefaultId: "main",
    sessionMainKey: "agent:main:main",
    sessionScope: "global",
    agents: [],
    currentAgentId: "main",
    currentSessionKey: "agent:main:main",
    currentSessionId: "session-1",
    activeChatRunId: "run-1",
    historyLoaded: true,
    sessionInfo: { verboseLevel: "on" },
    initialSessionApplied: true,
    isConnected: true,
    autoMessageSent: false,
    toolsExpanded: false,
    showThinking: false,
    connectionStatus: "connected",
    activityStatus: "idle",
    statusTimeout: null,
    lastCtrlCAt: 0,
    ...overrides,
  });

  const makeContext = (state: TuiStateAccess) => {
    const chatLog: MockChatLog = {
      startTool: vi.fn(),
      updateToolResult: vi.fn(),
      addSystem: vi.fn(),
      updateAssistant: vi.fn(),
      finalizeAssistant: vi.fn(),
    };
    const tui: MockTui = { requestRender: vi.fn() };
    const setActivityStatus = vi.fn();
    const loadHistory = vi.fn();
    const localRunIds = new Set<string>();
    const noteLocalRunId = (runId: string) => {
      localRunIds.add(runId);
    };
    const forgetLocalRunId = (runId: string) => {
      localRunIds.delete(runId);
    };
    const isLocalRunId = (runId: string) => localRunIds.has(runId);
    const clearLocalRunIds = () => {
      localRunIds.clear();
    };

    return {
      chatLog,
      tui,
      state,
      setActivityStatus,
      loadHistory,
      noteLocalRunId,
      forgetLocalRunId,
      isLocalRunId,
      clearLocalRunIds,
    };
  };

  it("processes tool events when runId matches activeChatRunId (even if sessionId differs)", () => {
    const state = makeState({ currentSessionId: "session-xyz", activeChatRunId: "run-123" });
    const { chatLog, tui, setActivityStatus } = makeContext(state);
    const { handleAgentEvent } = createEventHandlers({
      chatLog,
      tui,
      state,
      setActivityStatus,
    });

    const evt: AgentEvent = {
      runId: "run-123",
      stream: "tool",
      data: {
        phase: "start",
        toolCallId: "tc1",
        name: "exec",
        args: { command: "echo hi" },
      },
    };

    handleAgentEvent(evt);

    expect(chatLog.startTool).toHaveBeenCalledWith("tc1", "exec", { command: "echo hi" });
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("ignores tool events when runId does not match activeChatRunId", () => {
    const state = makeState({ activeChatRunId: "run-1" });
    const { chatLog, tui, setActivityStatus } = makeContext(state);
    const { handleAgentEvent } = createEventHandlers({
      chatLog,
      tui,
      state,
      setActivityStatus,
    });

    const evt: AgentEvent = {
      runId: "run-2",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc1", name: "exec" },
    };

    handleAgentEvent(evt);

    expect(chatLog.startTool).not.toHaveBeenCalled();
    expect(chatLog.updateToolResult).not.toHaveBeenCalled();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("processes lifecycle events when runId matches activeChatRunId", () => {
    const state = makeState({ activeChatRunId: "run-9" });
    const { tui, setActivityStatus } = makeContext(state);
    const { handleAgentEvent } = createEventHandlers({
      chatLog: {
        startTool: vi.fn(),
        updateToolResult: vi.fn(),
        addSystem: vi.fn(),
        updateAssistant: vi.fn(),
        finalizeAssistant: vi.fn(),
      },
      tui,
      state,
      setActivityStatus,
    });

    const evt: AgentEvent = {
      runId: "run-9",
      stream: "lifecycle",
      data: { phase: "start" },
    };

    handleAgentEvent(evt);

    expect(setActivityStatus).toHaveBeenCalledWith("running");
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("captures runId from chat events when activeChatRunId is unset", () => {
    const state = makeState({ activeChatRunId: null });
    const { chatLog, tui, setActivityStatus } = makeContext(state);
    const { handleChatEvent, handleAgentEvent } = createEventHandlers({
      chatLog,
      tui,
      state,
      setActivityStatus,
    });

    const chatEvt: ChatEvent = {
      runId: "run-42",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "hello" },
    };

    handleChatEvent(chatEvt);

    expect(state.activeChatRunId).toBe("run-42");

    const agentEvt: AgentEvent = {
      runId: "run-42",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc1", name: "exec" },
    };

    handleAgentEvent(agentEvt);

    expect(chatLog.startTool).toHaveBeenCalledWith("tc1", "exec", undefined);
  });

  it("clears run mapping when the session changes", () => {
    const state = makeState({ activeChatRunId: null });
    const { chatLog, tui, setActivityStatus } = makeContext(state);
    const { handleChatEvent, handleAgentEvent } = createEventHandlers({
      chatLog,
      tui,
      state,
      setActivityStatus,
    });

    handleChatEvent({
      runId: "run-old",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "hello" },
    });

    state.currentSessionKey = "agent:main:other";
    state.activeChatRunId = null;
    tui.requestRender.mockClear();

    handleAgentEvent({
      runId: "run-old",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc2", name: "exec" },
    });

    expect(chatLog.startTool).not.toHaveBeenCalled();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("accepts tool events after chat final for the same run", () => {
    const state = makeState({ activeChatRunId: null });
    const { chatLog, tui, setActivityStatus } = makeContext(state);
    const { handleChatEvent, handleAgentEvent } = createEventHandlers({
      chatLog,
      tui,
      state,
      setActivityStatus,
    });

    handleChatEvent({
      runId: "run-final",
      sessionKey: state.currentSessionKey,
      state: "final",
      message: { content: [{ type: "text", text: "done" }] },
    });

    handleAgentEvent({
      runId: "run-final",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc-final", name: "session_status" },
    });

    expect(chatLog.startTool).toHaveBeenCalledWith("tc-final", "session_status", undefined);
    expect(tui.requestRender).toHaveBeenCalled();
  });

  it("ignores lifecycle updates for non-active runs in the same session", () => {
    const state = makeState({ activeChatRunId: "run-active" });
    const { chatLog, tui, setActivityStatus } = makeContext(state);
    const { handleChatEvent, handleAgentEvent } = createEventHandlers({
      chatLog,
      tui,
      state,
      setActivityStatus,
    });

    handleChatEvent({
      runId: "run-other",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "hello" },
    });
    setActivityStatus.mockClear();
    tui.requestRender.mockClear();

    handleAgentEvent({
      runId: "run-other",
      stream: "lifecycle",
      data: { phase: "end" },
    });

    expect(setActivityStatus).not.toHaveBeenCalled();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("suppresses chat log but still shows status emoji when verbose is off", () => {
    const state = makeState({
      activeChatRunId: "run-123",
      sessionInfo: { verboseLevel: "off" },
    });
    const { chatLog, tui, setActivityStatus } = makeContext(state);
    const { handleAgentEvent } = createEventHandlers({
      chatLog,
      tui,
      state,
      setActivityStatus,
    });

    handleAgentEvent({
      runId: "run-123",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc-off", name: "session_status" },
    });

    expect(chatLog.startTool).not.toHaveBeenCalled();
    expect(setActivityStatus).toHaveBeenCalledTimes(1);
    expect(setActivityStatus.mock.calls[0][0]).toMatch(/…$/);
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("omits tool output when verbose is on (non-full)", () => {
    const state = makeState({
      activeChatRunId: "run-123",
      sessionInfo: { verboseLevel: "on" },
    });
    const { chatLog, tui, setActivityStatus } = makeContext(state);
    const { handleAgentEvent } = createEventHandlers({
      chatLog,
      tui,
      state,
      setActivityStatus,
    });

    handleAgentEvent({
      runId: "run-123",
      stream: "tool",
      data: {
        phase: "update",
        toolCallId: "tc-on",
        name: "session_status",
        partialResult: { content: [{ type: "text", text: "secret" }] },
      },
    });

    handleAgentEvent({
      runId: "run-123",
      stream: "tool",
      data: {
        phase: "result",
        toolCallId: "tc-on",
        name: "session_status",
        result: { content: [{ type: "text", text: "secret" }] },
        isError: false,
      },
    });

    expect(chatLog.updateToolResult).toHaveBeenCalledTimes(1);
    expect(chatLog.updateToolResult).toHaveBeenCalledWith(
      "tc-on",
      { content: [] },
      { isError: false },
    );
  });

  it("blocks delta 'streaming' status while tool emoji is active", () => {
    const state = makeState({ activeChatRunId: "run-1" });
    const { chatLog, tui, setActivityStatus } = makeContext(state);
    const { handleChatEvent, handleAgentEvent } = createEventHandlers({
      chatLog,
      tui,
      state,
      setActivityStatus,
    });

    // Register the run via a chat delta first
    handleChatEvent({
      runId: "run-1",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "hello" },
    });
    setActivityStatus.mockClear();

    // Start a tool — sets the tool emoji hold
    handleAgentEvent({
      runId: "run-1",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc1", name: "exec", args: {} },
    });
    expect(setActivityStatus).toHaveBeenCalledWith(expect.stringMatching(/…$/));
    setActivityStatus.mockClear();

    // Another delta arrives while tool is active
    handleChatEvent({
      runId: "run-1",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "world" },
    });

    // "streaming" should NOT have been called — tool emoji is held
    expect(setActivityStatus).not.toHaveBeenCalledWith("streaming");
  });

  it("blocks lifecycle 'running' status while tool emoji is active", () => {
    const state = makeState({ activeChatRunId: "run-1" });
    const { chatLog, tui, setActivityStatus } = makeContext(state);
    const { handleChatEvent, handleAgentEvent } = createEventHandlers({
      chatLog,
      tui,
      state,
      setActivityStatus,
    });

    // Register the run
    handleChatEvent({
      runId: "run-1",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "hi" },
    });
    setActivityStatus.mockClear();

    // Start a tool
    handleAgentEvent({
      runId: "run-1",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc1", name: "exec", args: {} },
    });
    setActivityStatus.mockClear();

    // Lifecycle start fires while tool is active
    handleAgentEvent({
      runId: "run-1",
      stream: "lifecycle",
      data: { phase: "start" },
    });

    // "running" should NOT have been called
    expect(setActivityStatus).not.toHaveBeenCalledWith("running");
  });

  it("terminal chat state clears tool emoji hold", () => {
    const state = makeState({ activeChatRunId: "run-1" });
    const { chatLog, tui, setActivityStatus } = makeContext(state);
    const { handleChatEvent, handleAgentEvent } = createEventHandlers({
      chatLog,
      tui,
      state,
      setActivityStatus,
    });

    // Register the run
    handleChatEvent({
      runId: "run-1",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "hi" },
    });

    // Start a tool
    handleAgentEvent({
      runId: "run-1",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc1", name: "exec", args: {} },
    });
    setActivityStatus.mockClear();

    // Chat aborted fires while tool is active
    handleChatEvent({
      runId: "run-1",
      sessionKey: state.currentSessionKey,
      state: "aborted",
      message: null,
    });

    expect(setActivityStatus).toHaveBeenCalledWith("aborted");
  });

  it("resumes streaming status after tool hold timer expires", () => {
    vi.useFakeTimers();
    try {
      const state = makeState({ activeChatRunId: "run-1" });
      const { chatLog, tui, setActivityStatus } = makeContext(state);
      const { handleChatEvent, handleAgentEvent } = createEventHandlers({
        chatLog,
        tui,
        state,
        setActivityStatus,
      });

      // Register the run
      handleChatEvent({
        runId: "run-1",
        sessionKey: state.currentSessionKey,
        state: "delta",
        message: { content: "hi" },
      });

      // Start a tool
      handleAgentEvent({
        runId: "run-1",
        stream: "tool",
        data: { phase: "start", toolCallId: "tc1", name: "exec", args: {} },
      });

      // Tool result arrives immediately (elapsed < MIN_TOOL_STATUS_MS) — timer set
      handleAgentEvent({
        runId: "run-1",
        stream: "tool",
        data: {
          phase: "result",
          toolCallId: "tc1",
          name: "exec",
          result: { content: [] },
          isError: false,
        },
      });
      setActivityStatus.mockClear();

      // During hold: delta should not set "streaming"
      handleChatEvent({
        runId: "run-1",
        sessionKey: state.currentSessionKey,
        state: "delta",
        message: { content: "more" },
      });
      expect(setActivityStatus).not.toHaveBeenCalledWith("streaming");

      // Advance past the hold timer
      vi.advanceTimersByTime(1500);

      // Timer should have fired and set "running"
      expect(setActivityStatus).toHaveBeenCalledWith("running");
      setActivityStatus.mockClear();

      // Now a new delta should set "streaming" again
      handleChatEvent({
        runId: "run-1",
        sessionKey: state.currentSessionKey,
        state: "delta",
        message: { content: "resumed" },
      });
      expect(setActivityStatus).toHaveBeenCalledWith("streaming");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes history after a non-local chat final", () => {
    const state = makeState({ activeChatRunId: null });
    const { chatLog, tui, setActivityStatus, loadHistory, isLocalRunId, forgetLocalRunId } =
      makeContext(state);
    const { handleChatEvent } = createEventHandlers({
      chatLog,
      tui,
      state,
      setActivityStatus,
      loadHistory,
      isLocalRunId,
      forgetLocalRunId,
    });

    handleChatEvent({
      runId: "external-run",
      sessionKey: state.currentSessionKey,
      state: "final",
      message: { content: [{ type: "text", text: "done" }] },
    });

    expect(loadHistory).toHaveBeenCalledTimes(1);
  });
});
