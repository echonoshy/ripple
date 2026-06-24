import type { ChatClientContext } from "@/lib/api";
import {
  getClientStorageItem,
  removeClientStorageItem,
  setClientStorageItem,
} from "@/lib/platform";

export const CLIENT_CONTEXT_DEMO_STORAGE_KEY = "ripple-client-context-demo";
export const CLIENT_CONTEXT_DEMO_SETTINGS_STORAGE_KEY = "ripple-client-context-demo-settings";
export const VIAIM_MEETING_DEMO_ID = "viaim-meeting";

const CLIENT_CONTEXT_SCHEMA_VERSION = "ripple.client_context.v1";
const VIAIM_PRODUCT_SUPPORT_SKILL_ID = "ripple:viaim-product-support";

interface ClientContextWindow extends Window {
  __RIPPLE_CLIENT_CONTEXT__?: unknown;
  __RIPPLE_CLIENT_CONTEXT_PROVIDER__?: () => unknown;
}

export interface ChatClientContextSnapshot {
  clientContext?: ChatClientContext;
  requiredSkillIds?: string[];
}

export type ClientContextDemoLayout = "mobile" | "desktop";
export type ClientContextDemoConnectionState = "connected" | "disconnected";
export type ClientContextDemoNoiseControl = "anc" | "transparency" | "off";

export interface ClientContextDemoSettings {
  hostAppName: string;
  screenTitle: string;
  selectionName: string;
  screenLayout: ClientContextDemoLayout;
  connectionState: ClientContextDemoConnectionState;
  leftBatteryPercent: number;
  rightBatteryPercent: number;
  caseBatteryPercent: number;
  noiseControl: ClientContextDemoNoiseControl;
  recording: boolean;
}

export const DEFAULT_CLIENT_CONTEXT_DEMO_SETTINGS: ClientContextDemoSettings = {
  hostAppName: "Viaim Meeting",
  screenTitle: "会议详情",
  selectionName: "产品周会",
  screenLayout: "mobile",
  connectionState: "connected",
  leftBatteryPercent: 80,
  rightBatteryPercent: 78,
  caseBatteryPercent: 55,
  noiseControl: "anc",
  recording: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-\s]/g, "_");
  return (
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized === "set_cookie" ||
    normalized.includes("api_key") ||
    normalized.includes("access_token") ||
    normalized.includes("refresh_token") ||
    normalized.includes("private_key") ||
    normalized.includes("credential") ||
    normalized.includes("password") ||
    normalized.includes("secret")
  );
}

function sanitizeJsonValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeJsonValue(item))
      .filter((item): item is Exclude<unknown, undefined> => item !== undefined);
  }

  if (!isRecord(value)) return undefined;

  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue;
    const sanitizedItem = sanitizeJsonValue(item);
    if (sanitizedItem !== undefined) sanitized[key] = sanitizedItem;
  }
  return sanitized;
}

function normalizeRequiredSkillIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function mergeRequiredSkillIds(
  manualSkillIds: readonly string[] = [],
  contextSkillIds: readonly string[] = []
): string[] {
  const merged: string[] = [];
  for (const item of [...manualSkillIds, ...contextSkillIds]) {
    const id = item.trim();
    if (id && !merged.includes(id)) merged.push(id);
  }
  return merged;
}

function normalizeClientContext(value: unknown): ChatClientContext | null {
  const sanitized = sanitizeJsonValue(value);
  if (!isRecord(sanitized)) return null;

  const context: Record<string, unknown> = {
    ...sanitized,
    schema_version:
      typeof sanitized.schema_version === "string" && sanitized.schema_version.trim()
        ? sanitized.schema_version
        : CLIENT_CONTEXT_SCHEMA_VERSION,
    captured_at:
      typeof sanitized.captured_at === "string" && sanitized.captured_at.trim()
        ? sanitized.captured_at
        : new Date().toISOString(),
  };

  return context as ChatClientContext;
}

