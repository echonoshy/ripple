export type PermissionAction = "allow" | "always" | "deny";

export interface ModelInfo {
  id: string;
  owned_by: string;
}

export interface SessionSummary {
  session_id: string;
  title: string;
  model: string;
  created_at: string;
  last_active: string;
  message_count: number;
  status: string;
}

export interface PermissionRequest {
  tool: string;
  params: Record<string, unknown> | string;
  riskLevel: string;
}

export interface SessionDetail extends SessionSummary {
  messages: Record<string, unknown>[];
  pending_question?: string | null;
  pending_options?: string[] | null;
  pending_permission_request?: PermissionRequest | null;
}

export interface UsageInfo {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  last_prompt_tokens?: number;
}

export interface ToolCallUpdate {
  id: string;
  name: string;
  arguments: Record<string, unknown> | string;
  status: "running" | "success" | "error";
  result?: string;
}

export interface AgentStopData {
  stop_reason: string;
  metadata: Record<string, unknown>;
}

export interface StreamChatCallbacks {
  onMessageDelta?: (delta: string) => void;
  onToolCall?: (toolCall: ToolCallUpdate) => void;
  onToolResult?: (toolUseId: string, result: string, isError: boolean) => void;
  onUsage?: (usage: UsageInfo) => void;
  onNewTurn?: () => void;
  onAgentStop?: (data: AgentStopData) => void;
  onPermissionRequest?: (request: PermissionRequest) => void;
  onHeartbeat?: () => void;
  onComplete?: () => void;
  onError?: (error: Error) => void;
}
