import type {
  Message,
  Session,
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
  }

  return events;
}