function snapshotFromUnknown(value: unknown): ChatClientContextSnapshot | null {
  if (!isRecord(value)) return null;

  const contextCandidate = value.clientContext ?? value.client_context ?? value;
  const clientContext = normalizeClientContext(contextCandidate);
  if (!clientContext) return null;

  const requiredSkillIds = mergeRequiredSkillIds(
    normalizeRequiredSkillIds(value.requiredSkillIds),
    normalizeRequiredSkillIds(value.required_skill_ids)
  );

  return {
    clientContext,
    requiredSkillIds: requiredSkillIds.length > 0 ? requiredSkillIds : undefined,
  };
}

function readHostProvidedSnapshot(): ChatClientContextSnapshot | null {
  if (typeof window === "undefined") return null;
  const clientContextWindow = window as ClientContextWindow;

  const provider = clientContextWindow.__RIPPLE_CLIENT_CONTEXT_PROVIDER__;
  if (typeof provider === "function") {
    try {
      const snapshot = snapshotFromUnknown(provider());
      if (snapshot) return snapshot;
    } catch (error) {
      console.warn("Failed to read Ripple client context provider:", error);
    }
  }

  return snapshotFromUnknown(clientContextWindow.__RIPPLE_CLIENT_CONTEXT__);
}

function demoIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const params = new URL(window.location.href).searchParams;
    return params.get("ripple_client_context_demo");
  } catch {
    return null;
  }
}

function demoIdFromLocalDevServer(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(window.location.href);
    const isLocalhost =
      url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    return isLocalhost && url.port === "8824" ? VIAIM_MEETING_DEMO_ID : null;
  } catch {
    return null;
  }
}

function activeDemoId(): string | null {
  const urlDemoId = demoIdFromUrl()?.trim();
  if (urlDemoId) return urlDemoId;

  const localDevServerDemoId = demoIdFromLocalDevServer();
  if (localDevServerDemoId) return localDevServerDemoId;

  return getClientStorageItem(CLIENT_CONTEXT_DEMO_STORAGE_KEY)?.trim() || null;
}

function hasStoredClientContextDemoSettings(): boolean {
  return getClientStorageItem(CLIENT_CONTEXT_DEMO_SETTINGS_STORAGE_KEY) !== null;
}

