# External Agent Runner Design

## Problem

Ripple should not compete with dedicated external agents for complex sandbox work. It should provide the shared server entry point, user sandbox, workspace, skills, task state, lifecycle management, and audit trail. In this version, complex tasks are delegated only to server-installed Codex through Codex app-server.

## Product Shape

Ripple remains the primary agent. It decides whether to answer directly, use basic built-in tools and skills, or launch a specialized trusted agent runner. Users can override the choice, but the default experience should not require them to know which backend is best.

## First Increment

Build a small, testable runner layer and expose it as an `AgentRunner` tool. This version only supports Codex through Codex app-server:

- `ripple.agent_runners.router` classifies prompts into `direct`, `ripple_tools`, or `agent_runner`.
- `ripple.agent_runners.codex_app_server` manages per-user Codex app-server processes over stdio JSON-RPC, starts independent thread/turn jobs, and streams notifications back to Ripple.
- `ripple.agent_runners.manager` tracks jobs, status, cancellation, event logs, stdout/stderr tails, and output files.
- `ripple.tools.builtin.agent_runner` lets the chat agent start, inspect, and cancel external runner jobs.

## Boundaries

Skills keep their value as routing hints and workflow instructions. In the development model, Codex is a trusted executor inside the current user's sandbox and may access that user's workspace, skills, and credentials.

The first runner implementation is Codex app-server based. Codex is installed once by an administrator, but Ripple starts an app-server process per `user_id`, scoped to that user's sandbox view. Destructive or long-running external agent launches still require confirmation through the normal tool permission path.

## Future Work

- Add finer-grained production permission modes if trusted direct credential access becomes too broad.
- Add UI controls for live app-server steering and event replay.
- Persist runner jobs beyond process memory if long jobs need server restart recovery.
