import {
  AgentStopData,
  ModelInfo,
  PermissionAction,
  PermissionRequest,
  SessionDetail,
  SessionSummary,
  StreamChatCallbacks,
  ToolCallUpdate,
  UsageInfo,
} from "./types";

export class RippleAuthError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "RippleAuthError";
  }
}

export class RippleApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "RippleApiError";
  }
}

export interface RippleClientConfig {
  serverUrl: string;
  apiKey?: string;
  userId?: string;
  fetchImpl?: typeof fetch;
}

export interface SendChatInput {
  sessionId: string;
  content: string;
  model: string;
  thinking?: boolean;
  signal?: AbortSignal;
}

type JsonObject = Record<string, unknown>;

const DEFAULT_USER_ID = "default";

export function normalizeApiBaseUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function makeHeaders(config: RippleClientConfig, json = false): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Ripple-User-Id": (config.userId || DEFAULT_USER_ID).trim() || DEFAULT_USER_ID,
  };
  if (json) {
    headers["Content-Type"] = "application/json";
  }
  if (config.apiKey?.trim()) {
    headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  }
  return headers;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown; error?: unknown };
    if (typeof body.detail === "string") return body.detail;
    if (typeof body.error === "string") return body.error;
  } catch {
    try {
      const text = await response.text();
      if (text) return text;
    } catch {
      // Keep the fallback below.
    }
  }
  return `Ripple API request failed (${response.status})`;
}

function asFetch(config: RippleClientConfig): typeof fetch {
  return config.fetchImpl ?? fetch;
}

function createUrl(config: RippleClientConfig, path: string): string {
  const base = normalizeApiBaseUrl(config.serverUrl);
  if (!base) throw new RippleApiError("Server URL is not configured");
  return `${base}${path}`;
}

async function requestJson<T>(config: RippleClientConfig, path: string, init?: RequestInit): Promise<T> {
  const response = await asFetch(config)(createUrl(config, path), init);
  if (response.status === 401) throw new RippleAuthError();
  if (!response.ok) {
    throw new RippleApiError(await readErrorMessage(response), response.status);
  }
  return (await response.json()) as T;
}

export function parseSseEvents(chunk: string): JsonObject[] {
  const events: JsonObject[] = [];
  for (const frame of chunk.split(/\r?\n\r?\n/)) {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    const data = dataLines.join("\n").trim();
    if (!data || data === "[DONE]") continue;
    events.push(JSON.parse(data) as JsonObject);
  }
  return events;
}

function dispatchSseEvent(data: JsonObject, callbacks: StreamChatCallbacks): void {
  if (data.error && typeof data.error === "object") {
    const message = (data.error as { message?: unknown }).message;
    callbacks.onError?.(new Error(typeof message === "string" ? message : "Ripple stream error"));
    return;
  }

  if (data.type === "heartbeat") {
    callbacks.onHeartbeat?.();
    return;
  }
  if (data.type === "new_turn") {
    callbacks.onNewTurn?.();
    return;
  }
  if (data.type === "agent_stop") {
    const metadata = typeof data.metadata === "object" && data.metadata !== null ? data.metadata : {};
    const stop: AgentStopData = {
      stop_reason: typeof data.stop_reason === "string" ? data.stop_reason : "completed",
      metadata: metadata as Record<string, unknown>,
    };
    callbacks.onAgentStop?.(stop);
    if (stop.stop_reason === "permission_request") {
      callbacks.onPermissionRequest?.({
        tool: typeof stop.metadata.tool === "string" ? stop.metadata.tool : "unknown",
        params:
          typeof stop.metadata.params === "string" ||
          (typeof stop.metadata.params === "object" && stop.metadata.params !== null)
            ? (stop.metadata.params as Record<string, unknown> | string)
            : {},
        riskLevel: typeof stop.metadata.riskLevel === "string" ? stop.metadata.riskLevel : "dangerous",
      });
    }
    return;
  }
  if (data.type === "tool_call") {
    callbacks.onToolCall?.({
      id: typeof data.id === "string" ? data.id : "",
      name: typeof data.name === "string" ? data.name : "unknown",
      arguments:
        typeof data.input === "object" && data.input !== null ? (data.input as Record<string, unknown>) : {},
      status: "running",
    } satisfies ToolCallUpdate);
    return;
  }
  if (data.type === "tool_result") {
    const content = typeof data.content === "string" ? data.content : JSON.stringify(data.content ?? "");
    callbacks.onToolResult?.(
      typeof data.tool_use_id === "string" ? data.tool_use_id : "",
      content,
      Boolean(data.is_error),
    );
    return;
  }

  if (data.usage && typeof data.usage === "object") {
    callbacks.onUsage?.(data.usage as UsageInfo);
  }

  const choices = Array.isArray(data.choices) ? data.choices : [];
  const delta = choices[0]?.delta;
  if (delta && typeof delta === "object" && typeof delta.content === "string") {
    callbacks.onMessageDelta?.(delta.content);
  }
}

