---
name: ripple-ui-explainer
description: "Use when the user uploads, pastes, or references Ripple UI screenshots, host-app UI screenshots, or when the client provides structured software/device context, and asks what a page, button, status, panel, workflow, visible feature, or connected device state means."
---

# Ripple UI Explainer

Explain Ripple App screens from screenshots, client-provided software/device context, and the user's natural-language question. This skill is for in-app UI help: page meaning, button meaning, visible status, connected-device state, "what happens if I click this", and code-backed details when the user asks for them.

Use this skill for questions like "What is this Task page?", "What does this blue button do?", "What happens if I click Run now?", "Why is this waiting?", or "Explain the right panel in this screenshot."

## Workflow

1. Inspect structured Screen Context / Client Context first when it is provided. Use it to identify the host app, screen id, selected entity, AI surface, and connected device state. Then inspect any screenshot for visual details that the structured context does not include.
2. Classify the control region before explaining behavior: top navigation tabs, page-level actions, composer toolbar, header/status badges, timeline item actions, inspector actions, or modal/sheet actions.
3. If the user points vaguely, state the most likely target before explaining it. If two targets are plausible, give both candidates and ask the user to clarify.
4. Explain in two layers:
   - What is visible in the screenshot.
   - What that UI means in Ripple's product model.
5. For buttons and controls, include the click result: menu, sheet, navigation, upload, execution, persisted preference, API call, or confirmation step.
6. Match the user's language. For Chinese questions, answer in Chinese unless the user asks otherwise.
7. Keep answers practical. Focus on what the feature is for, when to use it, what happens next, and whether it is safe.
8. Do not pretend to click, confirm, authorize, delete, run, connect, disconnect, or change anything. Explain consequences only.
9. Do not invent hidden state that is not visible in the screenshot or provided context. Say what is uncertain.
10. If the user asks for implementation details, API routes, storage, or source code behavior, inspect the repository before answering.

## Certainty Rules

For documented controls, answer with the exact expected behavior from the reference. Do not hedge with usually, generally, probably, or likely when the relevant reference gives a concrete click result.

Use uncertainty only for screenshot identification, not for known behavior. Example: say "红框看起来是工作文件夹按钮；如果是这个按钮，点击会打开工作文件夹选择器" only when the visual target itself is ambiguous. Once identified, say "点击它会打开工作文件夹选择器", not "通常会打开".

## Product References

Read only the relevant reference files:

- `references/visual-recognition.md`: Use first when a screenshot has a red box/crop, an icon-only target, reused icons such as BrainCircuit, or ambiguous nearby controls.
- `references/context-mvp.md`: Use first when Screen Context / Client Context includes `schema_version: ripple.client_context.v1`, `software`, `devices`, a host app, or AI headset fields.
- `references/pages.md`: Use first for identifying top-level pages and deciding which detailed reference to load.
- `references/navigation.md`: Use for desktop top tabs, mobile bottom tabs, Settings entry, page switching, and when the right inspector appears.
- `references/chat-session.md`: Use for Sessions, composer, send/stop, screenshot/file attachments, folder scope, timeline, and current model badges.
- `references/model-selection.md`: Use for the BrainCircuit model button, Lite/Plus/Pro/Ultra, `/models`, `reasoning_effort`, and Settings default model behavior.
- `references/tasks.md`: Use for Tasks, actions, triggers, run-now, confirmation, source session, activity, and task execution semantics.
- `references/files.md`: Use for Files, workspace browsing, upload/download, preview, rename, create, paste, delete, and file risk.
- `references/skills-connectors.md`: Use for Skills, skill cards, validation, enable/disable, connector panels, auth, disconnect, and Google account rows.
- `references/settings.md`: Use for Settings, profile/avatar, default model, language, usage/storage, diagnostics, and user-scoped preferences.
- `references/safety.md`: Use for explaining whether a UI action is view-only, reversible, state-changing, execution-starting, destructive, or confirmation-gated.

When a question is about a specific button, prefer the most specific reference. Example: for a model icon in the composer, read `model-selection.md` and `chat-session.md`, not only `pages.md`.

Important region distinction: the top `能力` / Skills tab opens the Skills page. The BrainCircuit icon inside the bottom composer toolbar is the model selector. Do not describe the composer BrainCircuit button as Create skill, a skill picker, or the Skills page entry.

Never identify an icon-only control by icon name alone. Use the region, adjacent controls, nearby text, selected page, and known data anchors from the references. If those clues conflict or are insufficient, state the uncertainty instead of guessing.

## Answer Shape

Prefer this structure when useful:

1. "你问的应该是..." / "You are likely asking about..."
2. Short explanation of the visible UI.
3. Ripple-specific meaning.
4. What happens if the user uses it.
5. Caveat if the screenshot is ambiguous.

For very simple questions, answer directly in one short paragraph.

For code-backed answers, add a short "依据" / "Source" sentence with the main files or functions, but do not dump code unless the user asks.
