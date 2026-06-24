# Ripple Inside Safety Semantics

Use this reference when explaining what happens if the user clicks or uses a visible control.

## View-only or Low-risk

- Navigation tabs: switch pages.
- Filters: change what is visible.
- Refresh: reloads server state.
- Preview/open file: displays content.
- Expand/collapse panels: changes layout only.
- Model menu opening: shows preset choices only.
- Fullscreen preview: changes presentation only.

## Execution or State-changing

- Run now: starts a Codex-backed run or task-trigger run.
- Confirm: approves a candidate task/action/trigger so it can become active or executable.
- Pause/resume trigger: changes future execution behavior.
- Edit/save: changes stored task/action/trigger/settings data.
- Model selection: changes selected/default model preference and may patch current session metadata.
- Connect/disconnect connector: changes connector authorization state.
- Upload: adds files to the user's workspace.
- Work folder selection: changes the chat/session context folder.

## Destructive or Sensitive

- Delete file, delete task, delete trigger, disconnect account, revoke authorization, or overwrite/replace content can remove state or access.
- Sending email, sharing Drive files, changing calendar events, and similar connector writes require explicit user confirmation.
- Moving files changes original location; overwriting upload conflicts can replace existing content.

## How to Explain Risk

Say whether the action is:

- just navigation or viewing,
- changing stored Ripple state,
- starting an execution,
- requiring confirmation,
- potentially destructive.

Do not claim an action has happened unless the screenshot or conversation shows it already completed.
