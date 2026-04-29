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

export type ScheduleType = "once" | "interval";
export type ScheduleExecutionType = "command" | "agent";

export interface ScheduledJob {
  id: string;
  user_id: string;
  name: string;
  command: string;
  prompt: string | null;
  execution_type: ScheduleExecutionType;
  created_from: "chat" | "ui" | "api";
  schedule_type: ScheduleType;
  run_at: string | null;
  interval_seconds: number | null;
  enabled: boolean;
  timeout_seconds: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduledRun {
  id: string;
  job_id: string;
  user_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  stdout_tail: string;
  stderr_tail: string;
  error: string | null;
  summary: string | null;
}

export interface ScheduleCreateInput {
  name: string;
  command?: string | null;
  prompt?: string | null;
  execution_type?: ScheduleExecutionType;
  created_from?: "chat" | "ui" | "api";
  schedule_type: ScheduleType;
  run_at?: string | null;
  interval_seconds?: number | null;
  enabled?: boolean;
  timeout_seconds?: number;
}

export interface ScheduleUpdateInput {
  name?: string;
  command?: string | null;
  prompt?: string | null;
  execution_type?: ScheduleExecutionType;
  created_from?: "chat" | "ui" | "api";
  schedule_type?: ScheduleType;
  run_at?: string | null;
  interval_seconds?: number | null;
  enabled?: boolean;
  timeout_seconds?: number;
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

export interface AgentStopData {
  stop_reason: "completed" | "ask_user" | "permission_request" | "tool_requested" | string;
  metadata: Record<string, unknown>;
}
