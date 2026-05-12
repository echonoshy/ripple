import { PermissionRequest, ToolCallUpdate } from "../api/types";

export interface AskUserPrompt {
  question: string;
  options: string[];
}

export interface ChatMessageItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
  toolCalls?: ToolCallUpdate[];
  askUser?: AskUserPrompt;
  permissionRequest?: PermissionRequest;
}
