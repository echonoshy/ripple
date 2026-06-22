"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleDot,
  Clock3,
  GripVertical,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import {
  AuthError,
  cancelTask,
  confirmTask,
  createTaskAction,
  createTaskActionTrigger,
  deleteTaskTrigger,
  deleteTask,
  fetchAllTaskTriggers,
  fetchTask,
  fetchTaskEvents,
  fetchTasks,
  runTaskNow,
  runTaskTriggerNow,
  updateTaskAction,
  updateTaskTrigger,
} from "@/lib/api";
import type {
  TaskActionCreateInput,
  TaskTriggerCreateInput,
  TaskTriggerUpdateInput,
} from "@/lib/api";
import type { TaskActionInfo, TaskEventInfo, TaskInfo, TaskTriggerInfo } from "@/types";
import { useI18n } from "@/i18n";
import {
  LUCIDE_NAV_STROKE_WIDTH,
  MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS,
  MOBILE_PAGE_TOP_SAFE_AREA_CLASS,
  TYPOGRAPHY_BODY_CLASS,
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_META_MEDIUM_CLASS,
  TYPOGRAPHY_MICRO_MEDIUM_CLASS,
  TYPOGRAPHY_PAGE_TITLE_CLASS,
  TYPOGRAPHY_SECTION_TITLE_CLASS,
  WORKBENCH_DANGER_BUTTON_CLASS,
  WORKBENCH_FIELD_CLASS,
  WORKBENCH_ICON_BUTTON_CLASS,
  WORKBENCH_PAGE_BACKGROUND_CLASS,
  WORKBENCH_PAGE_CONTENT_CLASS,
  WORKBENCH_PRIMARY_BUTTON_CLASS,
  WORKBENCH_SECONDARY_BUTTON_CLASS,
  WORKBENCH_STATUS_DANGER_CLASS,
  WORKBENCH_STATUS_NEUTRAL_CLASS,
  WORKBENCH_STATUS_SUCCESS_CLASS,
  WORKBENCH_STATUS_WARNING_CLASS,
} from "./stylePrimitives";
import MobilePageHeader from "./MobilePageHeader";

interface TasksPageProps {
  userId: string;
  selectedTaskId?: string | null;
  tasks?: TaskInfo[];
  actions?: TaskActionInfo[];
  events?: TaskEventInfo[];
  triggers?: TaskTriggerInfo[];
  isLoading?: boolean;
  error?: string | null;
  onAuthExpired?: (message: string) => void;
  onRefresh?: () => void;
  onSelectTask?: (taskId: string) => void;
  onOpenSession?: (sessionId: string) => void;
  onConfirmTask?: (taskId: string) => void;
  onRunTaskNow?: (taskId: string) => void;
  onCancelTask?: (taskId: string) => void;
  onDeleteTask?: (taskId: string) => void;
}

type TaskFilter = "all" | "open" | "waiting" | "blocked" | "done";

const taskFilters: TaskFilter[] = ["all", "open", "waiting", "blocked", "done"];

function statusLabel(status: string, t: ReturnType<typeof useI18n>["t"]): string {
  switch (status) {
    case "candidate":
      return t("tasks.status.candidate");
    case "active":
      return t("tasks.status.active");
    case "confirmed":
      return t("tasks.status.confirmed");
    case "in_progress":
      return t("tasks.status.inProgress");
    case "waiting_user":
      return t("tasks.status.waitingUser");
    case "blocked":
      return t("tasks.status.blocked");
    case "completed":
      return t("tasks.status.completed");
    case "cancelled":
      return t("tasks.status.cancelled");
    case "archived":
      return t("tasks.status.archived");
    default:
      return status || t("tasks.unknown");
  }
}

function filterLabel(filter: TaskFilter, t: ReturnType<typeof useI18n>["t"]): string {
  switch (filter) {
    case "all":
      return t("tasks.all");
    case "open":
      return t("tasks.open");
    case "waiting":
      return t("tasks.waiting");
    case "blocked":
      return t("tasks.blocked");
    case "done":
      return t("tasks.done");
  }
}

function statusClass(status: string): string {
  if (status === "completed") return WORKBENCH_STATUS_SUCCESS_CLASS;
  if (status === "blocked" || status === "cancelled") return WORKBENCH_STATUS_DANGER_CLASS;
  if (status === "waiting_user" || status === "candidate") return WORKBENCH_STATUS_WARNING_CLASS;
  return WORKBENCH_STATUS_NEUTRAL_CLASS;
}

function taskMatchesFilter(task: TaskInfo, filter: TaskFilter): boolean {
  if (filter === "all") return true;
  if (filter === "waiting") return task.status === "waiting_user" || task.status === "candidate";
  if (filter === "blocked") return task.status === "blocked";
  if (filter === "done") return task.status === "completed" || task.status === "archived";
  return !["completed", "archived", "cancelled", "blocked", "waiting_user"].includes(task.status);
}

export function taskEmptyStateMessageKey(
  totalTaskCount: number,
  visibleTaskCount: number
): "tasks.noTasks" | "tasks.noTasksForFilter" {
  return totalTaskCount > 0 && visibleTaskCount === 0 ? "tasks.noTasksForFilter" : "tasks.noTasks";
}

