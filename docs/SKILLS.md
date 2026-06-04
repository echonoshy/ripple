# Skills

Ripple skills are Markdown files with YAML frontmatter. They are not part of the backend control plane.

## Layout

- Shared skills live under `skills/*`.
- Workspace skills may live under `<user workspace>/skills/`.
- Each skill entrypoint is `SKILL.md`.
- A skill may include scripts, templates, references, and other resources next to its `SKILL.md`.
- User-facing source is simplified to `system` and `user`. Internally Ripple still keeps `codex:*`, `ripple:*`, and `user:*` namespaces.

## Runtime Contract

- Rust renders the skill manifest in `crates/ripple-server/src/skills.rs` and injects it into the Codex-facing prompt.
- Codex reads the relevant `SKILL.md` and adjacent resources from the user workspace or shared skill mounts.
- Ripple skills are manifest-driven instructions plus local helpers; connector auth, confirmations, and account state stay in the Ripple control plane.
- The prompt only receives skills that are enabled and whose bin/connector requirements are satisfied. Disabled, pending, conflicting, missing, or connector-blocked skills remain visible through the control-plane catalog but are not advertised to Codex as available skills.
- Connector-backed skills should declare both the required helper binary and the required connector in frontmatter, for example `requires.bins: ["gog"]` and `requires.connectors: ["google_workspace"]`.
- Shared helper `SKILL.md` files that are only internal pipeline references can set `metadata.visibility: internal`; Ripple skips them when building the public catalog and Codex-facing manifest.
- User-created skills support `metadata.kind: text` or `metadata.kind: executable`. First-version user executable skills only support `metadata.runtime: python`.
- Python executable skills declare `metadata.entry` and optional `metadata.requires.python_packages`. The prompt renders an explicit `/workspace/skills/<name>/...` command using `ripple-py python -- ...`; when packages are present it adds one `--with <package>` per requirement.
- `content_hash` covers `SKILL.md`, the Python entrypoint when declared, and files under `assets/`, `references/`, and `resources/` next to the skill.

## Capability Catalog

- `GET /v1/capabilities` returns the unified catalog for the current `X-Ripple-User-Id`: user connectors, runtime capabilities, Ripple shared skills, and user workspace skills.
- Each capability has a stable `id`, `type`, `source`, `status`, `enabled`, `requirements`, `related_skills`, and `related_connector`.
- The catalog is the internal aggregation source for connector status, skill prompt gating, and diagnostics. Runtime capabilities remain internal; ordinary users manage skills and connectors, not runtime entries.

## User Skill Management

- `GET /v1/skills` returns a user-facing skill list and omits runtime capabilities.
- `POST /v1/skills` creates a user skill under the current user workspace `skills/` directory, validates it immediately, and auto-enables it when checks pass and no risky confirmation is required.
- `PATCH /v1/skills/{skill_id}` edits, enables, or disables user skills. Content edits trigger immediate re-validation; Ripple shared skills are read-only.
- `DELETE /v1/skills/{skill_id}` archives a user skill after explicit confirmation; archived skills no longer participate in manifest rendering.
- `POST /v1/skills/{skill_id}/validate` records format, safety, current dependency availability, Python runtime, and content-hash checks. It does not run user scripts or install packages. Safe user skills enter the Codex prompt automatically when validation passes; skills with explicit confirmation/risk flags require the user to enable them.
- Connector names are stored canonically. `lark` is accepted as a compatibility alias and normalized to `feishu`.
- Chat-side “save this as a skill” requests create user skills and run the same automatic validation/activation flow.

## Namespaces

- `codex:*` is reserved for service-provider allowlisted, auth-neutral Codex capabilities. Ripple does not expose Codex marketplace/user-installed connector skills as user resources.
- `ripple:*` is the shared product skill namespace. These entries come from `skills/*`, are read-only product resources, and may require configured bins/vendor CLIs.
- `user:*` is loaded only from the current user workspace `skills/` directory. User skills are draft/pending by default and must be validated and explicitly enabled before they are injected into Codex. A user skill with the same local name as a shared skill is kept in the manifest as `conflict_disabled` and does not override `ripple:*`.

Example Python user skill frontmatter:

```yaml
metadata:
  kind: executable
  runtime: python
  entry: scripts/run.py
  requires:
    python_packages:
      - pandas==2.2.3
    connectors:
      - google_workspace
```

Codex-native `.agents/skills` and `.codex/skills` are not Ripple user-skill install locations. The app-server launch path disables Codex native apps/plugins/bundled skill instructions and the managed permission profile denies those workspace native skill roots.

## Helper Implementations

Skills may use helper CLIs or scripts next to their `SKILL.md`. Current examples:

- `crates/bilibili-cli` provides the `bilibili` binary used by `skills/bilibili/*`.
- `skills/podcast/*/pipeline.py`
- `skills/lark/lark-slides/scripts/*.py`

Skill helper paths must be relative to their skill directory unless the helper is a configured vendor CLI exposed on PATH. Do not depend on removed backend packages such as the legacy Python `ripple` control plane or `interfaces.server`.
