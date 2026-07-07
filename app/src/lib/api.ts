import { fetchEventSource } from "@microsoft/fetch-event-source";
import {
  CodexRuntimeEvent,
  ChangedFile,
  CapabilityInfo,
  ConnectorAuthChatEvent,
  ToolCall,
  UsageInfo,
  SandboxInfo,
  ConnectorInfo,
  ConnectorStatus,
  AgentRunInfo,
  AgentContact,
  AgentContactDeleteResponse,
  AgentContactRequest,
  AgentDelegation,
  AgentDelegationCreateInput,
  GogcliAccountsResponse,
  SessionDetail,
  SessionControlAction,
  SessionSummary,
  TaskActionInfo,
  TaskEventInfo,
  TaskInfo,
  TaskTriggerInfo,
  SkillDraftInput,
  SkillInfo,
  SkillUpdateInput,
  SkillValidationResult,
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
  UserProfile,
} from "@/types";
import { buildChatMessageContent, type ChatFileRef } from "@/lib/chatInput";
import { readableApiErrorMessage } from "@/lib/apiErrors";
import {
  API_URL,
  AuthError,
  authHeaders,
  getApiKey,
  isRecord,
  resolveRippleApiUrl,
  responseDetail,
} from "@/lib/apiTransport";

export {
  AuthError,
  clearApiKey,
  clearUserId,
  getApiKey,
  getApiOrigin,
  getAuthMode,
  getConfiguredApiUrl,
  getUserId,
  isUserSessionAuth,
  isValidUserId,
  resolveApiUrl,
  resolveBackendUrl,
  setApiKey,
  setUserId,
  setUserSessionToken,
} from "@/lib/apiTransport";
export type { ApiUrlEnv, AuthMode } from "@/lib/apiTransport";

export interface ParsedWorkspaceLink {
  isWorkspaceFile: boolean;
  workspacePath: string;
  lineNumber?: number;
  userId?: string;
}

function safeDecodeWorkspacePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parse and normalize potential workspace paths (absolute or relative) into standard
 * workspace-relative paths and optionally extract line numbers.
 * E.g., "/home/lake/workspace/ripple/.ripple/sandboxes/lake/workspace/outputs/bilibili/2026/05/summary.md:1"
 * becomes { isWorkspaceFile: true, workspacePath: "/workspace/outputs/bilibili/2026/05/summary.md", lineNumber: 1, userId: "lake" }
 */
export function parseWorkspaceLink(href: string | undefined): ParsedWorkspaceLink | null {
  if (!href) return null;

  // 1. Check if it's a full sandbox path on the server: ".../sandboxes/<user_id>/workspace/<raw_path>"
  const sandboxMatch = href.match(/sandboxes\/([a-zA-Z0-9_-]{1,64})\/workspace\/(.+)$/);

  let rawPath = "";
  let userId: string | undefined;

  if (sandboxMatch) {
    userId = sandboxMatch[1];
    rawPath = sandboxMatch[2];
  } else {
    // 2. If it's not a sandbox path, check if it is a standard workspace path like "/workspace/foo" or "workspace/foo"
    // Since the host path might contain "/workspace", we look for the last occurrence of "/workspace/" or if it starts with "/workspace/" or "workspace/"
    if (href.startsWith("/workspace/")) {
      rawPath = href.slice("/workspace/".length);
    } else if (href.startsWith("workspace/")) {
      rawPath = href.slice("workspace/".length);
    } else {
      // Check for last "/workspace/" to avoid matching the project root directory
      const lastWsIndex = href.lastIndexOf("/workspace/");
      if (lastWsIndex !== -1) {
        rawPath = href.slice(lastWsIndex + "/workspace/".length);
      } else {
        return null;
      }
    }
  }

  const lineMatch = rawPath.match(/:(\d+)(?::\d+)?$/);
  let lineNumber: number | undefined;
  let cleanPath = rawPath;

  if (lineMatch) {
    lineNumber = parseInt(lineMatch[1], 10);
    cleanPath = rawPath.slice(0, lineMatch.index);
  }

  cleanPath = safeDecodeWorkspacePath(cleanPath);

  const workspacePath = cleanPath.startsWith("/") ? cleanPath : `/workspace/${cleanPath}`;

  return {
    isWorkspaceFile: true,
    workspacePath,
    lineNumber,
    userId,
  };
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

export interface TaskTriggerCreateInput {
  title: string;
  prompt: string;
  trigger_type?: "time";
  kind: "once" | "interval";
  timezone: string;
  run_at?: string | null;
  interval_seconds?: number | null;
  enabled?: boolean;
  model?: string | null;
  effort?: string | null;
  cwd?: string | null;
  max_runtime_seconds?: number;
  max_runs?: number | null;
  missed_run_policy?: string;
  overlap_policy?: string;
  failure_policy?: string;
}

export interface TaskTriggerUpdateInput {
  title?: string;
  prompt?: string;
  trigger_type?: "time";
  kind?: "once" | "interval";
  timezone?: string;
  run_at?: string | null;
  interval_seconds?: number | null;
  enabled?: boolean;
  model?: string | null;
  effort?: string | null;
  cwd?: string | null;
  max_runtime_seconds?: number;
  max_runs?: number | null;
  missed_run_policy?: string;
  overlap_policy?: string;
  failure_policy?: string;
}

export interface TaskTriggerDeleteResponse {
  deleted: boolean;
  trigger_id?: string;
  task_id?: string;
}

export interface TaskActionCreateInput {
  title: string;
  kind?: string;
  objective?: string | null;
  status?: TaskActionInfo["status"];
  assignee?: string | null;
  requiresConfirmation?: boolean;
  nextWakeupAt?: string | null;
}

export interface TaskActionUpdateInput {
  title?: string;
  kind?: string;
  objective?: string | null;
  status?: TaskActionInfo["status"];
  assignee?: string | null;
  requiresConfirmation?: boolean;
  nextWakeupAt?: string | null;
  resultSummary?: string | null;
  lastError?: string | null;
  waitingReason?: string | null;
  sequenceIndex?: number | null;
}

export interface TaskDetailResponse {
  task: TaskInfo;
  actions: TaskActionInfo[];
}

export interface TaskActionUpdateResponse extends TaskDetailResponse {
  action: TaskActionInfo;
}

export interface TaskDeleteResponse {
  ok: boolean;
  taskId: string;
}

interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  fractional: string;
}

function isUtcTimezone(value: string | null | undefined): boolean {
  if (value === undefined || value === null) return false;
  return ["", "utc", "z", "etc/utc", "etc/gmt"].includes(value.trim().toLowerCase());
}

function hasDatetimeOffset(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.endsWith("Z") || trimmed.endsWith("z")) return true;
  const timeStart = Math.max(trimmed.indexOf("T"), trimmed.indexOf("t")) + 1;
  return (
    trimmed.slice(timeStart || trimmed.length).includes("+") ||
    trimmed.slice(timeStart || trimmed.length).includes("-")
  );
}

