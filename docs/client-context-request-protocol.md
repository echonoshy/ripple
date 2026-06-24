# Ripple Client Context Request Protocol

This document defines the MVP request protocol for sending host-app software context and mock or real device state into Ripple through `/v1/responses`.

The protocol is intentionally screen-level. It tells Ripple which app and screen the user is currently in, what object is selected, and what compact device state is available. It does not try to serialize the full UI tree, DOM, component hierarchy, element coordinates, or every visible button.

## Scope and Intent

Use this protocol when Ripple is embedded inside another app, such as a Viaim host app, and the host app wants the assistant to answer questions grounded in the current screen and connected device state.

Primary use cases:

- Answer "where am I" or "what is this page" questions from the current host-app screen.
- Answer screen-scoped product questions without guessing from screenshots alone.
- Answer current device state questions such as earbud battery, connection, recording, or noise-control mode.
- Test the host-app integration before real hardware or real SDK data is available, by sending `source: "mock"` device state.
- Force a product/support knowledge skill for the turn through `metadata.required_skill_ids`.

Non-goals:

- It is not a connector auth protocol.
- It is not a hardware control protocol.
- It is not a UI automation protocol.
- It is not a replacement for uploaded screenshots when visual details matter.
- It is not a long-term event log. It is a per-request grounding snapshot.

## Wire Contract

Transport:

- Request line: `POST /v1/responses`
- Method: `POST`
- Endpoint: `/v1/responses`
- Local development base URL: `http://127.0.0.1:8810/v1`
- Full local URL: `http://127.0.0.1:8810/v1/responses`

Headers:

```http
Content-Type: application/json
X-Ripple-User-Id: <user_id>
Authorization: Bearer <api_key>
```

Header rules:

- `X-Ripple-User-Id` is the Ripple user-isolation key. If omitted, the server may fall back to `default`, but test tools should send it explicitly.
- `Authorization` is required only when the running Ripple server has API key middleware enabled.
- The test tool reads `RIPPLE_API_KEY` and sends it as `Authorization: Bearer <value>` when present.

Body shape:

```json
{
  "model": "codex-high",
  "stream": true,
  "input": [
    {
      "role": "user",
      "content": "现在耳机电量是多少？"
    }
  ],
  "metadata": {
    "ripple_session_id": "client-context-demo",
    "required_skill_ids": ["ripple:viaim-product-support"],
    "client_context": {
      "schema_version": "ripple.client_context.v1",
      "captured_at": "2026-06-24T00:00:00.000Z",
      "producer": {
        "type": "host_app",
        "name": "viaim-meeting"
      },
      "software": {
        "host_app": {
          "app_id": "viaim.meeting",
          "name": "Viaim Meeting",
          "embedding": "ripple_sdk"
        },
        "ai_surface": {
          "surface_id": "meeting.detail.ai_panel",
          "mode": "embedded_panel"
        },
        "screen": {
          "screen_id": "meeting.detail",
          "title": "会议详情",
          "layout": "mobile"
        },
        "selection": {
          "type": "meeting",
          "entity_id": "meeting_123",
          "display_name": "产品周会"
        },
        "entities": [
          {
            "type": "meeting",
            "id": "meeting_123",
            "title": "产品周会",
            "state": {
              "status": "ended",
              "has_transcript": true,
              "has_summary": true
            }
          }
        ]
      },
      "devices": [
        {
          "id": "headset:primary",
          "kind": "ai_headset",
          "source": "mock",
          "identity": {
            "manufacturer": "viaim",
            "model": "AI Earbuds",
            "firmware_version": "1.2.3"
          },
          "connection": {
            "state": "connected",
            "transport": "bluetooth"
          },
          "state": {
            "left_battery_percent": 80,
            "right_battery_percent": 78,
            "case_battery_percent": 55,
            "wearing_state": "in_ear",
            "noise_control": "anc",
            "recording": false
          },
          "capabilities": ["audio_input", "audio_output", "transcription", "noise_control"]
        }
      ]
    }
  }
}
```

## Client Context Schema

`metadata.client_context` must be a JSON object. The current schema version is:

```json
"ripple.client_context.v1"
```

Top-level fields:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `schema_version` | string | yes | Protocol version. Use `ripple.client_context.v1`. |
| `captured_at` | string | recommended | ISO-8601 timestamp when the host app captured the snapshot. |
| `producer` | object | recommended | Describes the component that produced the context. |
| `software` | object | recommended | Current host-app and screen context. |
| `devices` | array | optional | Compact connected device snapshots. |

