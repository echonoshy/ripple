import type {
  CodexRuntimeEvent,
  Message,
  MessageArtifact,
  SessionAttention,
  SessionSummary,
  ToolCall,
  WorkbenchSessionStatus,
  WorkbenchSessionSummary,
  WorkbenchTimelineEvent,
} from "@/types";

function activityTimeValue(value: string | undefined): number {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

export function sessionStatusToWorkbenchStatus(status: string): WorkbenchSessionStatus {
  const normalized = status.toLowerCase();
  if (normalized === "awaiting_permission" || normalized === "waiting_for_approval") {
    return "waiting_for_approval";
  }
  if (normalized === "awaiting_user" || normalized === "waiting_for_user") {
    return "waiting_for_user";
  }
  if (normalized === "running") return "running";
  if (normalized === "compacting") return "compacting";
  if (normalized === "queued") return "queued";
  if (normalized === "completed") return "completed";
  if (normalized === "failed" || normalized === "error") return "failed";
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  if (normalized === "review") return "review";
  return "idle";
}

export function sessionAttentionFromStatus(
  status: WorkbenchSessionStatus,
  pendingApprovalCount = 0
): SessionAttention | null {
  if (pendingApprovalCount > 0) return "needs_input";
  if (status === "waiting_for_user" || status === "waiting_for_approval") return "needs_input";
  if (status === "failed") return "error";
  return null;
}

export function mapSessionSummariesToWorkbenchSessions(
  sessions: SessionSummary[]
): WorkbenchSessionSummary[] {
  return sessions.map((session) => {
    const status = sessionStatusToWorkbenchStatus(session.status);
    return {
      sessionId: session.sessionId,
      title: session.title?.trim() || "New Session",
      pinned: session.pinned,
      status,
      attention: sessionAttentionFromStatus(status, session.pendingApprovalCount) || undefined,
      model: session.model,
      lastActivityAt: session.lastActiveAt,
      messageCount: session.messageCount,
      changedFileCount: session.changedFileCount,
      pendingApprovalCount: session.pendingApprovalCount,
    };
  });
}

export function sortWorkbenchSessions(
  sessions: WorkbenchSessionSummary[]
): WorkbenchSessionSummary[] {
  return [...sessions].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return activityTimeValue(b.lastActivityAt) - activityTimeValue(a.lastActivityAt);
  });
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function formatSessionActivityTime(value: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const today = startOfLocalDay(now);
  const activityDay = startOfLocalDay(date);
  const dayDiff = Math.round((today.getTime() - activityDay.getTime()) / 86_400_000);

  if (dayDiff === 0) {
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  if (dayDiff === 1) return "Yesterday";
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function applyCurrentSessionRuntimeStatus(
  sessions: WorkbenchSessionSummary[],
  currentSessionId: string | null,
  runtimeStatus: WorkbenchSessionStatus | null,
  activityAt?: string
): WorkbenchSessionSummary[] {
  if (!currentSessionId || !runtimeStatus) return sessions;

  let changed = false;
  const updated = sessions.map((session) => {
    if (session.sessionId !== currentSessionId) return session;
    changed = true;
    const pendingApprovalCount = runtimeStatus === "running" ? 0 : session.pendingApprovalCount;
    const attention = sessionAttentionFromStatus(runtimeStatus, pendingApprovalCount);
    return {
      ...session,
      status: runtimeStatus,
      attention: attention || undefined,
      lastActivityAt: activityAt || session.lastActivityAt,
    };
  });

  return changed ? sortWorkbenchSessions(updated) : sessions;
}

export function applySessionAttentionMarkers(
  sessions: WorkbenchSessionSummary[],
  attentionBySessionId: Record<string, SessionAttention | undefined>,
  openSessionId: string | null
): WorkbenchSessionSummary[] {
  const marked = sessions.map((session) => {
    const statusAttention = sessionAttentionFromStatus(
      session.status,
      session.pendingApprovalCount
    );
    const storedAttention = attentionBySessionId[session.sessionId];
    const attention =
      statusAttention ||
      (storedAttention === "completed" && session.sessionId === openSessionId
        ? null
        : storedAttention) ||
      null;

    if ((session.attention || null) === attention) return session;
    return {
      ...session,
      attention: attention || undefined,
    };
  });

  return sortWorkbenchSessions(marked);
}

export function mergeInferredWorkbenchSessions(
  sessions: WorkbenchSessionSummary[],
  inferredSessions: Array<WorkbenchSessionSummary | null | undefined>
): WorkbenchSessionSummary[] {
  const seen = new Set(sessions.map((session) => session.sessionId));
  const additions: WorkbenchSessionSummary[] = [];

  for (const session of inferredSessions) {
    if (!session || seen.has(session.sessionId)) continue;
    seen.add(session.sessionId);
    additions.push(session);
  }

  return additions.length > 0 ? sortWorkbenchSessions([...sessions, ...additions]) : sessions;
}

export function createWorkbenchSessionsFromSessionSummaries(
  sessions: SessionSummary[]
): WorkbenchSessionSummary[] {
  return sortWorkbenchSessions(mapSessionSummariesToWorkbenchSessions(sessions));
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

function normalizeDiffPath(path: string): string {
  return path
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/^[ab]\//, "")
    .trim();
}

function diffText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return stringifyRuntimeBody(value);
}

function changedPathsFromDiff(diff: unknown): string[] {
  const paths = new Set<string>();
  const text = diffText(diff);
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const parts = line.trim().split(/\s+/);
      const path = normalizeDiffPath(parts[3] || parts[2] || "");
      if (path && path !== "/dev/null") paths.add(path);
      continue;
    }

    if (line.startsWith("+++ ")) {
      const path = normalizeDiffPath(line.slice(4));
      if (path && path !== "/dev/null") paths.add(path);
    }
  }
  return [...paths];
}