function parseLocalDateTime(value: string): LocalDateTimeParts | null {
  const match = value
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?$/);
  if (!match) return null;

  const parts: LocalDateTimeParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: match[6] ? Number(match[6]) : 0,
    fractional: match[7] || "",
  };
  const date = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  );
  if (
    date.getUTCFullYear() !== parts.year ||
    date.getUTCMonth() !== parts.month - 1 ||
    date.getUTCDate() !== parts.day ||
    date.getUTCHours() !== parts.hour ||
    date.getUTCMinutes() !== parts.minute ||
    date.getUTCSeconds() !== parts.second
  ) {
    return null;
  }
  return parts;
}

function partsAsUtcMillis(parts: LocalDateTimeParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function partsInTimezone(date: Date, timezone: string): LocalDateTimeParts | null {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }
  if (
    !values.year ||
    !values.month ||
    !values.day ||
    !values.hour ||
    !values.minute ||
    !values.second
  ) {
    return null;
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    fractional: "",
  };
}

function timezoneOffsetMinutesForLocalTime(
  localParts: LocalDateTimeParts,
  timezone: string
): number | null {
  const targetLocalMillis = partsAsUtcMillis(localParts);
  let utcMillis = targetLocalMillis;

  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const zonedParts = partsInTimezone(new Date(utcMillis), timezone);
      if (!zonedParts) return null;
      const delta = targetLocalMillis - partsAsUtcMillis(zonedParts);
      utcMillis += delta;
      if (delta === 0) break;
    }
  } catch {
    return null;
  }

  return Math.round((targetLocalMillis - utcMillis) / 60_000);
}

function timezoneOffsetText(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

function localDateTimeText(parts: LocalDateTimeParts): string {
  const year = String(parts.year).padStart(4, "0");
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  const hour = String(parts.hour).padStart(2, "0");
  const minute = String(parts.minute).padStart(2, "0");
  const second = String(parts.second).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${parts.fractional}`;
}

function normalizeTaskTriggerRunAtForRequest(
  runAt: string | null | undefined,
  timezone: string | null | undefined
): string | null | undefined {
  if (typeof runAt !== "string" || timezone === undefined || timezone === null) return runAt;
  const trimmed = runAt.trim();
  if (!trimmed || isUtcTimezone(timezone) || hasDatetimeOffset(trimmed)) return runAt;
  const localParts = parseLocalDateTime(trimmed);
  if (!localParts) return runAt;
  const offsetMinutes = timezoneOffsetMinutesForLocalTime(localParts, timezone.trim());
  if (offsetMinutes === null) return runAt;
  return `${localDateTimeText(localParts)}${timezoneOffsetText(offsetMinutes)}`;
}

function taskTriggerInputForRequest<T extends { run_at?: string | null; timezone?: string | null }>(
  input: T
): T {
  const runAt = normalizeTaskTriggerRunAtForRequest(input.run_at, input.timezone);
  if (runAt === input.run_at) return input;
  return { ...input, run_at: runAt };
}

function normalizeTaskActionWakeupAtForRequest(
  value: string | null | undefined
): string | null | undefined {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || hasDatetimeOffset(trimmed)) return value;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString();
}

function taskActionInputForRequest(
  input: TaskActionCreateInput | TaskActionUpdateInput
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if ("title" in input && input.title !== undefined) body.title = input.title;
  if ("kind" in input && input.kind !== undefined) body.kind = input.kind;
  if ("objective" in input && input.objective !== undefined) body.objective = input.objective;
  if ("status" in input && input.status !== undefined) body.status = input.status;
  if ("assignee" in input && input.assignee !== undefined) body.assignee = input.assignee;
  if ("requiresConfirmation" in input && input.requiresConfirmation !== undefined) {
    body.requires_confirmation = input.requiresConfirmation;
  }
  if ("nextWakeupAt" in input && input.nextWakeupAt !== undefined) {
    body.next_wakeup_at = normalizeTaskActionWakeupAtForRequest(input.nextWakeupAt);
  }
  if ("resultSummary" in input && input.resultSummary !== undefined) {
    body.result_summary = input.resultSummary;
  }
  if ("lastError" in input && input.lastError !== undefined) body.last_error = input.lastError;
  if ("waitingReason" in input && input.waitingReason !== undefined) {
    body.waiting_reason = input.waitingReason;
  }
  if ("sequenceIndex" in input && input.sequenceIndex !== undefined) {
    body.sequence_index = input.sequenceIndex;
  }
  return body;
}

const CODEX_RUNTIME_EVENT_TYPES = new Set<CodexRuntimeEvent["type"]>([
  "codex_turn_diff_updated",
  "tool_output_delta",
  "file_change_patch_updated",
  "folder_context_search",
  "image_generation",
  "image_view",
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

export interface UserAuthResponse {
  token: string;
  token_type: string;
  user_id: string;
  login: string;
  display_name?: string | null;
  expires_at: string;
}

export interface UserAuthConfigResponse {
  user_auth?: {
    enabled?: boolean;
    session_ttl_seconds?: number;
    service_login_allowed?: boolean;
  };
}

export async function fetchAuthConfig(): Promise<UserAuthConfigResponse> {
  const res = await fetch(`${API_URL}/auth/config`);
  if (!res.ok) return { user_auth: { enabled: false, service_login_allowed: true } };
  return (await res.json()) as UserAuthConfigResponse;
}

export async function loginWithPassword(
  login: string,
  password: string
): Promise<UserAuthResponse> {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login, password }),
  });
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || "Invalid login or password.");
  }
  return (await res.json()) as UserAuthResponse;
}

export async function claimInvite(input: {
  invite_code: string;
  login: string;
  password: string;
  display_name?: string | null;
}): Promise<UserAuthResponse> {
  const res = await fetch(`${API_URL}/auth/invite/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || "Could not claim invite.");
  }
  return (await res.json()) as UserAuthResponse;
}

