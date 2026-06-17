# Proactive Tasks Design

Date: 2026-06-17
Status: Approved for implementation

## Summary

Ripple should move from a literal "user asked, then task appears" model to a calibrated proactive assistant model. The system should actively identify useful follow-up opportunities from session context, present them as suggestions, and only turn them into durable tasks after user confirmation.

Automations are no longer a first-class navigation concept. They become task triggers: time-based, recurring, or context-based rules attached to a task action. The user-facing center is Tasks, while Sessions remain the place where suggestions and execution results appear in context.

## Current Problems

The current UI and control-plane model split the same user intent across separate surfaces:

- Sessions can trigger task or schedule creation, but the session does not consistently show follow-up state or results.
- Tasks show internal states such as `Not started` and `Confirmed`, which describe storage state more than user progress.
- Autos are a separate top-level tab even though most automations are really reminders, recurring checks, or scheduled executions for a task.
- Schedule runs currently behave like independent jobs and do not naturally write back to the source session.
- The product waits for explicit instructions instead of offering useful next actions when context implies an upcoming obligation or opportunity.

## Goals

- Merge Autos into Tasks as task triggers and run history.
- Add a proactive suggestion layer that can infer useful next actions from user context.
- Require user confirmation before a suggestion becomes a durable task.
- Use risk-based execution permissions so low-risk work can proceed after task-level approval, while high-risk real-world actions require explicit confirmation each time.
- Ensure every task or trigger execution has visible feedback in both the task timeline and the source session when one exists.
- Make Web and App navigation simpler and more legible.

## Non-Goals

- Do not build ticket booking, payment, alarm, or location automation in this implementation unless existing connectors already support the needed capability.
- Do not make the system silently create durable tasks from weak signals.
- Do not allow high-risk connector writes without explicit user confirmation.
- Do not move backend control-plane behavior into the frontend.
- Do not remove existing schedule APIs abruptly; keep compatibility while changing the primary user experience.

## Product Model

### Suggestion

A Suggestion is an inferred opportunity. It is shown to the user but is not a formal commitment.

Examples:

- "You mentioned a business trip tomorrow. I can create a preparation task and remind you tomorrow morning."
- "You said you need to report to your manager. I can track the material preparation and summarize recent git updates."
- "You are waiting for a reply. I can remind you to follow up if nothing changes by Friday."

Suggestion requirements:

- Include a clear reason based on visible session context.
- Include proposed actions and trigger times when applicable.
- Include risk labels for proposed actions.
- Offer explicit actions: confirm, adjust, ignore.

### Task

A Task is a user-confirmed durable goal, obligation, deliverable, or opportunity.

Task requirements:

- Store the objective and source session when available.
- Track actions, triggers, run history, progress, and blockers.
- Use user-facing statuses: suggestion, active, scheduled, waiting, blocked, done, cancelled.
- Avoid exposing implementation labels such as "confirmed" as if they were user progress.

### Action

An Action is a concrete step inside a task.

Action requirements:

- Represent work that can be run, reminded about, delegated to Codex, or marked complete.
- Carry risk level and confirmation requirements.
- Store result summaries and errors.

### Trigger

A Trigger is the unified replacement for top-level Autos.

Trigger types:

- Manual run.
- One-time scheduled run.
- Recurring scheduled run.
- Future context trigger, when supported later.

Implementation note: existing schedule records can remain as the storage mechanism for time-based triggers, but user-facing UI should present them under Tasks.

### Run

A Run is an execution attempt for a task action or trigger.

Run requirements:

- Record start, completion, failure, and output.
- Link to task and action when applicable.
- Write visible results into the task timeline.
- Write visible results back into the source session when one exists.

## Risk And Confirmation Model

Ripple should be proactive in discovery and conservative in authority.

Risk levels:

- Low risk: create a task, create a reminder, summarize local workspace context, draft a checklist, read public information, run a local analysis.
- Medium risk: query connected accounts, inspect private documents, prepare a draft, create a calendar-like plan when connector permissions exist.
- High risk: send email, book tickets, pay money, delete or replace files, share documents, update external systems, disconnect accounts.

Confirmation rules:

- Suggestions always need user confirmation before becoming durable tasks.
- Low-risk actions can run under task-level approval.
- Medium-risk actions need clear task-level or action-level approval depending on connector scope.
- High-risk actions require explicit confirmation each time before execution.

## Session Experience

When Ripple detects a useful opportunity, it should respond in the session with a suggestion card instead of silently creating a task.

The card should show:

- Why Ripple thinks this is useful.
- Proposed task title.
- Proposed actions.
- Proposed triggers.
- Risk labels.
- Confirm, adjust, and ignore actions.

