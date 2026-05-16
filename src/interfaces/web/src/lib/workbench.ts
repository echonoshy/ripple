import type {
  Message,
  Session,
  ToolCall,
  WorkbenchTaskStatus,
  WorkbenchTaskSummary,
  WorkbenchTimelineEvent,
} from "@/types";

const STATUS_PRIORITY: Record<WorkbenchTaskStatus, number> = {
  waiting_for_approval: 0,
  waiting_for_user: 1,
  failed: 2,
  running: 3,
  review: 4,
  queued: 5,
  idle: 6,
  completed: 7,
  cancelled: 8,
};

export function sessionStatusToWorkbenchStatus(status: string): WorkbenchTaskStatus {
  const normalized = status.toLowerCase();
  if (normalized === "awaiting_permission" || normalized === "waiting_for_approval") {
    return "waiting_for_approval";
  }
  if (normalized === "awaiting_user" || normalized === "waiting_for_user") {
    return "waiting_for_user";
  }
  if (normalized === "running") return "running";
  if (normalized === "queued") return "queued";
  if (normalized === "completed") return "completed";
  if (normalized === "failed" || normalized === "error") return "failed";
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  if (normalized === "review") return "review";
  return "idle";
}

export function mapSessionsToWorkbenchTasks(sessions: Session[]): WorkbenchTaskSummary[] {
  return sessions.map((session) => {
    const status = sessionStatusToWorkbenchStatus(session.status);
    return {
      id: session.session_id,
      title: session.title?.trim() || `Session ${session.session_id}`,
      status,
      model: session.model,
      lastActivityAt: session.last_active,
      messageCount: session.message_count,
      changedFileCount: 0,
      pendingApprovalCount: status === "waiting_for_approval" ? 1 : 0,
    };
  });
}

export function sortWorkbenchTasks(tasks: WorkbenchTaskSummary[]): WorkbenchTaskSummary[] {
  return [...tasks].sort((a, b) => {
    const priority = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
    if (priority !== 0) return priority;
    return Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
  });
}

export function createWorkbenchTasks(sessions: Session[]): WorkbenchTaskSummary[] {
  return sortWorkbenchTasks(mapSessionsToWorkbenchTasks(sessions));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toolArgs(tool: ToolCall): Record<string, unknown> {
  if (typeof tool.arguments === "string") {
    try {
      const parsed: unknown = JSON.parse(tool.arguments);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return { input: tool.arguments };
    }
  }
  return tool.arguments;
}

function stringifyToolBody(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value, null, 2);
}

function commandBody(args: Record<string, unknown>, result: string | undefined): string {
  const command = stringifyToolBody(args.command);
  const cwd = typeof args.cwd === "string" && args.cwd ? `\n\ncwd: ${args.cwd}` : "";
  const output = result ? `\n\nresult:\n${result}` : "";
  return `${command || stringifyToolBody(args)}${cwd}${output}`;
}

function changedPathsFromValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((change) => {
      if (typeof change === "string") return change;
      if (isRecord(change) && typeof change.path === "string") return change.path;
      if (isRecord(change) && typeof change.file === "string") return change.file;
      return "";
    })
    .filter(Boolean);
}

function changedPathsFromTool(tool: ToolCall): string[] {
  const args = toolArgs(tool);
  const fromArgs = changedPathsFromValue(args.changes);
  if (fromArgs.length > 0) return fromArgs;

  if (!tool.result) return [];
  try {
    const parsed: unknown = JSON.parse(tool.result);
    if (!isRecord(parsed)) return [];
    return changedPathsFromValue(parsed.changes);
  } catch {
    return [];
  }
}

function toolEvent(message: Message, tool: ToolCall): WorkbenchTimelineEvent {
  const args = toolArgs(tool);
  if (tool.name === "command_execution" || tool.name === "exec_command") {
    return {
      id: `${message.id}-${tool.id}`,
      type: "command",
      title: "Ran command",
      body: commandBody(args, tool.result),
      createdAt: message.created_at,
      status: tool.status,
    };
  }

  if (tool.name === "file_change" || tool.name === "apply_patch") {
    const paths = changedPathsFromTool(tool);
    return {
      id: `${message.id}-${tool.id}`,
      type: "file_change",
      title: "Changed files",
      body: paths.length > 0 ? paths.join("\n") : stringifyToolBody(args),
      createdAt: message.created_at,
      status: tool.status,
    };
  }

  return {
    id: `${message.id}-${tool.id}`,
    type: "tool_call",
    title: `Used ${tool.name}`,
    body: tool.result
      ? `${stringifyToolBody(args)}\n\nresult:\n${tool.result}`
      : stringifyToolBody(args),
    createdAt: message.created_at,
    status: tool.status,
  };
}

export function messagesToTimelineEvents(messages: Message[]): WorkbenchTimelineEvent[] {
  const events: WorkbenchTimelineEvent[] = [];

  for (const message of messages) {
    const id = String(message.id);
    if (message.content) {
      events.push({
        id,
        type: message.role === "user" ? "user_message" : "assistant_message",
        title: message.role === "user" ? "User request" : "Codex update",
        body: message.content,
        createdAt: message.created_at,
      });
    }

    if (message.permissionRequest) {
      events.push({
        id: `${id}-approval`,
        type: "approval_request",
        title: "Permission required",
        body:
          typeof message.permissionRequest.params === "string"
            ? message.permissionRequest.params
            : JSON.stringify(message.permissionRequest.params, null, 2),
        createdAt: message.created_at,
        status: message.permissionRequest.riskLevel,
      });
    }

    for (const tool of message.toolCalls || []) {
      events.push(toolEvent(message, tool));
    }
  }

  return events;
}

export function extractChangedFilePaths(messages: Message[]): string[] {
  const paths = new Set<string>();
  for (const message of messages) {
    for (const tool of message.toolCalls || []) {
      for (const path of changedPathsFromTool(tool)) {
        paths.add(path);
      }
    }
  }
  return [...paths];
}
