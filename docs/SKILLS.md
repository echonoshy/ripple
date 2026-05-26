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
- Ripple does not restore the old Python `SkillTool` or model-facing server tool runtime.

## Helper Implementations

Skills may use helper CLIs or scripts next to their `SKILL.md`. Current examples:

- `crates/bilibili-cli` provides the `bilibili` binary used by `skills/bilibili/*`.
- `skills/podcast/*/pipeline.py`
- `skills/lark/lark-slides/scripts/*.py`

Skill helper paths must be relative to their skill directory unless the helper is a configured vendor CLI exposed on PATH. Do not depend on removed backend packages such as the legacy Python `ripple` control plane or `interfaces.server`.