### Producer

`producer` identifies the source of the snapshot.

```json
{
  "type": "mock_host_app",
  "name": "viaim-meeting-demo"
}
```

Rules:

- Use `type: "mock_host_app"` or `source: "mock"` when test data is not backed by real host app or hardware state.
- Do not imply real hardware state if the host app is only replaying fixture data.
- Keep producer fields descriptive. They are not authentication claims.

### Software Context

`software` describes the host app, embedded AI surface, current screen, and selected object.

```json
{
  "host_app": {
    "app_id": "viaim.meeting",
    "name": "Viaim Meeting",
    "embedding": "ripple_sdk"
  },
  "ai_surface": {
    "surface_id": "meeting.detail.ai_panel",
    "mode": "embedded_panel"
  },
  "screen": {
    "screen_id": "meeting.detail",
    "title": "会议详情",
    "layout": "mobile"
  },
  "selection": {
    "type": "meeting",
    "entity_id": "meeting_123",
    "display_name": "产品周会"
  },
  "entities": []
}
```

Field rules:

- `host_app.app_id` is the namespace for the host product. Examples: `viaim.meeting`, `viaim.app`, `ripple.app`.
- `host_app.embedding` describes how Ripple is embedded. Example values: `ripple_sdk`, `webview`, `native_panel`.
- `ai_surface.surface_id` identifies the AI panel or surface inside the host app.
- `ai_surface.mode` can be `embedded_panel`, `full_app`, `sheet`, or another host-defined mode.
- `screen.screen_id` is the most important software field. It should identify the current page or view at screen-level granularity.
- `screen.title` is display text. It helps the model answer naturally but should not replace `screen_id`.
- `screen.layout` should be broad: `mobile`, `desktop`, `tablet`, or `web`.
- `selection` should describe the selected business object, not a button or DOM node.
- `entities` can include compact facts about selected or visible business objects.

Screen-level granularity examples:

| Good | Too fine-grained |
| --- | --- |
| `meeting.detail` | `button.summary.copy` |
| `session.chat` | `composer.toolbar.model_selector.icon` |
| `files.browser` | `row.4.more_menu.rename` |
| `settings.profile` | `avatar.upload.button` |

The host may still include a small state object inside an entity, such as `has_summary`, `current_model`, `is_recording`, or `active_folder`. Keep it compact and business-level.

### Devices

`devices` contains compact hardware state snapshots.

```json
{
  "id": "headset:primary",
  "kind": "ai_headset",
  "source": "mock",
  "identity": {
    "manufacturer": "viaim",
    "model": "AI Earbuds",
    "firmware_version": "1.2.3"
  },
  "connection": {
    "state": "connected",
    "transport": "bluetooth"
  },
  "state": {
    "left_battery_percent": 80,
    "right_battery_percent": 78,
    "case_battery_percent": 55,
    "wearing_state": "in_ear",
    "noise_control": "anc",
    "recording": false
  },
  "capabilities": ["audio_input", "audio_output", "transcription", "noise_control"]
}
```

Device field rules:

- `id` is stable inside the host app's current context. It does not need to be globally unique.
- `kind` selects the broad hardware category, such as `ai_headset`.
- `source` tells whether the data is real or simulated. Use `source: "mock"` for fixture data.
- `identity` fields are hints for product knowledge matching. They do not prove every capability is available.
- `connection.state` can be `connected`, `disconnected`, `connecting`, or host-defined values.
- `state` is current state, not a command.
- Battery fields are percentages from `0` to `100`.
- `noise_control: "anc"` means active noise cancellation mode is currently reported.
- `recording: false` means the host reports that recording is not active.
- `capabilities` are possible functions, not proof that permissions are granted or a function is currently running.

## Metadata Fields

`metadata.ripple_session_id`:

- Binds the request to a Ripple session.
- Should be stable across a conversation.
- The dev tool defaults to a generated `client-context-demo-<timestamp>` id.

`metadata.required_skill_ids`:

- Explicitly selects skills for the current turn.
- For Viaim app or headset context, use:

```json
["ripple:viaim-product-support"]
```

`metadata.client_context`:

- Carries the structured context object.
- Must be a JSON object.
- Should not include secrets, OAuth tokens, cookies, private keys, or raw credentials.

## Server Semantics

Ripple treats `client_context` as control-plane metadata and forwards a rendered version to Codex as application context.

Current server behavior:

