import type {
  CodexRuntimeEvent,
  Message,
  TaskSummary,
  ToolCall,
  WorkbenchSessionStatus,
  WorkbenchSessionSummary,
  WorkbenchTimelineEvent,
} from "@/types";

const STATUS_PRIORITY: Record<WorkbenchSessionStatus, number> = {
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

export function sessionStatusToWorkbenchStatus(status: string): WorkbenchSessionStatus {
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

export function mapTaskSummariesToWorkbenchSessions(
  tasks: TaskSummary[]
): WorkbenchSessionSummary[] {
  return tasks.map((task) => ({
    sessionId: task.session_id || task.task_id,
    title: task.title?.trim() || `Session ${task.session_id || task.task_id}`,
    status: sessionStatusToWorkbenchStatus(task.status),
    model: task.model,
    lastActivityAt: task.last_active,
    messageCount: task.message_count,
    changedFileCount: task.changed_file_count,
    pendingApprovalCount: task.pending_approval_count,
  }));
}

export function sortWorkbenchSessions(
  sessions: WorkbenchSessionSummary[]
): WorkbenchSessionSummary[] {
  return [...sessions].sort((a, b) => {
    const priority = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
    if (priority !== 0) return priority;
    return Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
  });
}

export function createWorkbenchSessionsFromTaskSummaries(
  tasks: TaskSummary[]
): WorkbenchSessionSummary[] {
  return sortWorkbenchSessions(mapTaskSummariesToWorkbenchSessions(tasks));
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

function compactLine(value: string, maxLength = 180): string {
  const line = value.replace(/\s+/g, " ").trim();
  if (line.length <= maxLength) return line;
  return `${line.slice(0, maxLength - 1)}...`;
}

function stringifyRuntimeBody(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value, null, 2);
}

function runtimeBody(event: CodexRuntimeEvent): string {
  if (event.type === "tool_output_delta") {
    return event.delta || stringifyRuntimeBody(event);
  }
  if (event.type === "file_change_patch_updated") {
    return (
      stringifyRuntimeBody(event.patch) ||
      stringifyRuntimeBody(event.changes) ||
      stringifyRuntimeBody(event)
    );
  }
  if (event.type === "codex_warning" || event.type === "codex_error") {
    return event.message || stringifyRuntimeBody(event);
  }
  if (event.type === "codex_turn_diff_updated") {
    return stringifyRuntimeBody(event.diff) || stringifyRuntimeBody(event);
  }
  if (event.type === "context_compaction") {
    return "Codex compacted conversation context.";
  }
  return stringifyRuntimeBody(event);
}

function runtimeTitle(event: CodexRuntimeEvent): string {
  if (event.type === "tool_output_delta") {
    return event.kind === "file_change" ? "File output" : "Command output";
  }
  if (event.type === "file_change_patch_updated") return "File patch updated";
  if (event.type === "codex_warning") return "Codex warning";
  if (event.type === "codex_error") return "Codex error";
  if (event.type === "context_compaction") return "Context compacted";
  if (event.type === "codex_turn_diff_updated") return "Workspace diff updated";
  return "Codex runtime update";
}

function runtimeTimelineType(event: CodexRuntimeEvent): WorkbenchTimelineEvent["type"] {
  if (event.type === "tool_output_delta") {
    return event.kind === "file_change" ? "file_change" : "command";
  }
  if (event.type === "file_change_patch_updated" || event.type === "codex_turn_diff_updated") {
    return "file_change";
  }
  if (event.type === "codex_warning") return "warning";
  if (event.type === "codex_error") return "error";
  if (event.type === "context_compaction") return "context_compaction";
  return "runtime_update";
}

export function codexRuntimeEventToTimelineEvent(
  event: CodexRuntimeEvent,
  options: { id?: string; createdAt?: string } = {}
): WorkbenchTimelineEvent {
  const id = options.id || `runtime-${event.type}-${event.id || event.turn_id || Date.now()}`;
  const status = event.type === "tool_output_delta" ? event.stream : event.status;
  return {
    id,
    type: runtimeTimelineType(event),
    title: runtimeTitle(event),
    body: runtimeBody(event),
    createdAt: options.createdAt,
    status,
  };
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

function toolStatus(tools: ToolCall[]): string | undefined {
  if (tools.some((tool) => tool.status === "error")) return "error";
  if (tools.some((tool) => tool.status === "running")) return "running";
  if (tools.length > 0 && tools.every((tool) => tool.status === "success")) return "success";
  return tools[0]?.status;
}

function toolSummaryLine(tool: ToolCall): string {
  const args = toolArgs(tool);
  if (tool.name === "command_execution" || tool.name === "exec_command") {
    const command = compactLine(stringifyToolBody(args.command) || stringifyToolBody(args));
    return command ? `$ ${command}` : tool.name;
  }

  if (tool.name === "file_change" || tool.name === "apply_patch") {
    const paths = changedPathsFromTool(tool);
    if (paths.length > 0) {
      const visiblePaths = paths.slice(0, 3).join(", ");
      const suffix = paths.length > 3 ? `, +${paths.length - 3} more` : "";
      return `changed ${paths.length} file${paths.length === 1 ? "" : "s"}: ${visiblePaths}${suffix}`;
    }
    return "changed files";
  }

  const firstArg = compactLine(stringifyToolBody(args), 120);
  return firstArg ? `${tool.name}: ${firstArg}` : tool.name;
}

function toolsEvent(message: Message, tools: ToolCall[]): WorkbenchTimelineEvent {
  const visibleTools = tools.slice(0, 8);
  const hiddenCount = tools.length - visibleTools.length;
  const body = [
    ...visibleTools.map(toolSummaryLine),
    hiddenCount > 0 ? `+${hiddenCount} more tool${hiddenCount === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    id: `${message.id}-tools`,
    type: "tool_call",
    title: `Used ${tools.length} tool${tools.length === 1 ? "" : "s"}`,
    body,
    createdAt: message.created_at,
    status: toolStatus(tools),
  };
}

export function messagesToTimelineEvents(messages: Message[]): WorkbenchTimelineEvent[] {
  const events: WorkbenchTimelineEvent[] = [];

  for (const message of messages) {
    const id = String(message.id);
    const toolCalls = message.toolCalls || [];

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

    if (message.role === "user" && message.content) {
      events.push({
        id,
        type: "user_message",
        title: "User request",
        body: message.content,
        createdAt: message.created_at,
      });
    }

    if (toolCalls.length > 0) {
      events.push(toolsEvent(message, toolCalls));
    }

    if (message.role === "assistant" && message.content) {
      const hasTools = toolCalls.length > 0;
      events.push({
        id,
        type: hasTools ? "final_summary" : "assistant_message",
        title: hasTools ? "Final answer" : "Codex update",
        body: message.content,
        createdAt: message.created_at,
      });
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
