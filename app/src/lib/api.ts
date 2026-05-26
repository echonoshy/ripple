import { fetchEventSource } from "@microsoft/fetch-event-source";
import {
  CodexRuntimeEvent,
  ConnectorAuthChatEvent,
  ToolCall,
  UsageInfo,
  SandboxInfo,
  ConnectorInfo,
  ConnectorStatus,
  AgentRunInfo,
  GogcliAccountsResponse,
  ScheduleInfo,
  SessionDetail,
  SessionSummary,
  PlanStep,
  PlanUpdate,
  PlanProgress,
  AgentStopData,
  WorkspaceAttachmentResponse,
  WorkspaceEntry,
  WorkspaceFilePreview,
  WorkspaceListing,
  WorkspaceSearchResponse,
  WorkspaceUploadResponse,
} from "@/types";
import { buildChatMessageContent, type ChatFileRef } from "@/lib/chatInput";
import { readableApiErrorMessage } from "@/lib/apiErrors";
import { getClientStorage } from "@/lib/platform";

// TEMP_HTTP_IP_API: use direct HTTP IP until test-oauth.weilai.ai is unblocked.
const DEFAULT_PUBLIC_API_URL = "http://140.143.229.103:8810/v1";

type ApiUrlEnv = {
  DEV?: boolean;
  PROD?: boolean;
  VITE_RIPPLE_API_URL?: string;
};

