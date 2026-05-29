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

## Namespaces

- `codex:*` is reserved for service-provider allowlisted, auth-neutral Codex capabilities. Ripple does not expose Codex marketplace/user-installed connector skills as user resources.
- `ripple:*` is the shared product skill namespace. These entries come from `skills/*`, are read-only product resources, and may require configured bins/vendor CLIs.
- `user:*` is loaded only from the current user workspace `skills/` directory. A user skill with the same local name as a shared skill is kept in the manifest as `conflict_disabled` and does not override `ripple:*`.

Codex-native `.agents/skills` and `.codex/skills` are not Ripple user-skill install locations. The app-server launch path disables Codex native apps/plugins/bundled skill instructions and the managed permission profile denies those workspace native skill roots.

## Helper Implementations

Skills may use helper CLIs or scripts next to their `SKILL.md`. Current examples:

- `crates/bilibili-cli` provides the `bilibili` binary used by `skills/bilibili/*`.
- `skills/podcast/*/pipeline.py`
- `skills/lark/lark-slides/scripts/*.py`

Skill helper paths must be relative to their skill directory unless the helper is a configured vendor CLI exposed on PATH. Do not depend on removed backend packages such as the legacy Python `ripple` control plane or `interfaces.server`.
