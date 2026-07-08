"use client";

import React, { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock3,
  FileText,
  Loader2,
  MessageSquare,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  XCircle,
} from "lucide-react";
import {
  AuthError,
  cancelTaskRun,
  confirmTaskSpec,
  createTaskConfirmation,
  createTaskSession,
  createTaskSpec,
  fetchTaskSession,
  fetchTaskSessions,
  respondTaskConfirmation,
  startTaskRun,
  updateTaskRun,
} from "@/lib/api";
import type {
  TaskConfirmationInfo,
  TaskRunInfo,
  TaskSessionDetail,
  TaskSessionInfo,
  TaskSpecInfo,
} from "@/types";
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

interface TasksPageProps {
  userId: string;
  onAuthExpired?: (message: string) => void;
  onOpenSession?: (sessionId: string) => void;
  initialSessions?: TaskSessionInfo[];
  initialDetail?: TaskSessionDetail | null;
}

type SubmitAction =
  | "create-session"
  | "create-spec"
  | "confirm-spec"
  | "confirm-run"
  | "start-run"
  | "complete-run"
  | "fail-run"
  | "cancel-run"
  | "create-confirmation"
  | "accept-confirmation"
  | "reject-confirmation";

const taskTypeOptions = [
  { value: "todo", label: "待办" },
  { value: "research", label: "检索/研究" },
  { value: "content", label: "内容生成" },
  { value: "connector_action", label: "外部服务动作" },
  { value: "other", label: "其他" },
];

const statusLabels: Record<string, string> = {
  pending_confirm: "待确认",
  in_progress: "进行中",
  waiting_user: "需要你确认",
  completed: "已完成",
  cancelled: "已取消",
  failed: "失败",
  confirmed: "已确认",
  requested: "待响应",
  accepted: "已接受",
  rejected: "已拒绝",
};

export function taskSessionEmptyStateMessageKey(totalCount: number, visibleCount: number): string {
  if (totalCount > 0 && visibleCount === 0) return "tasks.noTaskSessionsForFilter";
  return "tasks.noTaskSessions";
}

function statusLabel(status: string | null | undefined): string {
  if (!status) return "未知";
  return statusLabels[status] || status;
}

function statusClass(status: string | null | undefined): string {
  if (status === "completed" || status === "accepted" || status === "confirmed") {
    return WORKBENCH_STATUS_SUCCESS_CLASS;
  }
  if (status === "failed" || status === "cancelled" || status === "rejected") {
    return WORKBENCH_STATUS_DANGER_CLASS;
  }
  if (status === "pending_confirm" || status === "waiting_user" || status === "requested") {
    return WORKBENCH_STATUS_WARNING_CLASS;
  }
  return WORKBENCH_STATUS_NEUTRAL_CLASS;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatLongDate(value: string | null | undefined): string {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function detailLatestSpec(detail: TaskSessionDetail | null): TaskSpecInfo | null {
  if (!detail || detail.taskSpecs.length === 0) return null;
  const currentId = detail.taskSession.currentTaskSpecId;
  return (
    detail.taskSpecs.find((spec) => spec.taskSpecId === currentId) ||
    detail.taskSpecs[detail.taskSpecs.length - 1] ||
    null
  );
}

function detailLatestRun(detail: TaskSessionDetail | null): TaskRunInfo | null {
  if (!detail || detail.runs.length === 0) return null;
  const currentId = detail.taskSession.currentRunId || detail.taskSession.latestRunId;
  return (
    detail.runs.find((run) => run.runId === currentId) ||
    detail.runs[detail.runs.length - 1] ||
    null
  );
}

function detailPendingConfirmation(detail: TaskSessionDetail | null): TaskConfirmationInfo | null {
  if (!detail) return null;
  return detail.confirmations.find((confirmation) => confirmation.status === "requested") || null;
}

function upsertSession(
  sessions: TaskSessionInfo[],
  nextSession: TaskSessionInfo
): TaskSessionInfo[] {
  const withoutCurrent = sessions.filter((session) => session.sessionId !== nextSession.sessionId);
  return [nextSession, ...withoutCurrent].sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt || left.createdAt || "");
    const rightTime = Date.parse(right.updatedAt || right.createdAt || "");
    return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
  });
}

