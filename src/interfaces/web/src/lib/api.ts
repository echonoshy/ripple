import { fetchEventSource } from "@microsoft/fetch-event-source";
import {
  ToolCall,
  UsageInfo,
  SystemInfo,
  Session,
  SessionDetail,
  TaskInfo,
  TaskProgress,
  AgentStopData,
} from "@/types";

function getApiUrl(): string {
  if (process.env.NEXT_PUBLIC_RIPPLE_API_URL) {
    return process.env.NEXT_PUBLIC_RIPPLE_API_URL;
  }
  if (typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:8810/v1`;
  }
  return "http://localhost:8810/v1";
}

const API_URL = getApiUrl();
const API_KEY_STORAGE_KEY = "ripple-api-key";

export class AuthError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "AuthError";
  }
}

export function getApiKey(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(API_KEY_STORAGE_KEY);
}

export function setApiKey(key: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(API_KEY_STORAGE_KEY, key);
}

export function clearApiKey(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(API_KEY_STORAGE_KEY);
}

function authHeaders(): Record<string, string> {
  const key = getApiKey();
  if (!key) return {};
  return { Authorization: `Bearer ${key}` };
}

export async function fetchModels(): Promise<{ id: string; owned_by: string }[]> {
  const res = await fetch(`${API_URL}/models`, { headers: { ...authHeaders() } });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error("Failed to fetch models");
  const data = await res.json();
  return data.data || [];
}

export async function fetchSystemInfo(): Promise<SystemInfo | null> {
  try {
    const res = await fetch(`${API_URL}/info`, { headers: { ...authHeaders() } });
    if (res.status === 401) throw new AuthError();
    if (!res.ok) return null;
    return await res.json();
  } catch (error) {
    if (error instanceof AuthError) throw error;
    console.error("Error fetching system info:", error);
    return null;
  }
}

export async function createSession(): Promise<string> {
  const res = await fetch(`${API_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({}),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error("Failed to create session");
  const data = await res.json();
  return data.session_id;
}

export async function fetchSessions(): Promise<Session[]> {
  try {
    const res = await fetch(`${API_URL}/sessions`, { headers: { ...authHeaders() } });
    if (res.status === 401) throw new AuthError();
    if (!res.ok) return [];
    const data = await res.json();
    return data.sessions || [];
  } catch (error) {
    if (error instanceof AuthError) throw error;
    console.error("Error fetching sessions:", error);
    return [];
  }
}

export async function fetchSessionDetails(sessionId: string): Promise<SessionDetail | null> {
  try {
    const res = await fetch(`${API_URL}/sessions/${sessionId}`, {
      headers: { ...authHeaders() },
    });
    if (res.status === 401) throw new AuthError();
    if (!res.ok) return null;
    return await res.json();
  } catch (error) {
    if (error instanceof AuthError) throw error;
    console.error("Error fetching session details:", error);
    return null;
  }
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { ...authHeaders() },
    });
    if (res.status === 401) throw new AuthError();
    return res.ok;
  } catch {
    return false;
  }
}