function formatDate(value: string | null | undefined, locale: string, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function progressText(task: TaskInfo): string {
  const progress = task.progress;
  if (!progress) return "0/0";
  return `${progress.completed}/${progress.total}`;
}

function triggerRunProgressText(
  trigger: TaskTriggerInfo,
  t: ReturnType<typeof useI18n>["t"]
): string {
  const maxRuns = trigger.kind === "once" ? (trigger.max_runs ?? 1) : trigger.max_runs;
  if (typeof maxRuns === "number" && maxRuns > 0) {
    return t("tasks.triggerRuns", { count: trigger.run_count, max: maxRuns });
  }
  return t("tasks.triggerRunsUnlimited", { count: trigger.run_count });
}

function isTriggerCompleted(trigger: TaskTriggerInfo): boolean {
  if (trigger.status === "completed") return true;
  const maxRuns = trigger.kind === "once" ? (trigger.max_runs ?? 1) : trigger.max_runs;
  return (
    trigger.last_run_status === "completed" &&
    typeof maxRuns === "number" &&
    maxRuns > 0 &&
    trigger.run_count >= maxRuns
  );
}

function triggerStatusLabel(trigger: TaskTriggerInfo, t: ReturnType<typeof useI18n>["t"]): string {
  if (
    trigger.status === "error" ||
    trigger.last_run_status === "failed" ||
    trigger.last_run_status === "cancelled"
  ) {
    return t("tasks.triggerError");
  }
  if (isTriggerCompleted(trigger)) return t("tasks.triggerCompleted");
  if (trigger.status === "pending_confirmation") return t("tasks.triggerPendingConfirmation");
  if (trigger.status === "paused" || !trigger.enabled) return t("tasks.triggerPaused");
  return t("tasks.triggerActive");
}

function triggerStatusClass(trigger: TaskTriggerInfo): string {
  if (
    trigger.status === "error" ||
    trigger.last_run_status === "failed" ||
    trigger.last_run_status === "cancelled"
  ) {
    return WORKBENCH_STATUS_DANGER_CLASS;
  }
  if (isTriggerCompleted(trigger)) return WORKBENCH_STATUS_SUCCESS_CLASS;
  if (trigger.status === "pending_confirmation") return WORKBENCH_STATUS_WARNING_CLASS;
  if (trigger.status === "paused" || !trigger.enabled) return WORKBENCH_STATUS_WARNING_CLASS;
  return WORKBENCH_STATUS_NEUTRAL_CLASS;
}

function formatIntervalText(
  seconds: number | null | undefined,
  t: ReturnType<typeof useI18n>["t"]
): string {
  const safeSeconds = Math.max(1, Math.round(seconds || 0));
  if (safeSeconds % 86_400 === 0) {
    return t("tasks.triggerEveryDays", { count: safeSeconds / 86_400 });
  }
  if (safeSeconds % 3_600 === 0) {
    return t("tasks.triggerEveryHours", { count: safeSeconds / 3_600 });
  }
  if (safeSeconds % 60 === 0) {
    return t("tasks.triggerEveryMinutes", { count: safeSeconds / 60 });
  }
  return t("tasks.triggerEverySeconds", { count: safeSeconds });
}

function triggerScheduleText(
  trigger: TaskTriggerInfo,
  locale: string,
  t: ReturnType<typeof useI18n>["t"]
): string {
  if (trigger.kind === "interval") {
    return formatIntervalText(trigger.interval_seconds, t);
  }
  const runAt = trigger.run_at || trigger.next_run_at;
  if (!runAt) return t("tasks.triggerOnce");
  return `${t("tasks.triggerOnce")} · ${formatDate(runAt, locale, t("tasks.unknown"))}`;
}

function triggerNextText(
  trigger: TaskTriggerInfo,
  locale: string,
  t: ReturnType<typeof useI18n>["t"]
): string {
  if (isTriggerCompleted(trigger)) return t("tasks.triggerNoNextRun");
  if (trigger.status === "pending_confirmation") return t("tasks.triggerPendingConfirmation");
  if (trigger.status === "paused" || !trigger.enabled) return t("tasks.triggerPaused");
  if (!trigger.next_run_at) return t("tasks.triggerNoNextRun");
  return formatDate(trigger.next_run_at, locale, t("tasks.triggerNoNextRun"));
}

function toDateTimeLocalValue(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function earliestIso(values: Array<string | null | undefined>): string | null {
  let bestValue: string | null = null;
  let bestTime = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const time = new Date(value).getTime();
    if (Number.isNaN(time) || time >= bestTime) continue;
    bestTime = time;
    bestValue = value;
  }
  return bestValue;
}

function currentTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function canConfirm(task: TaskInfo): boolean {
  return task.status === "candidate" || task.requiresConfirmation;
}

function canRun(task: TaskInfo): boolean {
  return !["candidate", "completed", "cancelled", "archived"].includes(task.status);
}

function canCancel(task: TaskInfo): boolean {
  return !["completed", "cancelled", "archived"].includes(task.status);
}

function eventTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function eventLabel(eventType: string, t: ReturnType<typeof useI18n>["t"]): string {
  switch (eventType) {
    case "task_created":
      return t("tasks.event.taskCreated");
    case "task_updated":
      return t("tasks.event.taskUpdated");
    case "task_confirmed":
      return t("tasks.event.taskConfirmed");
    case "task_cancelled":
      return t("tasks.event.taskCancelled");
    case "task_run_started":
      return t("tasks.event.taskRunStarted");
    case "task_plan_updated":
      return t("tasks.event.taskPlanUpdated");
    case "task_action_created":
      return t("tasks.event.taskActionCreated");
    case "task_action_started":
      return t("tasks.event.taskActionStarted");
    case "task_action_due_triggered":
      return t("tasks.event.taskActionDueTriggered");
    case "task_action_completed":
      return t("tasks.event.taskActionCompleted");
    case "task_action_blocked":
      return t("tasks.event.taskActionBlocked");
    case "task_action_waiting_user":
      return t("tasks.event.taskActionWaitingUser");
    case "task_action_cancelled":
      return t("tasks.event.taskActionCancelled");
    case "task_trigger_run_started":
      return t("tasks.event.taskTriggerRunStarted");
    case "task_trigger_run_completed":
      return t("tasks.event.taskTriggerRunCompleted");
    case "task_trigger_run_failed":
      return t("tasks.event.taskTriggerRunFailed");
    case "task_completed":
      return t("tasks.event.taskCompleted");
    default:
      return eventType || t("tasks.unknown");
  }
}

function payloadString(payload: Record<string, unknown> | null | undefined, key: string) {
  const value = payload?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function payloadRecord(
  payload: Record<string, unknown> | null | undefined,
  key: string
): Record<string, unknown> | null {
  const value = payload?.[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function eventDetailText(
  event: TaskEventInfo,
  actions: TaskActionInfo[],
  t: ReturnType<typeof useI18n>["t"]
): string | null {
  const parts: string[] = [];
  const actionId = payloadString(event.payload, "action_id");
  const actionTitle = actionId
    ? actions.find((action) => action.actionId === actionId)?.title || actionId
    : null;
  if (actionTitle) parts.push(t("tasks.eventAction", { title: actionTitle }));

  const runId = payloadString(event.payload, "run_id");
  if (runId) parts.push(t("tasks.eventRunId", { id: runId }));

  const plan = payloadRecord(event.payload, "plan");
  const progress = payloadRecord(plan, "progress");
  const currentTask =
    (typeof progress?.currentTask === "string" && progress.currentTask) ||
    (typeof progress?.current_task === "string" && progress.current_task) ||
    null;
  if (currentTask) parts.push(t("tasks.eventCurrentTask", { title: currentTask }));

  return parts.length > 0 ? parts.join(" · ") : null;
}

function actionFollowUpText(
  action: TaskActionInfo,
  t: ReturnType<typeof useI18n>["t"]
): string | null {
  if (action.lastError) return `${t("tasks.lastError")}: ${action.lastError}`;
  if (action.waitingReason) return `${t("tasks.waitingReason")}: ${action.waitingReason}`;
  return action.resultSummary || action.objective || null;
}

function actionFollowUpClass(action: TaskActionInfo): string {
  if (action.lastError) return "text-[#B42318]";
  if (action.waitingReason) return "text-[#8B5E00]";
  return "text-[#646A73]";
}

const taskPanelClass =
  "rounded-xl border border-[#DEE0E3] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.04)]";

const taskSoftPanelClass = "rounded-xl border border-[#EFF0F1] bg-[#F8F9FA]";

const taskTimelineItemClass =
  "relative grid min-w-0 gap-1.5 border-l border-[#DEE0E3] pb-3 pl-3 last:pb-0 before:absolute before:top-1.5 before:-left-[4.5px] before:h-2 before:w-2 before:rounded-full before:bg-[#1456F0] before:ring-4 before:ring-white";

export default function TasksPage({
  userId,
  selectedTaskId,
  tasks,
  actions,
  events,
  triggers,
  isLoading,
  error,
  onAuthExpired,
  onRefresh,
  onSelectTask,
  onOpenSession,
  onConfirmTask,
  onRunTaskNow,
  onCancelTask,
  onDeleteTask,
}: TasksPageProps) {
  const { locale, t } = useI18n();
  const isControlled = tasks !== undefined;
  const [taskList, setTaskList] = useState<TaskInfo[]>(() => tasks || []);
  const [selectedId, setSelectedId] = useState<string | null>(
    selectedTaskId || tasks?.[0]?.taskId || null
  );
  const selectedIdRef = useRef<string | null>(selectedId);
  const [detailActions, setDetailActions] = useState<TaskActionInfo[]>(() => actions || []);
  const [taskEvents, setTaskEvents] = useState<TaskEventInfo[]>(() => events || []);
  const [triggerList, setTriggerList] = useState<TaskTriggerInfo[]>(() => triggers || []);
  const [internalLoading, setInternalLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [internalError, setInternalError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<TaskFilter>("all");
  const [confirmingTaskAction, setConfirmingTaskAction] = useState<string | null>(null);
  const [isActionFormOpen, setIsActionFormOpen] = useState(false);
  const [isActionSortMode, setIsActionSortMode] = useState(false);
  const [newActionTitle, setNewActionTitle] = useState("");
  const [newActionObjective, setNewActionObjective] = useState("");
  const [draftActionOrderIds, setDraftActionOrderIds] = useState<string[]>([]);
  const [draggingActionId, setDraggingActionId] = useState<string | null>(null);
  const [triggerActionId, setTriggerActionId] = useState<string | null>(null);
  const [newTriggerRunAt, setNewTriggerRunAt] = useState("");
  const [editingTriggerId, setEditingTriggerId] = useState<string | null>(null);
  const [editingTriggerKind, setEditingTriggerKind] = useState<"once" | "interval">("once");
  const [editingTriggerRunAt, setEditingTriggerRunAt] = useState("");
  const [editingTriggerIntervalMinutes, setEditingTriggerIntervalMinutes] = useState("60");
  const [editingTriggerMaxRuns, setEditingTriggerMaxRuns] = useState("");
  const [confirmingTriggerDeleteId, setConfirmingTriggerDeleteId] = useState<string | null>(null);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    if (tasks) setTaskList(tasks);
  }, [tasks]);

  useEffect(() => {
    if (actions) setDetailActions(actions);
  }, [actions]);

  useEffect(() => {
    if (events) setTaskEvents(events);
  }, [events]);

  useEffect(() => {
    if (triggers) setTriggerList(triggers);
  }, [triggers]);

  const handleError = useCallback(
    (caught: unknown, fallback: string) => {
      if (caught instanceof AuthError) {
        onAuthExpired?.(t("auth.sessionExpired"));
        return;
      }
      setInternalError(caught instanceof Error ? caught.message : fallback);
    },
    [onAuthExpired, t]
  );

  const loadTaskDetail = useCallback(
    async (taskId: string) => {
      if (isControlled) return;
      setDetailLoading(true);
      try {
        const [detail, nextEvents] = await Promise.all([
          fetchTask(taskId),
          fetchTaskEvents(taskId),
        ]);
        setDetailActions(detail.actions);
        setTaskEvents(nextEvents);
        setTaskList((current) =>
          current.map((task) => (task.taskId === detail.task.taskId ? detail.task : task))
        );
        setInternalError(null);
      } catch (caught) {
        handleError(caught, t("tasks.failedToLoad"));
      } finally {
        setDetailLoading(false);
      }
    },
    [handleError, isControlled, t]
  );

  const loadTasks = useCallback(
    async (preferredSelectedId?: string | null) => {
      if (isControlled) return;
      const requestedSelectedId =
        preferredSelectedId === undefined ? selectedIdRef.current : preferredSelectedId;
      setInternalLoading(true);
      try {
        const [nextTasks, nextTriggers] = await Promise.all([fetchTasks(), fetchAllTaskTriggers()]);
        setTaskList(nextTasks);
        setTriggerList(nextTriggers);
        const nextSelectedId =
          requestedSelectedId && nextTasks.some((task) => task.taskId === requestedSelectedId)
            ? requestedSelectedId
            : nextTasks[0]?.taskId || null;
        setSelectedId(nextSelectedId);
        setInternalError(null);
        if (nextSelectedId) {
          await loadTaskDetail(nextSelectedId);
        } else {
          setDetailActions([]);
          setTaskEvents([]);
        }
      } catch (caught) {
        handleError(caught, t("tasks.failedToLoad"));
      } finally {
        setInternalLoading(false);
      }
    },
    [handleError, isControlled, loadTaskDetail, t]
  );

  useEffect(() => {
    if (!isControlled) void loadTasks();
  }, [isControlled, loadTasks, userId]);

  useEffect(() => {
    if (selectedTaskId) setSelectedId(selectedTaskId);
  }, [selectedTaskId]);

  const filteredTasks = useMemo(
    () => taskList.filter((task) => taskMatchesFilter(task, activeFilter)),
    [activeFilter, taskList]
  );

  const selectedTask = useMemo(
    () => filteredTasks.find((task) => task.taskId === selectedId) || filteredTasks[0] || null,
    [filteredTasks, selectedId]
  );

  useEffect(() => {
    setIsActionSortMode(false);
    setDraftActionOrderIds([]);
    setDraggingActionId(null);
    setTriggerActionId(null);
    setEditingTriggerId(null);
    setConfirmingTriggerDeleteId(null);
  }, [selectedTask?.taskId]);

  useEffect(() => {
    if (filteredTasks.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (selectedId && filteredTasks.some((task) => task.taskId === selectedId)) return;
    const nextSelectedId = filteredTasks[0].taskId;
    setSelectedId(nextSelectedId);
    onSelectTask?.(nextSelectedId);
    void loadTaskDetail(nextSelectedId);
  }, [filteredTasks, loadTaskDetail, onSelectTask, selectedId]);

  const visibleActions = useMemo(() => {
    const actionsForTask = selectedTask
      ? detailActions.filter((action) => action.taskId === selectedTask.taskId)
      : [];
    if (!isActionSortMode || draftActionOrderIds.length === 0) return actionsForTask;
    const byId = new Map(actionsForTask.map((action) => [action.actionId, action]));
    const ordered = draftActionOrderIds.flatMap((actionId) => {
      const action = byId.get(actionId);
      return action ? [action] : [];
    });
    const orderedIds = new Set(ordered.map((action) => action.actionId));
    const rest = actionsForTask.filter((action) => !orderedIds.has(action.actionId));
    return [...ordered, ...rest];
  }, [detailActions, draftActionOrderIds, isActionSortMode, selectedTask]);
  const visibleEvents = useMemo(
    () =>
      selectedTask
        ? taskEvents
            .filter((event) => event.taskId === selectedTask.taskId)
            .slice()
            .sort((left, right) => eventTimestamp(right.createdAt) - eventTimestamp(left.createdAt))
        : [],
    [selectedTask, taskEvents]
  );
  const selectedTaskTriggers = useMemo(() => {
    if (!selectedTask) return [];
    const actionIds = new Set(visibleActions.map((action) => action.actionId));
    return triggerList.filter(
      (trigger) =>
        trigger.task_id === selectedTask.taskId ||
        (trigger.task_action_id ? actionIds.has(trigger.task_action_id) : false)
    );
  }, [triggerList, selectedTask, visibleActions]);
  const selectedTaskActionTriggers = useMemo(
    () => visibleActions.filter((action) => Boolean(action.nextWakeupAt)),
    [visibleActions]
  );
  const selectedTaskNextRunAt = useMemo(
    () =>
      earliestIso([
        ...selectedTaskActionTriggers.map((action) => action.nextWakeupAt),
        ...selectedTaskTriggers
          .filter((trigger) => trigger.enabled && !isTriggerCompleted(trigger))
          .map((trigger) => trigger.next_run_at),
      ]),
    [selectedTaskActionTriggers, selectedTaskTriggers]
  );
  const loading = isLoading ?? internalLoading;
  const errorMessage = error ?? internalError;
  const emptyTaskMessage = t(taskEmptyStateMessageKey(taskList.length, filteredTasks.length));

  const selectTask = useCallback(
    (taskId: string) => {
      setSelectedId(taskId);
      onSelectTask?.(taskId);
      void loadTaskDetail(taskId);
    },
    [loadTaskDetail, onSelectTask]
  );

  const refresh = useCallback(() => {
    onRefresh?.();
    void loadTasks();
  }, [loadTasks, onRefresh]);

  const runTaskOperation = useCallback(
    async (taskId: string, operation: "confirm" | "run" | "cancel" | "delete") => {
      const actionKey = `${operation}:${taskId}`;
      if (
        (operation === "cancel" || operation === "delete") &&
        confirmingTaskAction !== actionKey
      ) {
        setConfirmingTaskAction(actionKey);
        return;
      }
      setConfirmingTaskAction(null);
      setPendingAction(`${operation}:${taskId}`);
      try {
        if (operation === "confirm") {
          onConfirmTask?.(taskId);
          if (!isControlled) await confirmTask(taskId);
        } else if (operation === "run") {
          onRunTaskNow?.(taskId);
          if (!isControlled) await runTaskNow(taskId);
        } else if (operation === "delete") {
          onDeleteTask?.(taskId);
          if (!isControlled) await deleteTask(taskId);
        } else {
          onCancelTask?.(taskId);
          if (!isControlled) await cancelTask(taskId);
        }
        await loadTasks(operation === "delete" && selectedId === taskId ? null : selectedId);
      } catch (caught) {
        handleError(caught, t("tasks.actionFailed"));
      } finally {
        setPendingAction(null);
      }
    },
    [
      confirmingTaskAction,
      handleError,
      isControlled,
      loadTasks,
      onCancelTask,
      onConfirmTask,
      onDeleteTask,
      onRunTaskNow,
      selectedId,
      t,
    ]
  );

  const submitNewAction = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!selectedTask) return;
      const title = newActionTitle.trim();
      if (!title) {
        setInternalError(t("tasks.actionTitleRequired"));
        return;
      }
      setPendingAction(`create-action:${selectedTask.taskId}`);
      setInternalError(null);
      try {
        const input: TaskActionCreateInput = {
          title,
          kind: "next_step",
          objective: newActionObjective.trim() || null,
          status: "confirmed",
        };
        await createTaskAction(selectedTask.taskId, input);
        setNewActionTitle("");
        setNewActionObjective("");
        setIsActionFormOpen(false);
        await loadTasks(selectedTask.taskId);
      } catch (caught) {
        handleError(caught, t("tasks.actionFailed"));
      } finally {
        setPendingAction(null);
      }
    },
    [handleError, loadTasks, newActionObjective, newActionTitle, selectedTask, t]
  );

  const startActionSortMode = useCallback(() => {
    setIsActionFormOpen(false);
    setTriggerActionId(null);
    setDraftActionOrderIds(visibleActions.map((action) => action.actionId));
    setDraggingActionId(null);
    setIsActionSortMode(true);
  }, [visibleActions]);

  const cancelActionSortMode = useCallback(() => {
    setIsActionSortMode(false);
    setDraftActionOrderIds([]);
    setDraggingActionId(null);
  }, []);

  const moveDraftAction = useCallback(
    (actionId: string, direction: -1 | 1) => {
      const fallbackOrder = visibleActions.map((action) => action.actionId);
      setDraftActionOrderIds((current) => {
        const order = current.length > 0 ? current.slice() : fallbackOrder.slice();
        const currentIndex = order.indexOf(actionId);
        const targetIndex = currentIndex + direction;
        if (currentIndex < 0 || targetIndex < 0 || targetIndex >= order.length) return current;
        const [moved] = order.splice(currentIndex, 1);
        order.splice(targetIndex, 0, moved);
        return order;
      });
    },
    [visibleActions]
  );

  const moveDraftActionToIndex = useCallback(
    (actionId: string, targetIndex: number) => {
      const fallbackOrder = visibleActions.map((action) => action.actionId);
      setDraftActionOrderIds((current) => {
        const order = current.length > 0 ? current.slice() : fallbackOrder.slice();
        const currentIndex = order.indexOf(actionId);
        const boundedTargetIndex = Math.max(0, Math.min(targetIndex, order.length - 1));
        if (currentIndex < 0 || currentIndex === boundedTargetIndex) return current;
        const [moved] = order.splice(currentIndex, 1);
        order.splice(boundedTargetIndex, 0, moved);
        return order;
      });
    },
    [visibleActions]
  );

  const submitActionSortOrder = useCallback(async () => {
    if (!selectedTask) return;
    const orderIds =
      draftActionOrderIds.length > 0
        ? draftActionOrderIds
        : visibleActions.map((action) => action.actionId);
    const byId = new Map(visibleActions.map((action) => [action.actionId, action]));
    const nextActions = orderIds.flatMap((actionId) => {
      const action = byId.get(actionId);
      return action ? [action] : [];
    });
    if (nextActions.length <= 1) {
      cancelActionSortMode();
      return;
    }
    setPendingAction(`sort-actions:${selectedTask.taskId}`);
    setInternalError(null);
    try {
      await Promise.all(
        nextActions.map((action, index) =>
          updateTaskAction(selectedTask.taskId, action.actionId, { sequenceIndex: index + 1 })
        )
      );
      setDetailActions((current) => {
        const reorderedIds = new Set(nextActions.map((action) => action.actionId));
        const reordered = nextActions.map((action, index) => ({
          ...action,
          sequenceIndex: index + 1,
        }));
        const rest = current.filter((action) => !reorderedIds.has(action.actionId));
        return [...reordered, ...rest];
      });
      cancelActionSortMode();
      await loadTasks(selectedTask.taskId);
    } catch (caught) {
      handleError(caught, t("tasks.actionFailed"));
    } finally {
      setPendingAction(null);
    }
  }, [
    cancelActionSortMode,
    draftActionOrderIds,
    handleError,
    loadTasks,
    selectedTask,
    t,
    visibleActions,
  ]);

  const handleActionDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>, actionId: string) => {
      if (!isActionSortMode) return;
      setDraggingActionId(actionId);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", actionId);
    },
    [isActionSortMode]
  );

  const handleActionDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!isActionSortMode) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    [isActionSortMode]
  );

  const handleActionDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>, targetIndex: number) => {
      if (!isActionSortMode) return;
      event.preventDefault();
      const actionId = event.dataTransfer.getData("text/plain") || draggingActionId;
      if (actionId) moveDraftActionToIndex(actionId, targetIndex);
      setDraggingActionId(null);
    },
    [draggingActionId, isActionSortMode, moveDraftActionToIndex]
  );

  const openTriggerForm = useCallback(
    (action?: TaskActionInfo) => {
      const targetAction = action || visibleActions[0] || null;
      setTriggerActionId(targetAction?.actionId || null);
      setNewTriggerRunAt("");
    },
    [visibleActions]
  );

  const submitNewTrigger = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!selectedTask || !triggerActionId) return;
      const action = visibleActions.find((item) => item.actionId === triggerActionId) || null;
      const title = action?.title || selectedTask.title;
      const prompt =
        action?.objective || action?.title || selectedTask.objective || selectedTask.title;
      if (!newTriggerRunAt) {
        setInternalError(t("tasks.triggerRunAtRequired"));
        return;
      }
      setPendingAction(`create-trigger:${triggerActionId}`);
      setInternalError(null);
      try {
        const input: TaskTriggerCreateInput = {
          title,
          prompt,
          kind: "once",
          timezone: currentTimezone(),
          run_at: newTriggerRunAt,
          enabled: true,
          max_runtime_seconds: 600,
        };
        await createTaskActionTrigger(selectedTask.taskId, triggerActionId, input);
        setTriggerActionId(null);
        setNewTriggerRunAt("");
        await loadTasks(selectedTask.taskId);
      } catch (caught) {
        handleError(caught, t("tasks.actionFailed"));
      } finally {
        setPendingAction(null);
      }
    },
    [handleError, loadTasks, newTriggerRunAt, selectedTask, t, triggerActionId, visibleActions]
  );

  const openTriggerEditForm = useCallback((trigger: TaskTriggerInfo) => {
    setTriggerActionId(null);
    setEditingTriggerId(trigger.trigger_id);
    setEditingTriggerKind(trigger.kind);
    setEditingTriggerRunAt(toDateTimeLocalValue(trigger.run_at || trigger.next_run_at));
    setEditingTriggerIntervalMinutes(
      String(Math.max(1, Math.round((trigger.interval_seconds || 3_600) / 60)))
    );
    setEditingTriggerMaxRuns(trigger.max_runs ? String(trigger.max_runs) : "");
    setConfirmingTriggerDeleteId(null);
  }, []);

  const submitTriggerEdit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!editingTriggerId) return;
      const trigger =
        selectedTaskTriggers.find((item) => item.trigger_id === editingTriggerId) || null;
      const taskId = trigger?.task_id || selectedTask?.taskId;
      if (!trigger || !taskId) return;
      const input: TaskTriggerUpdateInput = {
        kind: editingTriggerKind,
        timezone: currentTimezone(),
        enabled: isTriggerCompleted(trigger) ? true : trigger.enabled,
      };
      if (editingTriggerKind === "once") {
        if (!editingTriggerRunAt) {
          setInternalError(t("tasks.triggerRunAtRequired"));
          return;
        }
        input.run_at = editingTriggerRunAt;
        input.interval_seconds = null;
        input.max_runs = null;
      } else {
        const intervalMinutes = Number(editingTriggerIntervalMinutes);
        if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
          setInternalError(t("tasks.triggerIntervalRequired"));
          return;
        }
        const maxRunsText = editingTriggerMaxRuns.trim();
        if (maxRunsText) {
          const maxRuns = Number(maxRunsText);
          if (!Number.isInteger(maxRuns) || maxRuns <= 0) {
            setInternalError(t("tasks.triggerMaxRunsInvalid"));
            return;
          }
          input.max_runs = maxRuns;
        } else {
          input.max_runs = null;
        }
        input.run_at = null;
        input.interval_seconds = Math.max(1, Math.round(intervalMinutes * 60));
      }
      setPendingAction(`edit-trigger:${editingTriggerId}`);
      setInternalError(null);
      try {
        await updateTaskTrigger(taskId, editingTriggerId, input);
        setEditingTriggerId(null);
        await loadTasks(selectedTask?.taskId || selectedId);
      } catch (caught) {
        handleError(caught, t("tasks.actionFailed"));
      } finally {
        setPendingAction(null);
      }
    },
    [
      editingTriggerId,
      editingTriggerIntervalMinutes,
      editingTriggerKind,
      editingTriggerMaxRuns,
      editingTriggerRunAt,
      handleError,
      loadTasks,
      selectedId,
      selectedTask?.taskId,
      selectedTaskTriggers,
      t,
    ]
  );

  const toggleTriggerEnabledOperation = useCallback(
    async (trigger: TaskTriggerInfo) => {
      const taskId = trigger.task_id || selectedTask?.taskId;
      if (!taskId) return;
      setPendingAction(`toggle-trigger:${trigger.trigger_id}`);
      setInternalError(null);
      try {
        await updateTaskTrigger(taskId, trigger.trigger_id, { enabled: !trigger.enabled });
        await loadTasks(selectedTask?.taskId || selectedId);
      } catch (caught) {
        handleError(caught, t("tasks.actionFailed"));
      } finally {
        setPendingAction(null);
      }
    },
    [handleError, loadTasks, selectedId, selectedTask?.taskId, t]
  );

  const deleteTriggerOperation = useCallback(
    async (trigger: TaskTriggerInfo) => {
      const taskId = trigger.task_id || selectedTask?.taskId;
      if (!taskId) return;
      if (confirmingTriggerDeleteId !== trigger.trigger_id) {
        setConfirmingTriggerDeleteId(trigger.trigger_id);
        return;
      }
      setPendingAction(`delete-trigger:${trigger.trigger_id}`);
      setInternalError(null);
      try {
        await deleteTaskTrigger(taskId, trigger.trigger_id);
        setConfirmingTriggerDeleteId(null);
        setEditingTriggerId(null);
        await loadTasks(selectedTask?.taskId || selectedId);
      } catch (caught) {
        handleError(caught, t("tasks.actionFailed"));
      } finally {
        setPendingAction(null);
      }
    },
    [
      confirmingTriggerDeleteId,
      handleError,
      loadTasks,
      selectedId,
      selectedTask?.taskId,
      t,
    ]
  );

  const runTriggerOperation = useCallback(
    async (trigger: TaskTriggerInfo) => {
      const taskId = trigger.task_id || selectedTask?.taskId;
      if (!taskId) return;
      setPendingAction(`trigger:${trigger.trigger_id}`);
      setInternalError(null);
      try {
        await runTaskTriggerNow(taskId, trigger.trigger_id);
        await loadTasks(selectedId);
      } catch (caught) {
        handleError(caught, t("tasks.actionFailed"));
      } finally {
        setPendingAction(null);
      }
    },
    [handleError, loadTasks, selectedId, selectedTask?.taskId, t]
  );

  const filterButtonClass = (filter: TaskFilter) =>
    `inline-flex h-8 shrink-0 items-center justify-center rounded-lg px-3 ${TYPOGRAPHY_META_MEDIUM_CLASS} transition-colors ${
      activeFilter === filter
        ? "bg-[#1456F0] text-white"
        : "border border-[#DEE0E3] bg-white text-[#2B2F36] hover:bg-[#F8F9FA]"
    }`;

  return (
    <div
      data-ripple-task-page="true"
      className={`flex h-full min-h-0 flex-col overflow-hidden ${WORKBENCH_PAGE_BACKGROUND_CLASS} text-[#1F2329]`}
    >
      <MobilePageHeader
        title={t("tasks.title")}
        subtitle={t("tasks.total", { count: taskList.length })}
        actions={
          <button
            type="button"
            onClick={refresh}
            aria-label={t("tasks.refresh")}
            title={t("tasks.refresh")}
            className={WORKBENCH_ICON_BUTTON_CLASS}
            disabled={loading}
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          </button>
        }
      />

      <div
        className={`min-h-0 flex-1 overflow-y-auto px-3 ${MOBILE_PAGE_TOP_SAFE_AREA_CLASS} ${MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS} md:px-6 lg:pt-5 lg:pb-5`}
      >
        <div className={`${WORKBENCH_PAGE_CONTENT_CLASS} flex min-h-full flex-col gap-3`}>
          <header className="hidden items-center justify-between gap-3 lg:flex">
            <div className="min-w-0">
              <h1 className={`${TYPOGRAPHY_PAGE_TITLE_CLASS} text-[#1F2329]`}>
                {t("tasks.title")}
              </h1>
              <p className={`${TYPOGRAPHY_META_CLASS} mt-0.5 text-[#646A73]`}>
                {t("tasks.total", { count: taskList.length })}
              </p>
            </div>
            <button
              type="button"
              onClick={refresh}
              className={`${WORKBENCH_SECONDARY_BUTTON_CLASS} h-9 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
              disabled={loading}
            >
              {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              <span>{t("tasks.refresh")}</span>
            </button>
          </header>

          {errorMessage ? (
            <div
              className={`flex items-start gap-2 rounded-lg border border-[#B42318]/25 bg-[#FFF1F0] px-3 py-2 ${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#B42318]`}
            >
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{errorMessage}</span>
            </div>
          ) : null}

          <div
            data-ripple-task-focus-split="true"
            className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(286px,0.78fr)_minmax(0,1.5fr)] xl:grid-cols-[320px_minmax(0,1fr)]"
          >
            <section
              data-ripple-task-list="true"
              data-ripple-task-inbox="true"
              className={`${taskPanelClass} min-h-0 overflow-hidden`}
            >
              <div className="flex items-center justify-between gap-2 border-b border-[#EFF0F1] px-3 py-2.5">
                <div className="min-w-0">
                  <h2 className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} truncate text-[#1F2329]`}>
                    {t("tasks.title")}
                  </h2>
                  <p className={`${TYPOGRAPHY_META_CLASS} mt-0.5 text-[#646A73]`}>
                    {t("tasks.total", { count: filteredTasks.length })}
                  </p>
                </div>
                {loading ? (
                  <Loader2 size={15} className="shrink-0 animate-spin text-[#646A73]" />
                ) : null}
              </div>
              <div className="flex min-w-0 flex-wrap gap-1.5 border-b border-[#EFF0F1] px-2.5 py-2">
                {taskFilters.map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    onClick={() => setActiveFilter(filter)}
                    className={filterButtonClass(filter)}
                  >
                    {filterLabel(filter, t)}
                  </button>
                ))}
              </div>
              <div className="grid content-start gap-2 p-2.5">
                {filteredTasks.length === 0 && !loading ? (
                  <div
                    className={`rounded-lg border border-dashed border-[#D0D3D6] bg-[#F8F9FA] px-4 py-8 text-center ${TYPOGRAPHY_BODY_CLASS} text-[#646A73]`}
                  >
                    {emptyTaskMessage}
                  </div>
                ) : null}
                {filteredTasks.map((task) => {
                  const selected = selectedTask?.taskId === task.taskId;
                  return (
                    <button
                      key={task.taskId}
                      type="button"
                      onClick={() => selectTask(task.taskId)}
                      className={`group min-w-0 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                        selected
                          ? "border-[#BACEFD] bg-[#F0F5FF] shadow-[inset_3px_0_0_#1456F0]"
                          : "border-transparent bg-white hover:border-[#DEE0E3] hover:bg-[#F8F9FA]"
                      }`}
                    >
                      <div className="flex min-w-0 items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className={`truncate ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>
                            {task.title}
                          </div>
                          <div
                            className={`mt-0.5 truncate ${TYPOGRAPHY_META_CLASS} text-[#646A73]`}
                          >
                            {task.progress?.currentActionTitle || task.objective || task.taskId}
                          </div>
                        </div>
                        <span
                          className={`${statusClass(task.status)} shrink-0 ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`}
                        >
                          {statusLabel(task.status, t)}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[#EFF0F1]">
                          <div
                            className="h-full rounded-full bg-[#1456F0]"
                            style={{ width: `${task.progress?.percent ?? 0}%` }}
                          />
                        </div>
                        <span className={`${TYPOGRAPHY_META_MEDIUM_CLASS} shrink-0 text-[#646A73]`}>
                          {progressText(task)}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            <section data-ripple-task-detail="true" className="min-h-0">
              {selectedTask ? (
                <div className="grid min-h-full gap-3">
                  <div
                    data-ripple-task-summary="true"
                    className={`${taskPanelClass} overflow-hidden`}
                  >
                    <div className="grid gap-3 p-3 sm:p-4">
                      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <h2
                              className={`${TYPOGRAPHY_SECTION_TITLE_CLASS} min-w-0 truncate text-[#1F2329]`}
                            >
                              {selectedTask.title}
                            </h2>
                            <span
                              className={`${statusClass(selectedTask.status)} ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`}
                            >
                              {statusLabel(selectedTask.status, t)}
                            </span>
                          </div>
                          <p className={`${TYPOGRAPHY_BODY_CLASS} mt-1 text-[#646A73]`}>
                            {selectedTask.objective || t("tasks.objective")}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                          {canConfirm(selectedTask) ? (
                            <button
                              type="button"
                              onClick={() => void runTaskOperation(selectedTask.taskId, "confirm")}
                              className={`${WORKBENCH_PRIMARY_BUTTON_CLASS} h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                              disabled={pendingAction !== null}
                            >
                              <Check size={14} />
                              <span>{t("tasks.confirm")}</span>
                            </button>
                          ) : null}
                          {canRun(selectedTask) ? (
                            <button
                              type="button"
                              onClick={() => void runTaskOperation(selectedTask.taskId, "run")}
                              className={`${WORKBENCH_PRIMARY_BUTTON_CLASS} h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                              disabled={pendingAction !== null}
                            >
                              {pendingAction === `run:${selectedTask.taskId}` ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <Play size={14} />
                              )}
                              <span>
                                {pendingAction === `run:${selectedTask.taskId}`
                                  ? t("tasks.runningNow")
                                  : t("tasks.runNow")}
                              </span>
                            </button>
                          ) : null}
                          {selectedTask.sourceSessionId ? (
                            <button
                              type="button"
                              onClick={() => onOpenSession?.(selectedTask.sourceSessionId || "")}
                              title={t("tasks.viewSourceSession")}
                              className={`${WORKBENCH_SECONDARY_BUTTON_CLASS} h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                            >
                              <CircleDot size={14} strokeWidth={LUCIDE_NAV_STROKE_WIDTH} />
                              <span>{t("tasks.viewSourceSession")}</span>
                            </button>
                          ) : null}
                        </div>
                      </div>

                      <div>
                        <div className="flex items-center justify-between gap-3">
                          <span className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#646A73]`}>
                            {t("tasks.progress")}
                          </span>
                          <span className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#1F2329]`}>
                            {progressText(selectedTask)} · {selectedTask.progress?.percent ?? 0}%
                          </span>
                        </div>
                        <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#EFF0F1]">
                          <div
                            className="h-full rounded-full bg-[#1456F0]"
                            style={{ width: `${selectedTask.progress?.percent ?? 0}%` }}
                          />
                        </div>
                      </div>

                      <div className="grid gap-2 md:grid-cols-4">
                        <div className={`${taskSoftPanelClass} px-3 py-2`}>
                          <div className={`${TYPOGRAPHY_META_CLASS} text-[#646A73]`}>
                            {t("tasks.currentAction")}
                          </div>
                          <div
                            className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} mt-0.5 truncate text-[#1F2329]`}
                          >
                            {selectedTask.progress?.currentActionTitle || t("tasks.unknown")}
                          </div>
                        </div>
                        <div className={`${taskSoftPanelClass} px-3 py-2`}>
                          <div className={`${TYPOGRAPHY_META_CLASS} text-[#646A73]`}>
                            {t("tasks.nextRun")}
                          </div>
                          <div
                            className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} mt-0.5 truncate text-[#1F2329]`}
                          >
                            {formatDate(selectedTaskNextRunAt, locale, t("tasks.triggerNoNextRun"))}
                          </div>
                        </div>
                        <div className={`${taskSoftPanelClass} px-3 py-2`}>
                          <div className={`${TYPOGRAPHY_META_CLASS} text-[#646A73]`}>
                            {t("tasks.updated")}
                          </div>
                          <div
                            className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} mt-0.5 truncate text-[#1F2329]`}
                          >
                            {formatDate(selectedTask.updatedAt, locale, t("tasks.unknown"))}
                          </div>
                        </div>
                        <div className={`${taskSoftPanelClass} px-3 py-2`}>
                          <div className={`${TYPOGRAPHY_META_CLASS} text-[#646A73]`}>
                            {t("tasks.triggers")}
                          </div>
                          <div
                            className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} mt-0.5 truncate text-[#1F2329]`}
                          >
                            {selectedTaskActionTriggers.length + selectedTaskTriggers.length}
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 border-t border-[#EFF0F1] pt-3">
                        {canCancel(selectedTask) ? (
                          <button
                            type="button"
                            onClick={() => void runTaskOperation(selectedTask.taskId, "cancel")}
                            className={`${WORKBENCH_DANGER_BUTTON_CLASS} h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                            disabled={pendingAction !== null}
                          >
                            {pendingAction === `cancel:${selectedTask.taskId}` ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <X size={14} />
                            )}
                            <span>
                              {confirmingTaskAction === `cancel:${selectedTask.taskId}`
                                ? t("tasks.confirmCancel")
                                : t("tasks.cancel")}
                            </span>
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => void runTaskOperation(selectedTask.taskId, "delete")}
                          className={`${WORKBENCH_DANGER_BUTTON_CLASS} h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                          disabled={pendingAction !== null}
                        >
                          {pendingAction === `delete:${selectedTask.taskId}` ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <Trash2 size={14} />
                          )}
                          <span>
                            {confirmingTaskAction === `delete:${selectedTask.taskId}`
                              ? t("tasks.confirmDelete")
                              : t("tasks.delete")}
                          </span>
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="grid min-h-0 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(280px,0.86fr)]">
                    <section
                      data-ripple-task-actions-panel="true"
                      className={`${taskPanelClass} min-h-0 p-3`}
                    >
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <h3 className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}>
                          {t("tasks.actions")}
                        </h3>
                        <div className="flex items-center gap-2">
                          {detailLoading ? (
                            <Loader2 size={14} className="shrink-0 animate-spin text-[#646A73]" />
                          ) : null}
                          {isActionSortMode ? (
                            <>
                              <button
                                type="button"
                                onClick={cancelActionSortMode}
                                className={`${WORKBENCH_SECONDARY_BUTTON_CLASS} h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                                disabled={pendingAction !== null}
                              >
                                {t("tasks.cancelSortingActions")}
                              </button>
                              <button
                                type="button"
                                onClick={() => void submitActionSortOrder()}
                                className={`${WORKBENCH_PRIMARY_BUTTON_CLASS} h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                                disabled={pendingAction !== null}
                              >
                                {pendingAction === `sort-actions:${selectedTask.taskId}` ? (
                                  <Loader2 size={14} className="animate-spin" />
                                ) : (
                                  <Check size={14} />
                                )}
                                <span>{t("tasks.finishSortingActions")}</span>
                              </button>
                            </>
                          ) : (
                            <>
                              {visibleActions.length > 1 ? (
                                <button
                                  type="button"
                                  onClick={startActionSortMode}
                                  className={`${WORKBENCH_SECONDARY_BUTTON_CLASS} h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                                  disabled={pendingAction !== null || detailLoading}
                                >
                                  <GripVertical size={14} />
                                  <span>{t("tasks.sortActions")}</span>
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => setIsActionFormOpen((open) => !open)}
                                className={`${WORKBENCH_SECONDARY_BUTTON_CLASS} h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                                disabled={pendingAction !== null}
                              >
                                <Plus size={14} />
                                <span>{t("tasks.addAction")}</span>
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      {isActionFormOpen && !isActionSortMode ? (
                        <form
                          onSubmit={submitNewAction}
                          className={`${taskSoftPanelClass} mb-3 grid gap-2 p-3`}
                        >
                          <input
                            value={newActionTitle}
                            onChange={(event) => setNewActionTitle(event.target.value)}
                            placeholder={t("tasks.actionTitlePlaceholder")}
                            className={`h-10 px-2.5 ${WORKBENCH_FIELD_CLASS} ${TYPOGRAPHY_BODY_CLASS}`}
                          />
                          <textarea
                            value={newActionObjective}
                            onChange={(event) => setNewActionObjective(event.target.value)}
                            placeholder={t("tasks.actionObjectivePlaceholder")}
                            rows={2}
                            className={`min-h-20 px-2.5 py-2 ${WORKBENCH_FIELD_CLASS} ${TYPOGRAPHY_BODY_CLASS}`}
                          />
                          <div className="flex flex-wrap justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setIsActionFormOpen(false)}
                              className={`${WORKBENCH_SECONDARY_BUTTON_CLASS} h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                            >
                              {t("tasks.cancel")}
                            </button>
                            <button
                              type="submit"
                              className={`${WORKBENCH_PRIMARY_BUTTON_CLASS} h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                              disabled={pendingAction !== null}
                            >
                              {pendingAction === `create-action:${selectedTask.taskId}` ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <Plus size={14} />
                              )}
                              <span>{t("tasks.addAction")}</span>
                            </button>
                          </div>
                        </form>
                      ) : null}
                      {visibleActions.length === 0 && !detailLoading ? (
                        <div
                          className={`${TYPOGRAPHY_BODY_CLASS} rounded-lg border border-dashed border-[#D0D3D6] bg-[#F8F9FA] px-3 py-6 text-center text-[#646A73]`}
                        >
                          {t("tasks.noActions")}
                        </div>
                      ) : null}
                      <div className="grid gap-0">
                        {visibleActions.map((action, index) => (
                          <div
                            key={action.actionId}
                            draggable={isActionSortMode}
                            onDragStart={(event) => handleActionDragStart(event, action.actionId)}
                            onDragOver={handleActionDragOver}
                            onDrop={(event) => handleActionDrop(event, index)}
                            onDragEnd={() => setDraggingActionId(null)}
                            className={`${taskTimelineItemClass} ${
                              isActionSortMode
                                ? "rounded-lg border border-[#DEE0E3] bg-[#F8F9FA] py-2 pr-2 transition-colors"
                                : ""
                            } ${draggingActionId === action.actionId ? "opacity-60" : ""}`}
                          >
                            <div className="flex min-w-0 items-start justify-between gap-2">
                              <div className="flex min-w-0 items-center gap-2">
                                {isActionSortMode ? (
                                  <span
                                    aria-label={t("tasks.actionSortHandle")}
                                    title={t("tasks.actionSortHandle")}
                                    className="inline-flex h-7 w-7 shrink-0 cursor-grab items-center justify-center rounded-lg text-[#8F959E] active:cursor-grabbing"
                                  >
                                    <GripVertical size={15} />
                                  </span>
                                ) : null}
                                <div className="flex min-w-0 items-center gap-2">
                                  {action.status === "completed" ? (
                                    <CheckCircle2 size={15} className="shrink-0 text-[#16845B]" />
                                  ) : action.status === "waiting_user" ? (
                                    <Clock3 size={15} className="shrink-0 text-[#8B5E00]" />
                                  ) : action.status === "blocked" ? (
                                    <AlertTriangle size={15} className="shrink-0 text-[#B42318]" />
                                  ) : (
                                    <CircleDot size={15} className="shrink-0 text-[#1456F0]" />
                                  )}
                                  <span className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} truncate`}>
                                    {action.title}
                                  </span>
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-1.5">
                                {isActionSortMode ? (
                                  <>
                                    <span
                                      className={`${TYPOGRAPHY_MICRO_MEDIUM_CLASS} shrink-0 rounded-md border border-[#DEE0E3] bg-white px-1.5 py-0.5 text-[#646A73]`}
                                    >
                                      {t("tasks.actionSortPosition", {
                                        current: index + 1,
                                        total: visibleActions.length,
                                      })}
                                    </span>
                                    <button
                                      type="button"
                                      aria-label={t("tasks.moveActionUp")}
                                      title={t("tasks.moveActionUp")}
                                      onClick={() => moveDraftAction(action.actionId, -1)}
                                      className="inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-lg border border-[#DEE0E3] bg-white px-2 text-[#2B2F36] transition-colors hover:bg-[#F8F9FA] disabled:cursor-not-allowed disabled:opacity-40"
                                      disabled={pendingAction !== null || index === 0}
                                    >
                                      <ChevronUp size={13} />
                                      <span className={TYPOGRAPHY_MICRO_MEDIUM_CLASS}>
                                        {t("tasks.moveActionUpShort")}
                                      </span>
                                    </button>
                                    <button
                                      type="button"
                                      aria-label={t("tasks.moveActionDown")}
                                      title={t("tasks.moveActionDown")}
                                      onClick={() => moveDraftAction(action.actionId, 1)}
                                      className="inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-lg border border-[#DEE0E3] bg-white px-2 text-[#2B2F36] transition-colors hover:bg-[#F8F9FA] disabled:cursor-not-allowed disabled:opacity-40"
                                      disabled={
                                        pendingAction !== null ||
                                        index === visibleActions.length - 1
                                      }
                                    >
                                      <ChevronDown size={13} />
                                      <span className={TYPOGRAPHY_MICRO_MEDIUM_CLASS}>
                                        {t("tasks.moveActionDownShort")}
                                      </span>
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => openTriggerForm(action)}
                                      className={`${WORKBENCH_SECONDARY_BUTTON_CLASS} h-7 px-2 ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`}
                                      disabled={pendingAction !== null}
                                    >
                                      <Clock3 size={12} />
                                      <span>{t("tasks.addTrigger")}</span>
                                    </button>
                                    <span
                                      className={`${statusClass(action.status)} ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`}
                                    >
                                      {statusLabel(action.status, t)}
                                    </span>
                                  </>
                                )}
                              </div>
                            </div>
                            {actionFollowUpText(action, t) || action.lastRunId ? (
                              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                                {actionFollowUpText(action, t) ? (
                                  <p
                                    className={`${TYPOGRAPHY_META_CLASS} min-w-0 break-words ${actionFollowUpClass(
                                      action
                                    )}`}
                                  >
                                    {actionFollowUpText(action, t)}
                                  </p>
                                ) : null}
                                {action.lastRunId ? (
                                  <span
                                    className={`shrink-0 rounded-md border border-[#DEE0E3] bg-white px-1.5 py-0.5 font-[family-name:var(--font-mono)] ${TYPOGRAPHY_MICRO_MEDIUM_CLASS} text-[#646A73]`}
                                  >
                                    {t("tasks.lastRun")}: {action.lastRunId}
                                  </span>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </section>

                    <div className="grid content-start gap-3">
                      <section className={`${taskPanelClass} p-3`}>
                        <div className="mb-3 flex items-center justify-between gap-2">
                          <h3 className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}>
                            {t("tasks.triggers")}
                          </h3>
                          {visibleActions.length > 0 ? (
                            <button
                              type="button"
                              onClick={() => openTriggerForm()}
                              className={`${WORKBENCH_SECONDARY_BUTTON_CLASS} h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                              disabled={pendingAction !== null}
                            >
                              <Plus size={14} />
                              <span>{t("tasks.addTrigger")}</span>
                            </button>
                          ) : null}
                        </div>
                        {triggerActionId ? (
                          <form
                            onSubmit={submitNewTrigger}
                            className={`${taskSoftPanelClass} mb-3 grid gap-2 p-3`}
                          >
                            <label
                              className={`grid gap-1 ${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#646A73]`}
                            >
                              {t("tasks.action")}
                              <select
                                value={triggerActionId}
                                onChange={(event) => setTriggerActionId(event.target.value)}
                                className={`h-10 px-2.5 ${WORKBENCH_FIELD_CLASS} ${TYPOGRAPHY_BODY_CLASS}`}
                              >
                                {visibleActions.map((action) => (
                                  <option key={action.actionId} value={action.actionId}>
                                    {action.title}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label
                              className={`grid gap-1 ${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#646A73]`}
                            >
                              {t("tasks.runAt")}
                              <input
                                type="datetime-local"
                                value={newTriggerRunAt}
                                onChange={(event) => setNewTriggerRunAt(event.target.value)}
                                className={`h-10 px-2.5 ${WORKBENCH_FIELD_CLASS} ${TYPOGRAPHY_BODY_CLASS}`}
                              />
                            </label>
                            <div className="flex flex-wrap justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => setTriggerActionId(null)}
                                className={`${WORKBENCH_SECONDARY_BUTTON_CLASS} h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                              >
                                {t("tasks.cancel")}
                              </button>
                              <button
                                type="submit"
                                className={`${WORKBENCH_PRIMARY_BUTTON_CLASS} h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                                disabled={pendingAction !== null}
                              >
                                {pendingAction === `create-trigger:${triggerActionId}` ? (
                                  <Loader2 size={14} className="animate-spin" />
                                ) : (
                                  <Plus size={14} />
                                )}
                                <span>{t("tasks.addTrigger")}</span>
                              </button>
                            </div>
                          </form>
                        ) : null}
                        {selectedTaskActionTriggers.length === 0 &&
                        selectedTaskTriggers.length === 0 ? (
                          <div
                            className={`${TYPOGRAPHY_BODY_CLASS} rounded-lg border border-dashed border-[#D0D3D6] bg-[#F8F9FA] px-3 py-5 text-center text-[#646A73]`}
                          >
                            {t("tasks.noTriggers")}
                          </div>
                        ) : null}
                        <div className="grid gap-2">
                          {selectedTaskActionTriggers.map((action) => (
                            <div
                              key={`task-action-trigger-${action.actionId}`}
                              className={`${taskSoftPanelClass} grid gap-1.5 px-3 py-2`}
                            >
                              <div className="flex min-w-0 items-center justify-between gap-2">
                                <div className="flex min-w-0 items-center gap-2">
                                  <Clock3 size={15} className="shrink-0 text-[#1456F0]" />
                                  <span className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} truncate`}>
                                    {action.title}
                                  </span>
                                </div>
                                <span
                                  className={`${WORKBENCH_STATUS_NEUTRAL_CLASS} shrink-0 ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`}
                                >
                                  {t("tasks.actionTrigger")}
                                </span>
                              </div>
                              <div className={`${TYPOGRAPHY_META_CLASS} text-[#646A73]`}>
                                {t("tasks.triggerNext")}:{" "}
                                {formatDate(action.nextWakeupAt, locale, t("tasks.unknown"))}
                              </div>
                              {action.lastRunId ? (
                                <span
                                  className={`w-fit rounded-md border border-[#DEE0E3] bg-white px-1.5 py-0.5 font-[family-name:var(--font-mono)] ${TYPOGRAPHY_MICRO_MEDIUM_CLASS} text-[#646A73]`}
                                >
                                  {t("tasks.lastRun")}: {action.lastRunId}
                                </span>
                              ) : null}
                            </div>
                          ))}
                          {selectedTaskTriggers.map((trigger) => (
                            <div
                              key={trigger.trigger_id}
                              className={`${taskSoftPanelClass} grid gap-1.5 px-3 py-2`}
                            >
                              <div className="flex min-w-0 items-center justify-between gap-2">
                                <div className="flex min-w-0 items-center gap-2">
                                  <Clock3 size={15} className="shrink-0 text-[#1456F0]" />
                                  <span className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} truncate`}>
                                    {trigger.title}
                                  </span>
                                </div>
                                <span
                                  className={`${triggerStatusClass(
                                    trigger
                                  )} shrink-0 ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`}
                                >
                                  {triggerStatusLabel(trigger, t)}
                                </span>
                              </div>
                              <div className={`${TYPOGRAPHY_META_CLASS} text-[#646A73]`}>
                                {triggerScheduleText(trigger, locale, t)}
                              </div>
                              <div className={`${TYPOGRAPHY_META_CLASS} text-[#646A73]`}>
                                {t("tasks.triggerNext")}: {triggerNextText(trigger, locale, t)}
                              </div>
                              <div className={`${TYPOGRAPHY_META_CLASS} text-[#646A73]`}>
                                {triggerRunProgressText(trigger, t)}
                              </div>
                              {trigger.last_error ? (
                                <div className={`${TYPOGRAPHY_META_CLASS} text-[#B42318]`}>
                                  {t("tasks.lastError")}: {trigger.last_error}
                                </div>
                              ) : null}
                              {editingTriggerId === trigger.trigger_id ? (
                                <form
                                  onSubmit={submitTriggerEdit}
                                  className="mt-1 grid gap-2 border-t border-[#DEE0E3] pt-2"
                                >
                                  <label
                                    className={`grid gap-1 ${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#646A73]`}
                                  >
                                    {t("tasks.triggerMode")}
                                    <select
                                      value={editingTriggerKind}
                                      onChange={(event) =>
                                        setEditingTriggerKind(
                                          event.target.value === "interval" ? "interval" : "once"
                                        )
                                      }
                                      className={`h-9 px-2.5 ${WORKBENCH_FIELD_CLASS} ${TYPOGRAPHY_BODY_CLASS}`}
                                    >
                                      <option value="once">{t("tasks.triggerOnce")}</option>
                                      <option value="interval">{t("tasks.triggerInterval")}</option>
                                    </select>
                                  </label>
                                  {editingTriggerKind === "once" ? (
                                    <label
                                      className={`grid gap-1 ${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#646A73]`}
                                    >
                                      {t("tasks.runAt")}
                                      <input
                                        type="datetime-local"
                                        value={editingTriggerRunAt}
                                        onChange={(event) =>
                                          setEditingTriggerRunAt(event.target.value)
                                        }
                                        className={`h-9 px-2.5 ${WORKBENCH_FIELD_CLASS} ${TYPOGRAPHY_BODY_CLASS}`}
                                      />
                                    </label>
                                  ) : (
                                    <div className="grid gap-2 sm:grid-cols-2">
                                      <label
                                        className={`grid gap-1 ${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#646A73]`}
                                      >
                                        {t("tasks.triggerEveryMinutesLabel")}
                                        <input
                                          type="number"
                                          min="1"
                                          step="1"
                                          value={editingTriggerIntervalMinutes}
                                          onChange={(event) =>
                                            setEditingTriggerIntervalMinutes(event.target.value)
                                          }
                                          className={`h-9 px-2.5 ${WORKBENCH_FIELD_CLASS} ${TYPOGRAPHY_BODY_CLASS}`}
                                        />
                                      </label>
                                      <label
                                        className={`grid gap-1 ${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#646A73]`}
                                      >
                                        {t("tasks.maxRuns")}
                                        <input
                                          type="number"
                                          min="1"
                                          step="1"
                                          placeholder={t("tasks.noLimit")}
                                          value={editingTriggerMaxRuns}
                                          onChange={(event) =>
                                            setEditingTriggerMaxRuns(event.target.value)
                                          }
                                          className={`h-9 px-2.5 ${WORKBENCH_FIELD_CLASS} ${TYPOGRAPHY_BODY_CLASS}`}
                                        />
                                      </label>
                                    </div>
                                  )}
                                  <div className="flex flex-wrap justify-end gap-2">
                                    <button
                                      type="button"
                                      onClick={() => setEditingTriggerId(null)}
                                      className={`${WORKBENCH_SECONDARY_BUTTON_CLASS} h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                                    >
                                      {t("tasks.cancel")}
                                    </button>
                                    <button
                                      type="submit"
                                      className={`${WORKBENCH_PRIMARY_BUTTON_CLASS} h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                                      disabled={pendingAction !== null}
                                    >
                                      {pendingAction === `edit-trigger:${trigger.trigger_id}` ? (
                                        <Loader2 size={14} className="animate-spin" />
                                      ) : (
                                        <Check size={14} />
                                      )}
                                      <span>{t("tasks.saveTrigger")}</span>
                                    </button>
                                  </div>
                                </form>
                              ) : null}
                              <div className="flex min-w-0 flex-wrap items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => openTriggerEditForm(trigger)}
                                  className={`${WORKBENCH_SECONDARY_BUTTON_CLASS} h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                                  disabled={pendingAction !== null}
                                >
                                  <Pencil size={14} />
                                  <span>{t("tasks.edit")}</span>
                                </button>
                                {!isTriggerCompleted(trigger) &&
                                trigger.status !== "pending_confirmation" ? (
                                  <button
                                    type="button"
                                    onClick={() => void toggleTriggerEnabledOperation(trigger)}
                                    className={`${WORKBENCH_SECONDARY_BUTTON_CLASS} h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                                    disabled={pendingAction !== null}
                                  >
                                    {pendingAction === `toggle-trigger:${trigger.trigger_id}` ? (
                                      <Loader2 size={14} className="animate-spin" />
                                    ) : trigger.enabled ? (
                                      <Pause size={14} />
                                    ) : (
                                      <Play size={14} />
                                    )}
                                    <span>
                                      {trigger.enabled ? t("tasks.pause") : t("tasks.resume")}
                                    </span>
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  onClick={() => void runTriggerOperation(trigger)}
                                  className={`${WORKBENCH_SECONDARY_BUTTON_CLASS} h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                                  disabled={pendingAction !== null}
                                >
                                  {pendingAction === `trigger:${trigger.trigger_id}` ? (
                                    <Loader2 size={14} className="animate-spin" />
                                  ) : (
                                    <Play size={14} />
                                  )}
                                  <span>
                                    {isTriggerCompleted(trigger)
                                      ? t("tasks.runAgain")
                                      : t("tasks.runNow")}
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void deleteTriggerOperation(trigger)}
                                  className={`${WORKBENCH_DANGER_BUTTON_CLASS} h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                                  disabled={pendingAction !== null}
                                >
                                  {pendingAction === `delete-trigger:${trigger.trigger_id}` ? (
                                    <Loader2 size={14} className="animate-spin" />
                                  ) : (
                                    <Trash2 size={14} />
                                  )}
                                  <span>
                                    {confirmingTriggerDeleteId === trigger.trigger_id
                                      ? t("tasks.confirmDelete")
                                      : t("tasks.delete")}
                                  </span>
                                </button>
                              </div>
                              {trigger.last_run_id || trigger.last_run_status ? (
                                <div className="flex min-w-0 flex-wrap items-center gap-2">
                                  {trigger.last_run_id ? (
                                    <span
                                      className={`shrink-0 rounded-md border border-[#DEE0E3] bg-white px-1.5 py-0.5 font-[family-name:var(--font-mono)] ${TYPOGRAPHY_MICRO_MEDIUM_CLASS} text-[#646A73]`}
                                    >
                                      {t("tasks.lastRun")}: {trigger.last_run_id}
                                    </span>
                                  ) : null}
                                  {trigger.last_run_status ? (
                                    <span className={`${TYPOGRAPHY_META_CLASS} text-[#646A73]`}>
                                      {trigger.last_run_status}
                                    </span>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      </section>

                      <section
                        data-ripple-task-activity-panel="true"
                        className={`${taskPanelClass} p-3`}
                      >
                        <h3 className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} mb-3 text-[#1F2329]`}>
                          {t("tasks.activity")}
                        </h3>
                        {visibleEvents.length === 0 ? (
                          <div
                            className={`${TYPOGRAPHY_BODY_CLASS} rounded-lg border border-dashed border-[#D0D3D6] bg-[#F8F9FA] px-3 py-5 text-center text-[#646A73]`}
                          >
                            {t("tasks.noEvents")}
                          </div>
                        ) : null}
                        <div className="grid gap-2">
                          {visibleEvents.slice(0, 6).map((event) => {
                            const detail = eventDetailText(event, visibleActions, t);
                            return (
                              <div key={event.eventId} className="grid min-w-0 gap-0.5">
                                <div className="flex min-w-0 items-center justify-between gap-3">
                                  <span
                                    className={`${TYPOGRAPHY_META_MEDIUM_CLASS} truncate text-[#2B2F36]`}
                                  >
                                    {eventLabel(event.eventType, t)}
                                  </span>
                                  <span
                                    className={`${TYPOGRAPHY_META_CLASS} shrink-0 text-[#646A73]`}
                                  >
                                    {formatDate(event.createdAt, locale, t("tasks.unknown"))}
                                  </span>
                                </div>
                                {detail ? (
                                  <div
                                    className={`${TYPOGRAPHY_META_CLASS} truncate text-[#646A73]`}
                                  >
                                    {detail}
                                  </div>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    </div>
                  </div>
                </div>
              ) : (
                <div className={`px-4 py-10 text-center ${TYPOGRAPHY_BODY_CLASS} text-[#646A73]`}>
                  {loading ? <Loader2 size={18} className="mx-auto mb-2 animate-spin" /> : null}
                  {loading ? t("tasks.loading") : emptyTaskMessage}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