export async function logoutUserSession(): Promise<void> {
  if (!getApiKey()) return;
  const res = await fetch(`${API_URL}/auth/logout`, {
    method: "POST",
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || "Could not log out.");
  }
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const res = await fetch(`${API_URL}/auth/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      current_password: currentPassword,
      new_password: newPassword,
    }),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || "Could not change password.");
  }
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
  context_folder_path?: string | null;
  forked_from_session_id?: string | null;
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
  pending_control_request?: Record<string, unknown> | null;
  pending_permission_request?: SessionDetail["pendingPermissionRequest"];
  plan_steps?: PlanStep[];
  plan_progress?: PlanProgress | null;
  task_steps?: PlanStep[];
  task_progress?: PlanProgress | null;
}

interface RawAgentDelegation {
  delegation_id?: string;
  requester_user_id?: string;
  requester_session_id?: string;
  target_user_id?: string;
  target_session_id?: string | null;
  target_job_id?: string | null;
  status?: string;
  task_title?: string;
  task_prompt?: string;
  created_at?: string;
  updated_at?: string;
  accepted_at?: string | null;
  completed_at?: string | null;
  result_text?: string | null;
  result_status?: string | null;
  result_job_id?: string | null;
  result_updated_at?: string | null;
  result_output_available?: boolean;
  pending_clarification?: Record<string, unknown> | null;
  last_answer_event?: Record<string, unknown> | null;
  reason?: string | null;
  error?: string | null;
}

interface RawAgentContact {
  owner_user_id?: string;
  contact_user_id?: string;
  remark?: string | null;
  created_at?: string;
  updated_at?: string;
  profile?: {
    user_id?: string;
    user_name?: string;
    display_name?: string | null;
    login?: string | null;
    avatar_uri?: string | null;
  } | null;
}

interface RawAgentContactRequest {
  request_id?: string;
  requester_user_id?: string;
  target_user_id?: string;
  status?: string;
  message?: string | null;
  reason?: string | null;
  created_at?: string;
  updated_at?: string;
  completed_at?: string | null;
  requester_profile?: RawAgentContact["profile"];
  target_profile?: RawAgentContact["profile"];
}

interface RawTaskProgress {
  completed?: number;
  total?: number;
  percent?: number;
  current_action_id?: string | null;
  current_action_title?: string | null;
}

interface RawTask {
  task_id?: string;
  id?: string;
  user_id?: string;
  title?: string;
  objective?: string | null;
  status?: string;
  priority?: string;
  pinned?: boolean;
  requires_confirmation?: boolean;
  source_session_id?: string | null;
  due_at?: string | null;
  progress?: RawTaskProgress | null;
  last_run_id?: string | null;
  last_error?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

interface RawTaskAction {
  action_id?: string;
  id?: string;
  task_id?: string;
  user_id?: string;
  kind?: string;
  title?: string;
  objective?: string | null;
  status?: string;
  assignee?: string | null;
  requires_confirmation?: boolean;
  source_session_id?: string | null;
  due_at?: string | null;
  next_wakeup_at?: string | null;
  result_summary?: string | null;
  last_run_id?: string | null;
  last_error?: string | null;
  waiting_reason?: string | null;
  sequence_index?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
}

interface RawTaskEvent {
  event_id?: string;
  id?: string;
  task_id?: string;
  user_id?: string;
  event_type?: string;
  type?: string;
  payload?: Record<string, unknown> | null;
  details?: Record<string, unknown> | null;
  created_at?: string | null;
}

function normalizeTaskProgress(raw: RawTaskProgress | null | undefined): TaskInfo["progress"] {
  if (!raw) return null;
  return {
    completed: typeof raw.completed === "number" ? raw.completed : 0,
    total: typeof raw.total === "number" ? raw.total : 0,
    percent: typeof raw.percent === "number" ? raw.percent : 0,
    currentActionId: raw.current_action_id ?? null,
    currentActionTitle: raw.current_action_title ?? null,
  };
}

function normalizeTask(raw: RawTask): TaskInfo {
  return {
    taskId: raw.task_id || raw.id || "",
    userId: raw.user_id || "",
    title: raw.title?.trim() || "Task",
    objective: raw.objective ?? null,
    status: raw.status || "active",
    priority: raw.priority || "normal",
    pinned: raw.pinned === true,
    requiresConfirmation: raw.requires_confirmation === true,
    sourceSessionId: raw.source_session_id ?? null,
    dueAt: raw.due_at ?? null,
    progress: normalizeTaskProgress(raw.progress),
    lastRunId: raw.last_run_id ?? null,
    lastError: raw.last_error ?? null,
    createdAt: raw.created_at ?? null,
    updatedAt: raw.updated_at ?? null,
  };
}

function normalizeTaskAction(raw: RawTaskAction): TaskActionInfo {
  return {
    actionId: raw.action_id || raw.id || "",
    taskId: raw.task_id || "",
    userId: raw.user_id || "",
    kind: raw.kind || "next_step",
    title: raw.title?.trim() || "Task action",
    objective: raw.objective ?? null,
    status: raw.status || "confirmed",
    assignee: raw.assignee ?? null,
    requiresConfirmation: raw.requires_confirmation === true,
    sourceSessionId: raw.source_session_id ?? null,
    nextWakeupAt: raw.next_wakeup_at ?? raw.due_at ?? null,
    resultSummary: raw.result_summary ?? null,
    lastRunId: raw.last_run_id ?? null,
    lastError: raw.last_error ?? null,
    waitingReason: raw.waiting_reason ?? null,
    sequenceIndex: raw.sequence_index ?? null,
    createdAt: raw.created_at ?? null,
    updatedAt: raw.updated_at ?? null,
  };
}

function normalizeTaskActionResponse(
  raw: RawTaskAction | { action?: RawTaskAction }
): TaskActionInfo {
  if ("action" in raw && raw.action) {
    return normalizeTaskAction(raw.action);
  }
  return normalizeTaskAction(raw as RawTaskAction);
}

function normalizeTaskEvent(raw: RawTaskEvent): TaskEventInfo {
  return {
    eventId: raw.event_id || raw.id || "",
    taskId: raw.task_id || "",
    userId: raw.user_id || "",
    eventType: raw.event_type || raw.type || "task_event",
    payload: raw.payload ?? raw.details ?? null,
    createdAt: raw.created_at ?? null,
  };
}

function normalizeTaskDetailResponse(raw: {
  task?: RawTask;
  actions?: RawTaskAction[];
}): TaskDetailResponse {
  return {
    task: normalizeTask(raw.task || {}),
    actions: (raw.actions || []).map(normalizeTaskAction),
  };
}

function normalizeSessionSummary(raw: RawSessionSummary): SessionSummary {
  return {
    sessionId: raw.session_id,
    title: raw.title,
    pinned: raw.pinned === true,
    contextFolderPath: raw.context_folder_path ?? null,
    ...(raw.forked_from_session_id !== undefined
      ? { forkedFromSessionId: raw.forked_from_session_id }
      : {}),
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
    pendingControlRequest: raw.pending_control_request ?? null,
    pendingPermissionRequest: raw.pending_permission_request ?? null,
    planSteps: raw.plan_steps || raw.task_steps || [],
    planProgress: raw.plan_progress ?? raw.task_progress ?? null,
  };
}

function normalizeAgentDelegation(raw: RawAgentDelegation): AgentDelegation {
  return {
    delegationId: raw.delegation_id || "",
    requesterUserId: raw.requester_user_id || "",
    requesterSessionId: raw.requester_session_id || "",
    targetUserId: raw.target_user_id || "",
    targetSessionId: raw.target_session_id ?? null,
    targetJobId: raw.target_job_id ?? null,
    status: raw.status || "pending_acceptance",
    taskTitle: raw.task_title || "Agent delegation",
    taskPrompt: raw.task_prompt || "",
    createdAt: raw.created_at || "",
    updatedAt: raw.updated_at || "",
    acceptedAt: raw.accepted_at ?? null,
    completedAt: raw.completed_at ?? null,
    resultText: raw.result_text ?? null,
    resultStatus: raw.result_status ?? null,
    resultJobId: raw.result_job_id ?? null,
    resultUpdatedAt: raw.result_updated_at ?? null,
    resultOutputAvailable: raw.result_output_available === true,
    pendingClarification: raw.pending_clarification ?? null,
    lastAnswerEvent: raw.last_answer_event ?? null,
    reason: raw.reason ?? null,
    error: raw.error ?? null,
  };
}

function normalizeAgentContact(raw: RawAgentContact): AgentContact {
  const profile = raw.profile || {};
  const contactUserId = raw.contact_user_id || profile.user_id || "";
  return {
    ownerUserId: raw.owner_user_id || "",
    contactUserId,
    remark: typeof raw.remark === "string" ? raw.remark : "",
    createdAt: raw.created_at || "",
    updatedAt: raw.updated_at || "",
    profile: {
      userId: profile.user_id || contactUserId,
      userName: profile.user_name || profile.display_name || profile.login || contactUserId,
      displayName: profile.display_name ?? null,
      login: profile.login ?? null,
      avatarUri: profile.avatar_uri ?? null,
    },
  };
}

function normalizeAgentContactProfile(
  raw: RawAgentContact["profile"] | undefined | null,
  fallbackUserId: string
): AgentContact["profile"] {
  const profile = raw || {};
  return {
    userId: profile.user_id || fallbackUserId,
    userName: profile.user_name || profile.display_name || profile.login || fallbackUserId,
    displayName: profile.display_name ?? null,
    login: profile.login ?? null,
    avatarUri: profile.avatar_uri ?? null,
  };
}

function normalizeAgentContactRequest(raw: RawAgentContactRequest): AgentContactRequest {
  const requesterUserId = raw.requester_user_id || "";
  const targetUserId = raw.target_user_id || "";
  return {
    requestId: raw.request_id || "",
    requesterUserId,
    targetUserId,
    status: raw.status || "pending",
    message: raw.message ?? null,
    reason: raw.reason ?? null,
    createdAt: raw.created_at || "",
    updatedAt: raw.updated_at || "",
    completedAt: raw.completed_at ?? null,
    requesterProfile: normalizeAgentContactProfile(raw.requester_profile, requesterUserId),
    targetProfile: normalizeAgentContactProfile(raw.target_profile, targetUserId),
  };
}

export async function fetchModels(): Promise<{ id: string; owned_by: string }[]> {
  const res = await fetch(`${API_URL}/models`, { headers: { ...authHeaders() } });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error("Failed to fetch models");
  const data = await res.json();
  return data.data || [];
}

export async function fetchBrowserPage(url: string): Promise<BrowserPageResponse> {
  const qs = new URLSearchParams({ url });
  const res = await fetch(`${API_URL}/browser/page?${qs.toString()}`, {
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to fetch browser page (${res.status})`);
  }
  return (await res.json()) as BrowserPageResponse;
}

