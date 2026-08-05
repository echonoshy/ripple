# release-cn Release Sync and Model Fallback Design

## Goal

Synchronize `release@039fed4` into `release-cn`, including the model fallback
and Record artifact synthesis changes, while keeping the domestic Coding Plan
provider, sandbox integration, and client-facing model aliases intact.

## Verified Baseline

- `release-cn` contains the domestic provider/sandbox commit `aa666c45` through
  merge commit `d89d62f2`.
- `release@039fed4` adds the fallback design, fallback implementation, and
  Record synthesis feature after common ancestor `e358b2d0`.
- A temporary full merge completed without conflicts and preserved
  `aa666c45`.
- The domestic provider profile uses `volcengine-coding-plan` with
  `model = "glm-latest"`; `glm-latest` currently resolves to GLM-5.2.
- Live Codex Responses probes succeeded for `deepseek-v4-flash-260425` and
  `doubao-seed-2-0-code-preview-260215` with low reasoning effort.

## Branch Synchronization

Merge `origin/release` into `release-cn` with a merge commit so the shared
release history remains traceable. Do not cherry-pick or manually recreate the
fallback implementation. Preserve the domestic-only commits and the two
pre-existing untracked backup paths.

The earlier local design that excluded fallback is superseded by this document
and must not remain as the current repository design.

## Domestic Model Configuration

Keep the existing public preset IDs to avoid breaking clients:

- `codex-low`
- `codex-medium`
- `codex-high`
- `codex-xhigh`

Change each preset's underlying `openai-codex` model from `gpt-5.5` to
`glm-latest`, preserving its existing reasoning effort. Configure this explicit
fallback chain in the domestic runtime settings:

```yaml
model:
  fallback_chain:
    - model: "deepseek-v4-flash-260425"
      reasoning_effort: "low"
    - model: "doubao-seed-2-0-code-preview-260215"
      reasoning_effort: "low"
```

Do not add GPT fallback entries to the domestic runtime. Do not rename the
public `codex-*` presets or require a client release. Filtering the broader
Codex model catalog returned by `/v1/models` is outside this synchronization;
the preset entries must nevertheless report `glm-latest` as their underlying
model after the change.

## Fallback Runtime Behavior

Reuse the upstream implementation unchanged:

1. Resolve the requested preset to its actual model and effort.
2. Try the requested model first, followed by the configured chain with model
   names de-duplicated.
3. Fall back only for model capacity, unsupported model, entitlement, or model
   sampling HTTP 429/502/503/504 failures.
4. Do not retry after assistant output, tool activity, file changes, approvals,
   user input requests, timeout, cancellation, authentication, sandbox, or
   permission failures.
5. Roll back the failed turn before retrying a persistent thread. Stop if that
   rollback fails.
6. Keep fallback transitions internal; preserve the existing Responses/SSE
   contract and caller-visible requested model.

## Record Synthesis Compatibility

Accept the Record synthesis feature included in `039fed4`. Add
`skills/record-artifact-synthesis` to the domestic runtime skill directories.
Adjust only its helper test annotation so the test suite imports under the
host's Python 3.8; do not change Record runtime behavior.

## Verification

- Run `cargo fmt -p ripple-server -- --check`.
- Run `cargo check -p ripple-server`.
- Run `cargo test -p ripple-server`.
- Run the Record helper unit tests with the host `python3`.
- Confirm the final source and runtime configuration contain no GPT fallback
  entries and that all `codex-*` presets resolve to `glm-latest`.
- Re-run minimal direct Coding Plan probes for the primary and both fallback
  models.
- Build the server, drain active work, restart exactly one listener, and prove
  listener PID, executable, cwd, `/health`, authenticated readiness, and a real
  `/v1/responses` request.
- Trigger a controlled unsupported-model request and verify it succeeds through
  the Flash fallback without exposing the intermediate failure to SSE.

## Rollback

Removing `model.fallback_chain` disables automatic fallback without reverting
code. If deployment validation fails, restore the previous server binary and
runtime settings, restart the single listener, and repeat health/readiness
checks. Never roll back or copy the live SQLite files directly.
