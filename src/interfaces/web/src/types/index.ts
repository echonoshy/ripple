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
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  last_input_tokens: number;
  message_count: number;
}

export interface SystemInfo {
  tools: string[];
  skills: { name: string; description: string }[];
  model_presets: Record<string, string>;
  default_model: string;
  max_turns: number;
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

export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  size_bytes: number;
  modified_at: string;
  is_hidden: boolean;
  mime_type?: string | null;
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

export interface AgentRunListResponse {
  runs: AgentRunInfo[];
  count: number;
}

export interface UserQuotaStatus {
  user_id: string;
  quota: {
    max_workspace_mb: number;
    max_sessions: number;
    max_runs_per_day: number;
    max_run_runtime_seconds: number;
  };
  usage: {
    workspace_size_bytes: number;
    session_count: number;
    runs_today: number;
    active_runs: number;
  };
}

export interface DocumentInfo {
  document_id: string;
  title: string;
  path: string;
  kind: string;
  source: string;
  linked_session_id: string | null;
  summary: string;
  created_at: string;
  updated_at: string;
  last_modified_at: string;
}

export interface DocumentListResponse {
  documents: DocumentInfo[];
  count: number;
}

export interface Session {
  session_id: string;
  title: string;
  model: string;
  created_at: string;
  last_active: string;
  message_count: number;
  status: string;
}

export interface SessionDetail extends Session {
  messages: Record<string, unknown>[];
  pending_question?: string | null;
  pending_options?: string[] | null;
  pending_permission_request?: PermissionRequestData | null;
}

export interface TaskSummary {
  task_id: string;
  session_id: string;
  title: string;
  model: string;
  created_at: string;
  last_active: string;
  message_count: number;
  status: string;
  changed_file_count: number;
  pending_approval_count: number;
}

export interface TaskDetail extends TaskSummary {
  messages: Record<string, unknown>[];
  pending_question?: string | null;
  pending_options?: string[] | null;
  pending_permission_request?: PermissionRequestData | null;
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

export interface AgentStopData {
  stop_reason: "completed" | "ask_user" | "permission_request" | "tool_requested" | string;
  metadata: Record<string, unknown>;
}

export type WorkbenchTaskStatus =
  | "queued"
  | "running"
  | "waiting_for_user"
  | "waiting_for_approval"
  | "review"
  | "completed"
  | "failed"
  | "cancelled"
  | "idle";

export interface WorkbenchTaskSummary {
  id: string;
  title: string;
  status: WorkbenchTaskStatus;
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
