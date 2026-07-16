# Feishu-only capability exposure

## Goal

Ripple must expose Feishu as the only user-authorizable business capability. Chat sessions may see and invoke Feishu skills through `lark-cli`, but must not see or trigger Google Workspace, Notion, Bilibili, Podcast, or future user connectors unless an administrator explicitly enables them.

The server-side Codex executor and its built-in runtime capabilities remain available because they are Ripple infrastructure rather than user-authorizable business connectors.

## Configuration contract

Add a server-level allowlist:

```yaml
server:
  enabled_connectors:
    - feishu
```

Omitting `enabled_connectors` preserves the current behavior and enables all registered user connectors. Unknown names fail configuration loading so a typo cannot silently expose or hide a capability.

The live deployment will also narrow its runtime assets:

```yaml
server:
  sandbox:
    lark_cli_install_root: "vendor/lark-cli"
    cli_tools: []

skills:
  shared_dirs:
    - "skills/lark"
```

The Notion and Google CLI roots remain unset. Existing binaries and per-user credentials stay on disk so the capabilities can be re-enabled later without data loss.

## Enforcement boundaries

The allowlist is enforced at four boundaries:

1. **Connector discovery:** `/v1/connectors` returns Feishu plus non-authorizable Codex runtime capabilities. Disabled user connectors are absent.
2. **Authorization APIs:** status, authorization, account, disconnect, and related-skill routes reject a disabled user connector as not found. A caller cannot bypass the UI by calling the endpoint directly.
3. **Skill exposure:** only `skills/lark` is loaded as a shared skill directory. Any user/workspace skill that requires a disabled connector is excluded from the chat-visible manifest rather than merely marked unavailable.
4. **CLI execution:** only the configured `lark-cli` installation is mounted into user sandboxes and added to `PATH`. Bilibili, Podcast, Notion, and Google CLIs are not mounted.

The same allowlist must drive discovery, authorization, skill filtering, and prompt context so those surfaces cannot drift apart.

## Chat behavior

When a conversation starts, Ripple builds the connector status and skill context from enabled connectors only. The model receives Feishu skill instructions and can request Feishu authorization when necessary. It receives no instructions, connector status, binary path, or authorization action for disabled business capabilities, so ordinary chat cannot select or trigger them.

Existing sessions must be recycled or the service restarted after the configuration change because Codex workers can retain their initial skill and environment context.

## Failure behavior

- An empty allowlist disables every user-authorizable connector while retaining Codex runtime capabilities.
- An unknown allowlist entry prevents startup with a clear configuration error.
- A disabled connector API request returns the same not-found shape used for unknown connectors, avoiding accidental capability disclosure.
- Missing `lark-cli` causes Feishu-dependent skills to report a missing binary during diagnostics; it does not re-enable another connector.

## Verification

Automated tests will cover:

- default compatibility when the allowlist is omitted;
- config parsing and rejection of unknown connector names;
- connector discovery containing Feishu but excluding Google Workspace, Notion, and Bilibili;
- disabled connector status/auth routes returning not found;
- skill manifests excluding skills that require disabled connectors;
- sandbox configuration mounting `lark-cli` and no other business CLI.

Deployment verification will confirm the live process and config path, restart the service, recycle active workers if needed, then check:

- `/v1/connectors` exposes Feishu and no other user connector;
- a new chat's skill context contains Lark skills only;
- `lark-cli` exists inside a new sandbox;
- `gog`, `ntn`, Bilibili, and Podcast binaries are absent inside that sandbox;
- direct authorization requests for disabled connectors return not found;
- the Feishu authorization flow still starts successfully.

## Rollback

Restore `skills.shared_dirs`, CLI mount settings, and either remove `server.enabled_connectors` or add the desired connector names, then restart Ripple and recycle affected workers. No credentials or skill files need to be restored.