function boundedPercent(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function stringSetting(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function enumSetting<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}

function normalizeClientContextDemoSettings(value: unknown): ClientContextDemoSettings {
  const source = isRecord(value) ? value : {};
  return {
    hostAppName: stringSetting(
      source.hostAppName,
      DEFAULT_CLIENT_CONTEXT_DEMO_SETTINGS.hostAppName
    ),
    screenTitle: stringSetting(
      source.screenTitle,
      DEFAULT_CLIENT_CONTEXT_DEMO_SETTINGS.screenTitle
    ),
    selectionName: stringSetting(
      source.selectionName,
      DEFAULT_CLIENT_CONTEXT_DEMO_SETTINGS.selectionName
    ),
    screenLayout: enumSetting(
      source.screenLayout,
      ["mobile", "desktop"] as const,
      DEFAULT_CLIENT_CONTEXT_DEMO_SETTINGS.screenLayout
    ),
    connectionState: enumSetting(
      source.connectionState,
      ["connected", "disconnected"] as const,
      DEFAULT_CLIENT_CONTEXT_DEMO_SETTINGS.connectionState
    ),
    leftBatteryPercent: boundedPercent(
      source.leftBatteryPercent,
      DEFAULT_CLIENT_CONTEXT_DEMO_SETTINGS.leftBatteryPercent
    ),
    rightBatteryPercent: boundedPercent(
      source.rightBatteryPercent,
      DEFAULT_CLIENT_CONTEXT_DEMO_SETTINGS.rightBatteryPercent
    ),
    caseBatteryPercent: boundedPercent(
      source.caseBatteryPercent,
      DEFAULT_CLIENT_CONTEXT_DEMO_SETTINGS.caseBatteryPercent
    ),
    noiseControl: enumSetting(
      source.noiseControl,
      ["anc", "transparency", "off"] as const,
      DEFAULT_CLIENT_CONTEXT_DEMO_SETTINGS.noiseControl
    ),
    recording:
      typeof source.recording === "boolean"
        ? source.recording
        : DEFAULT_CLIENT_CONTEXT_DEMO_SETTINGS.recording,
  };
}

export function readClientContextDemoSettings(): ClientContextDemoSettings {
  const rawValue = getClientStorageItem(CLIENT_CONTEXT_DEMO_SETTINGS_STORAGE_KEY);
  if (!rawValue) return { ...DEFAULT_CLIENT_CONTEXT_DEMO_SETTINGS };

  try {
    return normalizeClientContextDemoSettings(JSON.parse(rawValue));
  } catch {
    return { ...DEFAULT_CLIENT_CONTEXT_DEMO_SETTINGS };
  }
}

export function saveClientContextDemoSettings(
  settings: Partial<ClientContextDemoSettings>
): ClientContextDemoSettings {
  const nextSettings = normalizeClientContextDemoSettings({
    ...readClientContextDemoSettings(),
    ...settings,
  });
  setClientStorageItem(CLIENT_CONTEXT_DEMO_STORAGE_KEY, VIAIM_MEETING_DEMO_ID);
  setClientStorageItem(CLIENT_CONTEXT_DEMO_SETTINGS_STORAGE_KEY, JSON.stringify(nextSettings));
  return nextSettings;
}

export function resetClientContextDemoSettings(): ClientContextDemoSettings {
  removeClientStorageItem(CLIENT_CONTEXT_DEMO_STORAGE_KEY);
  removeClientStorageItem(CLIENT_CONTEXT_DEMO_SETTINGS_STORAGE_KEY);
  return { ...DEFAULT_CLIENT_CONTEXT_DEMO_SETTINGS };
}

export function buildViaimMeetingDemoClientContext(
  settings: ClientContextDemoSettings = readClientContextDemoSettings()
): ChatClientContext {
  return {
    schema_version: CLIENT_CONTEXT_SCHEMA_VERSION,
    captured_at: new Date().toISOString(),
    producer: {
      type: "mock_host_app",
      name: "viaim-meeting-demo",
    },
    software: {
      host_app: {
        app_id: "viaim.meeting",
        name: settings.hostAppName,
        embedding: "ripple_sdk",
      },
      ai_surface: {
        surface_id: "meeting.detail.ai_panel",
        mode: "embedded_panel",
      },
      screen: {
        screen_id: "meeting.detail",
        title: settings.screenTitle,
        layout: settings.screenLayout,
      },
      selection: {
        type: "meeting",
        entity_id: "meeting_123",
        display_name: settings.selectionName,
      },
      entities: [
        {
          type: "meeting",
          id: "meeting_123",
          title: settings.selectionName,
          state: {
            status: "ended",
            has_transcript: true,
            has_summary: true,
          },
        },
      ],
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
          state: settings.connectionState,
          transport: "bluetooth",
        },
        state: {
          left_battery_percent: settings.leftBatteryPercent,
          right_battery_percent: settings.rightBatteryPercent,
          case_battery_percent: settings.caseBatteryPercent,
          wearing_state: "in_ear",
          noise_control: settings.noiseControl,
          recording: settings.recording,
        },
        capabilities: ["audio_input", "audio_output", "transcription", "noise_control"],
      },
    ],
  };
}

function demoSnapshot(): ChatClientContextSnapshot | null {
  if (activeDemoId() !== VIAIM_MEETING_DEMO_ID && !hasStoredClientContextDemoSettings()) {
    return null;
  }
  return {
    clientContext: buildViaimMeetingDemoClientContext(),
    requiredSkillIds: [VIAIM_PRODUCT_SUPPORT_SKILL_ID],
  };
}

export function getChatClientContextSnapshot(): ChatClientContextSnapshot {
  return readHostProvidedSnapshot() ?? demoSnapshot() ?? {};
}
