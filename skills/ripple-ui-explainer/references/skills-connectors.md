# Ripple Skills And Connectors Page

Use this for Skills page screenshots, skill cards, status icons, category rows, connector panels, auth buttons, disconnect buttons, and Google account rows.

## Code Sources

- `app/src/components/workbench/SkillsPage.tsx`
- `app/src/components/workbench/SkillDescriptionMarkdown.tsx`
- `app/src/lib/api.ts`
- `crates/ripple-server/src/skills.rs`
- `docs/SKILLS.md`

## Page Meaning

Skills are Markdown/YAML-frontmatter capability instructions available to Codex. Ripple exposes shared skills from the repository and user/workspace skills from the user's workspace. Some skills depend on connectors such as Google Workspace, Notion, Feishu/Lark, or Bilibili.

The Skills page is also where connector state is surfaced in the current app. Connector-backed categories can show a connector panel with connected/not connected status and account details.

## Category Index

Visible clues:

- `data-ripple-skill-category-index="true"`.
- Category rows with right chevron.
- Connector status tags on some categories.

Behavior:

- Clicking a category opens `data-ripple-skill-category-detail="true"`.
- It is navigation within the Skills page. It does not enable a skill or connect a service by itself.
- Search and status filters narrow visible skill cards.

## Skill Cards

Visible clues:

- `data-ripple-skill-card="true"`.
- Skill title, description, status icon, buttons such as Validate, Enable/Disable, Edit, Delete.

Behavior:

- Validate calls `validateSkill(skill.id)` and refreshes skill validation state.
- Enable/Disable calls `updateSkill(skill.id, { enabled: ... })`; it changes desired state for a user skill.
- Edit opens a chat workflow through `openEditSkillChat(skill)` when the skill is editable and user-owned.
- Delete uses a two-step confirm label and then `deleteSkill(skill.id)`; this removes or archives the user skill from the current user's skill surface.
- Shared/read-only skills cannot be edited or deleted in the same way as user skills.

## Connector Panel

Visible clues:

- `data-ripple-skill-connector-panel="true"`.
- Status chip saying connected/not connected.
- Button text like Connect service or Disconnect service.

Behavior:

- If not connected, Connect opens a chat/control-plane auth flow using `type: "connector.auth.start"`.
- It may show an authorization URL or resume after auth, depending on connector.
- If connected, Disconnect uses `disconnectConnector(connectorName)` after a confirmation state.
- Disconnect changes per-user connector credentials or access state; it is not just hiding the UI.

## Google Workspace Account Rows

Visible clue:

- `data-ripple-skill-connector-account="true"`.
- Email address plus ready/invalid status.

Behavior:

- Rows are shown when Google Workspace accounts are available.
- Removing an account calls `disconnectConnector("google_workspace", { email })` after confirmation.
- Explain account removal as credential/access removal for that Ripple user.

## How To Answer

For skill/connector questions, include:

- Whether the user is looking at a skill, a category, or a connector panel.
- Whether the control navigates, validates, enables, starts auth, edits, deletes, or disconnects.
- Whether the target is shared/read-only or user-owned if visible.
- Connector auth/disconnect actions are state-changing and may affect future Codex work.