function compactJson(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

function StatusBadge({ status }: { status: string | null | undefined }) {
  return (
    <span className={`${statusClass(status)} ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`}>
      {statusLabel(status)}
    </span>
  );
}

function Metric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "warning" | "success";
}) {
  const toneClass =
    tone === "success"
      ? "text-[#16845B]"
      : tone === "warning"
        ? "text-[#8B5E00]"
        : "text-[#1F2329]";
  return (
    <div className="rounded-lg border border-[#DEE0E3] bg-white px-3 py-2">
      <div className={`${TYPOGRAPHY_META_CLASS} text-[#646A73]`}>{label}</div>
      <div className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} ${toneClass}`}>{value}</div>
    </div>
  );
}

export default function TasksPage({
  userId,
  onAuthExpired,
  onOpenSession,
  initialSessions = [],
  initialDetail = null,
}: TasksPageProps) {
  const initialSelectedSessionId =
    initialDetail?.taskSession.sessionId || initialSessions[0]?.sessionId || null;
  const [sessions, setSessions] = useState<TaskSessionInfo[]>(initialSessions);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    initialSelectedSessionId
  );
  const [detail, setDetail] = useState<TaskSessionDetail | null>(initialDetail);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [submittingAction, setSubmittingAction] = useState<SubmitAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newTaskType, setNewTaskType] = useState("todo");
  const [newGoal, setNewGoal] = useState("");
  const [specTaskType, setSpecTaskType] = useState("todo");
  const [specGoal, setSpecGoal] = useState("");
  const [specImpact, setSpecImpact] = useState("");
  const [runSummary, setRunSummary] = useState("");
  const [failureReason, setFailureReason] = useState("");
  const [confirmationTitle, setConfirmationTitle] = useState("");

  const selectedSession = useMemo(() => {
    if (detail?.taskSession.sessionId === selectedSessionId) return detail.taskSession;
    return sessions.find((session) => session.sessionId === selectedSessionId) || null;
  }, [detail, selectedSessionId, sessions]);

  const latestSpec = useMemo(() => detailLatestSpec(detail), [detail]);
  const latestRun = useMemo(() => detailLatestRun(detail), [detail]);
  const pendingConfirmation = useMemo(() => detailPendingConfirmation(detail), [detail]);

  const handleError = useCallback(
    (err: unknown, fallback: string) => {
      if (err instanceof AuthError) {
        onAuthExpired?.("登录已过期，请重新登录。");
        return;
      }
      setError(errorMessage(err, fallback));
    },
    [onAuthExpired]
  );

  const loadDetail = useCallback(
    async (sessionId: string) => {
      setDetailLoading(true);
      setError(null);
      try {
        const nextDetail = await fetchTaskSession(sessionId);
        setDetail(nextDetail);
        setSessions((current) => upsertSession(current, nextDetail.taskSession));
      } catch (err) {
        handleError(err, "加载任务会话详情失败");
      } finally {
        setDetailLoading(false);
      }
    },
    [handleError]
  );

  const loadSessions = useCallback(
    async (preferredSessionId?: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const nextSessions = await fetchTaskSessions();
        setSessions(nextSessions);
        const nextSelectedId =
          preferredSessionId ||
          selectedSessionId ||
          nextSessions[0]?.sessionId ||
          initialSelectedSessionId;
        if (nextSelectedId) {
          setSelectedSessionId(nextSelectedId);
          await loadDetail(nextSelectedId);
        } else {
          setSelectedSessionId(null);
          setDetail(null);
        }
      } catch (err) {
        handleError(err, "加载任务会话列表失败");
      } finally {
        setLoading(false);
      }
    },
    [handleError, initialSelectedSessionId, loadDetail, selectedSessionId]
  );

  useEffect(() => {
    void loadSessions(initialSelectedSessionId);
    // userId 是隔离维度，切换用户时必须重新拉取当前用户的任务会话。
  }, [initialSelectedSessionId, loadSessions, userId]);

  const selectSession = useCallback(
    (sessionId: string) => {
      setSelectedSessionId(sessionId);
      void loadDetail(sessionId);
    },
    [loadDetail]
  );

  const applyDetail = useCallback((nextDetail: TaskSessionDetail) => {
    setDetail(nextDetail);
    setSelectedSessionId(nextDetail.taskSession.sessionId);
    setSessions((current) => upsertSession(current, nextDetail.taskSession));
  }, []);

  const runAction = useCallback(
    async (
      action: SubmitAction,
      task: () => Promise<TaskSessionDetail>,
      successMessage: string
    ) => {
      if (submittingAction) return;
      setSubmittingAction(action);
      setError(null);
      setNotice(null);
      try {
        const nextDetail = await task();
        applyDetail(nextDetail);
        setNotice(successMessage);
      } catch (err) {
        handleError(err, "操作失败");
      } finally {
        setSubmittingAction(null);
      }
    },
    [applyDetail, handleError, submittingAction]
  );

  const submitCreateSession = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const goal = newGoal.trim();
    const title = newTitle.trim() || goal || "任务会话";
    if (!goal) {
      setError("请先填写任务目标。");
      return;
    }
    await runAction(
      "create-session",
      () =>
        createTaskSession({
          title,
          sourceSurface: "web_task_tab",
          taskType: newTaskType,
          goal,
          executor: "vitana",
          initialMessage: goal,
        }),
      "已创建任务会话"
    );
    setNewTitle("");
    setNewGoal("");
    setSpecGoal(goal);
    setSpecTaskType(newTaskType);
  };

  const submitCreateSpec = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedSession) return;
    const goal = specGoal.trim() || selectedSession.goal || "";
    if (!goal) {
      setError("请先填写 TaskSpec 目标。");
      return;
    }
    await runAction(
      "create-spec",
      () =>
        createTaskSpec(selectedSession.sessionId, {
          taskType: specTaskType,
          goal,
          riskLevel: "low",
          impactSummary: specImpact.trim() || `准备执行：${goal}`,
        }),
      "已生成 TaskSpec"
    );
    setSpecImpact("");
  };

  const confirmLatestSpec = (startRunAfterConfirm: boolean) => {
    if (!selectedSession || !latestSpec) return;
    void runAction(
      startRunAfterConfirm ? "confirm-run" : "confirm-spec",
      () =>
        confirmTaskSpec(selectedSession.sessionId, latestSpec.taskSpecId, {
          startRun: startRunAfterConfirm,
        }),
      startRunAfterConfirm ? "已确认并启动运行" : "已确认 TaskSpec"
    );
  };

  const startLatestRun = () => {
    if (!selectedSession || !latestSpec) return;
    void runAction(
      "start-run",
      () =>
        startTaskRun(selectedSession.sessionId, latestSpec.taskSpecId, {
          confirm: latestSpec.status === "pending_confirm",
        }),
      "已启动 TaskRun"
    );
  };

  const completeLatestRun = () => {
    if (!selectedSession || !latestRun) return;
    const summary = runSummary.trim() || "任务运行已完成。";
    void runAction(
      "complete-run",
      () =>
        updateTaskRun(selectedSession.sessionId, latestRun.runId, {
          status: "completed",
          resultSummary: summary,
        }),
      "已标记运行完成"
    );
    setRunSummary("");
  };

  const failLatestRun = () => {
    if (!selectedSession || !latestRun) return;
    const reason = failureReason.trim() || "运行失败。";
    void runAction(
      "fail-run",
      () =>
        updateTaskRun(selectedSession.sessionId, latestRun.runId, {
          status: "failed",
          failureReason: reason,
        }),
      "已标记运行失败"
    );
    setFailureReason("");
  };

  const cancelLatestRun = () => {
    if (!selectedSession || !latestRun) return;
    void runAction(
      "cancel-run",
      () => cancelTaskRun(selectedSession.sessionId, latestRun.runId),
      "已取消当前运行"
    );
  };

  const requestConfirmation = () => {
    if (!selectedSession) return;
    const title = confirmationTitle.trim() || "请确认是否继续执行";
    void runAction(
      "create-confirmation",
      () =>
        createTaskConfirmation(selectedSession.sessionId, {
          title,
          confirmationType: "allow_deny",
          critical: true,
        }),
      "已创建确认卡"
    );
    setConfirmationTitle("");
  };

  const respondConfirmation = (confirmation: TaskConfirmationInfo, allow: boolean) => {
    if (!selectedSession) return;
    void runAction(
      allow ? "accept-confirmation" : "reject-confirmation",
      () =>
        respondTaskConfirmation(selectedSession.sessionId, confirmation.confirmationId, {
          decision: allow ? "allow" : "deny",
        }),
      allow ? "已通过确认" : "已拒绝确认"
    );
  };

  const isBusy = Boolean(submittingAction);
  const canStartRun = Boolean(selectedSession && latestSpec && !latestRun);
  const canCompleteRun = Boolean(
    latestRun && !["completed", "cancelled", "failed"].includes(latestRun.status)
  );
  const sourceSessionId =
    selectedSession?.sourceSurface === "session"
      ? selectedSession.sourceId
      : selectedSession?.sourceId;

  return (
    <div
      data-ripple-task-page="true"
      className={`${WORKBENCH_PAGE_BACKGROUND_CLASS} ${MOBILE_PAGE_TOP_SAFE_AREA_CLASS} ${MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS} h-full min-h-0 overflow-y-auto text-[#1F2329] lg:pt-0 lg:pb-6`}
    >
      <div className={`${WORKBENCH_PAGE_CONTENT_CLASS} space-y-4 p-4 lg:p-6`}>
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#646A73]`}>
              Vitana Task Center
            </div>
            <h1 className={`${TYPOGRAPHY_PAGE_TITLE_CLASS} text-[#1F2329]`}>Task Sessions</h1>
            <p className={`${TYPOGRAPHY_BODY_CLASS} mt-1 max-w-3xl text-[#646A73]`}>
              当前 Task tab 已切到 `/v1/task-sessions`。这里用于验证任务会话、TaskSpec、确认卡和
              TaskRun 投影，不再调用旧 `/v1/tasks`。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`${TYPOGRAPHY_META_CLASS} rounded-lg bg-white px-2.5 py-1 text-[#646A73]`}
            >
              User: {userId}
            </span>
            <button
              type="button"
              className={`${WORKBENCH_ICON_BUTTON_CLASS} h-9 w-9`}
              onClick={() => void loadSessions(selectedSessionId)}
              disabled={loading || isBusy}
              aria-label="刷新任务会话"
              title="刷新任务会话"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={LUCIDE_NAV_STROKE_WIDTH} />
              ) : (
                <RefreshCw className="h-4 w-4" strokeWidth={LUCIDE_NAV_STROKE_WIDTH} />
              )}
            </button>
          </div>
        </header>

        {error ? (
          <div className="flex items-start gap-2 rounded-lg border border-[#FAD4D4] bg-[#FFF1F0] px-3 py-2 text-[#B42318]">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0"
              strokeWidth={LUCIDE_NAV_STROKE_WIDTH}
            />
            <span className={TYPOGRAPHY_BODY_CLASS}>{error}</span>
          </div>
        ) : null}
        {notice ? (
          <div className="flex items-start gap-2 rounded-lg border border-[#BFEAD6] bg-[#E4F8EE] px-3 py-2 text-[#16845B]">
            <CheckCircle2
              className="mt-0.5 h-4 w-4 shrink-0"
              strokeWidth={LUCIDE_NAV_STROKE_WIDTH}
            />
            <span className={TYPOGRAPHY_BODY_CLASS}>{notice}</span>
          </div>
        ) : null}

        <form
          className="rounded-lg border border-[#DEE0E3] bg-white p-4 shadow-[0_1px_2px_rgba(31,35,41,0.04)]"
          onSubmit={submitCreateSession}
        >
          <div className="flex flex-col gap-3 lg:grid lg:grid-cols-[minmax(0,1fr)_180px_minmax(0,1.5fr)_auto] lg:items-end">
            <label className="flex flex-col gap-1">
              <span className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#646A73]`}>标题</span>
              <input
                className={`${WORKBENCH_FIELD_CLASS} h-9 px-3 ${TYPOGRAPHY_BODY_CLASS}`}
                value={newTitle}
                onChange={(event) => setNewTitle(event.target.value)}
                placeholder="可选，默认取任务目标"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#646A73]`}>类型</span>
              <select
                className={`${WORKBENCH_FIELD_CLASS} h-9 px-3 ${TYPOGRAPHY_BODY_CLASS}`}
                value={newTaskType}
                onChange={(event) => setNewTaskType(event.target.value)}
              >
                {taskTypeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#646A73]`}>目标</span>
              <input
                className={`${WORKBENCH_FIELD_CLASS} h-9 px-3 ${TYPOGRAPHY_BODY_CLASS}`}
                value={newGoal}
                onChange={(event) => setNewGoal(event.target.value)}
                placeholder="例如：明天上午整理客户会议纪要"
              />
            </label>
            <button
              type="submit"
              className={`${WORKBENCH_PRIMARY_BUTTON_CLASS} h-9 px-3 ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
              disabled={isBusy}
            >
              {submittingAction === "create-session" ? (
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={LUCIDE_NAV_STROKE_WIDTH} />
              ) : (
                <Plus className="h-4 w-4" strokeWidth={LUCIDE_NAV_STROKE_WIDTH} />
              )}
              <span>新建会话</span>
            </button>
          </div>
        </form>

        <div className="grid min-h-[520px] gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <aside
            data-ripple-task-list="true"
            className="min-h-0 rounded-lg border border-[#DEE0E3] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.04)]"
          >
            <div className="flex items-center justify-between border-b border-[#EFF0F1] px-4 py-3">
              <div>
                <div className={`${TYPOGRAPHY_SECTION_TITLE_CLASS} text-[#1F2329]`}>任务会话</div>
                <div className={`${TYPOGRAPHY_META_CLASS} text-[#646A73]`}>
                  {sessions.length} 条记录
                </div>
              </div>
              {loading ? (
                <Loader2
                  className="h-4 w-4 animate-spin text-[#646A73]"
                  strokeWidth={LUCIDE_NAV_STROKE_WIDTH}
                />
              ) : null}
            </div>
            <div className="max-h-[calc(100vh-360px)] min-h-[320px] overflow-y-auto p-2">
              {sessions.length === 0 ? (
                <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[#DEE0E3] text-center">
                  <MessageSquare
                    className="h-6 w-6 text-[#8F959E]"
                    strokeWidth={LUCIDE_NAV_STROKE_WIDTH}
                  />
                  <div className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}>
                    {taskSessionEmptyStateMessageKey(0, 0) === "tasks.noTaskSessions"
                      ? "还没有任务会话"
                      : "没有匹配的任务会话"}
                  </div>
                  <div className={`${TYPOGRAPHY_META_CLASS} max-w-[240px] text-[#646A73]`}>
                    用上面的表单创建一个会话，就能测试 TaskSpec、确认卡和 TaskRun。
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {sessions.map((session) => {
                    const selected = session.sessionId === selectedSessionId;
                    return (
                      <button
                        key={session.sessionId}
                        type="button"
                        className={`w-full rounded-lg border px-3 py-3 text-left transition-colors ${
                          selected
                            ? "border-[#1456F0] bg-[#F0F5FF]"
                            : "border-[#DEE0E3] bg-white hover:bg-[#F8F9FA]"
                        }`}
                        onClick={() => selectSession(session.sessionId)}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div
                              className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} truncate text-[#1F2329]`}
                            >
                              {session.title}
                            </div>
                            <div
                              className={`${TYPOGRAPHY_META_CLASS} mt-0.5 truncate text-[#646A73]`}
                            >
                              {session.goal || session.latestMessage || session.sessionId}
                            </div>
                          </div>
                          <StatusBadge status={session.status} />
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[#646A73]">
                          <span
                            className={`${TYPOGRAPHY_META_CLASS} inline-flex items-center gap-1`}
                          >
                            <Clock3 className="h-3.5 w-3.5" strokeWidth={LUCIDE_NAV_STROKE_WIDTH} />
                            {formatDate(session.updatedAt || session.createdAt)}
                          </span>
                          {session.needsUserAction ? (
                            <span className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#8B5E00]`}>
                              需要处理
                            </span>
                          ) : null}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>

          <main
            data-ripple-task-detail="true"
            className="min-h-0 rounded-lg border border-[#DEE0E3] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.04)]"
          >
            {!selectedSession ? (
              <div className="flex min-h-[520px] flex-col items-center justify-center gap-2 text-center">
                <FileText
                  className="h-8 w-8 text-[#8F959E]"
                  strokeWidth={LUCIDE_NAV_STROKE_WIDTH}
                />
                <div className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}>
                  选择一个任务会话
                </div>
                <div className={`${TYPOGRAPHY_META_CLASS} text-[#646A73]`}>
                  或创建新会话开始测试。
                </div>
              </div>
            ) : (
              <div className="min-h-[520px]">
                <div className="border-b border-[#EFF0F1] px-4 py-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className={`${TYPOGRAPHY_SECTION_TITLE_CLASS} truncate text-[#1F2329]`}>
                          {selectedSession.title}
                        </h2>
                        <StatusBadge status={selectedSession.status} />
                      </div>
                      <div className={`${TYPOGRAPHY_META_CLASS} mt-1 break-all text-[#646A73]`}>
                        {selectedSession.sessionId}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {sourceSessionId && onOpenSession ? (
                        <button
                          type="button"
                          className={`${WORKBENCH_SECONDARY_BUTTON_CLASS} h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                          onClick={() => onOpenSession(sourceSessionId)}
                        >
                          打开来源会话
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className={`${WORKBENCH_ICON_BUTTON_CLASS} h-8 w-8`}
                        onClick={() => void loadDetail(selectedSession.sessionId)}
                        disabled={detailLoading || isBusy}
                        aria-label="刷新详情"
                        title="刷新详情"
                      >
                        {detailLoading ? (
                          <Loader2
                            className="h-4 w-4 animate-spin"
                            strokeWidth={LUCIDE_NAV_STROKE_WIDTH}
                          />
                        ) : (
                          <RotateCcw className="h-4 w-4" strokeWidth={LUCIDE_NAV_STROKE_WIDTH} />
                        )}
                      </button>
                    </div>
                  </div>
                  <div className="mt-4 grid gap-2 sm:grid-cols-3">
                    <Metric label="TaskSpec" value={`${detail?.taskSpecs.length || 0}`} />
                    <Metric label="TaskRun" value={`${detail?.runs.length || 0}`} />
                    <Metric
                      label="用户动作"
                      value={selectedSession.needsUserAction ? "需要" : "不需要"}
                      tone={selectedSession.needsUserAction ? "warning" : "success"}
                    />
                  </div>
                </div>

                <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_320px]">
                  <section className="space-y-4">
                    <div className="rounded-lg border border-[#DEE0E3] p-4">
                      <div className={`${TYPOGRAPHY_SECTION_TITLE_CLASS} text-[#1F2329]`}>
                        会话摘要
                      </div>
                      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                        <div>
                          <dt className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#646A73]`}>
                            任务类型
                          </dt>
                          <dd className={`${TYPOGRAPHY_BODY_CLASS} text-[#1F2329]`}>
                            {selectedSession.taskType || "未设置"}
                          </dd>
                        </div>
                        <div>
                          <dt className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#646A73]`}>
                            执行方
                          </dt>
                          <dd className={`${TYPOGRAPHY_BODY_CLASS} text-[#1F2329]`}>
                            {selectedSession.executor || "vitana"}
                          </dd>
                        </div>
                        <div className="sm:col-span-2">
                          <dt className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#646A73]`}>目标</dt>
                          <dd
                            className={`${TYPOGRAPHY_BODY_CLASS} whitespace-pre-wrap text-[#1F2329]`}
                          >
                            {selectedSession.goal || "未设置"}
                          </dd>
                        </div>
                        <div className="sm:col-span-2">
                          <dt className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#646A73]`}>
                            最新消息
                          </dt>
                          <dd
                            className={`${TYPOGRAPHY_BODY_CLASS} whitespace-pre-wrap text-[#646A73]`}
                          >
                            {selectedSession.latestMessage || "暂无"}
                          </dd>
                        </div>
                        <div>
                          <dt className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#646A73]`}>创建</dt>
                          <dd className={`${TYPOGRAPHY_BODY_CLASS} text-[#1F2329]`}>
                            {formatLongDate(selectedSession.createdAt)}
                          </dd>
                        </div>
                        <div>
                          <dt className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#646A73]`}>更新</dt>
                          <dd className={`${TYPOGRAPHY_BODY_CLASS} text-[#1F2329]`}>
                            {formatLongDate(selectedSession.updatedAt)}
                          </dd>
                        </div>
                      </dl>
                    </div>

                    <div className="rounded-lg border border-[#DEE0E3] p-4">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <div className={`${TYPOGRAPHY_SECTION_TITLE_CLASS} text-[#1F2329]`}>
                            TaskSpec
                          </div>
                          <p className={`${TYPOGRAPHY_META_CLASS} mt-1 text-[#646A73]`}>
                            任务执行前的结构化规格。确认后才能启动 TaskRun。
                          </p>
                        </div>
                        {latestSpec ? <StatusBadge status={latestSpec.status} /> : null}
                      </div>

                      {latestSpec ? (
                        <div className="mt-3 rounded-lg bg-[#F8F9FA] p-3">
                          <div className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}>
                            {latestSpec.goal || "未设置目标"}
                          </div>
                          <div className={`${TYPOGRAPHY_META_CLASS} mt-1 text-[#646A73]`}>
                            {latestSpec.taskType} · {latestSpec.taskSpecId}
                          </div>
                          {latestSpec.impactSummary ? (
                            <p
                              className={`${TYPOGRAPHY_BODY_CLASS} mt-2 whitespace-pre-wrap text-[#646A73]`}
                            >
                              {latestSpec.impactSummary}
                            </p>
                          ) : null}
                        </div>
                      ) : (
                        <div
                          className={`${TYPOGRAPHY_BODY_CLASS} mt-3 rounded-lg bg-[#F8F9FA] p-3 text-[#646A73]`}
                        >
                          当前会话还没有 TaskSpec。
                        </div>
                      )}

                      <form className="mt-4 space-y-3" onSubmit={submitCreateSpec}>
                        <div className="grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)]">
                          <label className="flex flex-col gap-1">
                            <span className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#646A73]`}>
                              类型
                            </span>
                            <select
                              className={`${WORKBENCH_FIELD_CLASS} h-9 px-3 ${TYPOGRAPHY_BODY_CLASS}`}
                              value={specTaskType}
                              onChange={(event) => setSpecTaskType(event.target.value)}
                            >
                              {taskTypeOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#646A73]`}>
                              目标
                            </span>
                            <input
                              className={`${WORKBENCH_FIELD_CLASS} h-9 px-3 ${TYPOGRAPHY_BODY_CLASS}`}
                              value={specGoal}
                              onChange={(event) => setSpecGoal(event.target.value)}
                              placeholder={selectedSession.goal || "TaskSpec 目标"}
                            />
                          </label>
                        </div>
                        <label className="flex flex-col gap-1">
                          <span className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#646A73]`}>
                            影响说明
                          </span>
                          <textarea
                            className={`${WORKBENCH_FIELD_CLASS} min-h-[76px] resize-y px-3 py-2 ${TYPOGRAPHY_BODY_CLASS}`}
                            value={specImpact}
                            onChange={(event) => setSpecImpact(event.target.value)}
                            placeholder="可选：执行会影响哪些文件、外部服务或用户状态"
                          />
                        </label>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="submit"
                            className={`${WORKBENCH_SECONDARY_BUTTON_CLASS} h-9 ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
                            disabled={isBusy}
                          >
                            {submittingAction === "create-spec" ? (
                              <Loader2
                                className="h-4 w-4 animate-spin"
                                strokeWidth={LUCIDE_NAV_STROKE_WIDTH}
                              />
                            ) : (
                              <FileText className="h-4 w-4" strokeWidth={LUCIDE_NAV_STROKE_WIDTH} />
                            )}
                            <span>生成 TaskSpec</span>
                          </button>
                          <button
                            type="button"
                            className={`${WORKBENCH_PRIMARY_BUTTON_CLASS} h-9 ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
                            onClick={() => confirmLatestSpec(false)}
                            disabled={
                              isBusy || !latestSpec || latestSpec.status !== "pending_confirm"
                            }
                          >
                            <Check className="h-4 w-4" strokeWidth={LUCIDE_NAV_STROKE_WIDTH} />
                            <span>确认 Spec</span>
                          </button>
                          <button
                            type="button"
                            className={`${WORKBENCH_PRIMARY_BUTTON_CLASS} h-9 ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
                            onClick={() => confirmLatestSpec(true)}
                            disabled={
                              isBusy || !latestSpec || latestSpec.status !== "pending_confirm"
                            }
                          >
                            <Play className="h-4 w-4" strokeWidth={LUCIDE_NAV_STROKE_WIDTH} />
                            <span>确认并启动</span>
                          </button>
                        </div>
                      </form>
                    </div>

                    <div className="rounded-lg border border-[#DEE0E3] p-4">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <div className={`${TYPOGRAPHY_SECTION_TITLE_CLASS} text-[#1F2329]`}>
                            TaskRun
                          </div>
                          <p className={`${TYPOGRAPHY_META_CLASS} mt-1 text-[#646A73]`}>
                            当前是运行投影 API，用于对接真实执行 run 或业务侧执行器。
                          </p>
                        </div>
                        {latestRun ? <StatusBadge status={latestRun.status} /> : null}
                      </div>

                      {latestRun ? (
                        <div className="mt-3 rounded-lg bg-[#F8F9FA] p-3">
                          <div
                            className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} break-all text-[#1F2329]`}
                          >
                            {latestRun.runId}
                          </div>
                          <div className={`${TYPOGRAPHY_META_CLASS} mt-1 text-[#646A73]`}>
                            Spec: {latestRun.taskSpecId} · started {formatDate(latestRun.startedAt)}
                          </div>
                          {latestRun.resultSummary ? (
                            <p
                              className={`${TYPOGRAPHY_BODY_CLASS} mt-2 whitespace-pre-wrap text-[#16845B]`}
                            >
                              {latestRun.resultSummary}
                            </p>
                          ) : null}
                          {latestRun.failureReason || latestRun.cancellationReason ? (
                            <p
                              className={`${TYPOGRAPHY_BODY_CLASS} mt-2 whitespace-pre-wrap text-[#B42318]`}
                            >
                              {latestRun.failureReason || latestRun.cancellationReason}
                            </p>
                          ) : null}
                        </div>
                      ) : (
                        <div
                          className={`${TYPOGRAPHY_BODY_CLASS} mt-3 rounded-lg bg-[#F8F9FA] p-3 text-[#646A73]`}
                        >
                          当前还没有 TaskRun。
                        </div>
                      )}

                      <div className="mt-4 space-y-3">
                        <label className="flex flex-col gap-1">
                          <span className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#646A73]`}>
                            完成摘要
                          </span>
                          <input
                            className={`${WORKBENCH_FIELD_CLASS} h-9 px-3 ${TYPOGRAPHY_BODY_CLASS}`}
                            value={runSummary}
                            onChange={(event) => setRunSummary(event.target.value)}
                            placeholder="例如：已生成任务结果并写入会话"
                          />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#646A73]`}>
                            失败原因
                          </span>
                          <input
                            className={`${WORKBENCH_FIELD_CLASS} h-9 px-3 ${TYPOGRAPHY_BODY_CLASS}`}
                            value={failureReason}
                            onChange={(event) => setFailureReason(event.target.value)}
                            placeholder="可选，用于失败状态"
                          />
                        </label>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className={`${WORKBENCH_PRIMARY_BUTTON_CLASS} h-9 ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
                            onClick={startLatestRun}
                            disabled={isBusy || !canStartRun}
                          >
                            <Play className="h-4 w-4" strokeWidth={LUCIDE_NAV_STROKE_WIDTH} />
                            <span>启动 Run</span>
                          </button>
                          <button
                            type="button"
                            className={`${WORKBENCH_SECONDARY_BUTTON_CLASS} h-9 ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
                            onClick={completeLatestRun}
                            disabled={isBusy || !canCompleteRun}
                          >
                            <CheckCircle2
                              className="h-4 w-4"
                              strokeWidth={LUCIDE_NAV_STROKE_WIDTH}
                            />
                            <span>标记完成</span>
                          </button>
                          <button
                            type="button"
                            className={`${WORKBENCH_DANGER_BUTTON_CLASS} h-9 ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
                            onClick={failLatestRun}
                            disabled={isBusy || !canCompleteRun}
                          >
                            <AlertTriangle
                              className="h-4 w-4"
                              strokeWidth={LUCIDE_NAV_STROKE_WIDTH}
                            />
                            <span>标记失败</span>
                          </button>
                          <button
                            type="button"
                            className={`${WORKBENCH_DANGER_BUTTON_CLASS} h-9 ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
                            onClick={cancelLatestRun}
                            disabled={isBusy || !canCompleteRun}
                          >
                            <XCircle className="h-4 w-4" strokeWidth={LUCIDE_NAV_STROKE_WIDTH} />
                            <span>取消 Run</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  </section>

                  <aside className="space-y-4">
                    <div className="rounded-lg border border-[#DEE0E3] p-4">
                      <div className={`${TYPOGRAPHY_SECTION_TITLE_CLASS} text-[#1F2329]`}>
                        确认卡
                      </div>
                      <p className={`${TYPOGRAPHY_META_CLASS} mt-1 text-[#646A73]`}>
                        用于测试 `waiting_user` 状态和用户确认响应。
                      </p>
                      {pendingConfirmation ? (
                        <div className="mt-3 rounded-lg border border-[#FAD355]/45 bg-[#FFF8DB] p-3">
                          <div className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}>
                            {pendingConfirmation.title}
                          </div>
                          <div className={`${TYPOGRAPHY_META_CLASS} mt-1 text-[#646A73]`}>
                            {pendingConfirmation.confirmationId}
                          </div>
                          <div className="mt-3 flex gap-2">
                            <button
                              type="button"
                              className={`${WORKBENCH_PRIMARY_BUTTON_CLASS} h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                              onClick={() => respondConfirmation(pendingConfirmation, true)}
                              disabled={isBusy}
                            >
                              通过
                            </button>
                            <button
                              type="button"
                              className={`${WORKBENCH_DANGER_BUTTON_CLASS} h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                              onClick={() => respondConfirmation(pendingConfirmation, false)}
                              disabled={isBusy}
                            >
                              拒绝
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div
                          className={`${TYPOGRAPHY_BODY_CLASS} mt-3 rounded-lg bg-[#F8F9FA] p-3 text-[#646A73]`}
                        >
                          当前没有待响应确认卡。
                        </div>
                      )}
                      <div className="mt-3 flex gap-2">
                        <input
                          className={`${WORKBENCH_FIELD_CLASS} h-9 min-w-0 flex-1 px-3 ${TYPOGRAPHY_BODY_CLASS}`}
                          value={confirmationTitle}
                          onChange={(event) => setConfirmationTitle(event.target.value)}
                          placeholder="确认卡标题"
                        />
                        <button
                          type="button"
                          className={`${WORKBENCH_SECONDARY_BUTTON_CLASS} h-9 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                          onClick={requestConfirmation}
                          disabled={isBusy}
                        >
                          创建
                        </button>
                      </div>
                    </div>

                    <div className="rounded-lg border border-[#DEE0E3] p-4">
                      <div className={`${TYPOGRAPHY_SECTION_TITLE_CLASS} text-[#1F2329]`}>
                        事件流
                      </div>
                      <div className="mt-3 max-h-[420px] space-y-2 overflow-y-auto">
                        {detail?.events.length ? (
                          [...detail.events].reverse().map((event) => (
                            <div key={event.eventId} className="rounded-lg bg-[#F8F9FA] p-3">
                              <div className="flex items-center justify-between gap-2">
                                <span className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}>
                                  {event.eventType}
                                </span>
                                <span
                                  className={`${TYPOGRAPHY_META_CLASS} shrink-0 text-[#646A73]`}
                                >
                                  {formatDate(event.createdAt)}
                                </span>
                              </div>
                              {event.payload ? (
                                <pre
                                  className={`${TYPOGRAPHY_META_CLASS} mt-2 overflow-x-auto break-words whitespace-pre-wrap text-[#646A73]`}
                                >
                                  {compactJson(event.payload)}
                                </pre>
                              ) : null}
                            </div>
                          ))
                        ) : (
                          <div
                            className={`${TYPOGRAPHY_BODY_CLASS} rounded-lg bg-[#F8F9FA] p-3 text-[#646A73]`}
                          >
                            暂无事件。
                          </div>
                        )}
                      </div>
                    </div>
                  </aside>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