function urlWithCursor(url: string, cursor: string | null): string {
  if (!cursor) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}cursor=${encodeURIComponent(cursor)}`;
}

async function fetchPaginatedApiList<TRaw, TOut>(
  url: string,
  itemKey: string,
  normalize: (raw: TRaw) => TOut,
  fallbackMessage: string
): Promise<TOut[]> {
  const items: TOut[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  do {
    const pageUrl: string = urlWithCursor(url, cursor);
    const res: Response = await fetch(pageUrl, { headers: { ...authHeaders() } });
    if (res.status === 401) throw new AuthError();
    if (!res.ok) {
      const detail = await responseDetail(res);
      throw new Error(detail || `${fallbackMessage} (${res.status})`);
    }

    const data: unknown = await res.json();
    const rawItems: unknown[] = isRecord(data) && Array.isArray(data[itemKey]) ? data[itemKey] : [];
    items.push(...(rawItems as TRaw[]).map(normalize));

    const nextCursor: string =
      isRecord(data) && typeof data.next_cursor === "string" ? data.next_cursor.trim() : "";
    if (!nextCursor || seenCursors.has(nextCursor)) {
      cursor = null;
    } else {
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  } while (cursor);

  return items;
}

export async function fetchTasks(): Promise<TaskInfo[]> {
  return fetchPaginatedApiList<RawTask, TaskInfo>(
    `${API_URL}/tasks`,
    "tasks",
    normalizeTask,
    "Failed to fetch tasks"
  );
}

export async function fetchSessionTasks(sessionId: string): Promise<TaskInfo[]> {
  return fetchPaginatedApiList<RawTask, TaskInfo>(
    `${API_URL}/sessions/${encodeURIComponent(sessionId)}/tasks`,
    "tasks",
    normalizeTask,
    "Failed to fetch session tasks"
  );
}

export async function fetchTask(taskId: string): Promise<TaskDetailResponse> {
  const res = await fetch(`${API_URL}/tasks/${encodeURIComponent(taskId)}`, {
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to fetch task (${res.status})`);
  }
  return normalizeTaskDetailResponse(
    (await res.json()) as { task?: RawTask; actions?: RawTaskAction[] }
  );
}

export interface TaskUpdateInput {
  title?: string;
  objective?: string | null;
  status?: string;
  priority?: string;
  pinned?: boolean;
  dueAt?: string | null;
}

export async function updateTask(
  taskId: string,
  input: TaskUpdateInput
): Promise<TaskDetailResponse> {
  const body: Record<string, unknown> = {};
  if ("title" in input) body.title = input.title;
  if ("objective" in input) body.objective = input.objective;
  if ("status" in input) body.status = input.status;
  if ("priority" in input) body.priority = input.priority;
  if ("pinned" in input) body.pinned = input.pinned;
  if ("dueAt" in input) body.due_at = input.dueAt;

  const res = await fetch(`${API_URL}/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to update task (${res.status})`);
  }
  return normalizeTaskDetailResponse(
    (await res.json()) as { task?: RawTask; actions?: RawTaskAction[] }
  );
}

export async function confirmTask(taskId: string): Promise<TaskDetailResponse> {
  const res = await fetch(`${API_URL}/tasks/${encodeURIComponent(taskId)}/confirm`, {
    method: "POST",
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to confirm task (${res.status})`);
  }
  return normalizeTaskDetailResponse(
    (await res.json()) as { task?: RawTask; actions?: RawTaskAction[] }
  );
}

export async function cancelTask(taskId: string): Promise<TaskDetailResponse> {
  const res = await fetch(`${API_URL}/tasks/${encodeURIComponent(taskId)}`, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to cancel task (${res.status})`);
  }
  return normalizeTaskDetailResponse(
    (await res.json()) as { task?: RawTask; actions?: RawTaskAction[] }
  );
}

export async function deleteTask(taskId: string): Promise<TaskDeleteResponse> {
  const res = await fetch(`${API_URL}/tasks/${encodeURIComponent(taskId)}/delete`, {
    method: "POST",
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to delete task (${res.status})`);
  }
  const data = (await res.json()) as { ok?: boolean; task_id?: string };
  return {
    ok: data.ok === true,
    taskId: data.task_id || taskId,
  };
}

export async function runTaskNow(taskId: string): Promise<AgentRunInfo> {
  const res = await fetch(`${API_URL}/tasks/${encodeURIComponent(taskId)}/run-now`, {
    method: "POST",
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to run task (${res.status})`);
  }
  return (await res.json()) as AgentRunInfo;
}

