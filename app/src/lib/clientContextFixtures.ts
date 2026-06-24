import type { ChatClientContext } from "@/lib/api";

export const CONTEXT_EXPLAINER_REQUIRED_SKILL_ID = "ripple:ripple-ui-explainer";

export interface ClientContextFixture {
  id: string;
  label: string;
  description: string;
  clientContext: ChatClientContext | null;
  requiredSkillIds?: string[];
}

export const CLIENT_CONTEXT_FIXTURES: ClientContextFixture[] = [
  {
    id: "none",
    label: "No context",
    description: "Send the message without software or device context.",
    clientContext: null,
  },
  {
    id: "ripple-chat",
    label: "Ripple chat page",
    description: "MVP sample for the current Ripple chat surface.",
    requiredSkillIds: [CONTEXT_EXPLAINER_REQUIRED_SKILL_ID],
    clientContext: {
      schema_version: "ripple.client_context.v1",
      captured_at: "mock",
      producer: {
        type: "ripple_app_fixture",
        name: "ripple",
      },
      software: {
        host_app: {
          app_id: "ripple",
          name: "Ripple",
          embedding: "full_app",
        },
        ai_surface: {
          surface_id: "session.chat",
          mode: "full_page",
        },
        screen: {
          app: "ripple",
          screen_id: "session.chat",
          active_view: "sessions",
          layout: "responsive",
        },
      },
      devices: [],
    },
  },
  {
    id: "meeting-detail",
    label: "Host app meeting page",
    description: "Simulates Ripple embedded as an AI panel inside a meeting app.",
    requiredSkillIds: [CONTEXT_EXPLAINER_REQUIRED_SKILL_ID],
    clientContext: {
      schema_version: "ripple.client_context.v1",
      captured_at: "mock",
      producer: {
        type: "host_app_fixture",
        name: "viaim-meeting",
      },
      software: {
        host_app: {
          app_id: "viaim.meeting",
          name: "Viaim Meeting",
          embedding: "ripple_sdk",
        },
        ai_surface: {
          surface_id: "meeting.detail.ai_panel",
          mode: "embedded_panel",
        },
        screen: {
          screen_id: "meeting.detail",
          title: "会议详情",
          layout: "mobile",
        },
        selection: {
          type: "meeting",
          entity_id: "meeting_123",
          display_name: "产品周会",
        },
        entities: [
          {
            type: "meeting",
            id: "meeting_123",
            title: "产品周会",
            state: {
              status: "ended",
              has_transcript: true,
              has_summary: true,
            },
          },
        ],
      },
      devices: [],
    },
  },
  {
    id: "meeting-detail-with-headset",
    label: "Meeting page + AI headset",
    description: "Simulates host software context plus a connected AI headset.",
    requiredSkillIds: [CONTEXT_EXPLAINER_REQUIRED_SKILL_ID],
    clientContext: {
      schema_version: "ripple.client_context.v1",
      captured_at: "mock",
      producer: {
        type: "host_app_fixture",
        name: "viaim-meeting",
      },
      software: {
        host_app: {
          app_id: "viaim.meeting",
          name: "Viaim Meeting",
          embedding: "ripple_sdk",
        },
        ai_surface: {
          surface_id: "meeting.detail.ai_panel",
          mode: "embedded_panel",
        },
        screen: {
          screen_id: "meeting.detail",
          title: "会议详情",
          layout: "mobile",
        },
        selection: {
          type: "meeting",
          entity_id: "meeting_123",
          display_name: "产品周会",
        },
      },
      devices: [
        {
          id: "headset:primary",
          kind: "ai_headset",
          source: "mock",
          identity: {
            manufacturer: "viaim",
            model: "AI Earbuds",
            firmware_version: "1.2.3",
          },
          connection: {
            state: "connected",
            transport: "bluetooth",
          },
          state: {
            left_battery_percent: 80,
            right_battery_percent: 78,
            case_battery_percent: 55,
            wearing_state: "in_ear",
            noise_control: "anc",
            recording: false,
          },
          capabilities: ["audio_input", "audio_output", "transcription", "noise_control"],
        },
      ],
    },
  },
];

export function getClientContextFixture(fixtureId: string | null | undefined): ClientContextFixture {
  return (
    CLIENT_CONTEXT_FIXTURES.find((fixture) => fixture.id === fixtureId) ||
    CLIENT_CONTEXT_FIXTURES[0]
  );
}
