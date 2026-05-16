import type { Message, TaskInfo, TaskPlanUpdate, TaskProgress } from "@/types";

function hasVisibleAssistantContent(message: Message): boolean {
  if (message.role !== "assistant") return false;
  return message.content.trim().length > 0 || !!message.askUser || !!message.permissionRequest;
}

function findPlaceholderTaskIndex(tasks: TaskInfo[], incoming: TaskInfo): number {
  return tasks.findIndex(
    (task) =>
      task.id !== incoming.id &&
      task.subject === incoming.subject &&
      (task.activeForm || "") === (incoming.activeForm || "") &&
      (task.status === "pending" || task.status === "in_progress")
  );
}

export function shouldRenderAssistantMessage(
  message: Message,
  isGenerating: boolean,
  isLast: boolean
): boolean {
  if (message.role !== "assistant") {
    return true;
  }

  if (hasVisibleAssistantContent(message)) {
    return true;
  }

  return isGenerating && isLast;
}

export function upsertTask(tasks: TaskInfo[], incoming: TaskInfo): TaskInfo[] {
  const sameIdIndex = tasks.findIndex((task) => task.id === incoming.id);
  if (sameIdIndex >= 0) {
    return tasks.map((task, index) => (index === sameIdIndex ? { ...task, ...incoming } : task));
  }

  const placeholderIndex = findPlaceholderTaskIndex(tasks, incoming);
  if (placeholderIndex >= 0) {
    return tasks.map((task, index) =>
      index === placeholderIndex ? { ...task, ...incoming } : task
    );
  }

  return [...tasks, incoming];
}

export function applyTaskUpdate(tasks: TaskInfo[], incoming: TaskInfo): TaskInfo[] {
  const sameIdIndex = tasks.findIndex((task) => task.id === incoming.id);
  if (sameIdIndex >= 0) {
    return tasks.map((task, index) => (index === sameIdIndex ? { ...task, ...incoming } : task));
  }

  const placeholderIndex = findPlaceholderTaskIndex(tasks, incoming);
  if (placeholderIndex >= 0) {
    return tasks.map((task, index) =>
      index === placeholderIndex ? { ...task, ...incoming } : task
    );
  }

  return [...tasks, incoming];
}

export function applyTaskPlanUpdate(
  currentTasks: TaskInfo[],
  update: TaskPlanUpdate
): { taskSteps: TaskInfo[]; taskProgress: TaskProgress | null } {
  const nextSteps = update.allCompleted ? [] : update.steps;
  return {
    taskSteps: currentTasks === nextSteps ? [...nextSteps] : nextSteps,
    taskProgress: update.allCompleted ? null : update.progress,
  };
}