export async function stopSession(sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/sessions/${sessionId}/stop`, {
      method: "POST",
      headers: { ...authHeaders() },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function resolvePermissionRequest(
  sessionId: string,
  action: "allow" | "always" | "deny"
): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/sessions/${sessionId}/permissions/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ action }),
    });
    if (res.status === 401) throw new AuthError();
    return res.ok;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    return false;
  }
}

export async function sendChatMessage(
  sessionId: string,
  content: string,
  model: string,
  thinking: boolean,
  callbacks: {
    onMessageDelta: (delta: string) => void;
    onToolCall: (toolCall: ToolCall) => void;
    onToolResult: (toolId: string, result: string) => void;
    onUsage: (usage: UsageInfo) => void;
    onNewTurn?: () => void;
    onTaskCreated?: (task: TaskInfo) => void;
    onTaskUpdated?: (task: TaskInfo) => void;
    onTaskProgress?: (progress: TaskProgress) => void;
    onAgentStop?: (data: AgentStopData) => void;
    onPermissionRequest?: (request: {
      tool: string;
      params: Record<string, unknown> | string;
      riskLevel: string;
    }) => void;
    onHeartbeat?: () => void;
    onComplete: () => void;
    onError: (error: Error) => void;
  },
  options?: { signal?: AbortSignal }
) {
  let completed = false;
  const markComplete = () => {
    if (completed) return;
    completed = true;
    callbacks.onComplete();
  };

  const CONNECTION_TIMEOUT_MS = 60_000;
  let lastEventTime = Date.now();
  let timeoutTimer: ReturnType<typeof setInterval> | null = null;

  const startTimeoutCheck = () => {
    timeoutTimer = setInterval(() => {
      if (Date.now() - lastEventTime > CONNECTION_TIMEOUT_MS) {
        clearInterval(timeoutTimer!);
        timeoutTimer = null;
        if (!completed) {
          callbacks.onError(new Error("连接超时：服务器长时间无响应，请检查后端服务状态。"));
        }
      }
    }, 5000);
  };

  try {
    startTimeoutCheck();

    await fetchEventSource(`${API_URL}/chat/completions`, {
      method: "POST",
      signal: options?.signal,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        stream: true,
        session_id: sessionId,
        thinking,
      }),
      async onopen(response) {
        if (response.status === 401) throw new AuthError();
        if (!response.ok) throw new Error(`Server responded with ${response.status}`);
        lastEventTime = Date.now();
      },
      onmessage(msg) {
        lastEventTime = Date.now();

        if (msg.data === "[DONE]") {
          markComplete();
          return;
        }

        try {
          const data = JSON.parse(msg.data);

          if (data.error) {
            callbacks.onError(new Error(data.error.message || String(data.error)));
            markComplete();
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
            if (data.stop_reason === "permission_request" && data.metadata) {
              callbacks.onPermissionRequest?.({
                tool: data.metadata.tool || "unknown",
                params: data.metadata.params || {},
                riskLevel: data.metadata.riskLevel || "dangerous",
              });
            }
            callbacks.onAgentStop?.({
              stop_reason: data.stop_reason || "completed",
              metadata: data.metadata || {},
            });
            return;
          }

          if (data.type === "tool_call") {
            callbacks.onToolCall({
              id: data.id,
              name: data.name,
              arguments: data.input || {},
              status: "running",
            });
            return;
          }

          if (data.type === "tool_result") {
            const resultContent =
              typeof data.content === "string" ? data.content : JSON.stringify(data.content);
            callbacks.onToolResult(data.tool_use_id, resultContent);
            return;
          }

          if (data.type === "task_created") {
            callbacks.onTaskCreated?.({
              id: data.id,
              subject: data.subject,
              status: data.status || "pending",
              activeForm: data.activeForm,
            });
            return;
          }

          if (data.type === "task_updated") {
            callbacks.onTaskUpdated?.({
              id: data.id,
              subject: data.subject,
              status: data.status || "pending",
            });
            return;
          }

          if (data.type === "task_progress") {
            callbacks.onTaskProgress?.({
              completed: data.completed || 0,
              total: data.total || 0,
              currentTask: data.currentTask,
            });
            return;
          }

          if (data.type === "permission_request") {
            callbacks.onPermissionRequest?.({
              tool: data.tool,
              params: data.params,
              riskLevel: data.riskLevel,
            });
            return;
          }

          if (data.usage) {
            callbacks.onUsage(data.usage);
          }

          if (data.choices?.[0]?.delta) {
            const delta = data.choices[0].delta;
            if (delta.content) {
              callbacks.onMessageDelta(delta.content);
            }
          }
        } catch (e) {
          console.warn("Failed to parse SSE message:", msg.data, e);
        }
      },
      onerror(err) {
        throw err;
      },
      onclose() {
        markComplete();
      },
    });
  } catch (error) {
    if (options?.signal?.aborted) {
      markComplete();
      return;
    }
    if (!completed) {
      callbacks.onError(error as Error);
    }
  } finally {
    if (timeoutTimer) clearInterval(timeoutTimer);
  }
}
