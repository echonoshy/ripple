# Skills

Ripple skills are Markdown files with YAML frontmatter. They are not part of the backend control plane.

## Layout

- Shared skills live under `src/skills/*`.
- Workspace skills may live under `<user workspace>/skills/`.
- Each skill entrypoint is `SKILL.md`.
- A skill may include scripts, templates, references, and other resources next to its `SKILL.md`.

## Runtime Contract

- Rust renders the skill manifest in `crates/ripple-server/src/skills.rs` and injects it into the Codex-facing prompt.
- Codex reads the relevant `SKILL.md` and adjacent resources from the user workspace or shared skill mounts.
- Ripple does not restore the old Python `SkillTool` or model-facing server tool runtime.

## Python Helpers

Python is allowed inside skill helper scripts, for example:

- `src/skills/bilibili/*/pipeline.py`
- `src/skills/podcast/*/pipeline.py`
- `src/skills/lark/lark-slides/scripts/*.py`

Skill helper paths must be relative to their skill directory. Do not depend on removed backend packages such as `src/ripple` or `src/interfaces/server`.
