# Ripple Tasks

Tasks are Ripple's durable follow-up model. They are not just a visual todo list and not a standalone scheduler page.

## Code Sources

- `app/src/components/workbench/TasksPage.tsx`
- `app/src/lib/api.ts`
- `crates/ripple-server/src/api/tasks.rs`
- `crates/ripple-server/src/api/task_triggers.rs`
- `crates/ripple-server/src/task_actions.rs`

## Core Concepts

- Task: a persistent work item, obligation, deliverable, or follow-up that may outlive the current chat.
- Action: a concrete step under a task. Multi-step work should be represented as one task with multiple actions.
- Trigger: a condition that can run a task/action later or repeatedly. The current concrete driver is time-based trigger.
- Activity: the task timeline, including creation, confirmation, runs, progress, waiting states, errors, and completion.
- Source session: the session where the task came from or should return to. Task-trigger execution can reuse that session/Codex thread and write results back to the task and source session.

## Statuses

- Candidate / needs confirmation: proposed by the assistant or inferred from context. The user must confirm before it should become active or executable.
- Active / confirmed: accepted and ready for execution or tracking.
- In progress: currently being worked on.
- Waiting user: blocked on user input or a missing detail.
- Blocked: cannot proceed until an external problem is resolved.
- Completed / archived / cancelled: finished, hidden, or stopped.

## Common Controls

| Control | Code anchor | Effect |
| --- | --- | --- |
| Confirm | `confirmTask` | Accepts a candidate task so it can become active/executable. In controlled contexts `onConfirmTask` may handle it. |
| Run now | `runTaskNow` | Starts immediate Codex-backed execution for the task using stored task context. |
| Source session | `onOpenSession(sourceSessionId)` | Opens the session where the task came from or should write back to. |
| Cancel | `cancelTask` | Stops/cancels stored task state after a two-step confirm label. |
| Delete | `deleteTask` | Deletes task state after a two-step confirm label. Treat as destructive. |
| Add action | `createTaskAction` | Adds a concrete step under the selected task. |
| Edit action | `updateTaskAction` | Updates action title/body/status/sequence depending on form. |
| Reorder actions | `updateTaskAction(... { sequenceIndex })` | Changes action order. |
| Add trigger | `createTaskActionTrigger` | Creates a trigger for an action under the selected task. |
| Edit trigger | `updateTaskTrigger` | Changes timing, enabled state, run policy, or model fields visible in the form. |
| Pause/resume trigger | `updateTaskTrigger(... { enabled: !trigger.enabled })` | Disables or re-enables future trigger execution. |
| Run trigger now | `runTaskTriggerNow` | Runs that trigger immediately instead of waiting for the due time. |
| Delete trigger | `deleteTaskTrigger` | Removes the trigger after confirmation. |

## Page Layout

Visible data attributes:

- `data-ripple-task-page="true"`: overall task page.
- `data-ripple-task-focus-split="true"`: split layout.
- `data-ripple-task-list="true"` and `data-ripple-task-inbox="true"`: left task inbox/list.
- `data-ripple-task-detail="true"`: selected task detail.
- `data-ripple-task-summary="true"`: task summary/header.
- `data-ripple-task-actions-panel="true"`: actions under the task.
- `data-ripple-task-activity-panel="true"`: activity/event timeline.

The accepted product direction is a left inbox plus a right focused execution panel. Do not describe it as a generic card board.

## Filters And States

Common filters: All, Open, Waiting, Blocked, Done.

Explain filters as view filters only. Switching a filter does not change task state.

Task statuses:

- Candidate / needs confirmation: proposed but not fully accepted.
- Active / confirmed: accepted and ready for execution/tracking.
- In progress: work is running.
- Waiting user: needs user input.
- Blocked: cannot proceed until an external problem is resolved.
- Done/completed/cancelled/deleted: final or removed states depending on UI.

## What To Say In UI Answers

When a screenshot shows the Tasks page, explain that the left side is usually the task inbox/list and the right side is the selected task's focused execution workspace. The right side may include summary, actions, triggers, and activity.

When explaining "Run now", mention that it can start real Codex execution and may update task events/actions and the source session. If a task or trigger is still pending confirmation, explain that confirmation is usually required first.

When explaining triggers, avoid saying "schedule" as if it were a separate product. In Ripple, time scheduling is one Task Trigger driver.

When explaining source session, be precise: execution/writeback uses the task's stored `source_session_id`, which may differ from whatever session the user is currently viewing.

When the screenshot does not show the selected task's full details, avoid claiming exact run target, timing, or source session.
