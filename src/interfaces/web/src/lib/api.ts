import { fetchEventSource } from "@microsoft/fetch-event-source";
import {
  ToolCall,
  UsageInfo,
  SystemInfo,
  SandboxInfo,
  ConnectorActionResponse,
  ConnectorInfo,
  ConnectorStatus,
  GogcliAccountsResponse,
  Session,
  SessionDetail,
  TaskDetail,
  TaskInfo,
  TaskPlanUpdate,
  TaskProgress,
  TaskSummary,
  AgentStopData,
  AgentRunInfo,
  AgentRunListResponse,
  DocumentInfo,
  DocumentListResponse,
  UserQuotaStatus,
  WorkspaceAttachmentResponse,
  WorkspaceEntry,
  WorkspaceFilePreview,
  WorkspaceListing,
  WorkspaceSearchResponse,
} from "@/types";
import { buildChatMessageContent, type ChatFileRef } from "@/lib/chatInput";

function getApiUrl(): string {
  if (import.meta.env.VITE_RIPPLE_API_URL) {
    return import.meta.env.VITE_RIPPLE_API_URL;
  }
  if (typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:8810/v1`;
  }
  return "http://localhost:8810/v1";
}

const API_URL = getApiUrl();

/**
 * API origin (host only, no `/v1` suffix) — useful for tools that return a
 * relative backend path like `/v1/bilibili/qrcode.png?content=...` and need
 * the markdown renderer to rewrite it to a fully-qualified URL.
 */
export function getApiOrigin(): string {
  return API_URL.replace(/\/v1\/?$/, "");
}

/**
 * Rewrite a backend-relative URL (starts with `/v1/`) to an absolute URL
 * against the configured API origin. Non-`/v1/` URLs are returned as-is.
 */
export function resolveBackendUrl(href: string | undefined): string | undefined {
  if (!href) return href;
  if (href.startsWith("/v1/")) {
    return `${getApiOrigin()}${href}`;
  }
  return href;
}
const API_KEY_STORAGE_KEY = "ripple-api-key";
const USER_ID_STORAGE_KEY = "ripple-user-id";
const DEFAULT_USER_ID = "default";
const USER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

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

export function isValidUserId(uid: string): boolean {
  return USER_ID_PATTERN.test(uid);
}

export function getUserId(): string {
  if (typeof window === "undefined") return DEFAULT_USER_ID;
  const stored = localStorage.getItem(USER_ID_STORAGE_KEY);
  if (stored && isValidUserId(stored)) return stored;
  return DEFAULT_USER_ID;
}

export function setUserId(uid: string): void {
  if (typeof window === "undefined") return;
  const trimmed = uid.trim();
  if (!isValidUserId(trimmed)) {
    throw new Error("Invalid user_id: must match ^[a-zA-Z0-9_-]{1,64}$");
  }
  localStorage.setItem(USER_ID_STORAGE_KEY, trimmed);
}

export function clearUserId(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(USER_ID_STORAGE_KEY);
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "X-Ripple-User-Id": getUserId() };
  const key = getApiKey();
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function responseDetail(res: Response): Promise<string> {
  try {
    const body = (await res.clone().json()) as unknown;
    if (isRecord(body) && typeof body.detail === "string") return body.detail;
  } catch {
    /* ignore parse error */
  }
  return "";
}

function parseTaskStatus(value: unknown): TaskInfo["status"] {
  if (value === "completed" || value === "in_progress" || value === "pending") {
    return value;
  }
  return "pending";
}

function parseTaskPlanUpdate(data: Record<string, unknown>): TaskPlanUpdate {
  const rawSteps = Array.isArray(data.steps) ? data.steps : [];
  const steps = rawSteps.filter(isRecord).map((step, index) => ({
    id:
      typeof step.id === "string" && step.id
        ? step.id
        : `codex-plan:${typeof data.turn_id === "string" ? data.turn_id : "unknown"}:${index}`,
    subject: typeof step.subject === "string" ? step.subject : "",
    status: parseTaskStatus(step.status),
  }));
  const rawProgress = isRecord(data.progress) ? data.progress : {};
  return {
    thread_id: typeof data.thread_id === "string" ? data.thread_id : null,
    turn_id: typeof data.turn_id === "string" ? data.turn_id : undefined,
    explanation: typeof data.explanation === "string" ? data.explanation : null,
    steps,
    progress: {
      completed: typeof rawProgress.completed === "number" ? rawProgress.completed : 0,
      total: typeof rawProgress.total === "number" ? rawProgress.total : steps.length,
      currentTask:
        typeof rawProgress.currentTask === "string" ? rawProgress.currentTask : undefined,
    },
    allCompleted: data.allCompleted === true,
  };
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

export async function createTask(): Promise<TaskSummary> {
  const res = await fetch(`${API_URL}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({}),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error("Failed to create task");
  return (await res.json()) as TaskSummary;
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

export async function fetchTasks(): Promise<TaskSummary[]> {
  try {
    const res = await fetch(`${API_URL}/tasks`, { headers: { ...authHeaders() } });
    if (res.status === 401) throw new AuthError();
    if (!res.ok) return [];
    const data = (await res.json()) as { tasks?: TaskSummary[] };
    return data.tasks || [];
  } catch (error) {
    if (error instanceof AuthError) throw error;
    console.error("Error fetching tasks:", error);
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

export async function fetchTaskDetails(taskId: string): Promise<TaskDetail | null> {
  try {
    const res = await fetch(`${API_URL}/tasks/${taskId}`, {
      headers: { ...authHeaders() },
    });
    if (res.status === 401) throw new AuthError();
    if (!res.ok) return null;
    return (await res.json()) as TaskDetail;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    console.error("Error fetching task details:", error);
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

export async function deleteTask(taskId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/tasks/${taskId}`, {
      method: "DELETE",
      headers: { ...authHeaders() },
    });
    if (res.status === 401) throw new AuthError();
    return res.ok;
  } catch {
    return false;
  }
}

export async function clearTaskContext(taskId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/tasks/${encodeURIComponent(taskId)}/context/clear`, {
      method: "POST",
      headers: { ...authHeaders() },
    });
    if (res.status === 401) throw new AuthError();
    return res.ok;
  } catch (error) {
    if (error instanceof AuthError) throw error;
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

export async function stopTask(taskId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/tasks/${taskId}/stop`, {
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

export async function resolveTaskPermissionRequest(
  taskId: string,
  action: "allow" | "always" | "deny"
): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/tasks/${taskId}/permissions/resolve`, {
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
  callbacks: {
    onMessageDelta: (delta: string) => void;
    onToolCall: (toolCall: ToolCall) => void;
    onToolResult: (toolId: string, result: string) => void;
    onUsage: (usage: UsageInfo) => void;
    onNewTurn?: () => void;
    onTaskCreated?: (task: TaskInfo) => void;
    onTaskUpdated?: (task: TaskInfo) => void;
    onTaskProgress?: (progress: TaskProgress) => void;
    onTaskPlanUpdated?: (update: TaskPlanUpdate) => void;
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
  options?: { signal?: AbortSignal; files?: ChatFileRef[] }
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
        messages: [
          { role: "user", content: buildChatMessageContent(content, options?.files || []) },
        ],
        stream: true,
        session_id: sessionId,
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

          if (data.type === "approval_required") {
            const approval =
              data.approval && typeof data.approval === "object"
                ? (data.approval as Record<string, unknown>)
                : {};
            const metadata =
              approval.metadata && typeof approval.metadata === "object"
                ? (approval.metadata as Record<string, unknown>)
                : approval;
            const action =
              typeof approval.action === "string"
                ? approval.action
                : typeof approval.method === "string"
                  ? approval.method
                  : "codex_approval";
            callbacks.onPermissionRequest?.({
              tool: action,
              params: metadata,
              riskLevel: action.includes("command") ? "medium" : "dangerous",
            });
            callbacks.onAgentStop?.({
              stop_reason: "permission_request",
              metadata: {
                tool: action,
                params: metadata,
                riskLevel: action.includes("command") ? "medium" : "dangerous",
              },
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

          if (data.type === "task_plan_updated") {
            callbacks.onTaskPlanUpdated?.(parseTaskPlanUpdate(data));
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

export async function fetchCurrentSandbox(): Promise<SandboxInfo | null> {
  const res = await fetch(`${API_URL}/sandboxes`, { headers: { ...authHeaders() } });
  if (res.status === 401) throw new AuthError();
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch sandbox (${res.status})`);
  return (await res.json()) as SandboxInfo;
}

export async function fetchGogcliAccounts(
  check: boolean = false
): Promise<GogcliAccountsResponse | null> {
  const qs = check ? "?check=true" : "";
  const res = await fetch(`${API_URL}/connectors/google_workspace/accounts${qs}`, {
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) return null;
  return (await res.json()) as GogcliAccountsResponse;
}

export async function fetchConnectors(): Promise<ConnectorInfo[]> {
  const res = await fetch(`${API_URL}/connectors`, { headers: { ...authHeaders() } });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Failed to fetch connectors (${res.status})`);
  const body = (await res.json()) as { connectors: ConnectorInfo[] };
  return body.connectors || [];
}

export async function fetchConnectorStatus(name: string): Promise<ConnectorStatus | null> {
  const res = await fetch(`${API_URL}/connectors/${encodeURIComponent(name)}/status`, {
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch connector ${name} (${res.status})`);
  return (await res.json()) as ConnectorStatus;
}

export async function fetchConnectorStatuses(
  connectors: ConnectorInfo[]
): Promise<Record<string, ConnectorStatus>> {
  const pairs = await Promise.all(
    connectors.map(async (connector) => {
      const status = await fetchConnectorStatus(connector.name);
      return [connector.name, status] as const;
    })
  );
  return Object.fromEntries(
    pairs.filter((pair): pair is [string, ConnectorStatus] => pair[1] !== null)
  );
}

async function postConnectorAction(
  name: string,
  action: "auth/start" | "auth/complete" | "disconnect",
  payload: Record<string, unknown> = {}
): Promise<ConnectorActionResponse> {
  const res = await fetch(`${API_URL}/connectors/${encodeURIComponent(name)}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Connector ${name} action failed (${res.status})`);
  return (await res.json()) as ConnectorActionResponse;
}

export function startConnectorAuth(
  name: string,
  payload: Record<string, unknown> = {}
): Promise<ConnectorActionResponse> {
  return postConnectorAction(name, "auth/start", payload);
}

export function completeConnectorAuth(
  name: string,
  payload: Record<string, unknown> = {}
): Promise<ConnectorActionResponse> {
  return postConnectorAction(name, "auth/complete", payload);
}

export function disconnectConnector(
  name: string,
  payload: Record<string, unknown> = {}
): Promise<ConnectorActionResponse> {
  return postConnectorAction(name, "disconnect", payload);
}

export async function createCurrentSandbox(): Promise<SandboxInfo> {
  const res = await fetch(`${API_URL}/sandboxes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Failed to create sandbox (${res.status})`);
  return (await res.json()) as SandboxInfo;
}

export async function deleteCurrentSandbox(): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_URL}/sandboxes`, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (res.ok) return { ok: true };
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { detail?: string };
    if (body?.detail) message = body.detail;
  } catch {
    /* ignore parse error */
  }
  return { ok: false, error: message };
}

function encodeWorkspacePath(path: string): string {
  return encodeURIComponent(path || "/workspace");
}

export async function fetchWorkspaceListing(
  path: string = "/workspace"
): Promise<WorkspaceListing> {
  const res = await fetch(`${API_URL}/workspace?path=${encodeWorkspacePath(path)}`, {
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Failed to fetch workspace (${res.status})`);
  return (await res.json()) as WorkspaceListing;
}

export interface WorkspaceSearchOptions {
  limit?: number;
  scope?: "all" | "name" | "content";
  kind?: "all" | "file" | "directory";
  fileType?: "all" | "code" | "markdown" | "text" | "image";
  includeHidden?: boolean;
  maxFileBytes?: number;
}

export async function searchWorkspaceFiles(
  query: string,
  options: WorkspaceSearchOptions | number = {}
): Promise<WorkspaceEntry[]> {
  const normalizedOptions: WorkspaceSearchOptions =
    typeof options === "number" ? { limit: options } : options;
  const qs = new URLSearchParams({
    q: query,
    limit: String(normalizedOptions.limit ?? 20),
    scope: normalizedOptions.scope ?? "all",
    kind: normalizedOptions.kind ?? "all",
    file_type: normalizedOptions.fileType ?? "all",
    include_hidden: String(normalizedOptions.includeHidden ?? false),
    max_file_bytes: String(normalizedOptions.maxFileBytes ?? 1024 * 1024),
  });
  const res = await fetch(`${API_URL}/workspace/search?${qs.toString()}`, {
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Failed to search workspace (${res.status})`);
  const body = (await res.json()) as WorkspaceSearchResponse;
  return body.entries || [];
}

export async function fetchWorkspaceFilePreview(
  path: string,
  limit: number = 64 * 1024
): Promise<WorkspaceFilePreview> {
  const qs = new URLSearchParams({ path, limit: String(limit) });
  const res = await fetch(`${API_URL}/workspace/file?${qs.toString()}`, {
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Failed to preview file (${res.status})`);
  return (await res.json()) as WorkspaceFilePreview;
}

export async function uploadWorkspaceAttachment(file: File): Promise<WorkspaceAttachmentResponse> {
  const body = new FormData();
  body.append("file", file);
  body.append("kind", file.type.startsWith("image/") ? "image" : "attachment");

  const res = await fetch(`${API_URL}/workspace/attachments`, {
    method: "POST",
    headers: { ...authHeaders() },
    body,
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Failed to upload attachment (${res.status})`);
  return (await res.json()) as WorkspaceAttachmentResponse;
}

export async function renameWorkspaceEntry(path: string, name: string): Promise<WorkspaceEntry> {
  const res = await fetch(`${API_URL}/workspace/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ path, name }),
  });
  if (res.status === 401) throw new AuthError();
  if (res.status === 404) {
    const detail = await responseDetail(res);
    if (detail === "Not Found") {
      throw new Error("Workspace rename API is unavailable. Restart Ripple server.");
    }
    if (detail.includes("Sandbox for user")) {
      throw new Error("Workspace is not ready for this user.");
    }
    throw new Error("File or folder no longer exists. Refresh workspace.");
  }
  if (res.status === 409) {
    throw new Error("A file or folder with that name already exists.");
  }
  if (!res.ok) throw new Error(`Failed to rename entry (${res.status})`);
  return (await res.json()) as WorkspaceEntry;
}

export async function saveWorkspaceFile(
  path: string,
  content: string,
  expectedModifiedAt?: string
): Promise<WorkspaceFilePreview> {
  const res = await fetch(`${API_URL}/workspace/file`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      path,
      content,
      expected_modified_at: expectedModifiedAt,
    }),
  });
  if (res.status === 401) throw new AuthError();
  if (res.status === 409) throw new Error("File changed on disk. Refresh before saving.");
  if (!res.ok) throw new Error(`Failed to save file (${res.status})`);
  return (await res.json()) as WorkspaceFilePreview;
}

export async function fetchRuns(): Promise<AgentRunInfo[]> {
  const res = await fetch(`${API_URL}/runs`, { headers: { ...authHeaders() } });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Failed to fetch runs (${res.status})`);
  const body = (await res.json()) as AgentRunListResponse;
  return body.runs || [];
}

export async function fetchRun(jobId: string): Promise<AgentRunInfo | null> {
  const res = await fetch(`${API_URL}/runs/${encodeURIComponent(jobId)}`, {
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch run (${res.status})`);
  return (await res.json()) as AgentRunInfo;
}

export async function streamRunEvents(
  jobId: string,
  callbacks: {
    onEvent: (event: Record<string, unknown>) => void;
    onHeartbeat?: (event: Record<string, unknown>) => void;
    onComplete: () => void;
    onError: (error: Error) => void;
  },
  options?: { signal?: AbortSignal; fromStart?: boolean; follow?: boolean }
) {
  const qs = new URLSearchParams({
    from_start: String(options?.fromStart ?? true),
    follow: String(options?.follow ?? true),
  });
  let completed = false;
  const markComplete = () => {
    if (completed) return;
    completed = true;
    callbacks.onComplete();
  };

  try {
    await fetchEventSource(`${API_URL}/runs/${encodeURIComponent(jobId)}/events?${qs.toString()}`, {
      method: "GET",
      signal: options?.signal,
      headers: { ...authHeaders() },
      async onopen(response) {
        if (response.status === 401) throw new AuthError();
        if (!response.ok) throw new Error(`Server responded with ${response.status}`);
      },
      onmessage(message) {
        if (message.data === "[DONE]") {
          markComplete();
          return;
        }
        try {
          const event = JSON.parse(message.data) as Record<string, unknown>;
          if (event.type === "heartbeat") {
            callbacks.onHeartbeat?.(event);
          } else {
            callbacks.onEvent(event);
          }
        } catch (error) {
          callbacks.onError(error as Error);
        }
      },
      onerror(error) {
        throw error;
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
    if (!completed) callbacks.onError(error as Error);
  }
}

export async function fetchUserQuota(): Promise<UserQuotaStatus> {
  const res = await fetch(`${API_URL}/users/me/quota`, { headers: { ...authHeaders() } });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Failed to fetch quota (${res.status})`);
  return (await res.json()) as UserQuotaStatus;
}

export async function fetchDocuments(query?: string): Promise<DocumentInfo[]> {
  const qs = query ? `?${new URLSearchParams({ q: query }).toString()}` : "";
  const res = await fetch(`${API_URL}/documents${qs}`, { headers: { ...authHeaders() } });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Failed to fetch documents (${res.status})`);
  const body = (await res.json()) as DocumentListResponse;
  return body.documents || [];
}

export async function createDocument(payload: {
  title: string;
  path: string;
  linked_session_id?: string | null;
  summary?: string;
}): Promise<DocumentInfo> {
  const res = await fetch(`${API_URL}/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Failed to create document (${res.status})`);
  return (await res.json()) as DocumentInfo;
}

export async function updateDocument(
  documentId: string,
  payload: {
    title?: string;
    linked_session_id?: string | null;
    summary?: string | null;
  }
): Promise<DocumentInfo> {
  const res = await fetch(`${API_URL}/documents/${encodeURIComponent(documentId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Failed to update document (${res.status})`);
  return (await res.json()) as DocumentInfo;
}

export async function deleteDocument(documentId: string): Promise<boolean> {
  const res = await fetch(`${API_URL}/documents/${encodeURIComponent(documentId)}`, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  return res.ok;
}
