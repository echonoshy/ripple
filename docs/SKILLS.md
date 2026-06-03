# Skills

Ripple skills are Markdown files with YAML frontmatter. They are not part of the backend control plane.

## Layout

- Shared skills live under `skills/*`.
- Workspace skills may live under `<user workspace>/skills/`.
- Each skill entrypoint is `SKILL.md`.
- A skill may include scripts, templates, references, and other resources next to its `SKILL.md`.

## Runtime Contract

- Rust renders the skill manifest in `crates/ripple-server/src/skills.rs` and injects it into the Codex-facing prompt.
- Codex reads the relevant `SKILL.md` and adjacent resources from the user workspace or shared skill mounts.
- Ripple skills are manifest-driven instructions plus local helpers; connector auth, confirmations, and account state stay in the Ripple control plane.
- The prompt only receives skills that are enabled and whose bin/connector requirements are satisfied. Disabled, pending, conflicting, missing, or connector-blocked skills remain visible through the control-plane catalog but are not advertised to Codex as available skills.
- Connector-backed skills should declare both the required helper binary and the required connector in frontmatter, for example `requires.bins: ["gog"]` and `requires.connectors: ["google_workspace"]`.

## Capability Catalog

- `GET /v1/capabilities` returns the unified catalog for the current `X-Ripple-User-Id`: user connectors, runtime capabilities, Ripple shared skills, and user workspace skills.
- Each capability has a stable `id`, `type`, `source`, `status`, `enabled`, `requirements`, `related_skills`, and `related_connector`.
- The catalog is the internal aggregation source for connector status, skill prompt gating, and diagnostics. Runtime capabilities remain internal; ordinary users manage skills and connectors, not runtime entries.

## User Skill Management

- `GET /v1/skills` returns a user-facing skill list and omits runtime capabilities.
- `POST /v1/skills` creates a user skill draft under the current user workspace `skills/` directory.
- `PATCH /v1/skills/{skill_id}` edits, enables, or disables user skills. Ripple shared skills are read-only.
- `DELETE /v1/skills/{skill_id}` archives a user skill after explicit confirmation; archived skills no longer participate in manifest rendering.
- `POST /v1/skills/{skill_id}/validate` records format, safety, dependency, and preview-test checks. New or edited user skills must validate before they can be enabled.
- Chat-side “save this as a skill” requests create draft user skills only. They are not auto-enabled and do not enter the Codex prompt until validation passes and the user enables them.

## Namespaces

- `codex:*` is reserved for service-provider allowlisted, auth-neutral Codex capabilities. Ripple does not expose Codex marketplace/user-installed connector skills as user resources.
- `ripple:*` is the shared product skill namespace. These entries come from `skills/*`, are read-only product resources, and may require configured bins/vendor CLIs.
- `user:*` is loaded only from the current user workspace `skills/` directory. User skills are draft/pending by default and must be validated and explicitly enabled before they are injected into Codex. A user skill with the same local name as a shared skill is kept in the manifest as `conflict_disabled` and does not override `ripple:*`.

Codex-native `.agents/skills` and `.codex/skills` are not Ripple user-skill install locations. The app-server launch path disables Codex native apps/plugins/bundled skill instructions and the managed permission profile denies those workspace native skill roots.

## Helper Implementations

Skills may use helper CLIs or scripts next to their `SKILL.md`. Current examples:

- `crates/bilibili-cli` provides the `bilibili` binary used by `skills/bilibili/*`.
- `skills/podcast/*/pipeline.py`
- `skills/lark/lark-slides/scripts/*.py`

Skill helper paths must be relative to their skill directory unless the helper is a configured vendor CLI exposed on PATH. Do not depend on removed backend packages such as the legacy Python `ripple` control plane or `interfaces.server`.
