# Client Context MVP

Use this reference when the turn includes structured Screen Context / Client Context, especially:

- `schema_version: "ripple.client_context.v1"`
- `software`
- `devices`
- host app fields such as `software.host_app.app_id`
- connected hardware fields such as an AI headset state

This context is an MVP protocol for testing Ripple as an embedded AI module inside another app. The client or host app may collect the software and hardware facts. Ripple should not assume it collected them itself.

## Core Interpretation

Structured context is grounding, not proof that an action happened.

- Use `software.host_app.app_id` and `software.screen.screen_id` to identify the app/page.
- Use `software.ai_surface` to understand where Ripple is embedded: full app, panel, sheet, or inline AI surface.
- Use `software.selection` to understand what entity the user is asking about, such as a meeting, file, message, task, or device.
- Use `software.entities` as compact facts about the selected entity.
- Use `software.available_actions` only as possible UI actions. Do not claim an action ran unless the user or tool result says it did.
- Use `devices` as compact hardware state. Match `kind`, `identity`, `connection`, `state`, and `capabilities` to hardware knowledge before explaining.

## Software Fields

Expected MVP shape:

```json
{
  "schema_version": "ripple.client_context.v1",
  "producer": {
    "type": "host_app_fixture",
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
      "title": "Meeting detail",
      "layout": "mobile"
    },
    "selection": {
      "type": "meeting",
      "entity_id": "meeting_123",
      "display_name": "Product weekly"
    },
    "entities": []
  }
}
```

Interpretation rules:

- `host_app.app_id` is the primary software namespace. It decides which product reference or knowledge base category to use.
- `screen.screen_id` is the primary page/function key. It should map to a page/function reference when one exists.
- `selection` narrows the answer to the current object. If the user asks "what can I do here", explain actions for the selected entity first.
- `entities` can contain minimal state. Treat it as provided context and say when fields are missing.

## Hardware Fields

Expected MVP shape:

```json
{
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
      "capabilities": [
        "audio_input",
        "audio_output",
        "transcription",
        "noise_control"
      ]
    }
  ]
}
```

Interpretation rules:

- `kind` selects the hardware knowledge category. For example, `ai_headset` means explain earbud/headset concepts and supported AI audio workflows.
- `identity.manufacturer`, `identity.model`, and `firmware_version` are matching hints, not enough by themselves to infer unsupported capabilities.
- `connection.state` tells whether the device is usable now. `connected` means available; it does not mean active recording.
- `state.noise_control: "anc"` means active noise cancellation mode.
- Battery fields are state facts. Do not infer charging, health, or battery faults unless provided.
- `capabilities` describes possible functions; it does not mean the user has granted permission or started the function.

## Answer Rules

- Prefer structured context for app/page/device identity.
- Prefer screenshots for visual layout, highlighted regions, labels, and ambiguity resolution.
- If structured context and screenshot conflict, state the conflict and avoid overclaiming.
- If context is missing or empty, answer from the screenshot and say what is uncertain.
- Never claim to click, connect, record, transcribe, authorize, delete, or run anything.
- For embedded host apps, explain that Ripple is acting as the AI module inside the host app when `software.host_app.embedding` says so.
- For hardware questions, explain current state first, then likely capability, then any missing permission or setup uncertainty.
