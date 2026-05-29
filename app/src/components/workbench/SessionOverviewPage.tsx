"use client";

import React, { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Loader2,
  MessageCircle,
  Pin,
  Plus,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { AuthError, fetchSessionOverview } from "@/lib/api";
import { formatModelName } from "@/lib/models";
import { formatSessionActivityTime } from "@/lib/workbench";
import type { SessionOverview, SessionOverviewItem } from "@/types";

interface SessionOverviewPageProps {
  userId: string;
  refreshToken: number;
  onAuthExpired: (message: string) => void;
  onStartSession: (draft?: string) => void | Promise<void>;
  onSelectSession: (sessionId: string) => void | Promise<void>;
}

function pendingLabel(session: SessionOverviewItem): string | null {
  if (session.pendingKind === "approval") return "Pending approval";
  if (session.pendingKind === "question") return "Needs input";
  if (session.pendingKind === "connector_auth") return "Needs authorization";
  if (session.pendingKind === "schedule_request") return "Schedule review";
  if (session.status === "waiting_for_approval") return "Pending approval";
  if (session.status === "waiting_for_user") return "Needs input";
  return null;
}

function statusLabel(session: SessionOverviewItem): string {
  const pending = pendingLabel(session);
  if (pending) return pending;
  if (session.status === "running") return "Running";
  if (session.status === "queued") return "Queued";
  if (session.status === "compacting") return "Compacting";
  if (session.status === "failed") return "Failed";
  if (session.status === "cancelled") return "Cancelled";
  if (session.lastRun?.status === "completed") return "Completed";
  return "Idle";
}

function statusClass(session: SessionOverviewItem): string {
  if (pendingLabel(session)) return "border-[#bf8700]/25 bg-[#fff8c5] text-[#7d4e00]";
  if (["running", "queued", "compacting"].includes(session.status)) {
    return "border-[#0969da]/20 bg-[#ddf4ff] text-[#0969da]";
  }
  if (session.status === "failed") return "border-[#cf222e]/25 bg-[#ffebe9] text-[#cf222e]";
  return "border-[#d7dce3] bg-[#f7f8fa] text-[#374151]";
}

function SessionCard({
  session,
  onSelectSession,
}: {
  session: SessionOverviewItem;
  onSelectSession: (sessionId: string) => void | Promise<void>;
}) {
  const lastActivity = formatSessionActivityTime(session.lastActiveAt);
  const status = statusLabel(session);
  const title = session.title.trim() || "Untitled session";

  return (
    <button
      type="button"
      onClick={() => void onSelectSession(session.sessionId)}
      className="group flex min-h-[112px] w-full flex-col rounded-lg border border-[#dfe6f4] bg-white px-4 py-3 text-left shadow-[0_8px_22px_rgba(44,63,123,0.05)] transition hover:border-[#c8d6ff] hover:shadow-[0_12px_28px_rgba(44,63,123,0.08)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            {session.pinned ? <Pin size={13} className="shrink-0 text-[#8b8f94]" /> : null}
            <div className="truncate text-[14px] font-semibold text-[#111827]">{title}</div>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[#667085]">
            <span>{formatModelName(session.model)}</span>
            {lastActivity ? <span>{lastActivity}</span> : null}
            <span>{session.messageCount} messages</span>
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusClass(session)}`}
        >
          {status}
        </span>
      </div>

      <div className="mt-3 min-h-[36px] text-[12px] leading-5 text-[#4b5563]">
        {session.currentStep ? (
          <span>{session.currentStep}</span>
        ) : session.lastMessagePreview ? (
          <span>{session.lastMessagePreview}</span>
        ) : (
          <span className="text-[#8b8f94]">No activity yet</span>
        )}
      </div>

      {session.lastRun || session.planProgress ? (
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-3 text-[11px] text-[#7a8496]">
          {session.planProgress ? (
            <span className="inline-flex items-center gap-1">
              <CheckCircle2 size={12} />
              {session.planProgress.completed}/{session.planProgress.total}
            </span>
          ) : null}
          {session.lastRun ? (
            <span className="inline-flex items-center gap-1">
              <Clock3 size={12} />
              Run {session.lastRun.status}
            </span>
          ) : null}
        </div>
      ) : null}
    </button>
  );
}

function Section({
  title,
  icon,
  sessions,
  emptyLabel,
  onSelectSession,
}: {
  title: string;
  icon: React.ReactNode;
  sessions: SessionOverviewItem[];
  emptyLabel: string;
  onSelectSession: (sessionId: string) => void | Promise<void>;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-[#111827]">
          <span className="text-[#667085]">{icon}</span>
          {title}
        </div>
        <span className="text-[11px] font-medium text-[#7a8496]">{sessions.length}</span>
      </div>
      {sessions.length > 0 ? (
        <div className="grid gap-3 xl:grid-cols-2">
          {sessions.map((session) => (
            <SessionCard
              key={session.sessionId}
              session={session}
              onSelectSession={onSelectSession}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-[#dfe6f4] bg-white/72 px-4 py-6 text-center text-[13px] text-[#667085]">
          {emptyLabel}
        </div>
      )}
    </section>
  );
}

export default function SessionOverviewPage({
  userId,
  refreshToken,
  onAuthExpired,
  onStartSession,
  onSelectSession,
}: SessionOverviewPageProps) {
  const [overview, setOverview] = useState<SessionOverview | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const loadOverview = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      setOverview(await fetchSessionOverview());
    } catch (err) {
      if (err instanceof AuthError) {
        onAuthExpired("API key 已失效");
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to load sessions");
    } finally {
      setIsLoading(false);
    }
  }, [onAuthExpired]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview, refreshToken, userId]);

  const sessionsById = useMemo(() => {
    const map = new Map<string, SessionOverviewItem>();
    for (const session of overview?.sessions || []) {
      map.set(session.sessionId, session);
    }
    return map;
  }, [overview?.sessions]);

  const sectionSessions = useCallback(
    (ids: string[]) =>
      ids.map((id) => sessionsById.get(id)).filter(Boolean) as SessionOverviewItem[],
    [sessionsById]
  );

  const needsInput = sectionSessions(overview?.sections.needsInput || []);
  const running = sectionSessions(overview?.sections.running || []);
  const pinned = sectionSessions(overview?.sections.pinned || []);
  const recent = sectionSessions(overview?.sections.recentSessions || []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextDraft = draft.trim();
    setDraft("");
    await onStartSession(nextDraft || undefined);
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-[#fbfdff] px-5 pt-5 pb-[calc(88px+env(safe-area-inset-bottom))] text-[#111827] md:px-8 lg:pb-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[22px] leading-7 font-semibold tracking-normal">Sessions</h1>
          </div>
          <button
            type="button"
            onClick={() => void loadOverview()}
            disabled={isLoading}
            className="inline-flex h-9 items-center gap-2 rounded-full border border-[#dfe6f4] bg-white px-3 text-[13px] font-medium text-[#384152] shadow-[0_8px_18px_rgba(44,63,123,0.05)] hover:bg-[#f7f8fa] disabled:opacity-60"
          >
            {isLoading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            Refresh
          </button>
        </header>

        <form
          onSubmit={handleSubmit}
          className="rounded-lg border border-[#cfd9ee] bg-white p-2 shadow-[0_14px_36px_rgba(44,63,123,0.08)]"
        >
          <div className="flex items-end gap-2">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[#dfe6f4] bg-[#f6f8ff] text-[#2457e6]">
              <MessageCircle size={18} />
            </div>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={1}
              placeholder="Start a new Session..."
              className="min-h-10 flex-1 resize-none bg-transparent px-1 py-2 text-[15px] leading-5 text-[#111827] outline-none placeholder:text-[#9aa3af]"
            />
            <button
              type="submit"
              className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-[#2463eb] px-4 text-[13px] font-semibold text-white shadow-[0_10px_24px_rgba(36,99,235,0.20)] hover:bg-[#1d56d8]"
            >
              <Plus size={15} />
              New Session
            </button>
          </div>
        </form>

        {error ? (
          <div className="flex items-start gap-2 rounded-lg border border-[#cf222e]/25 bg-[#ffebe9] px-3 py-3 text-sm font-medium text-[#cf222e]">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        ) : null}

        {isLoading && !overview ? (
          <div className="flex h-56 items-center justify-center rounded-lg border border-[#dfe6f4] bg-white text-[13px] text-[#667085]">
            <Loader2 size={18} className="mr-2 animate-spin" />
            Loading sessions
          </div>
        ) : (
          <div className="space-y-7">
            <Section
              title="Needs input"
              icon={<ShieldAlert size={15} />}
              sessions={needsInput}
              emptyLabel="No sessions need input right now."
              onSelectSession={onSelectSession}
            />
            <Section
              title="Running"
              icon={<Loader2 size={15} />}
              sessions={running}
              emptyLabel="No sessions are running."
              onSelectSession={onSelectSession}
            />
            <Section
              title="Pinned"
              icon={<Pin size={15} />}
              sessions={pinned}
              emptyLabel="No pinned sessions."
              onSelectSession={onSelectSession}
            />
            <Section
              title="Recent sessions"
              icon={<Clock3 size={15} />}
              sessions={recent}
              emptyLabel="No sessions yet."
              onSelectSession={onSelectSession}
            />
          </div>
        )}
      </div>
    </div>
  );
}
