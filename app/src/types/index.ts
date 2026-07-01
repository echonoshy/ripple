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

export interface MessageArtifact {
  type: "image";
  workspacePath: string;
  mimeType?: string;
  size?: number;
  revisedPrompt?: string;
}

export interface ChangedFile {
  path: string;
  status?: string;
  additions?: number;
  deletions?: number;
  previousPath?: string;
}

export interface Message {
  id: string | number;
  role: "user" | "assistant";
  content: string;
  created_at?: string;
  toolCalls?: ToolCall[];
  artifacts?: MessageArtifact[];
  changedFiles?: ChangedFile[];
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

export interface UserLimits {
  max_workspace_bytes: number;
  max_workspace_mb: number;
  max_sessions: number;
  max_runs_per_day: number;
  max_run_runtime_seconds: number;
}

export interface UserProfile {
  user_id: string;
  avatar_uri?: string | null;
  auth?: {
    kind?: "open" | "service" | "user" | string;
    effective_user_id?: string;
  };
  profile?: {
    user_id?: string;
    user_name?: string;
    display_name?: string | null;
    login?: string | null;
    avatar_uri?: string | null;
  };
  usage?: {
    workspace_size_bytes: number;
    session_count: number;
    runs_today: number;
    active_runs: number;
    total_tokens?: number;
    total_input_tokens?: number;
    total_output_tokens?: number;
    daily_tokens?: number;
    daily_input_tokens?: number;
    daily_output_tokens?: number;
    weekly_tokens?: number;
    weekly_input_tokens?: number;
    weekly_output_tokens?: number;
  };
  limits?: UserLimits;
}

export interface WorkspaceFileOpenRequest {
  id: number;
  path: string;
  lineNumber?: number;
  userId?: string;
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
  auth_cancel_path: string | null;
  disconnect_path: string | null;
  accounts_path: string | null;
  supports_account_disconnect?: boolean;
}

export interface ConnectorStatus {
  name: string;
  connected: boolean;
  required: boolean;
  detail: string;
  metadata: Record<string, unknown>;
  pending_auth?: {
    count: number;
    cancel_path?: string;
  };
}

export type CapabilityStatus =
  | "available"
  | "pending_enable"
  | "missing_requirements"
  | "blocked_by_connector_auth"
  | "conflict_disabled"
  | "draft"
  | "invalid";

export type SkillUserStatus =
  | "available"
  | "needs_connection"
  | "needs_confirmation"
  | "needs_fix"
  | "not_enabled"
  | "disabled"
  | "unavailable";

export interface CapabilityRequirement {
  kind: string;
  name: string;
  status: "satisfied" | "missing" | "not_connected" | string;
  detail?: string;
}

export interface SkillInfo {
  id: string;
  type?: "skill";
  name: string;
  display_name?: string;
  namespace?: string;
  description: string;
  source: string;
  display_source?: "system" | "user" | string;
  path: string;
  read_only?: boolean;
  can_edit?: boolean;
  can_delete?: boolean;
  desired_state?: string;
  computed_status?: string;
  user_status?: SkillUserStatus | string;
  status_label?: string;
  related_connector?: string | null;
  validation?: SkillValidationResult | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_tested_at?: string | null;
  last_validated_at?: string | null;
  when_to_use?: string;
  version?: string;
  kind?: "text" | "executable" | string;
  runtime?: "python" | string | null;
  entry?: string | null;
  python_packages?: string[];
  content_hash?: string;
  enabled: boolean;
  status: CapabilityStatus | string;
  conflict_with?: string | null;
  requires_bins?: string[];
  requires_connectors?: string[];
  risk_flags?: string[];
  missing_bins?: string[];
  missing_connectors?: string[];
  blocked_connectors?: string[];
}

export interface SkillValidationCheck {
  name: string;
  status: "passed" | "failed" | string;
  message: string;
}

export interface SkillValidationResult {
  passed: boolean;
  content_hash?: string | null;
  checks: SkillValidationCheck[];
  issues?: string[];
  preview?: string | null;
  validated_at?: string | null;
}

export interface SkillDraftInput {
  name?: string;
  display_name?: string;
  description: string;
  when_to_use?: string;
  steps: string[];
  output_format?: string;
  kind?: "text" | "executable" | string;
  runtime?: "python" | string;
  entry?: string;
  python_packages?: string[];
  script?: string;
  requires_connectors?: string[];
  requires_user_confirmation?: boolean;
  test_example?: string;
}

export interface SkillUpdateInput {
  enabled?: boolean;
  display_name?: string;
  description?: string;
  when_to_use?: string;
  steps?: string[];
  output_format?: string;
  kind?: "text" | "executable" | string;
  runtime?: "python" | string;
  entry?: string;
  python_packages?: string[];
  script?: string;
  requires_connectors?: string[];
  requires_user_confirmation?: boolean;
  test_example?: string;
}

export interface CapabilityInfo {
  id: string;
  type: "connector" | "skill" | "runtime_capability";
  name: string;
  display_name: string;
  description: string;
  source: string;
  status: CapabilityStatus | string;
  enabled: boolean;
  requirements: CapabilityRequirement[];
  related_skills: string[];
  related_connector?: string | null;
  connector?: ConnectorInfo;
  skill?: SkillInfo;
}

export interface ConnectorActionResponse {
  name: string;
  ok: boolean;
  stage: string;
  detail: string;
  source?: string;
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

export interface SessionControlAction {
  type: "connector.auth.start";
  connector: string;
  force_reauth?: boolean;
  source?: string;
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

export type TimeTriggerKind = "once" | "interval";
export type TaskTriggerStatus = "active" | "paused" | "completed" | "error" | string;
export type MissedRunPolicy = "run_once" | "skip" | string;
export type OverlapPolicy = "skip" | "allow" | string;
export type FailurePolicy = "pause" | "keep_active" | string;

export interface AgentRunInfo {
  job_id: string;
  provider: string;
  status: string;
  output_file: string | null;
  events_file: string | null;
  output_available?: boolean;
  events_available?: boolean;
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

export interface TaskTriggerInfo {
  trigger_id: string;
  trigger_type: "time" | string;
  user_id: string;
  title: string;
  prompt: string;
  kind: TimeTriggerKind;
  timezone: string;
  run_at: string | null;
  interval_seconds: number | null;
  enabled: boolean;
  status: TaskTriggerStatus;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_id: string | null;
  last_error: string | null;
  failure_reason?: string | null;
  last_run_status?: string | null;
  missed_run_policy?: MissedRunPolicy;
  overlap_policy?: OverlapPolicy;
  failure_policy?: FailurePolicy;
  cwd: string | null;
  model: string | null;
  effort: string | null;
  summary: string | null;
  output_schema: Record<string, unknown> | null;
  max_runtime_seconds: number;
  max_runs: number | null;
  task_id?: string | null;
  task_action_id?: string | null;
  run_count: number;
  created_at: string;
  updated_at: string;
}

export type TaskStatus =
  | "candidate"
  | "active"
  | "in_progress"
  | "waiting_user"
  | "blocked"
  | "completed"
  | "cancelled"
  | "archived"
  | string;

export type TaskActionStatus =
  | "candidate"
  | "confirmed"
  | "in_progress"
  | "waiting_user"
  | "blocked"
  | "completed"
  | "cancelled"
  | string;

export interface TaskProgress {
  completed: number;
  total: number;
  percent: number;
  currentActionId?: string | null;
  currentActionTitle?: string | null;
}

export interface TaskInfo {
  taskId: string;
  userId: string;
  title: string;
  objective?: string | null;
  status: TaskStatus;
  priority: string;
  pinned: boolean;
  requiresConfirmation: boolean;
  sourceSessionId?: string | null;
  dueAt?: string | null;
  progress?: TaskProgress | null;
  lastRunId?: string | null;
  lastError?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface TaskActionInfo {
  actionId: string;
  taskId: string;
  userId: string;
  kind: string;
  title: string;
  objective?: string | null;
  status: TaskActionStatus;
  assignee?: string | null;
  requiresConfirmation: boolean;
  sourceSessionId?: string | null;
  nextWakeupAt?: string | null;
  resultSummary?: string | null;
  lastRunId?: string | null;
  lastError?: string | null;
  waitingReason?: string | null;
  sequenceIndex?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface TaskEventInfo {
  eventId: string;
  taskId: string;
  userId: string;
  eventType: string;
  payload?: Record<string, unknown> | null;
  createdAt?: string | null;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  pinned: boolean;
  contextFolderPath?: string | null;
  forkedFromSessionId?: string | null;
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
  planSteps?: PlanStep[];
  planProgress?: PlanProgress | null;
}

export interface PlanStep {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface PlanProgress {
  completed: number;
  total: number;
  currentTask?: string;
}

export interface PlanUpdate {
  thread_id?: string | null;
  turn_id?: string;
  explanation?: string | null;
  steps: PlanStep[];
  progress: PlanProgress;
  allCompleted: boolean;
}

export type CodexRuntimeEventType =
  | "codex_turn_diff_updated"
  | "tool_output_delta"
  | "file_change_patch_updated"
  | "folder_context_search"
  | "image_generation"
  | "image_view"
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
  context_folder_path?: string;
  query?: string;
  match_count?: number;
  scanned_files?: number;
  truncated?: boolean;
  matches?: Array<{
    path?: string;
    line?: number;
    snippet?: string;
  }>;
  workspace_path?: string;
  mime_type?: string;
  size?: number;
  revised_prompt?: string;
}

export interface AgentStopData {
  stop_reason: "completed" | "ask_user" | "permission_request" | "tool_requested" | string;
  metadata: Record<string, unknown>;
}

export type WorkbenchSessionStatus =
  | "queued"
  | "running"
  | "compacting"
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
  pinned: boolean;
  contextFolderPath?: string | null;
  forkedFromSessionId?: string | null;
  status: WorkbenchSessionStatus;
  attention?: SessionAttention;
  model: string;
  lastActivityAt: string;
  messageCount: number;
  changedFileCount: number;
  pendingApprovalCount: number;
}

export type SessionAttention = "completed" | "needs_input" | "error";

export type WorkbenchTimelineEventType =
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "command"
  | "file_change"
  | "image_generation"
  | "image_view"
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
  workspacePath?: string;
  mimeType?: string;
  size?: number;
  revisedPrompt?: string;
  changedFiles?: ChangedFile[];
}
