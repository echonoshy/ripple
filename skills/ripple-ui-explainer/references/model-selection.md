# Ripple Model Selection

Use this for the BrainCircuit model button, Lite/Plus/Pro/Ultra labels, `/models`, Settings default model, and "which model should I choose" questions.

## Code Sources

- `app/src/lib/models.ts`
- `app/src/lib/modelPreference.ts`
- `app/src/components/workbench/SessionComposer.tsx`
- `app/src/components/workbench/SettingsPage.tsx`
- `app/src/App.tsx`
- `app/src/lib/api.ts`
- `crates/ripple-server/src/api/models.rs`
- `crates/ripple-server/src/config.rs`
- `config/settings.yaml.sample`

## What The Four Options Mean

`app/src/lib/models.ts` maps internal preset ids to UI labels:

| Preset id | UI label | Current sample config | Practical explanation |
| --- | --- | --- | --- |
| `codex-low` | Lite | `reasoning_effort: "low"` | Fastest/lightest preset. Good for simple UI explanations, short edits, and low-risk questions. |
| `codex-medium` | Plus | `reasoning_effort: "medium"` | Default balanced preset. Good for normal chat, code reading, and everyday work. |
| `codex-high` | Pro | `reasoning_effort: "high"` | More reasoning budget. Good for harder debugging, architecture, and multi-step implementation. |
| `codex-xhigh` | Ultra | `reasoning_effort: "xhigh"` | Highest reasoning budget. Good for complex, high-stakes, or long-context analysis when speed/cost is less important. |

Important: do not tell the user these are necessarily four different underlying model families. In the current sample config, all four map to `openai-codex: "gpt-5.5"` and differ by `reasoning_effort`. Deployments may change `config/settings.yaml`, so phrase it as "the current Ripple presets" unless you have inspected the live config.

## How The Menu Is Built

Frontend:

- `fetchModels()` calls `GET /models` and reads `data.data`.
- `sortModelOptions()` orders known ids as `codex-low`, `codex-medium`, `codex-high`, `codex-xhigh`.
- `formatModelName()` renders Lite, Plus, Pro, Ultra.
- `selectPreferredModel()` prefers the stored default, then `codex-medium`, then the first returned model.

Backend:

- `crates/ripple-server/src/api/models.rs` returns keys from `state.config.model_presets` with `owned_by: "ripple"`.
- `crates/ripple-server/src/config.rs` uses `resolve_model(selected)` to map the selected alias to the configured underlying Codex model and `reasoning_effort`.

## Composer Model Button

Visible clue:

- BrainCircuit icon in the composer toolbar.
- `data-ripple-composer-model-button`.
- Tooltip/aria label is `composer.selectModel`.

Click effect:

- `SessionComposer.tsx` opens a menu with `data-ripple-composer-model-menu`.
- The menu has `role="menu"` and each option is `role="menuitemradio"`.
- The visible options are the available models rendered through `formatModelName`: usually Lite, Plus, Pro, Ultra.
- The selected option gets accent styling and `aria-checked=true`.
- Touch selection uses `handleModelOptionPointerDown`; mouse/click selection uses `handleModelOptionClick`.

Selection effect:

- `App.tsx` `handleSelectModel(model)` sets `selectedModel`.
- It remembers a per-session override through `rememberSelectedModelOverride`.
- It persists the selected model as the user default through `persistDefaultModel`.
- If there is an existing selected session, it patches that session with `updateSessionById(sessionId, { model })`.
- It closes the dropdown.

How to explain it:

- "This changes which model preset the current composer/session will use for the next response."
- "It also becomes your remembered default in this app."
- "If the session is already stored, Ripple patches the session's model metadata."

## Settings Default Model

Visible clue:

- Settings page, Defaults section, row labeled Default model.
- Rounded button showing Lite/Plus/Pro/Ultra with a chevron.

Click effect:

- Desktop opens a small menu rendered through `createPortal`.
- Mobile opens `MobileActionSheet` with `data-ripple-settings-model-sheet`.
- Options are the same available models rendered by `formatModelName`.

Selection effect:

- `App.tsx` `handleSelectDefaultModel(model)` calls `persistDefaultModel(model)`, sets `selectedModel`, and remembers an override.
- It does not call `updateSessionById` directly. If explaining persistence, say this is primarily the user's default preference and current app selection, not a direct "run now" action.

## Common Answer Corrections

- Do not say "Lite means a cheap model and Ultra means a different premium model" unless live config proves that.
- Do not say clicking the model icon sends a message. It opens a preset menu.
- Do not say the composer BrainCircuit icon opens the Skills page, Create skill flow, or a skill/workflow picker. The top Skills/能力 navigation tab is the Skills page entry.
- Do not confuse the header current-model badge with the composer model dropdown.
- If the screenshot shows only the label "Plus", explain that Plus is the default balanced `codex-medium` preset in the current code.
