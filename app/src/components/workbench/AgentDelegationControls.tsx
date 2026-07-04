"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Check,
  CheckCircle2,
  Clock3,
  HelpCircle,
  Loader2,
  MessageSquareText,
  Send,
  UserPlus,
  X,
  XCircle,
} from "lucide-react";
import type { AgentDelegation, AgentDelegationCreateInput } from "@/types";
import {
  LUCIDE_STANDARD_STROKE_WIDTH,
  TYPOGRAPHY_BODY_CLASS,
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_META_MEDIUM_CLASS,
  WORKBENCH_DANGER_BUTTON_CLASS,
  WORKBENCH_FIELD_CLASS,
  WORKBENCH_FLOATING_SURFACE_CLASS,
  WORKBENCH_PRIMARY_BUTTON_CLASS,
  WORKBENCH_SECONDARY_BUTTON_CLASS,
  WORKBENCH_SECTION_CLASS,
  WORKBENCH_STATUS_DANGER_CLASS,
  WORKBENCH_STATUS_NEUTRAL_CLASS,
  WORKBENCH_STATUS_SUCCESS_CLASS,
  WORKBENCH_STATUS_WARNING_CLASS,
} from "./stylePrimitives";

export interface DelegationClarificationRequest {
  delegationId: string;
  targetUserId?: string | null;
  targetJobId?: string | null;
  question: string;
  reason?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export function controlRequestToDelegationClarification(
  request: Record<string, unknown> | null | undefined
): DelegationClarificationRequest | null {
  if (!isRecord(request)) return null;
  const type = stringField(request, "type");
  if (type !== "agent_delegation_clarification") return null;
  const delegationId = stringField(request, "delegation_id", "delegationId");
  const question = stringField(request, "question");
  if (!delegationId || !question) return null;
  return {
    delegationId,
    targetUserId: stringField(request, "target_user_id", "targetUserId"),
    targetJobId: stringField(request, "target_job_id", "targetJobId"),
    question,
    reason: stringField(request, "reason"),
  };
}

export function agentDelegationStatusLabel(status: string): string {
  switch (status) {
    case "pending_acceptance":
      return "等待对方授权";
    case "running":
      return "对方 agent 执行中";
    case "awaiting_target_permission":
      return "等待对方确认权限";
    case "awaiting_requester_info":
      return "需要补充信息";
    case "completed":
      return "已完成";
    case "failed":
      return "执行失败";
    case "cancelled":
      return "已取消";
    case "rejected":
      return "已拒绝";
    default:
      return status || "未知状态";
  }
}

function statusPillClass(status: string): string {
  if (status === "completed") return WORKBENCH_STATUS_SUCCESS_CLASS;
  if (status === "failed" || status === "cancelled" || status === "rejected") {
    return WORKBENCH_STATUS_DANGER_CLASS;
  }
  if (
    status === "pending_acceptance" ||
    status === "awaiting_target_permission" ||
    status === "awaiting_requester_info"
  ) {
    return WORKBENCH_STATUS_WARNING_CLASS;
  }
  return WORKBENCH_STATUS_NEUTRAL_CLASS;
}

function StatusIcon({ status }: { status: string }) {
  if (status === "completed") return <CheckCircle2 size={15} className="text-[#16845B]" />;
  if (status === "failed" || status === "cancelled" || status === "rejected") {
    return <XCircle size={15} className="text-[#B42318]" />;
  }
  if (status === "awaiting_requester_info") {
    return <HelpCircle size={15} className="text-[#8B5E00]" />;
  }
  if (status === "running") return <Loader2 size={15} className="animate-spin text-[#1456F0]" />;
  return <Clock3 size={15} className="text-[#8B5E00]" />;
}

function formatTime(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AgentDelegationStatusCard({
  delegation,
  compact = false,
}: {
  delegation: AgentDelegation;
  compact?: boolean;
}) {
  const updatedAt = formatTime(delegation.updatedAt);
  return (
    <article className={`${WORKBENCH_SECTION_CLASS} overflow-hidden`}>
      <div className="flex items-start gap-3 px-3 py-2.5">
        <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#F0F5FF] text-[#1456F0]">
          <Bot size={16} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className={`min-w-0 truncate ${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}>
              {delegation.taskTitle}
            </div>
            <span
              className={`inline-flex shrink-0 items-center gap-1 ${TYPOGRAPHY_META_MEDIUM_CLASS} ${statusPillClass(
                delegation.status
              )}`}
            >
              <StatusIcon status={delegation.status} />
              {agentDelegationStatusLabel(delegation.status)}
            </span>
          </div>
          {!compact && (
            <div className={`mt-1 line-clamp-2 ${TYPOGRAPHY_META_CLASS} text-[#646A73]`}>
              @{delegation.targetUserId} · {delegation.taskPrompt}
            </div>
          )}
          {delegation.status === "awaiting_requester_info" && delegation.pendingClarification && (
            <div className={`mt-2 rounded-lg bg-[#FFF8DB] px-2.5 py-2 ${TYPOGRAPHY_META_CLASS}`}>
              <span className="text-[#8B5E00]">对方 agent 提问：</span>
              <span className="ml-1 text-[#1F2329]">
                {String(delegation.pendingClarification.question || "")}
              </span>
            </div>
          )}
          {(delegation.reason || delegation.error || updatedAt) && (
            <div className={`mt-1.5 flex flex-wrap gap-x-2 gap-y-1 ${TYPOGRAPHY_META_CLASS}`}>
              {updatedAt && <span className="text-[#8F959E]">更新 {updatedAt}</span>}
              {delegation.reason && <span className="text-[#646A73]">{delegation.reason}</span>}
              {delegation.error && <span className="text-[#B42318]">{delegation.error}</span>}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

export function DelegatedSessionBanner({ delegation }: { delegation: AgentDelegation }) {
  return (
    <div
      className={`flex items-start gap-2 rounded-xl border border-[#BACEFD] bg-[#F0F5FF] p-3 ${TYPOGRAPHY_BODY_CLASS} text-[#1F2329]`}
    >
      <Bot size={16} className="mt-0.5 shrink-0 text-[#1456F0]" />
      <div className="min-w-0">
        <div className={TYPOGRAPHY_BODY_MEDIUM_CLASS}>
          来自 @{delegation.requesterUserId} 的任务
        </div>
        <div className={`mt-0.5 line-clamp-2 ${TYPOGRAPHY_META_CLASS} text-[#2B2F36]`}>
          {delegation.taskTitle} · {delegation.taskPrompt}
        </div>
      </div>
    </div>
  );
}

export function DelegationClarificationCard({
  request,
  pending,
  onAnswer,
}: {
  request: DelegationClarificationRequest;
  pending: boolean;
  onAnswer: (delegationId: string, answer: string) => Promise<void> | void;
}) {
  const [answer, setAnswer] = useState("");
  const canSend = answer.trim().length > 0 && !pending;
  return (
    <section className={`${WORKBENCH_SECTION_CLASS} overflow-hidden`}>
      <div className="flex items-start gap-3 px-3 py-3">
        <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#FFF8DB] text-[#8B5E00]">
          <MessageSquareText size={16} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
        </span>
        <div className="min-w-0 flex-1">
          <div className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}>
            对方 agent 需要补充信息
          </div>
          <div className={`mt-1 ${TYPOGRAPHY_BODY_CLASS} text-[#2B2F36]`}>{request.question}</div>
          {request.reason && (
            <div className={`mt-1 ${TYPOGRAPHY_META_CLASS} text-[#646A73]`}>
              原因：{request.reason}
            </div>
          )}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
            <textarea
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              rows={2}
              placeholder="补充说明，发送给对方 agent"
              className={`${WORKBENCH_FIELD_CLASS} min-h-16 flex-1 resize-none px-3 py-2 ${TYPOGRAPHY_BODY_CLASS}`}
            />
            <button
              type="button"
              disabled={!canSend}
              onClick={async () => {
                const nextAnswer = answer.trim();
                if (!nextAnswer) return;
                await onAnswer(request.delegationId, nextAnswer);
                setAnswer("");
              }}
              className={`h-9 shrink-0 ${WORKBENCH_PRIMARY_BUTTON_CLASS} ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
            >
              {pending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              发送给对方 agent
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

export function AgentDelegationCreateDialog({
  sourceSessionId,
  defaultTaskTitle,
  defaultTaskPrompt,
  pending,
  onClose,
  onSubmit,
}: {
  sourceSessionId: string;
  defaultTaskTitle?: string;
  defaultTaskPrompt?: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: AgentDelegationCreateInput) => Promise<void> | void;
}) {
  const [targetUserId, setTargetUserId] = useState("");
  const [taskTitle, setTaskTitle] = useState(defaultTaskTitle || "");
  const [taskPrompt, setTaskPrompt] = useState(defaultTaskPrompt || "");
  const canSubmit =
    Boolean(targetUserId.trim() && taskTitle.trim() && taskPrompt.trim()) && !pending;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="agent-delegation-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/20 px-3 py-3 sm:items-center"
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!canSubmit) return;
          await onSubmit({
            targetUserId: targetUserId.trim(),
            sourceSessionId,
            taskTitle: taskTitle.trim(),
            taskPrompt: taskPrompt.trim(),
          });
        }}
        className={`w-full max-w-lg ${WORKBENCH_FLOATING_SURFACE_CLASS} overflow-hidden`}
      >
        <div className="flex items-center justify-between border-b border-[#EFF0F1] px-4 py-3">
          <div className="min-w-0">
            <h2
              id="agent-delegation-title"
              className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}
            >
              委托给其他用户
            </h2>
            <div className={`${TYPOGRAPHY_META_CLASS} text-[#646A73]`}>
              对方授权后，会启动他的 agent session 执行一次任务。
            </div>
          </div>
          <button
            type="button"
            aria-label="关闭"
            title="关闭"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[#646A73] hover:bg-[#F5F6F7] hover:text-[#1F2329]"
          >
            <X size={16} />
          </button>
        </div>
        <div className="space-y-3 px-4 py-4">
          <label className="block">
            <span className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#2B2F36]`}>目标 user_id</span>
            <input
              value={targetUserId}
              onChange={(event) => setTargetUserId(event.target.value)}
              placeholder="例如 bob"
              className={`mt-1 h-9 w-full px-3 ${WORKBENCH_FIELD_CLASS} ${TYPOGRAPHY_BODY_CLASS}`}
            />
          </label>
          <label className="block">
            <span className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#2B2F36]`}>任务标题</span>
            <input
              value={taskTitle}
              onChange={(event) => setTaskTitle(event.target.value)}
              placeholder="例如 帮我检查发布说明"
              className={`mt-1 h-9 w-full px-3 ${WORKBENCH_FIELD_CLASS} ${TYPOGRAPHY_BODY_CLASS}`}
            />
          </label>
          <label className="block">
            <span className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#2B2F36]`}>任务内容</span>
            <textarea
              value={taskPrompt}
              onChange={(event) => setTaskPrompt(event.target.value)}
              rows={5}
              placeholder="明确告诉对方 agent 需要完成什么、可用上下文和交付结果。"
              className={`${WORKBENCH_FIELD_CLASS} mt-1 min-h-28 w-full resize-none px-3 py-2 ${TYPOGRAPHY_BODY_CLASS}`}
            />
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[#EFF0F1] px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className={`h-9 ${WORKBENCH_SECONDARY_BUTTON_CLASS} ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
          >
            取消
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className={`h-9 ${WORKBENCH_PRIMARY_BUTTON_CLASS} ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
          >
            {pending ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
            发起委托
          </button>
        </div>
      </form>
    </div>
  );
}

export function AgentDelegationRequestsButton({
  delegations,
  actionKey,
  onAccept,
  onReject,
}: {
  delegations: AgentDelegation[];
  actionKey?: string | null;
  onAccept?: (delegationId: string) => Promise<void> | void;
  onReject?: (delegationId: string) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pendingDelegations = useMemo(
    () => delegations.filter((delegation) => delegation.status === "pending_acceptance"),
    [delegations]
  );
  const activeDelegations = useMemo(
    () =>
      delegations.filter(
        (delegation) =>
          delegation.status === "pending_acceptance" ||
          delegation.status === "running" ||
          delegation.status === "awaiting_target_permission"
      ),
    [delegations]
  );
  const visibleDelegations =
    activeDelegations.length > 0 ? activeDelegations : delegations.slice(0, 4);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (delegations.length === 0) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-ripple-agent-delegation-requests
        aria-label="Agent 请求"
        title="Agent 请求"
        onClick={() => setOpen((value) => !value)}
        className={`relative inline-flex h-10 items-center gap-1.5 rounded-xl border border-[#DEE0E3] bg-white px-3 text-[#2B2F36] transition-colors hover:bg-[#F8F9FA] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
      >
        <Bot size={15} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
        <span className="hidden sm:inline">Agent 请求</span>
        {pendingDelegations.length > 0 && (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[#F53F3F] px-1.5 text-[11px] leading-5 text-white">
            {pendingDelegations.length}
          </span>
        )}
      </button>
      {open && (
        <div
          className={`absolute top-full right-0 z-40 mt-2 w-[min(360px,calc(100vw-24px))] ${WORKBENCH_FLOATING_SURFACE_CLASS}`}
        >
          <div className="border-b border-[#EFF0F1] px-3 py-2">
            <div className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}>Agent 请求</div>
            <div className={`${TYPOGRAPHY_META_CLASS} text-[#646A73]`}>
              授权后会在你的沙箱中启动对方委托的任务。
            </div>
          </div>
          <div className="max-h-[360px] overflow-y-auto p-2">
            {visibleDelegations.map((delegation) => {
              const isPending = delegation.status === "pending_acceptance";
              const accepting = actionKey === `accept:${delegation.delegationId}`;
              const rejecting = actionKey === `reject:${delegation.delegationId}`;
              return (
                <div
                  key={delegation.delegationId}
                  className="rounded-lg px-2 py-2 hover:bg-[#F8F9FA]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} truncate text-[#1F2329]`}>
                        {delegation.taskTitle}
                      </div>
                      <div className={`${TYPOGRAPHY_META_CLASS} mt-0.5 text-[#646A73]`}>
                        @{delegation.requesterUserId} ·{" "}
                        {agentDelegationStatusLabel(delegation.status)}
                      </div>
                    </div>
                    <span
                      className={`shrink-0 ${TYPOGRAPHY_META_MEDIUM_CLASS} ${statusPillClass(
                        delegation.status
                      )}`}
                    >
                      {agentDelegationStatusLabel(delegation.status)}
                    </span>
                  </div>
                  <div className={`mt-1 line-clamp-2 ${TYPOGRAPHY_META_CLASS} text-[#2B2F36]`}>
                    {delegation.taskPrompt}
                  </div>
                  {isPending && (
                    <div className="mt-2 flex justify-end gap-2">
                      <button
                        type="button"
                        disabled={Boolean(actionKey)}
                        onClick={() => onReject?.(delegation.delegationId)}
                        className={`h-8 ${WORKBENCH_DANGER_BUTTON_CLASS} ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                      >
                        {rejecting ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <X size={13} />
                        )}
                        拒绝
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(actionKey)}
                        onClick={() => onAccept?.(delegation.delegationId)}
                        className={`h-8 ${WORKBENCH_PRIMARY_BUTTON_CLASS} ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                      >
                        {accepting ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <Check size={13} />
                        )}
                        授权执行
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function AgentDelegationComposerButton({
  disabled,
  onClick,
}: {
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label="委托给其他用户"
      title={disabled ? "需要先打开一个 session" : "委托给其他用户"}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-transparent text-[#646A73] transition-colors hover:bg-[#F5F6F7] hover:text-[#1F2329] active:bg-[#EFF0F1] disabled:cursor-not-allowed disabled:opacity-40 lg:h-7 lg:w-7 lg:rounded-md`}
    >
      <UserPlus size={16} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
    </button>
  );
}
