# Subagent Stop Feature

Stop a specific subagent by `runId`. Previously the only abort mechanism (`stopSubagentsForRequester`) was all-or-nothing. This feature adds targeted termination via two entry points: the `sessions_stop` agent tool and the `agent.abort` gateway RPC.

## Architecture

```
                    ┌──────────────────────┐
                    │  Entry Points        │
                    └──────────┬───────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                                  ▼
   sessions_stop tool                   agent.abort gateway RPC
   (agent calls this)                   (external clients call this)
   src/agents/tools/                    src/gateway/server-methods/
   sessions-stop-tool.ts                agent.ts
              │                                  │
              │    ┌─────────────────────────┐   │
              └───►│  stopSubagentByRunId()  │◄──┘
                   │  src/auto-reply/reply/  │
                   │  abort.ts               │
                   └────────────┬────────────┘
                                │
                   ┌────────────┼────────────────────┐
                   ▼            ▼                     ▼
           getSubagentRun()   clearSessionQueues()   abortEmbeddedPiRun()
           (registry lookup   (clears followup       (signals abort to
            by runId)          + command queues)       the PI runner)
```

## Agent Tool: `sessions_stop`

Stops a running sub-agent by its `runId` (returned from `sessions_spawn`).

### Parameters

| Parameter | Type   | Required | Description                              |
| --------- | ------ | -------- | ---------------------------------------- |
| `runId`   | string | yes      | The run ID returned by `sessions_spawn`. |

### Response

Returns a JSON object with `status` and `runId`:

| Status          | Description                                  |
| --------------- | -------------------------------------------- |
| `stopped`       | The subagent was successfully stopped.       |
| `not_found`     | No subagent run exists with that `runId`.    |
| `already_ended` | The subagent had already finished.           |
| `forbidden`     | The caller does not own the target subagent. |
| `error`         | Invalid parameters (e.g. missing `runId`).   |

### Example

```
# Spawn a subagent
sessions_spawn({ task: "research topic X", ... })
# => { status: "accepted", runId: "abc-123", childSessionKey: "agent:main:subagent:..." }

# Later, stop it
sessions_stop({ runId: "abc-123" })
# => { status: "stopped", runId: "abc-123" }
```

### Ownership

The tool automatically passes the caller's session key as `requesterSessionKey`. A subagent can only be stopped by the session that spawned it. Attempts to stop another session's subagent return `{ status: "forbidden" }`.

## Gateway RPC: `agent.abort`

Stops a subagent by `runId` via the gateway WebSocket protocol.

### Authorization

- Method is in the `WRITE_METHODS` set.
- Requires `operator.write` scope.

### Request

```json
{
  "method": "agent.abort",
  "params": {
    "runId": "abc-123"
  }
}
```

| Parameter | Type   | Required | Description        |
| --------- | ------ | -------- | ------------------ |
| `runId`   | string | yes      | The target run ID. |

### Response

```json
{
  "ok": true,
  "runId": "abc-123",
  "stopped": true
}
```

| Field     | Type    | Description                                                                          |
| --------- | ------- | ------------------------------------------------------------------------------------ |
| `ok`      | boolean | Always `true` (errors use the standard error frame).                                 |
| `runId`   | string  | Echoed back from the request.                                                        |
| `stopped` | boolean | Whether the subagent was actually stopped.                                           |
| `reason`  | string  | Present when `stopped` is `false`: `not_found`, `already_ended`, `no_child_session`. |

### Validation

Params are validated against `AgentAbortParamsSchema` (TypeBox). Invalid requests receive an error response with code `INVALID_REQUEST`.

## Data Flow

```
sessions_spawn returns:              sessions_stop accepts:
┌─────────────────────┐              ┌─────────────────┐
│ { status: "accepted"│              │ { runId: "abc"} │
│   runId: "abc",     │──(runId)───►│                 │
│   childSessionKey } │              └────────┬────────┘
└─────────────────────┘                       │
                                              ▼
                                    subagentRuns Map (in-memory)
                                    ┌─────────────────────────────┐
                                    │ "abc" → {                   │
                                    │   runId: "abc",             │
                                    │   childSessionKey: "...",   │
                                    │   requesterSessionKey: ..., │
                                    │   endedAt: undefined,       │ ← checked: skip if set
                                    │   ...                       │
                                    │ }                           │
                                    └──────────────┬──────────────┘
                                                   │
                                         childSessionKey
                                                   │
                                    ┌──────────────┼──────────────┐
                                    ▼                              ▼
                          clearSessionQueues()          abortEmbeddedPiRun()
                          (queued messages               (active PI run abort)
                           discarded)
```

## Stop Logic (`stopSubagentByRunId`)

Located in `src/auto-reply/reply/abort.ts`:

1. Look up the run via `getSubagentRun(runId)`.
2. If not found, return `{ stopped: false, reason: "not_found" }`.
3. If `endedAt` is set, return `{ stopped: false, reason: "already_ended" }`.
4. If `requesterSessionKey` is provided and doesn't match the run's requester, return `{ stopped: false, reason: "forbidden" }`.
5. Clear the child session's message queues via `clearSessionQueues()`.
6. Resolve the child session's `sessionId` from the session store and call `abortEmbeddedPiRun()`.
7. Return `{ stopped: true }`.

## Files

| File                                              | Role                                          |
| ------------------------------------------------- | --------------------------------------------- |
| `src/agents/subagent-registry.ts`                 | `getSubagentRun()` — registry lookup by runId |
| `src/auto-reply/reply/abort.ts`                   | `stopSubagentByRunId()` — core stop logic     |
| `src/agents/tools/sessions-stop-tool.ts`          | `sessions_stop` agent tool                    |
| `src/agents/openclaw-tools.ts`                    | Tool registration                             |
| `src/agents/tool-display.json`                    | UI display entry (emoji: `🛑`)                |
| `src/gateway/server-methods/agent.ts`             | `agent.abort` gateway handler                 |
| `src/gateway/server-methods.ts`                   | Authorization (`WRITE_METHODS`)               |
| `src/gateway/protocol/schema/agent.ts`            | `AgentAbortParamsSchema`                      |
| `src/gateway/protocol/schema/types.ts`            | `AgentAbortParams` type                       |
| `src/gateway/protocol/schema/protocol-schemas.ts` | Schema registration                           |
| `src/gateway/protocol/index.ts`                   | `validateAgentAbortParams` validator          |
