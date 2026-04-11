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

export interface Message {
  id: string | number;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[];
  askUser?: AskUserData;
}

export interface UsageInfo {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
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
}