function runtimeDiffSummary(event: CodexRuntimeEvent): string {
  const paths = changedPathsFromDiff(event.diff);
  if (paths.length === 0) return "Workspace changes updated.";

  const visible = paths.slice(0, 4);
  const more = paths.length > visible.length ? `, +${paths.length - visible.length} more` : "";
  const noun = paths.length === 1 ? "file" : "files";
  return `${paths.length} ${noun} changed: ${visible.join(", ")}${more}`;
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
    return runtimeDiffSummary(event);
  }
  if (event.type === "image_generation" || event.type === "image_view") {
    return imageEventBody(event.revised_prompt, event.workspace_path);
  }
  if (event.type === "context_compaction") {
    return "Compacted conversation context.";
  }
  return stringifyRuntimeBody(event);
}

function imageEventBody(revisedPrompt: string | undefined, workspacePath: string | undefined) {
  return [
    revisedPrompt ? `Prompt: ${revisedPrompt}` : "",
    workspacePath ? `Saved to ${workspacePath}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function runtimeTitle(event: CodexRuntimeEvent): string {
  if (event.type === "tool_output_delta") {
    return event.kind === "file_change" ? "File output" : "Command output";
  }
  if (event.type === "file_change_patch_updated") return "File patch updated";
  if (event.type === "codex_warning") return "System warning";
  if (event.type === "codex_error") return "System error";
  if (event.type === "context_compaction") return "Context compacted";
  if (event.type === "codex_turn_diff_updated") return "Workspace diff";
  if (event.type === "image_generation") return "Generated image";
  if (event.type === "image_view") return "Image";
  return "Runtime update";
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
  if (event.type === "image_generation" || event.type === "image_view") return event.type;
  return "runtime_update";
}

export function codexRuntimeEventToTimelineEvent(
  event: CodexRuntimeEvent,
  options: { id?: string; createdAt?: string } = {}
): WorkbenchTimelineEvent {
  const contextCompactionId =
    event.type === "context_compaction" && (event.id || event.turn_id || event.thread_id)
      ? `runtime-context_compaction-${event.id || event.turn_id || event.thread_id}`
      : null;
  const id =
    contextCompactionId || options.id || `runtime-${event.type}-${event.id || event.turn_id || Date.now()}`;
  const status = event.type === "tool_output_delta" ? event.stream : event.status;
  return {
    id,
    type: runtimeTimelineType(event),
    title: runtimeTitle(event),
    body: runtimeBody(event),
    createdAt: options.createdAt,
    status,
    workspacePath: event.workspace_path,
    mimeType: event.mime_type,
    size: event.size,
    revisedPrompt: event.revised_prompt,
  };
}

function imageArtifactToTimelineEvent(
  messageId: string,
  artifact: MessageArtifact,
  index: number,
  createdAt: string | undefined
): WorkbenchTimelineEvent {
  return {
    id: `${messageId}-image-${index}`,
    type: "image_generation",
    title: "Generated image",
    body: imageEventBody(artifact.revisedPrompt, artifact.workspacePath),
    createdAt,
    status: "completed",
    workspacePath: artifact.workspacePath,
    mimeType: artifact.mimeType,
    size: artifact.size,
    revisedPrompt: artifact.revisedPrompt,
  };
}

export function upsertRuntimeTimelineEvent(
  events: WorkbenchTimelineEvent[],
  event: CodexRuntimeEvent,
  options: { id?: string; createdAt?: string } = {}
): WorkbenchTimelineEvent[] {
  const nextEvent = codexRuntimeEventToTimelineEvent(event, options);
  if (event.type !== "codex_turn_diff_updated" && event.type !== "context_compaction") {
    return [...events, nextEvent];
  }

  const existingIndex = events.findIndex((candidate) => candidate.id === nextEvent.id);
  if (existingIndex < 0) return [...events, nextEvent];

  return events.map((candidate, index) => (index === existingIndex ? nextEvent : candidate));
}

function eventTime(value: string | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function trailingAssistantIndex(events: WorkbenchTimelineEvent[]): number {
  const lastIndex = events.length - 1;
  const last = events[lastIndex];
  return last?.type === "assistant_message" || last?.type === "final_summary" ? lastIndex : -1;
}

export function mergeTimelineEvents(
  messageEvents: WorkbenchTimelineEvent[],
  runtimeEvents: WorkbenchTimelineEvent[]
): WorkbenchTimelineEvent[] {
  const merged = [...messageEvents];
  const orderedRuntime = runtimeEvents
    .map((event, index) => ({ event, index, time: eventTime(event.createdAt) }))
    .sort((a, b) => {
      if (a.time !== null && b.time !== null && a.time !== b.time) return a.time - b.time;
      return a.index - b.index;
    });

  for (const { event, time } of orderedRuntime) {
    if (time === null) {
      const assistantIndex = trailingAssistantIndex(merged);
      if (assistantIndex >= 0) {
        merged.splice(assistantIndex, 0, event);
      } else {
        merged.push(event);
      }
      continue;
    }

    const insertAt = merged.findIndex((candidate) => {
      const candidateTime = eventTime(candidate.createdAt);
      return candidateTime !== null && candidateTime > time;
    });
    if (insertAt < 0) {
      const assistantIndex = trailingAssistantIndex(merged);
      if (assistantIndex >= 0) {
        merged.splice(assistantIndex, 0, event);
      } else {
        merged.push(event);
      }
    } else {
      merged.splice(insertAt, 0, event);
    }
  }

  return merged;
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

function toolsEvent(
  message: Message,
  tools: ToolCall[],
  options: { maxToolActivityItems?: number } = {}
): WorkbenchTimelineEvent {
  const maxItems = Math.max(1, options.maxToolActivityItems ?? 8);
  const visibleTools = tools.slice(-maxItems);
  const hiddenCount = tools.length - visibleTools.length;
  const body = [
    ...visibleTools.map(toolSummaryLine),
    hiddenCount > 0 ? `+${hiddenCount} earlier tool${hiddenCount === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const status = toolStatus(tools);
  const title =
    status === "running"
      ? "Working with tools"
      : status === "error"
        ? "Tool activity failed"
        : "Tool activity";

  return {
    id: `${message.id}-tools`,
    type: "tool_call",
    title,
    body,
    createdAt: message.created_at,
    status,
  };
}

export function messagesToTimelineEvents(
  messages: Message[],
  options: { showToolActivity?: boolean; maxToolActivityItems?: number } = {}
): WorkbenchTimelineEvent[] {
  const events: WorkbenchTimelineEvent[] = [];
  const showToolActivity = options.showToolActivity ?? true;

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

    if (showToolActivity && toolCalls.length > 0) {
      events.push(toolsEvent(message, toolCalls, options));
    }

    for (const [index, artifact] of (message.artifacts || []).entries()) {
      events.push(imageArtifactToTimelineEvent(id, artifact, index, message.created_at));
    }

    if (message.role === "assistant" && message.content) {
      const hasTools = toolCalls.length > 0;
      events.push({
        id,
        type: hasTools ? "final_summary" : "assistant_message",
        title: hasTools ? "Response" : "Update",
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