export async function fetchTaskEvents(taskId: string): Promise<TaskEventInfo[]> {
  const res = await fetch(`${API_URL}/tasks/${encodeURIComponent(taskId)}/events`, {
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to fetch task events (${res.status})`);
  }
  const data = (await res.json()) as { events?: RawTaskEvent[] };
  return (data.events || []).map(normalizeTaskEvent);
}

export async function createTaskAction(
  taskId: string,
  input: TaskActionCreateInput
): Promise<TaskActionInfo> {
  const res = await fetch(`${API_URL}/tasks/${encodeURIComponent(taskId)}/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(taskActionInputForRequest(input)),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to create task action (${res.status})`);
  }
  return normalizeTaskActionResponse(
    (await res.json()) as RawTaskAction | { action?: RawTaskAction }
  );
}

export async function updateTaskAction(
  taskId: string,
  actionId: string,
  input: TaskActionUpdateInput
): Promise<TaskActionUpdateResponse> {
  const res = await fetch(
    `${API_URL}/tasks/${encodeURIComponent(taskId)}/actions/${encodeURIComponent(actionId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(taskActionInputForRequest(input)),
    }
  );
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to update task action (${res.status})`);
  }
  const data = (await res.json()) as {
    task?: RawTask;
    action?: RawTaskAction;
    actions?: RawTaskAction[];
  };
  const detail = normalizeTaskDetailResponse(data);
  return {
    ...detail,
    action: data.action
      ? normalizeTaskAction(data.action)
      : detail.actions.find((action) => action.actionId === actionId) || normalizeTaskAction({}),
  };
}

export async function fetchTaskTriggers(taskId: string): Promise<TaskTriggerInfo[]> {
  return fetchPaginatedApiList<TaskTriggerInfo, TaskTriggerInfo>(
    `${API_URL}/tasks/${encodeURIComponent(taskId)}/triggers`,
    "triggers",
    (trigger) => trigger,
    "Failed to fetch task triggers"
  );
}

export async function fetchAllTaskTriggers(): Promise<TaskTriggerInfo[]> {
  return fetchPaginatedApiList<TaskTriggerInfo, TaskTriggerInfo>(
    `${API_URL}/task-triggers`,
    "triggers",
    (trigger) => trigger,
    "Failed to fetch task triggers"
  );
}

export async function createTaskActionTrigger(
  taskId: string,
  actionId: string,
  input: TaskTriggerCreateInput
): Promise<TaskTriggerInfo> {
  const res = await fetch(
    `${API_URL}/tasks/${encodeURIComponent(taskId)}/actions/${encodeURIComponent(actionId)}/triggers`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(taskTriggerInputForRequest(input)),
    }
  );
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to create task trigger (${res.status})`);
  }
  return (await res.json()) as TaskTriggerInfo;
}

export async function createTaskTrigger(
  taskId: string,
  input: TaskTriggerCreateInput
): Promise<TaskTriggerInfo> {
  const res = await fetch(`${API_URL}/tasks/${encodeURIComponent(taskId)}/triggers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(taskTriggerInputForRequest(input)),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to create task trigger (${res.status})`);
  }
  return (await res.json()) as TaskTriggerInfo;
}

export async function updateTaskTrigger(
  taskId: string,
  triggerId: string,
  input: TaskTriggerUpdateInput
): Promise<TaskTriggerInfo> {
  const res = await fetch(
    `${API_URL}/tasks/${encodeURIComponent(taskId)}/triggers/${encodeURIComponent(triggerId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(taskTriggerInputForRequest(input)),
    }
  );
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to update task trigger (${res.status})`);
  }
  return (await res.json()) as TaskTriggerInfo;
}

export async function deleteTaskTrigger(
  taskId: string,
  triggerId: string
): Promise<TaskTriggerDeleteResponse> {
  const res = await fetch(
    `${API_URL}/tasks/${encodeURIComponent(taskId)}/triggers/${encodeURIComponent(triggerId)}`,
    {
      method: "DELETE",
      headers: { ...authHeaders() },
    }
  );
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to delete task trigger (${res.status})`);
  }
  return (await res.json()) as TaskTriggerDeleteResponse;
}

export async function runTaskTriggerNow(taskId: string, triggerId: string): Promise<AgentRunInfo> {
  const res = await fetch(
    `${API_URL}/tasks/${encodeURIComponent(taskId)}/triggers/${encodeURIComponent(triggerId)}/run-now`,
    {
      method: "POST",
      headers: { ...authHeaders() },
    }
  );
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to run task trigger (${res.status})`);
  }
  return (await res.json()) as AgentRunInfo;
}

export async function fetchRun(jobId: string): Promise<AgentRunInfo> {
  const res = await fetch(`${API_URL}/runs/${encodeURIComponent(jobId)}`, {
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to fetch run (${res.status})`);
  }
  return (await res.json()) as AgentRunInfo;
}

export async function downloadRunOutput(jobId: string): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(`${API_URL}/runs/${encodeURIComponent(jobId)}/output`, {
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to download run output (${res.status})`);
  }
  return {
    blob: await res.blob(),
    filename: filenameFromContentDisposition(
      res.headers.get("content-disposition"),
      `${jobId}-output.txt`
    ),
  };
}

export async function fetchRunOutputText(jobId: string): Promise<string> {
  const { blob } = await downloadRunOutput(jobId);
  return blob.text();
}

export interface SessionCreateInput {
  model?: string | null;
  contextFolderPath?: string | null;
}

export async function createSession(input: SessionCreateInput = {}): Promise<SessionSummary> {
  const res = await fetch(`${API_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      model: input.model,
      context_folder_path: input.contextFolderPath,
    }),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error("Failed to create session");
  return normalizeSessionSummary((await res.json()) as RawSessionSummary);
}

export interface SessionUpdateInput {
  title?: string;
  pinned?: boolean;
  model?: string | null;
  contextFolderPath?: string | null;
}

export async function updateSession(
  sessionId: string,
  input: SessionUpdateInput
): Promise<SessionSummary> {
  const body: Record<string, unknown> = {};
  if ("title" in input) body.title = input.title;
  if ("pinned" in input) body.pinned = input.pinned;
  if ("model" in input) body.model = input.model;
  if ("contextFolderPath" in input) body.context_folder_path = input.contextFolderPath ?? null;
  const res = await fetch(`${API_URL}/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
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
    return await fetchPaginatedApiList<RawSessionSummary, SessionSummary>(
      `${API_URL}/sessions`,
      "sessions",
      normalizeSessionSummary,
      "Failed to fetch sessions"
    );
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

export async function fetchAgentDelegations(role: "sent" | "received"): Promise<AgentDelegation[]> {
  const res = await fetch(`${API_URL}/agent-delegations?role=${encodeURIComponent(role)}`, {
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to fetch agent delegations (${res.status})`);
  }
  const data = (await res.json()) as unknown;
  const rawDelegations =
    isRecord(data) && Array.isArray(data.delegations)
      ? data.delegations
      : Array.isArray(data)
        ? data
        : [];
  return (rawDelegations as RawAgentDelegation[]).map(normalizeAgentDelegation);
}

export async function fetchAgentContacts(): Promise<AgentContact[]> {
  const res = await fetch(`${API_URL}/contacts`, {
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to fetch contacts (${res.status})`);
  }
  const data = (await res.json()) as unknown;
  const rawContacts =
    isRecord(data) && Array.isArray(data.contacts)
      ? data.contacts
      : Array.isArray(data)
        ? data
        : [];
  return (rawContacts as RawAgentContact[]).map(normalizeAgentContact);
}

export async function addAgentContact(contactUserId: string): Promise<AgentContact> {
  const res = await fetch(`${API_URL}/contacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ contact_user_id: contactUserId }),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to add contact (${res.status})`);
  }
  return normalizeAgentContact((await res.json()) as RawAgentContact);
}

export async function updateAgentContact(
  contactUserId: string,
  input: { remark: string }
): Promise<AgentContact> {
  const res = await fetch(`${API_URL}/contacts/${encodeURIComponent(contactUserId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ remark: input.remark }),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to update contact (${res.status})`);
  }
  return normalizeAgentContact((await res.json()) as RawAgentContact);
}

