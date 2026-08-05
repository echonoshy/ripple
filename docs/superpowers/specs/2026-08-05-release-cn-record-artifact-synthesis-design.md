# release-cn Record Artifact Synthesis Design

## Goal

Port the Record-derived summary, mind-map, and title synthesis capability from
`039fed4` to `release-cn` without importing the overseas-only model fallback
feature from `0aca22f`.

## Scope

- Preserve the existing `release-cn` provider and sandbox changes.
- Port only the Record request classifier, required-skill selection, bounded
  source bundle, configuration switch, shared skill, helper, and Record tests.
- Keep the existing Responses API contract: automatic selection requires
  `metadata.record_intent = "record_chat"` and a whole-artifact request.
- Enable `skills/record-artifact-synthesis` in the domestic runtime config.
- Keep the helper and its tests compatible with the host Python 3.8 runtime.

## Explicit Exclusions

- Do not merge `0aca22f`, its model fallback chain, fallback retry behavior,
  fallback configuration, documentation, or tests.
- Do not merge `release` wholesale.
- Do not change model/provider selection or restart the running service as part
  of the source merge.

## Data Flow

1. A Record chat request enters `/v1/responses` with `record_intent` metadata.
2. The server classifies only complete summary, mind-map, or title generation
   requests; partial edits remain on the normal chat path.
3. If enabled, Ripple requires the Record synthesis skill and loads the current
   Record `AGENTS.md` plus `transcript.md` or `content.md` from the validated
   workspace context.
4. The source bundle is limited to 256 KiB and marked as untrusted data.
5. The skill writes exactly one target atomically through
   `record_artifact.sh`; summary todos are preserved.

## Error Handling

- Invalid or unavailable required skills remain a client-visible bad request.
- Missing, empty, oversized, or out-of-workspace Record sources do not become a
  server-injected bundle; the skill's bounded fallback workflow applies.
- Helper validation failures must stop without directly editing an artifact.

## Verification

- Prove that the unmodified `039fed4` transplant fails because of the unwanted
  model-fallback tests.
- Prove Python 3.8 compatibility with the helper unit tests.
- Run Record-focused Rust tests, full Rust test compilation and test suite,
  formatting, and `cargo check`.
- Confirm the final diff contains no model fallback symbols and preserves the
  two pre-existing untracked backup paths.