async function readStreamResponse(response: Response, callbacks: StreamChatCallbacks): Promise<void> {
  const body = response.body as unknown;
  const reader =
    body && typeof body === "object" && "getReader" in body
      ? (body as ReadableStream<Uint8Array>).getReader()
      : null;

  if (!reader) {
    for (const event of parseSseEvents(await response.text())) {
      dispatchSseEvent(event, callbacks);
    }
    callbacks.onComplete?.();
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const event of parseSseEvents(`${frame}\n\n`)) {
        dispatchSseEvent(event, callbacks);
      }
    }
  }
  buffer += decoder.decode();
  for (const event of parseSseEvents(buffer)) {
    dispatchSseEvent(event, callbacks);
  }
  callbacks.onComplete?.();
}

export function createRippleClient(config: RippleClientConfig) {
  return {
    listModels: async (): Promise<ModelInfo[]> => {
      const data = await requestJson<{ data?: ModelInfo[] }>(config, "/models", {
        headers: makeHeaders(config),
      });
      return data.data ?? [];
    },

    createSession: async (model?: string): Promise<string> => {
      const data = await requestJson<{ session_id: string }>(config, "/sessions", {
        method: "POST",
        headers: makeHeaders(config, true),
        body: JSON.stringify(model ? { model } : {}),
      });
      return data.session_id;
    },

    listSessions: async (): Promise<SessionSummary[]> => {
      const data = await requestJson<{ sessions?: SessionSummary[] }>(config, "/sessions", {
        headers: makeHeaders(config),
      });
      return data.sessions ?? [];
    },

    getSession: async (sessionId: string): Promise<SessionDetail> =>
      requestJson<SessionDetail>(config, `/sessions/${encodeURIComponent(sessionId)}`, {
        headers: makeHeaders(config),
      }),

    stopSession: async (sessionId: string): Promise<boolean> => {
      const data = await requestJson<{ stopped?: boolean }>(config, `/sessions/${encodeURIComponent(sessionId)}/stop`, {
        method: "POST",
        headers: makeHeaders(config),
      });
      return Boolean(data.stopped);
    },

    resolvePermission: async (sessionId: string, action: PermissionAction): Promise<void> => {
      await requestJson<{ ok: boolean }>(config, `/sessions/${encodeURIComponent(sessionId)}/permissions/resolve`, {
        method: "POST",
        headers: makeHeaders(config, true),
        body: JSON.stringify({ action }),
      });
    },

    streamChat: async (input: SendChatInput, callbacks: StreamChatCallbacks): Promise<void> => {
      try {
        const response = await asFetch(config)(createUrl(config, "/chat/completions"), {
          method: "POST",
          signal: input.signal,
          headers: makeHeaders(config, true),
          body: JSON.stringify({
            model: input.model,
            messages: [{ role: "user", content: input.content }],
            stream: true,
            session_id: input.sessionId,
            thinking: Boolean(input.thinking),
          }),
        });
        if (response.status === 401) throw new RippleAuthError();
        if (!response.ok) {
          throw new RippleApiError(await readErrorMessage(response), response.status);
        }
        await readStreamResponse(response, callbacks);
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          callbacks.onComplete?.();
          return;
        }
        callbacks.onError?.(error as Error);
        throw error;
      }
    },
  };
}