export async function removeAgentContact(
  contactUserId: string
): Promise<AgentContactDeleteResponse> {
  const res = await fetch(`${API_URL}/contacts/${encodeURIComponent(contactUserId)}`, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to remove contact (${res.status})`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  return {
    deleted: data.deleted === true,
    contactUserId: typeof data.contact_user_id === "string" ? data.contact_user_id : contactUserId,
  };
}

export async function fetchAgentContactRequests(
  role: "sent" | "received"
): Promise<AgentContactRequest[]> {
  const res = await fetch(`${API_URL}/contact-requests?role=${encodeURIComponent(role)}`, {
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to fetch contact requests (${res.status})`);
  }
  const data = (await res.json()) as unknown;
  const rawRequests =
    isRecord(data) && Array.isArray(data.requests)
      ? data.requests
      : Array.isArray(data)
        ? data
        : [];
  return (rawRequests as RawAgentContactRequest[]).map(normalizeAgentContactRequest);
}

export async function createAgentContactRequest(
  targetUserId: string,
  message?: string
): Promise<AgentContactRequest> {
  const res = await fetch(`${API_URL}/contact-requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      target_user_id: targetUserId,
      message: message?.trim() || undefined,
    }),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to create contact request (${res.status})`);
  }
  return normalizeAgentContactRequest((await res.json()) as RawAgentContactRequest);
}

async function postAgentContactRequestAction(
  requestId: string,
  action: "accept" | "reject",
  body: Record<string, unknown> = {}
): Promise<AgentContactRequest> {
  const res = await fetch(
    `${API_URL}/contact-requests/${encodeURIComponent(requestId)}/${action}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    }
  );
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to ${action} contact request (${res.status})`);
  }
  return normalizeAgentContactRequest((await res.json()) as RawAgentContactRequest);
}

export async function acceptAgentContactRequest(requestId: string): Promise<AgentContactRequest> {
  return postAgentContactRequestAction(requestId, "accept");
}

export async function rejectAgentContactRequest(
  requestId: string,
  reason?: string
): Promise<AgentContactRequest> {
  return postAgentContactRequestAction(
    requestId,
    "reject",
    reason?.trim() ? { reason: reason.trim() } : {}
  );
}

export async function createAgentDelegation(
  input: AgentDelegationCreateInput
): Promise<AgentDelegation> {
  const res = await fetch(`${API_URL}/agent-delegations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      target_user_id: input.targetUserId,
      source_session_id: input.sourceSessionId,
      task_title: input.taskTitle,
      task_prompt: input.taskPrompt,
    }),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to create agent delegation (${res.status})`);
  }
  return normalizeAgentDelegation((await res.json()) as RawAgentDelegation);
}

async function postAgentDelegationAction(
  delegationId: string,
  action: "accept" | "reject" | "cancel" | "answer",
  body: Record<string, unknown> = {}
): Promise<AgentDelegation> {
  const res = await fetch(
    `${API_URL}/agent-delegations/${encodeURIComponent(delegationId)}/${action}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    }
  );
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to ${action} agent delegation (${res.status})`);
  }
  return normalizeAgentDelegation((await res.json()) as RawAgentDelegation);
}

export async function acceptAgentDelegation(
  delegationId: string,
  reason?: string
): Promise<AgentDelegation> {
  return postAgentDelegationAction(
    delegationId,
    "accept",
    reason?.trim() ? { reason: reason.trim() } : {}
  );
}

export async function rejectAgentDelegation(
  delegationId: string,
  reason?: string
): Promise<AgentDelegation> {
  return postAgentDelegationAction(
    delegationId,
    "reject",
    reason?.trim() ? { reason: reason.trim() } : {}
  );
}

export async function cancelAgentDelegation(
  delegationId: string,
  reason?: string
): Promise<AgentDelegation> {
  return postAgentDelegationAction(
    delegationId,
    "cancel",
    reason?.trim() ? { reason: reason.trim() } : {}
  );
}