function normalizeApiUrl(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export function resolveApiUrl(env: ApiUrlEnv): string {
  if (env.VITE_RIPPLE_API_URL) {
    return normalizeApiUrl(env.VITE_RIPPLE_API_URL);
  }
  if (env.DEV) {
    return "/v1";
  }
  return DEFAULT_PUBLIC_API_URL;
}

function getApiUrl(): string {
  return resolveApiUrl(import.meta.env);
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

export interface WorkspaceUploadConflict {
  name: string;
  path: string;
}

export class WorkspaceUploadConflictError extends Error {
  conflicts: WorkspaceUploadConflict[];

  constructor(conflicts: WorkspaceUploadConflict[]) {
    super("Workspace upload conflicts");
    this.name = "WorkspaceUploadConflictError";
    this.conflicts = conflicts;
  }
}

export interface ScheduleCreateInput {
  title: string;
  prompt: string;
  kind: "once" | "interval";
  timezone: string;
  run_at?: string | null;
  interval_seconds?: number | null;
  enabled?: boolean;
  model?: string | null;
  cwd?: string | null;
  max_runtime_seconds?: number;
  max_runs?: number | null;
}

export type ScheduleUpdateInput = Partial<ScheduleCreateInput>;

export function getApiKey(): string | null {
  return getClientStorage()?.getItem(API_KEY_STORAGE_KEY) ?? null;
}

export function setApiKey(key: string): void {
  getClientStorage()?.setItem(API_KEY_STORAGE_KEY, key);
}

export function clearApiKey(): void {
  getClientStorage()?.removeItem(API_KEY_STORAGE_KEY);
}

export function isValidUserId(uid: string): boolean {
  return USER_ID_PATTERN.test(uid);
}

export function getUserId(): string {
  const stored = getClientStorage()?.getItem(USER_ID_STORAGE_KEY);
  if (stored && isValidUserId(stored)) return stored;
  return DEFAULT_USER_ID;
}

export function setUserId(uid: string): void {
  const trimmed = uid.trim();
  if (!isValidUserId(trimmed)) {
    throw new Error("Invalid user_id: must match ^[a-zA-Z0-9_-]{1,64}$");
  }
  getClientStorage()?.setItem(USER_ID_STORAGE_KEY, trimmed);
}

export function clearUserId(): void {
  getClientStorage()?.removeItem(USER_ID_STORAGE_KEY);
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

const CODEX_RUNTIME_EVENT_TYPES = new Set<CodexRuntimeEvent["type"]>([
  "codex_turn_diff_updated",
  "tool_output_delta",
  "file_change_patch_updated",
  "codex_warning",
  "codex_error",
  "context_compaction",
]);

function isCodexRuntimeEvent(value: unknown): value is CodexRuntimeEvent {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    CODEX_RUNTIME_EVENT_TYPES.has(value.type as CodexRuntimeEvent["type"])
  );
}

function isConnectorAuthChatEvent(value: unknown): value is ConnectorAuthChatEvent {
  return (
    isRecord(value) &&
    (value.type === "connector_auth_required" || value.type === "connector_auth_updated") &&
    typeof value.connector === "string" &&
    typeof value.display_name === "string" &&
    typeof value.auth_flow === "string" &&
    typeof value.stage === "string" &&
    typeof value.message === "string"
  );
}

async function responseDetail(res: Response): Promise<string> {
  try {
    const body = (await res.clone().json()) as unknown;
    if (isRecord(body)) {
      const detail = body.detail;
      if (typeof detail === "string") return detail;
      if (isRecord(detail) && typeof detail.message === "string") return detail.message;
      if (detail !== undefined && detail !== null) return JSON.stringify(detail);
    }
  } catch {
    /* ignore parse error */
  }
  return "";
}

function parsePlanStepStatus(value: unknown): PlanStep["status"] {
  if (value === "completed" || value === "in_progress" || value === "pending") {
    return value;
  }
  return "pending";
}

function parsePlanUpdate(data: Record<string, unknown>): PlanUpdate {
  const rawSteps = Array.isArray(data.steps) ? data.steps : [];
  const steps = rawSteps.filter(isRecord).map((step, index) => ({
    id:
      typeof step.id === "string" && step.id
        ? step.id
        : `codex-plan:${typeof data.turn_id === "string" ? data.turn_id : "unknown"}:${index}`,
    subject: typeof step.subject === "string" ? step.subject : "",
    status: parsePlanStepStatus(step.status),
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

interface RawSessionSummary {
  session_id: string;
  title: string;
  pinned?: boolean;
  model: string;
  created_at: string;
  last_active: string;
  message_count: number;
  status: string;
  changed_file_count: number;
  pending_approval_count: number;
}

interface RawSessionDetail extends RawSessionSummary {
  messages?: Record<string, unknown>[];
  pending_question?: string | null;
  pending_options?: string[] | null;
  pending_permission_request?: SessionDetail["pendingPermissionRequest"];
  plan_steps?: PlanStep[];
  plan_progress?: PlanProgress | null;
  task_steps?: PlanStep[];
  task_progress?: PlanProgress | null;
}

function normalizeSessionSummary(raw: RawSessionSummary): SessionSummary {
  return {
    sessionId: raw.session_id,
    title: raw.title,
    pinned: raw.pinned === true,
    model: raw.model,
    createdAt: raw.created_at,
    lastActiveAt: raw.last_active,
    messageCount: raw.message_count,
    status: raw.status,
    changedFileCount: raw.changed_file_count,
    pendingApprovalCount: raw.pending_approval_count,
  };
}

function normalizeSessionDetail(raw: RawSessionDetail): SessionDetail {
  return {
    ...normalizeSessionSummary(raw),
    messages: raw.messages || [],
    pendingQuestion: raw.pending_question ?? null,
    pendingOptions: raw.pending_options ?? null,
    pendingPermissionRequest: raw.pending_permission_request ?? null,
    planSteps: raw.plan_steps || raw.task_steps || [],
    planProgress: raw.plan_progress ?? raw.task_progress ?? null,
  };
}

export async function fetchModels(): Promise<{ id: string; owned_by: string }[]> {
  const res = await fetch(`${API_URL}/models`, { headers: { ...authHeaders() } });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error("Failed to fetch models");
  const data = await res.json();
  return data.data || [];
}

export async function fetchSchedules(): Promise<ScheduleInfo[]> {
  const res = await fetch(`${API_URL}/schedules`, { headers: { ...authHeaders() } });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to fetch schedules (${res.status})`);
  }
  const data = (await res.json()) as { schedules?: ScheduleInfo[] };
  return data.schedules || [];
}

export async function createSchedule(input: ScheduleCreateInput): Promise<ScheduleInfo> {
  const res = await fetch(`${API_URL}/schedules`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to create schedule (${res.status})`);
  }
  return (await res.json()) as ScheduleInfo;
}

export async function updateSchedule(
  scheduleId: string,
  input: ScheduleUpdateInput
): Promise<ScheduleInfo> {
  const res = await fetch(`${API_URL}/schedules/${encodeURIComponent(scheduleId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to update schedule (${res.status})`);
  }
  return (await res.json()) as ScheduleInfo;
}

export async function deleteSchedule(scheduleId: string): Promise<boolean> {
  const res = await fetch(`${API_URL}/schedules/${encodeURIComponent(scheduleId)}`, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  return res.ok;
}

export async function runScheduleNow(scheduleId: string): Promise<AgentRunInfo> {
  const res = await fetch(`${API_URL}/schedules/${encodeURIComponent(scheduleId)}/run-now`, {
    method: "POST",
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to run schedule (${res.status})`);
  }
  return (await res.json()) as AgentRunInfo;
}

export async function createSession(): Promise<SessionSummary> {
  const res = await fetch(`${API_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({}),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error("Failed to create session");
  return normalizeSessionSummary((await res.json()) as RawSessionSummary);
}

export interface SessionUpdateInput {
  title?: string;
  pinned?: boolean;
}

export async function updateSession(
  sessionId: string,
  input: SessionUpdateInput
): Promise<SessionSummary> {
  const res = await fetch(`${API_URL}/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to update session (${res.status})`);
  }
  return normalizeSessionSummary((await res.json()) as RawSessionSummary);
}

export async function fetchSessions(): Promise<SessionSummary[]> {
  try {
    const res = await fetch(`${API_URL}/sessions`, { headers: { ...authHeaders() } });
    if (res.status === 401) throw new AuthError();
    if (!res.ok) {
      const detail = await responseDetail(res);
      throw new Error(detail || `Failed to fetch sessions (${res.status})`);
    }
    const data = (await res.json()) as { sessions?: RawSessionSummary[] };
    return (data.sessions || []).map(normalizeSessionSummary);
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new Error(readableApiErrorMessage(error));
  }
}

export async function fetchSessionDetails(sessionId: string): Promise<SessionDetail | null> {
  try {
    const res = await fetch(`${API_URL}/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { ...authHeaders() },
    });
    if (res.status === 401) throw new AuthError();
    if (!res.ok) return null;
    return normalizeSessionDetail((await res.json()) as RawSessionDetail);
  } catch (error) {
    if (error instanceof AuthError) throw error;
    console.error("Error fetching session details:", error);
    return null;
  }
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      headers: { ...authHeaders() },
    });
    if (res.status === 401) throw new AuthError();
    return res.ok;
  } catch {
    return false;
  }
}

export async function clearSessionContext(sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/sessions/${encodeURIComponent(sessionId)}/context/clear`, {
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

export async function compactSessionContext(sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${API_URL}/sessions/${encodeURIComponent(sessionId)}/context/compact`,
      {
        method: "POST",
        headers: { ...authHeaders() },
      }
    );
    if (res.status === 401) throw new AuthError();
    return res.ok;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    return false;
  }
}

export async function stopSession(sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/sessions/${encodeURIComponent(sessionId)}/stop`, {
      method: "POST",
      headers: { ...authHeaders() },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function cancelSessionConnectorAuth(sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${API_URL}/sessions/${encodeURIComponent(sessionId)}/connector-auth/cancel`,
      {
        method: "POST",
        headers: { ...authHeaders() },
      }
    );
    if (res.status === 401) throw new AuthError();
    return res.ok;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    return false;
  }
}

export async function resolveSessionPermissionRequest(
  sessionId: string,
  action: "allow" | "always" | "deny"
): Promise<boolean> {
  try {
    const res = await fetch(
      `${API_URL}/sessions/${encodeURIComponent(sessionId)}/permissions/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ action }),
      }
    );
    if (res.status === 401) throw new AuthError();
    return res.ok;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    return false;
  }
}

export interface ChatStreamCallbacks {
  onMessageDelta: (delta: string) => void;
  onAssistantUpdateDelta?: (id: string, delta: string) => void;
  onAssistantUpdate?: (id: string, content: string) => void;
  onToolCall: (toolCall: ToolCall) => void;
  onToolResult: (toolId: string, result: string) => void;
  onUsage: (usage: UsageInfo) => void;
  onNewTurn?: () => void;
  onPlanStepCreated?: (step: PlanStep) => void;
  onPlanStepUpdated?: (step: PlanStep) => void;
  onPlanProgress?: (progress: PlanProgress) => void;
  onPlanUpdated?: (update: PlanUpdate) => void;
  onRuntimeEvent?: (event: CodexRuntimeEvent) => void;
  onConnectorAuth?: (event: ConnectorAuthChatEvent) => void;
  onAgentStop?: (data: AgentStopData) => void;
  onPermissionRequest?: (request: {
    tool: string;
    params: Record<string, unknown> | string;
    riskLevel: string;
  }) => void;
  onHeartbeat?: () => void;
  onComplete: () => void;
  onError: (error: Error) => void;
}

interface ChatStreamOptions {
  signal?: AbortSignal;
  connectionTimeoutMs?: number;
}

async function streamChatResponse(
  endpointPath: string,
  body: Record<string, unknown>,
  callbacks: ChatStreamCallbacks,
  options?: ChatStreamOptions
) {
  let completed = false;
  const markComplete = () => {
    if (completed) return;
    completed = true;
    callbacks.onComplete();
  };

  const CONNECTION_TIMEOUT_MS = options?.connectionTimeoutMs ?? 60_000;
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

    await fetchEventSource(`${API_URL}${endpointPath}`, {
      method: "POST",
      openWhenHidden: true,
      signal: options?.signal,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify(body),
      async onopen(response) {
        if (response.status === 401) throw new AuthError();
        if (!response.ok) {
          const detail = await responseDetail(response);
          throw new Error(detail || `Server responded with ${response.status}`);
        }
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

          if (isConnectorAuthChatEvent(data)) {
            callbacks.onConnectorAuth?.(data);
            return;
          }

          if (data.type === "assistant_update_delta") {
            if (typeof data.id === "string" && typeof data.delta === "string") {
              callbacks.onAssistantUpdateDelta?.(data.id, data.delta);
            }
            return;
          }

          if (data.type === "assistant_update") {
            if (typeof data.id === "string" && typeof data.content === "string") {
              callbacks.onAssistantUpdate?.(data.id, data.content);
            }
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

          if (data.type === "task_created" || data.type === "plan_step_created") {
            callbacks.onPlanStepCreated?.({
              id: data.id,
              subject: data.subject,
              status: parsePlanStepStatus(data.status),
              activeForm: data.activeForm,
            });
            return;
          }

          if (data.type === "task_updated" || data.type === "plan_step_updated") {
            callbacks.onPlanStepUpdated?.({
              id: data.id,
              subject: data.subject,
              status: parsePlanStepStatus(data.status),
            });
            return;
          }

          if (data.type === "task_progress" || data.type === "plan_progress") {
            callbacks.onPlanProgress?.({
              completed: data.completed || 0,
              total: data.total || 0,
              currentTask: data.currentTask,
            });
            return;
          }

          if (data.type === "task_plan_updated" || data.type === "plan_updated") {
            callbacks.onPlanUpdated?.(parsePlanUpdate(data));
            return;
          }

          if (isCodexRuntimeEvent(data)) {
            callbacks.onRuntimeEvent?.(data);
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

export async function sendChatMessage(
  sessionId: string,
  content: string,
  model: string,
  callbacks: ChatStreamCallbacks,
  options?: { signal?: AbortSignal; files?: ChatFileRef[] }
) {
  return streamChatResponse(
    "/chat/completions",
    {
      model,
      messages: [{ role: "user", content: buildChatMessageContent(content, options?.files || []) }],
      stream: true,
      session_id: sessionId,
    },
    callbacks,
    { signal: options?.signal }
  );
}

export async function pollSessionConnectorAuth(
  sessionId: string,
  model: string,
  callbacks: ChatStreamCallbacks,
  options?: { signal?: AbortSignal }
) {
  return streamChatResponse(
    `/sessions/${encodeURIComponent(sessionId)}/connector-auth/poll`,
    { model, stream: true },
    callbacks,
    { signal: options?.signal, connectionTimeoutMs: 180_000 }
  );
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
    scope: normalizedOptions.scope ?? "name",
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

function parseWorkspaceUploadConflicts(value: unknown): WorkspaceUploadConflict[] {
  if (!isRecord(value)) return [];
  const detail = value.detail;
  if (!isRecord(detail) || detail.code !== "workspace_upload_conflict") return [];
  const conflicts = Array.isArray(detail.conflicts) ? detail.conflicts : [];
  return conflicts.filter(isRecord).flatMap((conflict) => {
    if (typeof conflict.name !== "string" || typeof conflict.path !== "string") return [];
    return [{ name: conflict.name, path: conflict.path }];
  });
}

export async function uploadWorkspaceFiles(
  files: File[],
  path: string,
  overwrite: boolean = false
): Promise<WorkspaceEntry[]> {
  const body = new FormData();
  for (const file of files) {
    body.append("files", file);
  }
  body.append("path", path);
  body.append("overwrite", String(overwrite));

  const res = await fetch(`${API_URL}/workspace/upload`, {
    method: "POST",
    headers: { ...authHeaders() },
    body,
  });
  if (res.status === 401) throw new AuthError();
  if (res.status === 409) {
    let parsed: unknown = {};
    try {
      parsed = await res.clone().json();
    } catch {
      /* ignore parse error */
    }
    throw new WorkspaceUploadConflictError(parseWorkspaceUploadConflicts(parsed));
  }
  if (!res.ok) throw new Error(`Failed to upload files (${res.status})`);
  const response = (await res.json()) as WorkspaceUploadResponse;
  return response.entries || [];
}

function filenameFromContentDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) return decodeURIComponent(utf8Match[1].replace(/^"|"$/g, ""));
  const match = header.match(/filename="?([^";]+)"?/i);
  return match?.[1] || fallback;
}

export async function downloadWorkspaceFile(
  path: string
): Promise<{ blob: Blob; filename: string }> {
  const qs = new URLSearchParams({ path });
  const res = await fetch(`${API_URL}/workspace/download?${qs.toString()}`, {
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Failed to download file (${res.status})`);
  const fallback = path.split("/").filter(Boolean).at(-1) || "download";
  return {
    blob: await res.blob(),
    filename: filenameFromContentDisposition(res.headers.get("content-disposition"), fallback),
  };
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
