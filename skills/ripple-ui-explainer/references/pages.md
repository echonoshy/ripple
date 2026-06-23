# Ripple UI Pages

Use this reference to identify common Ripple App pages from screenshots, then load the detailed page reference.

## Page Map

| Page | Visible clues | Product meaning | Detailed reference |
| --- | --- | --- | --- |
| Sessions / Chat | message timeline, composer, BrainCircuit model icon, send/stop button, work folder badge, attachments | Main conversation workspace backed by a persistent Ripple session and Codex thread | `chat-session.md`, `model-selection.md` |
| Tasks | "Tasks", filters All/Open/Waiting/Blocked/Done, task inbox, selected task detail, Actions, Triggers, Activity | Durable follow-up and multi-step work center | `tasks.md` |
| Files | "Files", workspace tree/list, search, preview panel, upload, more actions | Per-user long-lived workspace file browser | `files.md` |
| Skills | "Skills", skill categories/cards, status icons, Validate/Enable/Edit/Delete, connector panel | Capability and connector management surface | `skills-connectors.md` |
| Settings | avatar/profile, Defaults, Default model, language, usage/storage, diagnostics | User-scoped preferences and account/runtime information | `settings.md` |
| Navigation | top tabs on desktop, bottom tab bar on mobile, profile/settings avatar | Page switching, not execution | `navigation.md` |

## Sessions / Chat

Sessions are the primary conversation workspace. A session contains user and assistant messages, tool/run progress, approvals, connector auth prompts, attachments, generated artifacts, and the persistent Codex thread behind the chat. Users can continue a session, switch model preset, attach workspace files or screenshots, stop a running response, set a work folder, and open related workspace files.

Explain screenshot attachments as part of the current formal conversation. The user may ask follow-up questions about the same screenshot in later messages. Read `chat-session.md` for the exact attachment and send behavior.

## Tasks

Tasks are Ripple's durable follow-up and multi-step work center. Use `tasks.md` for detailed semantics.

Visible clues include: "Tasks", filters such as All/Open/Waiting/Blocked/Done, task status chips, Actions, Triggers, Activity, Confirm, Run now, Pause, Resume, Edit, Delete, and Source session.

## Files

Files is the current user's workspace file browser. It shows the long-lived per-user workspace, not a per-session temporary folder. Users can browse folders, upload files, search, preview documents or images, select files, and use files as context for chat. Read `files.md` before explaining file action menus or preview controls.

Explain destructive file actions carefully. Deleting, replacing, or moving files changes the user workspace.

## Skills / Connectors

Skills are Markdown-based capability instructions available to Codex. Shared skills come from the repository; workspace skills live under `/workspace/skills`. Connector-backed skills may need Google Workspace, Notion, Feishu/Lark, or Bilibili authorization before they can work.

Connectors show auth state and account state. Connecting or disconnecting a connector changes per-user credentials or access state; do not describe it as a harmless view-only action.

## Settings

Settings contains user profile, default model, language, usage limits, workspace storage, session counts, runtime diagnostics, and related preferences. Most settings affect the current Ripple user, not every user.

## Common Navigation

Top-level tabs on desktop and bottom tabs on mobile switch between primary work areas. A tab click usually navigates; it does not run work by itself.

Refresh buttons reload server state for the visible page. They should not create, delete, or execute tasks by themselves.