After confirmation:

- The session gets a concise confirmation message.
- The new task is linked back to the session.
- Future execution output appears in the session as an assistant update, not only in Tasks.

## Tasks Experience

Tasks becomes the primary follow-up center.

Top-level sections inside Tasks:

- Suggestions: inferred opportunities awaiting user confirmation.
- Active: confirmed tasks with pending or running actions.
- Waiting: tasks waiting for user input, connector auth, or approval.
- Scheduled: tasks with future or recurring triggers.
- History: completed runs and completed tasks.

Task detail should show:

- Objective and source session.
- Next best action.
- Actions.
- Triggers.
- Run history.
- Timeline events.
- Errors and blockers in readable language.

Task cards should use product language:

- "Suggested" instead of "Candidate" when shown as a suggestion.
- "Ready" or "Scheduled" instead of "Confirmed" for pending actions.
- "Running", "Waiting", "Blocked", and "Done" when those are the real user states.

## Navigation

Desktop top navigation:

- Sessions
- Tasks
- Files
- Skills

Autos should be removed from the primary navigation. Existing automation management should be accessible from Tasks as triggers or history.

Mobile bottom navigation:

- Sessions
- Tasks
- Files
- Skills
- Me

Mobile task detail pages should use the existing pattern: first-level pages in bottom tabs, second-level detail pages with a clear top back affordance.

## Backend Design

The backend remains the control plane.

Required backend changes:

- Treat schedule records as task triggers when `task_id` or `task_action_id` is present.
- Expose schedule-task links in the frontend API types.
- Ensure chat-created proactive suggestions use task proposal semantics before becoming confirmed tasks.
- When a scheduled run is tied to a task/action, run it through task-aware execution or apply equivalent task/session writeback behavior.
- Persist task events for suggestion created, suggestion confirmed, trigger created, trigger fired, run completed, and run failed.
- Preserve existing schedule APIs for compatibility.

The initial implementation can reuse existing schedules for trigger storage. A future migration can introduce a first-class `TaskTrigger` store if the schedule model becomes too constrained.

## Frontend Design

Required frontend changes:

- Remove Autos from primary navigation.
- Fold automation list/detail concepts into Tasks as triggers and run history.
- Load schedules alongside tasks and group linked schedules under their tasks.
- Show unlinked schedules in a compatibility section inside Tasks so existing data is not lost.
- Add suggestion-oriented copy and filters.
- Show session source and result writeback status prominently.
- Replace raw task event names with readable event labels.

The first implementation should keep visual density close to the existing workbench style and avoid a large decorative redesign.

## Phased Implementation

Phase 1: Merge navigation and display model.

- Remove Autos from top-level navigation.
- Add schedule/trigger data to Tasks.
- Show linked schedules under task details.
- Keep unlinked schedules visible in Tasks under "Standalone plans" or "Unlinked triggers".

Phase 2: Close the execution feedback loop.

- For task-linked schedule runs, write status and result back to the task timeline.
- If a source session exists, append the final assistant-visible result to that session.
- Improve status labels and task event language.

Phase 3: Add proactive suggestion semantics.

- Update Codex-facing prompt and chat control-plane handling to produce candidate suggestions for inferred opportunities.
- Add suggestion card rendering in sessions.
- Add confirm/adjust/ignore flows.

Phase 4: Risk-based permissions.

- Add explicit risk labels for actions.
- Enforce confirmation rules for high-risk operations.
- Surface connector auth and approval blockers inside task detail.

## Testing

Backend tests:

- Task-linked schedule creation preserves `task_id` and `task_action_id`.
- Task-linked schedule run records task events.
- Task-linked schedule completion writes back to the task and source session.
- High-risk action confirmation remains required.

Frontend tests:

- Primary navigation no longer shows Autos.
- Tasks page renders suggestions, active tasks, scheduled triggers, and unlinked schedules.
- Task detail shows trigger metadata and run history.
- Status labels use user-facing language.
- Session suggestion cards expose confirm, adjust, and ignore actions.

Manual verification:

- Desktop Tasks page with existing tasks and existing automations.
- Mobile bottom navigation after Autos removal.
- Mobile task detail back navigation.
- A "tomorrow business trip" session creates a suggestion instead of silently creating an automation.
- A confirmed scheduled task run shows results in both Tasks and source Session.

## Open Implementation Notes

- The first UI implementation may use schedule records directly instead of introducing a new `TaskTrigger` API.
- Existing standalone schedules should remain manageable during the transition.
- The final wording of suggestion cards should be tuned in Chinese and English together.