export async function answerAgentDelegation(
  delegationId: string,
  answer: string
): Promise<AgentDelegation> {
  return postAgentDelegationAction(delegationId, "answer", { answer });
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

export async function forkSession(sessionId: string): Promise<SessionSummary> {
  const res = await fetch(`${API_URL}/sessions/${encodeURIComponent(sessionId)}/fork`, {
    method: "POST",
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to fork session (${res.status})`);
  }
  const data = (await res.json()) as unknown;
  const rawSession = isRecord(data) && isRecord(data.session) ? data.session : data;
  return normalizeSessionSummary(rawSession as RawSessionSummary);
}

export interface MemoryFeatureStatus {
  enabled: boolean;
  use_memories: boolean;
  generate_memories: boolean;
  dedicated_tools: boolean;
  disable_on_external_context: boolean;
}

export interface MemorySummaryStatus {
  available: boolean;
  registry_available: boolean;
  raw_available: boolean;
  last_updated_at: string | null;
}

export interface MemoryRuntimeStatus {
  memories_db_available: boolean;
  stage1_output_count: number | null;
}

export interface MemoryStatusResponse {
  ok: boolean;
  memory: MemoryFeatureStatus;
  summary: MemorySummaryStatus;
  runtime: MemoryRuntimeStatus;
}

export interface MemoryFileContent {
  text: string;
  truncated: boolean;
}

export interface MemorySummaryResponse {
  ok: boolean;
  summary: MemoryFileContent | null;
  registry: MemoryFileContent | null;
  raw: MemoryFileContent | null;
}

export async function fetchMemoryStatus(): Promise<MemoryStatusResponse> {
  const res = await fetch(`${API_URL}/memory/status`, {
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to fetch memory status (${res.status})`);
  }
  return (await res.json()) as MemoryStatusResponse;
}

export async function fetchMemorySummary(): Promise<MemorySummaryResponse> {
  const res = await fetch(`${API_URL}/memory/summary`, {
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to fetch memory summary (${res.status})`);
  }
  return (await res.json()) as MemorySummaryResponse;
}

export async function resetMemory(): Promise<boolean> {
  const res = await fetch(`${API_URL}/memory/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ confirm: true }),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to reset memory (${res.status})`);
  }
  return true;
}

export async function disableSessionMemory(sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/sessions/${encodeURIComponent(sessionId)}/memory/disable`, {
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
  onChangedFiles?: (files: ChangedFile[]) => void;
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

export interface ChatScreenContext {
  app?: string;
  screen_id?: string;
  active_view?: string;
  target?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ChatClientContext {
  schema_version?: string;
  captured_at?: string;
  producer?: Record<string, unknown>;
  software?: {
    host_app?: Record<string, unknown>;
    ai_surface?: Record<string, unknown>;
    screen?: Record<string, unknown>;
    selection?: Record<string, unknown>;
    entities?: Array<Record<string, unknown>>;
    available_actions?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  devices?: Array<{
    id?: string;
    kind?: string;
    source?: string;
    identity?: Record<string, unknown>;
    connection?: Record<string, unknown>;
    state?: Record<string, unknown>;
    capabilities?: string[];
    [key: string]: unknown;
  }>;
  environment?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ChatBrowserContext {
  schema_version?: string;
  captured_at?: string;
  active?: boolean;
  page?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface BrowserPageResponse {
  url: string;
  title?: string | null;
  text: string;
  truncated: boolean;
  captured_at: string;
}

interface SendChatMessageOptions {
  signal?: AbortSignal;
  files?: ChatFileRef[];
  requiredSkillIds?: string[];
  screenContext?: ChatScreenContext;
  clientContext?: ChatClientContext | null;
  browserContext?: ChatBrowserContext | null;
}

function responseIdForSession(sessionId: string): string {
  return `resp_${sessionId}`;
}

function normalizeRippleStreamEvent(value: Record<string, unknown>): Record<string, unknown> {
  const type = typeof value.type === "string" ? value.type : "";
  if (!type.startsWith("ripple.")) return value;
  return {
    ...value,
    type:
      typeof value.ripple_event_type === "string"
        ? value.ripple_event_type
        : type.slice("ripple.".length),
  };
}

function usageFromResponsesUsage(value: unknown): UsageInfo | null {
  if (!isRecord(value)) return null;
  const inputTokens =
    typeof value.input_tokens === "number"
      ? value.input_tokens
      : typeof value.prompt_tokens === "number"
        ? value.prompt_tokens
        : 0;
  const outputTokens =
    typeof value.output_tokens === "number"
      ? value.output_tokens
      : typeof value.completion_tokens === "number"
        ? value.completion_tokens
        : 0;
  const inputDetails = isRecord(value.input_tokens_details) ? value.input_tokens_details : {};
  const outputDetails = isRecord(value.output_tokens_details) ? value.output_tokens_details : {};
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens:
      typeof value.total_tokens === "number" ? value.total_tokens : inputTokens + outputTokens,
    cached_input_tokens:
      typeof inputDetails.cached_tokens === "number" ? inputDetails.cached_tokens : undefined,
    reasoning_output_tokens:
      typeof outputDetails.reasoning_tokens === "number"
        ? outputDetails.reasoning_tokens
        : undefined,
  };
}

function changedFilesFromResponsesPayload(value: unknown): ChangedFile[] {
  if (!isRecord(value) || !isRecord(value.ripple_changed_files)) return [];
  const files = Array.isArray(value.ripple_changed_files.files)
    ? value.ripple_changed_files.files
    : [];
  const changedFiles: ChangedFile[] = [];
  const seen = new Set<string>();
  for (const item of files) {
    if (!isRecord(item) || typeof item.path !== "string" || !item.path.trim()) continue;
    const path = item.path.trim();
    if (seen.has(path)) continue;
    seen.add(path);
    const file: ChangedFile = { path };
    if (typeof item.status === "string" && item.status.trim()) {
      file.status = item.status.trim();
    }
    if (
      typeof item.additions === "number" &&
      Number.isFinite(item.additions) &&
      item.additions >= 0
    ) {
      file.additions = Math.trunc(item.additions);
    }
    if (
      typeof item.deletions === "number" &&
      Number.isFinite(item.deletions) &&
      item.deletions >= 0
    ) {
      file.deletions = Math.trunc(item.deletions);
    }
    if (typeof item.previous_path === "string" && item.previous_path.trim()) {
      file.previousPath = item.previous_path.trim();
    } else if (typeof item.previousPath === "string" && item.previousPath.trim()) {
      file.previousPath = item.previousPath.trim();
    }
    changedFiles.push(file);
  }
  return changedFiles;
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
          const parsed = JSON.parse(msg.data);
          const data = isRecord(parsed) ? normalizeRippleStreamEvent(parsed) : parsed;

          if (data.error) {
            callbacks.onError(new Error(data.error.message || String(data.error)));
            markComplete();
            return;
          }

          if (data.type === "heartbeat") {
            callbacks.onHeartbeat?.();
            return;
          }

          if (data.type === "response.created") {
            return;
          }

          if (data.type === "response.output_text.delta") {
            if (typeof data.delta === "string") {
              callbacks.onMessageDelta(data.delta);
            }
            return;
          }

          if (data.type === "response.completed") {
            const response = isRecord(data.response) ? data.response : {};
            const usage = usageFromResponsesUsage(response.usage);
            if (usage) callbacks.onUsage(usage);
            const changedFiles = changedFilesFromResponsesPayload(response);
            if (changedFiles.length > 0) callbacks.onChangedFiles?.(changedFiles);
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
  options?: SendChatMessageOptions
) {
  const metadata: Record<string, unknown> = { ripple_session_id: sessionId };
  if (options?.requiredSkillIds?.length) {
    metadata.required_skill_ids = options.requiredSkillIds;
  }
  if (options?.screenContext) {
    metadata.screen_context = options.screenContext;
  }
  if (options?.clientContext) {
    metadata.client_context = options.clientContext;
  }
  if (options?.browserContext) {
    metadata.browser_context = options.browserContext;
  }
  return streamChatResponse(
    "/responses",
    {
      model,
      input: [{ role: "user", content: buildChatMessageContent(content, options?.files || []) }],
      stream: true,
      previous_response_id: responseIdForSession(sessionId),
      metadata,
    },
    callbacks,
    { signal: options?.signal }
  );
}

export async function sendSessionControlAction(
  sessionId: string,
  label: string,
  action: SessionControlAction,
  model: string,
  callbacks: ChatStreamCallbacks,
  options?: { signal?: AbortSignal }
) {
  return streamChatResponse(
    "/responses",
    {
      model,
      input: [
        {
          role: "user",
          content: [
            {
              type: "ripple_control_action",
              label,
              action,
            },
          ],
        },
      ],
      stream: true,
      previous_response_id: responseIdForSession(sessionId),
      metadata: { ripple_session_id: sessionId },
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

export async function fetchCapabilities(): Promise<CapabilityInfo[]> {
  const res = await fetch(`${API_URL}/capabilities`, { headers: { ...authHeaders() } });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Failed to fetch capabilities (${res.status})`);
  const body = (await res.json()) as { capabilities: CapabilityInfo[] };
  return body.capabilities || [];
}

export async function updateSkillCapability(skillId: string, enabled: boolean): Promise<SkillInfo> {
  const res = await fetch(`${API_URL}/skills/${encodeURIComponent(skillId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ enabled }),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to update skill (${res.status})`);
  }
  return (await res.json()) as SkillInfo;
}

export async function fetchSkills(): Promise<SkillInfo[]> {
  const res = await fetch(`${API_URL}/skills`, { headers: { ...authHeaders() } });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Failed to fetch skills (${res.status})`);
  const body = (await res.json()) as { skills: SkillInfo[] };
  return body.skills || [];
}

export async function fetchSkill(skillId: string): Promise<SkillInfo> {
  const res = await fetch(`${API_URL}/skills/${encodeURIComponent(skillId)}`, {
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to fetch skill (${res.status})`);
  }
  return (await res.json()) as SkillInfo;
}

export async function createSkill(input: SkillDraftInput): Promise<SkillInfo> {
  const res = await fetch(`${API_URL}/skills`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to create skill (${res.status})`);
  }
  return (await res.json()) as SkillInfo;
}

export async function updateSkill(skillId: string, input: SkillUpdateInput): Promise<SkillInfo> {
  const res = await fetch(`${API_URL}/skills/${encodeURIComponent(skillId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to update skill (${res.status})`);
  }
  return (await res.json()) as SkillInfo;
}

export async function validateSkill(skillId: string): Promise<SkillValidationResult> {
  const res = await fetch(`${API_URL}/skills/${encodeURIComponent(skillId)}/validate`, {
    method: "POST",
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to validate skill (${res.status})`);
  }
  return (await res.json()) as SkillValidationResult;
}

export async function deleteSkill(skillId: string): Promise<SkillInfo> {
  const res = await fetch(`${API_URL}/skills/${encodeURIComponent(skillId)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ confirm: true }),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to delete skill (${res.status})`);
  }
  return (await res.json()) as SkillInfo;
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
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ confirm: true }),
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
  if (!res.ok) {
    const detail = await responseDetail(res);
    if (res.status === 404) {
      if (detail.includes("Sandbox for user")) {
        throw new Error("Workspace is not ready for this user.");
      }
      if (detail.includes("Path not found")) {
        throw new Error("File or folder no longer exists. Refresh workspace.");
      }
    }
    throw new Error(detail || `Failed to preview file (${res.status})`);
  }
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
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to upload attachment (${res.status})`);
  }
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
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to upload files (${res.status})`);
  }
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

export async function fetchWorkspaceDocumentPreview(
  path: string
): Promise<{ blob: Blob; filename: string }> {
  const qs = new URLSearchParams({ path });
  const res = await fetch(`${API_URL}/workspace/preview?${qs.toString()}`, {
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    if (res.status === 404) {
      if (detail.includes("Sandbox for user")) {
        throw new Error("Workspace is not ready for this user.");
      }
      if (detail.includes("Path not found")) {
        throw new Error("File or folder no longer exists. Refresh workspace.");
      }
    }
    throw new Error(detail || `Failed to preview document (${res.status})`);
  }
  const fallback = path.split("/").filter(Boolean).at(-1) || "preview.pdf";
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

export async function deleteWorkspaceEntry(path: string): Promise<boolean> {
  const res = await fetch(`${API_URL}/workspace/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ path, confirm: true }),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to delete entry (${res.status})`);
  }
  return res.ok;
}

export async function pasteWorkspaceEntry(
  path: string,
  destinationDir: string,
  action: "copy" | "move"
): Promise<WorkspaceEntry> {
  const res = await fetch(`${API_URL}/workspace/paste`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ path, destination_dir: destinationDir, action }),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Paste failed (${res.status})`);
  }
  return (await res.json()) as WorkspaceEntry;
}

export async function createWorkspaceEntry(
  path: string,
  kind: "file" | "directory"
): Promise<WorkspaceEntry> {
  const res = await fetch(`${API_URL}/workspace/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ path, kind }),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Create failed (${res.status})`);
  }
  return (await res.json()) as WorkspaceEntry;
}

export async function fetchUserProfile(): Promise<UserProfile> {
  const res = await fetch(`${API_URL}/users/me`, { headers: { ...authHeaders() } });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error("Failed to fetch user profile");
  const data = (await res.json()) as unknown;
  return data as UserProfile;
}

export async function updateUserProfile(input: {
  display_name: string | null;
}): Promise<UserProfile> {
  const res = await fetch(`${API_URL}/users/me/profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to update profile (${res.status})`);
  }
  return (await res.json()) as UserProfile;
}

export async function uploadUserAvatar(file: File): Promise<UserProfile> {
  const form = new FormData();
  form.append("avatar", file);
  const res = await fetch(`${API_URL}/users/me/avatar`, {
    method: "POST",
    headers: { ...authHeaders() },
    body: form,
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to upload avatar (${res.status})`);
  }
  return (await res.json()) as UserProfile;
}

export async function deleteUserAvatar(): Promise<UserProfile> {
  const res = await fetch(`${API_URL}/users/me/avatar`, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to remove avatar (${res.status})`);
  }
  return (await res.json()) as UserProfile;
}

export async function fetchUserAvatarImage(avatarUri: string): Promise<Blob> {
  const href = resolveRippleApiUrl(avatarUri, "Avatar URL");
  const res = await fetch(href, { headers: { ...authHeaders() } });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to fetch avatar (${res.status})`);
  }
  return res.blob();
}

export async function startConnectorAuth(
  connectorName: string,
  payload: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_URL}/connectors/${encodeURIComponent(connectorName)}/auth/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to start connector auth (${res.status})`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export async function completeConnectorAuth(
  connectorName: string,
  payload: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const res = await fetch(
    `${API_URL}/connectors/${encodeURIComponent(connectorName)}/auth/complete`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(payload),
    }
  );
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to complete connector auth (${res.status})`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export async function cancelConnectorAuth(connectorName: string): Promise<Record<string, unknown>> {
  const res = await fetch(
    `${API_URL}/connectors/${encodeURIComponent(connectorName)}/auth/cancel`,
    {
      method: "POST",
      headers: { ...authHeaders() },
    }
  );
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to cancel connector auth (${res.status})`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export async function disconnectConnector(
  connectorName: string,
  payload: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_URL}/connectors/${encodeURIComponent(connectorName)}/disconnect`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ confirm: true, ...payload }),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const detail = await responseDetail(res);
    throw new Error(detail || `Failed to disconnect connector (${res.status})`);
  }
  return (await res.json()) as Record<string, unknown>;
}
