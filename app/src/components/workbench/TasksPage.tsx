"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  CircleDot,
  Clock3,
  Loader2,
  Play,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import {
  AuthError,
  cancelTask,
  confirmTask,
  deleteTask,
  fetchTask,
  fetchTaskEvents,
  fetchTaskTriggers,
  fetchTasks,
  runTaskNow,
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
  const [detailActions, setDetailActions] = useState<TaskActionInfo[]>(() => actions || []);
  const [taskEvents, setTaskEvents] = useState<TaskEventInfo[]>(() => events || []);
  const [triggerList, setTriggerList] = useState<TaskTriggerInfo[]>(() => triggers || []);
  const [internalLoading, setInternalLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [internalError, setInternalError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<TaskFilter>("all");

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

  const loadTasks = useCallback(async (preferredSelectedId: string | null = selectedId) => {
    if (isControlled) return;
    setInternalLoading(true);
    try {
      const nextTasks = await fetchTasks();
      const triggerGroups = await Promise.all(
        nextTasks.map((task) => fetchTaskTriggers(task.taskId))
      );
      setTaskList(nextTasks);
      setTriggerList(triggerGroups.flat());
      const nextSelectedId =
        preferredSelectedId && nextTasks.some((task) => task.taskId === preferredSelectedId)
          ? preferredSelectedId
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
  }, [handleError, isControlled, loadTaskDetail, selectedId, t]);

  useEffect(() => {
    if (!isControlled) void loadTasks();
  }, [isControlled, loadTasks, userId]);

  useEffect(() => {
    if (selectedTaskId) setSelectedId(selectedTaskId);
  }, [selectedTaskId]);

  const selectedTask = useMemo(
    () => taskList.find((task) => task.taskId === selectedId) || taskList[0] || null,
    [selectedId, taskList]
  );

  const filteredTasks = useMemo(
    () => taskList.filter((task) => taskMatchesFilter(task, activeFilter)),
    [activeFilter, taskList]
  );

  const visibleActions = useMemo(
    () =>
      selectedTask ? detailActions.filter((action) => action.taskId === selectedTask.taskId) : [],
    [detailActions, selectedTask]
  );
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
  const loading = isLoading ?? internalLoading;
  const errorMessage = error ?? internalError;

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

          <div className="flex min-w-0 gap-1.5 overflow-x-auto pb-0.5">
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

          {errorMessage ? (
            <div
              className={`flex items-start gap-2 rounded-lg border border-[#B42318]/25 bg-[#FFF1F0] px-3 py-2 ${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#B42318]`}
            >
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{errorMessage}</span>
            </div>
          ) : null}

          <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(260px,0.82fr)_minmax(0,1.38fr)]">
            <section data-ripple-task-list="true" className="grid content-start gap-2">
              {filteredTasks.length === 0 && !loading ? (
                <div
                  className={`rounded-xl border border-dashed border-[#D0D3D6] bg-white px-4 py-8 text-center ${TYPOGRAPHY_BODY_CLASS} text-[#646A73]`}
                >
                  {t("tasks.noTasks")}
                </div>
              ) : null}
              {filteredTasks.map((task) => {
                const selected = selectedTask?.taskId === task.taskId;
                return (
                  <button
                    key={task.taskId}
                    type="button"
                    onClick={() => selectTask(task.taskId)}
                    className={`min-w-0 rounded-xl border bg-white px-3 py-2.5 text-left shadow-[0_1px_2px_rgba(31,35,41,0.04)] transition-colors ${
                      selected
                        ? "border-[#BACEFD] bg-[#F0F5FF]"
                        : "border-[#DEE0E3] hover:bg-[#F8F9FA]"
                    }`}
                  >
                    <div className="flex min-w-0 items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className={`truncate ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>
                          {task.title}
                        </div>
                        <div className={`mt-0.5 truncate ${TYPOGRAPHY_META_CLASS} text-[#646A73]`}>
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
            </section>

            <section
              data-ripple-task-detail="true"
              className="min-h-0 rounded-xl border border-[#DEE0E3] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.04)]"
            >
              {selectedTask ? (
                <div className="grid gap-3 p-3 sm:p-4">
                  <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className={`${TYPOGRAPHY_SECTION_TITLE_CLASS} truncate text-[#1F2329]`}>
                        {selectedTask.title}
                      </h2>
                      <p className={`${TYPOGRAPHY_BODY_CLASS} mt-1 text-[#646A73]`}>
                        {selectedTask.objective || t("tasks.objective")}
                      </p>
                    </div>
                    <span
                      className={`${statusClass(selectedTask.status)} ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`}
                    >
                      {statusLabel(selectedTask.status, t)}
                    </span>
                  </div>

                  <div className="grid gap-2 md:grid-cols-3">
                    <div className="rounded-lg border border-[#EFF0F1] bg-[#F8F9FA] px-3 py-2">
                      <div className={`${TYPOGRAPHY_META_CLASS} text-[#646A73]`}>
                        {t("tasks.progress")}
                      </div>
                      <div className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} mt-0.5 text-[#1F2329]`}>
                        {progressText(selectedTask)} · {selectedTask.progress?.percent ?? 0}%
                      </div>
                    </div>
                    <div className="rounded-lg border border-[#EFF0F1] bg-[#F8F9FA] px-3 py-2">
                      <div className={`${TYPOGRAPHY_META_CLASS} text-[#646A73]`}>
                        {t("tasks.currentAction")}
                      </div>
                      <div
                        className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} mt-0.5 truncate text-[#1F2329]`}
                      >
                        {selectedTask.progress?.currentActionTitle || t("tasks.unknown")}
                      </div>
                    </div>
                    <div className="rounded-lg border border-[#EFF0F1] bg-[#F8F9FA] px-3 py-2">
                      <div className={`${TYPOGRAPHY_META_CLASS} text-[#646A73]`}>
                        {t("tasks.updated")}
                      </div>
                      <div
                        className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} mt-0.5 truncate text-[#1F2329]`}
                      >
                        {formatDate(selectedTask.updatedAt, locale, t("tasks.unknown"))}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
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
                        className={`${WORKBENCH_SECONDARY_BUTTON_CLASS} h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
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
                    {canCancel(selectedTask) ? (
                      <button
                        type="button"
                        onClick={() => void runTaskOperation(selectedTask.taskId, "cancel")}
                        className={`${WORKBENCH_DANGER_BUTTON_CLASS} h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                        disabled={pendingAction !== null}
                      >
                        <X size={14} />
                        <span>{t("tasks.cancel")}</span>
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
                      <span>{t("tasks.delete")}</span>
                    </button>
                  </div>

                  <div className="grid gap-2">
                    <h3 className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}>
                      {t("tasks.actions")}
                    </h3>
                    {detailLoading ? (
                      <div className="flex items-center gap-2 text-[#646A73]">
                        <Loader2 size={14} className="animate-spin" />
                        <span className={TYPOGRAPHY_META_CLASS}>{t("tasks.failedToLoad")}</span>
                      </div>
                    ) : null}
                    {visibleActions.length === 0 && !detailLoading ? (
                      <div
                        className={`${TYPOGRAPHY_BODY_CLASS} rounded-lg border border-dashed border-[#D0D3D6] px-3 py-4 text-center text-[#646A73]`}
                      >
                        {t("tasks.noActions")}
                      </div>
                    ) : null}
                    {visibleActions.map((action) => (
                      <div
                        key={action.actionId}
                        className="grid gap-1.5 rounded-lg border border-[#EFF0F1] bg-[#F8F9FA] px-3 py-2"
                      >
                        <div className="flex min-w-0 items-center justify-between gap-2">
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
                          <span
                            className={`${statusClass(action.status)} shrink-0 ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`}
                          >
                            {statusLabel(action.status, t)}
                          </span>
                        </div>
                        {action.nextWakeupAt ? (
                          <div className={`${TYPOGRAPHY_META_CLASS} text-[#646A73]`}>
                            {t("tasks.plannedAt")}:{" "}
                            {formatDate(action.nextWakeupAt, locale, t("tasks.unknown"))}
                          </div>
                        ) : null}
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

                  <div className="grid gap-2">
                    <h3 className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}>
                      {t("tasks.triggers")}
                    </h3>
                    {selectedTaskActionTriggers.length === 0 &&
                    selectedTaskTriggers.length === 0 ? (
                      <div
                        className={`${TYPOGRAPHY_BODY_CLASS} rounded-lg border border-dashed border-[#D0D3D6] px-3 py-4 text-center text-[#646A73]`}
                      >
                        {t("tasks.noTriggers")}
                      </div>
                    ) : null}
                    {selectedTaskActionTriggers.map((action) => (
                      <div
                        key={`task-action-trigger-${action.actionId}`}
                        className="grid gap-1.5 rounded-lg border border-[#EFF0F1] bg-[#F8F9FA] px-3 py-2"
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
                        className="grid gap-1.5 rounded-lg border border-[#EFF0F1] bg-[#F8F9FA] px-3 py-2"
                      >
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <Clock3 size={15} className="shrink-0 text-[#1456F0]" />
                            <span className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} truncate`}>
                              {trigger.title}
                            </span>
                          </div>
                          <span
                            className={`${
                              trigger.enabled
                                ? WORKBENCH_STATUS_NEUTRAL_CLASS
                                : WORKBENCH_STATUS_WARNING_CLASS
                            } shrink-0 ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`}
                          >
                            {trigger.enabled ? t("tasks.triggerActive") : t("tasks.triggerPaused")}
                          </span>
                        </div>
                        <div className={`${TYPOGRAPHY_META_CLASS} text-[#646A73]`}>
                          {t("tasks.triggerNext")}:{" "}
                          {formatDate(trigger.next_run_at, locale, t("tasks.unknown"))}
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

                  <div className="grid gap-2">
                    <h3 className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}>
                      {t("tasks.events")}
                    </h3>
                    {visibleEvents.length === 0 ? (
                      <div
                        className={`${TYPOGRAPHY_BODY_CLASS} rounded-lg border border-dashed border-[#D0D3D6] px-3 py-4 text-center text-[#646A73]`}
                      >
                        {t("tasks.noEvents")}
                      </div>
                    ) : null}
                    {visibleEvents.slice(0, 6).map((event) => {
                      const detail = eventDetailText(event, visibleActions, t);
                      return (
                        <div
                          key={event.eventId}
                          className="grid min-w-0 gap-0.5 rounded-lg border border-[#EFF0F1] px-3 py-2"
                        >
                          <div className="flex min-w-0 items-center justify-between gap-3">
                            <span
                              className={`${TYPOGRAPHY_META_MEDIUM_CLASS} truncate text-[#2B2F36]`}
                            >
                              {eventLabel(event.eventType, t)}
                            </span>
                            <span className={`${TYPOGRAPHY_META_CLASS} shrink-0 text-[#646A73]`}>
                              {formatDate(event.createdAt, locale, t("tasks.unknown"))}
                            </span>
                          </div>
                          {detail ? (
                            <div className={`${TYPOGRAPHY_META_CLASS} truncate text-[#646A73]`}>
                              {detail}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className={`px-4 py-10 text-center ${TYPOGRAPHY_BODY_CLASS} text-[#646A73]`}>
                  {loading ? <Loader2 size={18} className="mx-auto mb-2 animate-spin" /> : null}
                  {loading ? t("tasks.failedToLoad") : t("tasks.noTasks")}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
