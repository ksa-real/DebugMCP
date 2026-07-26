# DebuggingHandler

## Purpose

High-level orchestration layer that coordinates debugging operations between the MCP server and VS Code's debug API. It keeps command dispatch separate from explicit waiting.

## Motivation

Debugging is inherently asynchronous, but an MCP control request should not occupy the caller until an unrelated future stop. `DebuggingHandler` returns once VS Code accepts start, continue, step, or restart commands. Callers that need the next stopped state use `wait_for_debug_stop` with a bounded timeout.

## Responsibility

- Orchestrate debugging operations (start, stop, step, breakpoints)
- Format prompt command-acceptance responses
- Expose an explicit bounded wait for pause or termination
- Format debug state into human/AI-readable responses
- Provide root cause analysis guidance to AI agents
- Manage operation timeouts

## Architecture Position

```
┌───────────────────┐
│  DebugMCPServer   │
└───────────────────┘
        │
        ▼ Delegates to
┌───────────────────┐
│ DebuggingHandler  │  ◄── You are here
└───────────────────┘
        │
        ▼ Uses
┌───────────────────┐
│ DebuggingExecutor │
└───────────────────┘
```

## Key Concepts

### Dispatch and wait semantics

Start, continue, step, and restart commands report acceptance immediately. Launch responses also include the requested configuration name, resolved configuration and session identity when VS Code exposes them, and the current lifecycle state. `wait_for_debug_stop` listens for VS Code stack-frame or termination events and reports the stopped state or a clear timeout.

### Root Cause Analysis

When debugging stops, the handler prompts AI agents to consider whether they found the root cause or just a symptom, encouraging deeper investigation.

## Key Code Locations

- Class definition: `src/debuggingHandler.ts`
- Interface: `IDebuggingHandler`
- Explicit stop wait: `handleWaitForDebugStop()`
- Launch response formatting: `formatLaunchResult()`
- State formatting: `formatDebugState()`

## Design Patterns

- **Command/Observation Separation**: Control operations dispatch; the explicit wait observes
- **Bounded Waiting**: `wait_for_debug_stop` uses `timeoutInSeconds` or a per-call timeout, capped at 300 seconds
- **Dependency Injection**: Executor and config manager are injected via constructor

## Error Handling

All operations wrap errors with context about what operation failed, enabling AI agents to understand and potentially recover from failures.