- `/v1/responses` reads `metadata.client_context`.
- Non-object `client_context` values are rejected.
- Ripple summarizes important fields such as app id, screen id, selection, and device state.
- Ripple sends the rendered context to Codex as additional context named `ripple_client_context`.
- The user's actual prompt still goes through `input`.
- Viaim software context or a Viaim device can auto-select `ripple:viaim-product-support` when the client did not specify it.
- `metadata.screen_context` with the same `schema_version` can be treated as a compatibility fallback, but new clients should use `metadata.client_context`.

The model should treat this as grounding:

- It can answer facts present in the structured context.
- It can combine those facts with required skill documentation.
- It must not claim an action happened only because `available_actions` or `capabilities` say an action is possible.
- It must not claim real hardware state when the context says `source: "mock"`.

## Example Requests

### Dry Run

Print the generated request without calling the server:

```bash
scripts/dev/send-client-context-request.sh --dry-run
```

### Print This Protocol

```bash
scripts/dev/send-client-context-request.sh --protocol
```

### Show Protocol File Path

```bash
scripts/dev/send-client-context-request.sh --protocol-path
```

### Send to a Local Server

```bash
RIPPLE_API_KEY=rk-local \
scripts/dev/send-client-context-request.sh \
  --url http://127.0.0.1:8810 \
  --user-id mvp_host_demo \
  --session-id client-context-demo \
  --prompt "现在耳机电量是多少？"
```

### Send a Non-Streaming Request

```bash
RIPPLE_API_KEY=rk-local \
scripts/dev/send-client-context-request.sh \
  --no-stream \
  --prompt "解释当前页面和耳机状态"
```

### Use a Custom Context Fixture

The fixture file may be either the `client_context` object itself:

```json
{
  "schema_version": "ripple.client_context.v1",
  "producer": {
    "type": "mock_host_app",
    "name": "custom-fixture"
  },
  "software": {
    "host_app": {
      "app_id": "viaim.app",
      "name": "Viaim",
      "embedding": "ripple_sdk"
    },
    "screen": {
      "screen_id": "device.detail",
      "title": "设备详情",
      "layout": "mobile"
    }
  },
  "devices": []
}
```

Or a full request-like object with `metadata.client_context`:

```json
{
  "metadata": {
    "client_context": {
      "schema_version": "ripple.client_context.v1",
      "software": {
        "screen": {
          "screen_id": "meeting.detail"
        }
      }
    }
  }
}
```

Run:

```bash
scripts/dev/send-client-context-request.sh --dry-run --context-file fixtures/client-context.json
```

## Response Handling

When `stream: true`, the dev tool reads Server-Sent Events and prints:

- `response.output_text.delta` text chunks to stdout.
- SSE event type summaries to stderr, unless `--hide-events` is set.
- Error event details when event type or payload indicates an error.
- `[DONE]` when the stream terminates.

When `--no-stream` is used, the tool prints the raw response body.

## Validation and Error Handling

Client-side tool validation:

- Unknown CLI flags fail fast.
- Flags that require a value fail when the value is missing.
- `--context-file` must contain valid JSON.
- `--context-file` must contain either a `client_context` object, a `metadata.client_context` object, or be the `client_context` object itself.

Server-side validation:

- `metadata.client_context` must be an object if present.
- `metadata.required_skill_ids` must be an array of strings if present.
- `metadata.ripple_session_id` must pass Ripple session id validation if present.

Security rules:

- Do not put credentials in `client_context`.
- Do not put server Codex auth, connector tokens, OAuth refresh tokens, cookies, API keys, or local filesystem secrets in the context object.
- The context is intended for model grounding. Assume it may be summarized into model-visible instructions.

## Versioning

Current version:

```json
"schema_version": "ripple.client_context.v1"
```

Compatibility rule:

- Additive fields are allowed.
- Existing field meaning should not be changed within `v1`.
- Breaking changes should use a new `schema_version`.

Recommended next version triggers:

- Adding command/control semantics.
- Adding real hardware permission state beyond passive status.
- Changing `software.screen` from screen-level to another granularity.
- Changing server routing semantics for skill selection.

## Design Boundary

Keep the protocol small:

- Send current screen/view identity.
- Send selected business object.
- Send compact business or device state.
- Let product knowledge docs explain what the screen and state mean.

Avoid:

- DOM/component dumps.
- Per-button dictionaries.
- Pixel coordinates.
- Long transcript or document bodies.
- Raw screenshots encoded into `client_context`.
- Action execution records unless a separate result/event protocol is introduced.

This boundary is deliberate. It keeps mobile and embedded host-app integrations practical while still giving Ripple enough context to avoid guessing.
