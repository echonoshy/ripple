export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown> | string;
  status: "running" | "success" | "error";
  result?: string;
}

export interface AskUserData {
  question: string;
  options: string[];
}

export interface PermissionRequestData {
  tool: string;
  params: Record<string, unknown> | string;
  riskLevel: string;
}

export interface Message {
  id: string | number;
  role: "user" | "assistant";
  content: string;
  created_at?: string;
  toolCalls?: ToolCall[];
  askUser?: AskUserData;
  permissionRequest?: PermissionRequestData;
}

export interface UsageInfo {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  last_prompt_tokens?: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
  model_context_window?: number;
}

export interface SessionUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  lastInputTokens: number;
  messageCount: number;
}

export interface SandboxInfo {
  user_id: string;
  workspace_size_bytes: number;
  session_count: number;
  has_python_venv: boolean;
  has_pnpm_setup: boolean;
  has_lark_cli_config: boolean;
  has_notion_token: boolean;
  has_gogcli_client_config: boolean;
  has_gogcli_login: boolean;
}

export interface GogcliAccountInfo {
  email: string;
  alias: string | null;
  valid: boolean | null;
}

export interface GogcliAccountsResponse {
  has_client_config: boolean;
  accounts: GogcliAccountInfo[];
  count: number;
  checked: boolean;
}

export interface ConnectorInfo {
  name: string;
  display_name: string;
  description: string;
  auth_type: string;
  kind: "user_connector" | "runtime_capability";
  auth_flow: string;
  auth_surfaces: {
    web: boolean;
    chat: boolean;
  };
  auth_start_path: string | null;
  auth_complete_path: string | null;
  disconnect_path: string | null;
  accounts_path: string | null;
}

export interface ConnectorStatus {
  name: string;
  connected: boolean;
  required: boolean;
  detail: string;
  metadata: Record<string, unknown>;
}

export interface ConnectorActionResponse {
  name: string;
  ok: boolean;
  stage: string;
  detail: string;
  data: Record<string, unknown>;
}

export interface ConnectorAuthChatEvent {
  type: "connector_auth_required" | "connector_auth_updated";
  connector: string;
  display_name: string;
  auth_flow: string;
  stage: string;
  message: string;
  action?: ConnectorActionResponse | null;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  size_bytes: number;
  modified_at: string;
  is_hidden: boolean;
  mime_type?: string | null;
  match?: "name" | "path" | "content" | null;
}

export interface WorkspaceListing {
  path: string;
  parent_path: string | null;
  entries: WorkspaceEntry[];
}

export interface WorkspaceSearchResponse {
  query: string;
  count: number;
  entries: WorkspaceEntry[];
}

export interface WorkspaceFilePreview {
  path: string;
  name: string;
  size_bytes: number;
  modified_at: string;
  mime_type: string;
  encoding: string;
  content: string;
  truncated: boolean;
}

export interface WorkspaceAttachmentResponse {
  path: string;
  name: string;
  mime_type: string;
  size: number;
  kind: "image" | "attachment";
}

export interface WorkspaceUploadResponse {
  entries: WorkspaceEntry[];
}

export type ScheduleKind = "once" | "interval";
export type ScheduleStatus = "active" | "paused" | "completed" | "error" | string;

export interface AgentRunInfo {
  job_id: string;
  provider: string;
  status: string;
  output_file: string | null;
  events_file: string | null;
  created_at: string | null;
  updated_at: string | null;
  exit_code: number | null;
  prompt_preview: string | null;
  sandbox_cwd: string | null;
  stdout_tail: string;
  stderr_tail: string;
  error: string | null;
  pending_approval?: Record<string, unknown> | null;
}

export interface ScheduleInfo {
  schedule_id: string;
  user_id: string;
  title: string;
  prompt: string;
  kind: ScheduleKind;
  timezone: string;
  run_at: string | null;
  interval_seconds: number | null;
  enabled: boolean;
  status: ScheduleStatus;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_id: string | null;
  last_error: string | null;
  cwd: string | null;
  model: string | null;
  effort: string | null;
  summary: string | null;
  output_schema: Record<string, unknown> | null;
  max_runtime_seconds: number;
  max_runs: number | null;
  run_count: number;
  created_at: string;
  updated_at: string;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  model: string;
  createdAt: string;
  lastActiveAt: string;
  messageCount: number;
  status: string;
  changedFileCount: number;
  pendingApprovalCount: number;
}

export interface SessionDetail extends SessionSummary {
  messages: Record<string, unknown>[];
  pendingQuestion?: string | null;
  pendingOptions?: string[] | null;
  pendingPermissionRequest?: PermissionRequestData | null;
  taskSteps?: TaskInfo[];
  taskProgress?: TaskProgress | null;
}

export interface TaskInfo {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface TaskProgress {
  completed: number;
  total: number;
  currentTask?: string;
}

export interface TaskPlanUpdate {
  thread_id?: string | null;
  turn_id?: string;
  explanation?: string | null;
  steps: TaskInfo[];
  progress: TaskProgress;
  allCompleted: boolean;
}

export type CodexRuntimeEventType =
  | "codex_turn_diff_updated"
  | "tool_output_delta"
  | "file_change_patch_updated"
  | "codex_warning"
  | "codex_error"
  | "context_compaction";

export interface CodexRuntimeEvent {
  type: CodexRuntimeEventType;
  id?: string;
  codex_method?: string;
  thread_id?: string | null;
  turn_id?: string | null;
  kind?: string;
  delta?: string;
  stream?: string;
  message?: string;
  diff?: unknown;
  patch?: unknown;
  changes?: unknown;
  status?: string;
}

export interface AgentStopData {
  stop_reason: "completed" | "ask_user" | "permission_request" | "tool_requested" | string;
  metadata: Record<string, unknown>;
}

export type WorkbenchSessionStatus =
  | "queued"
  | "running"
  | "waiting_for_user"
  | "waiting_for_approval"
  | "review"
  | "completed"
  | "failed"
  | "cancelled"
  | "idle";

export interface WorkbenchSessionSummary {
  sessionId: string;
  title: string;
  status: WorkbenchSessionStatus;
  model: string;
  lastActivityAt: string;
  messageCount: number;
  changedFileCount: number;
  pendingApprovalCount: number;
}

export type WorkbenchTimelineEventType =
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "command"
  | "file_change"
  | "warning"
  | "error"
  | "context_compaction"
  | "runtime_update"
  | "approval_request"
  | "final_summary";

export interface WorkbenchTimelineEvent {
  id: string;
  type: WorkbenchTimelineEventType;
  title: string;
  body: string;
  createdAt?: string;
  status?: string;
}
