/**
 * WebSocket 事件类型定义
 */

export interface BaseEvent {
  type: string;
  timestamp: number;
}

export interface ConnectedEvent extends BaseEvent {
  type: 'connected';
  session_id: string;
}

export interface ThinkingStartEvent extends BaseEvent {
  type: 'thinking_start';
}

export interface TextEvent extends BaseEvent {
  type: 'text';
  content: string;
}

export interface ToolCallEvent extends BaseEvent {
  type: 'tool_call';
  tool_id: string;
  tool_name: string;
  tool_input: Record<string, any>;
}

export interface ToolResultEvent extends BaseEvent {
  type: 'tool_result';
  tool_id: string;
  is_error: boolean;
  content: string;
  subagent_data?: SubAgentData;
}

export interface SubAgentData {
  result: string;
  turns_used: number;
  execution_log: ExecutionLogEntry[];
}

export interface ExecutionLogEntry {
  type: 'tool_call' | 'tool_result' | 'assistant_text';
  tool_name?: string;
  tool_input?: Record<string, any>;
  is_error?: boolean;
  content?: string;
}

export interface TokenUsageEvent extends BaseEvent {
  type: 'token_usage';
  input_tokens: number;
  output_tokens: number;
}

export interface CompletedEvent extends BaseEvent {
  type: 'completed';
}

export interface SessionStatsEvent extends BaseEvent {
  type: 'session_stats';
  token_count: number;
  message_count: number;
}

export interface ErrorEvent extends BaseEvent {
  type: 'error';
  error: string;
}

export type WebSocketEvent =
  | ConnectedEvent
  | ThinkingStartEvent
  | TextEvent
  | ToolCallEvent
  | ToolResultEvent
  | TokenUsageEvent
  | CompletedEvent
  | SessionStatsEvent
  | ErrorEvent;

/**
 * 消息类型
 */
export interface Message {
  id: string;
  type: 'text' | 'tool_call' | 'tool_result' | 'thinking' | 'user' | 'error';
  content?: string;
  toolName?: string;
  toolInput?: Record<string, any>;
  toolId?: string;
  isError?: boolean;
  subagentData?: SubAgentData;
  timestamp: number;
}

/**
 * Token 统计
 */
export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
