"use client";

import React from "react";
import {
  AlertTriangle,
  ChevronLeft,
  Edit3,
  Loader2,
  MoreHorizontal,
  Pin,
  Plus,
  Trash2,
} from "lucide-react";
import { useI18n } from "@/i18n";
import { formatSessionActivityTime } from "@/lib/workbench";
import type { WorkbenchSessionSummary } from "@/types";
import SessionAttentionDot from "./SessionAttentionDot";
import {
  TYPOGRAPHY_BODY_CLASS,
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_MEDIUM_CLASS,
  TYPOGRAPHY_MICRO_CLASS,
} from "./stylePrimitives";

interface WorkspaceNavProps {
  sessions: WorkbenchSessionSummary[];
  selectedSessionId: string | null;
  isLoading: boolean;
  sessionLoadError?: string | null;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string, event: React.MouseEvent) => void;
  onUpdateSession: (
    sessionId: string,
    updates: { title?: string; pinned?: boolean }
  ) => Promise<unknown>;
  onCollapse?: () => void;
}

export default function WorkspaceNav({
  sessions,
  selectedSessionId,
  isLoading,
  sessionLoadError,
  onNewSession,
  onSelectSession,
  onDeleteSession,
  onUpdateSession,
  onCollapse,
}: WorkspaceNavProps) {
  const { locale, t } = useI18n();
  const [activeMenuSessionId, setActiveMenuSessionId] = React.useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = React.useState<string | null>(null);
  const [editingTitle, setEditingTitle] = React.useState<string>("");
  const isCancellingRef = React.useRef(false);
  const activeMenuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!activeMenuSessionId) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (activeMenuRef.current && !activeMenuRef.current.contains(event.target as Node)) {
        setActiveMenuSessionId(null);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [activeMenuSessionId]);

  return (
    <aside
      data-ripple-session-rail="true"
      className="flex h-full min-h-0 flex-col border-r border-[#DEE0E3]/80 bg-[#F5F6F7]/90 text-[#1F2329] shadow-[8px_0_22px_rgba(31,35,41,0.04)] backdrop-blur-2xl"
    >
      <div className="border-b border-[#DEE0E3]/70 px-3.5 py-3">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className={`truncate ${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}>
              {t("sessions.railTitle")}
            </h2>
            <p className={`mt-0.5 ${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#646A73]`}>
              {t("sessions.railSubtitle")}
            </p>
          </div>
          {isLoading ? <Loader2 size={14} className="animate-spin text-[#646A73]" /> : null}
          {onCollapse ? (
            <button
              type="button"
              onClick={onCollapse}
              aria-label={t("sessions.collapseList")}
              title={t("sessions.collapseList")}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#DEE0E3] bg-white/82 text-[#646A73] shadow-[0_6px_18px_rgba(31,35,41,0.05)] backdrop-blur-xl transition-colors hover:bg-white hover:text-[#1F2329]"
            >
              <ChevronLeft size={15} />
            </button>
          ) : null}
        </div>

        <button
          type="button"
          onClick={onNewSession}
          className={`grid h-8 w-full place-items-center rounded-full bg-[#1456F0] px-3 text-center ${TYPOGRAPHY_META_MEDIUM_CLASS} text-white shadow-[0_10px_22px_rgba(20,86,240,0.22)] transition-all duration-200 hover:bg-[#0F4BD8] active:scale-[0.98]`}
        >
          <span
            data-ripple-session-new-button-label="true"
            className="inline-flex min-w-0 items-center justify-center gap-1.5 leading-none"
          >
            <Plus size={14} className="shrink-0" />
            <span className="leading-none">{t("sessions.newSession")}</span>
          </span>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
        {sessionLoadError && !isLoading ? (
          <div
            className={`flex items-start gap-2 rounded-lg border border-[#B42318]/25 bg-[#FFF1F0] px-3 py-3 ${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#B42318]`}
          >
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{sessionLoadError}</span>
          </div>
        ) : sessions.length === 0 && !isLoading ? (
          <div
            className={`rounded-lg border border-dashed border-[#EFF0F1] bg-white px-3 py-5 text-center ${TYPOGRAPHY_BODY_CLASS} text-[#646A73]`}
          >
            {t("sessions.empty")}
          </div>
        ) : (
          <div className="space-y-1">
            {sessions.map((session) => {
              const selected = session.sessionId === selectedSessionId;
              const activityTime = formatSessionActivityTime(
                session.lastActivityAt,
                new Date(),
                locale,
                t("common.yesterday")
              );
              const isEditing = editingSessionId === session.sessionId;
              const isMenuOpen = activeMenuSessionId === session.sessionId;

              if (isEditing) {
                const handleSave = () => {
                  if (isCancellingRef.current) {
                    isCancellingRef.current = false;
                    return;
                  }
                  const trimmed = editingTitle.trim();
                  if (trimmed && trimmed !== session.title) {
                    void onUpdateSession(session.sessionId, { title: trimmed });
                  }
                  setEditingSessionId(null);
                };

                return (
                  <div
                    key={session.sessionId}
                    className="flex items-center gap-2 rounded-xl border border-[#1456F0] bg-white px-2.5 py-1.5 text-[#1F2329] shadow-[0_6px_16px_rgba(31,35,41,0.06)]"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <SessionAttentionDot attention={session.attention} reserveSpace />
                    <input
                      type="text"
                      value={editingTitle}
                      onChange={(event) => setEditingTitle(event.target.value)}
                      onBlur={handleSave}
                      onFocus={(event) => event.target.select()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          handleSave();
                        } else if (event.key === "Escape") {
                          isCancellingRef.current = true;
                          setEditingSessionId(null);
                        }
                      }}
                      className={`min-w-0 flex-1 bg-transparent py-0.5 ${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329] outline-none`}
                      autoFocus
                      maxLength={120}
                    />
                  </div>
                );
              }

              return (
                <div
                  key={session.sessionId}
                  ref={isMenuOpen ? activeMenuRef : undefined}
                  className={`group relative flex items-center gap-2 rounded-xl border px-2.5 py-1.5 transition-all ${
                    selected
                      ? "border-[#BACEFD] bg-white text-[#1456F0] shadow-[0_6px_16px_rgba(31,35,41,0.06)]"
                      : "border-transparent text-[#2B2F36] hover:bg-white/76 hover:text-[#1F2329]"
                  }`}
                >
                  <SessionAttentionDot attention={session.attention} reserveSpace />
                  <button
                    type="button"
                    onClick={() => onSelectSession(session.sessionId)}
                    className={`grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-0.5 text-left ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
                  >
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      {session.pinned ? (
                        <Pin size={11} className="shrink-0 text-[#8F959E]" />
                      ) : null}
                      <span className="truncate">{session.title}</span>
                    </span>
                    {activityTime && (
                      <span
                        className={`font-[family-name:var(--font-mono)] ${TYPOGRAPHY_MICRO_CLASS} ${
                          selected ? "text-[#1456F0]/75" : "text-[#8F959E]"
                        }`}
                      >
                        {activityTime}
                      </span>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setActiveMenuSessionId(
                        activeMenuSessionId === session.sessionId ? null : session.sessionId
                      );
                    }}
                    className={`h-6 w-6 shrink-0 items-center justify-center rounded-lg border transition-all ${
                      activeMenuSessionId === session.sessionId
                        ? "z-50 flex border-[#DEE0E3] bg-white text-[#1F2329] shadow-[0_2px_8px_rgba(31,35,41,0.06)]"
                        : "hidden border-transparent text-[#8F959E] group-hover:flex hover:border-[#DEE0E3] hover:bg-white hover:text-[#1F2329] active:scale-[0.92]"
                    }`}
                    aria-label={t("sessions.options")}
                    title={t("sessions.options")}
                  >
                    <MoreHorizontal size={14} />
                  </button>

                  {activeMenuSessionId === session.sessionId && (
                    <div className="animate-in fade-in-50 zoom-in-95 absolute top-9 right-2 z-50 w-36 rounded-2xl border border-[#DEE0E3] bg-white/92 p-1.5 shadow-[0_12px_36px_-4px_rgba(31,35,41,0.16),0_4px_16px_-2px_rgba(31,35,41,0.08)] backdrop-blur-2xl duration-100">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void onUpdateSession(session.sessionId, { pinned: !session.pinned });
                          setActiveMenuSessionId(null);
                        }}
                        className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left ${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#2B2F36] transition-all hover:bg-[#F5F6F7] active:bg-[#F0F5FF]`}
                      >
                        <Pin size={13} className="shrink-0 text-[#646A73]" />
                        {session.pinned ? t("sessions.unpin") : t("sessions.pin")}
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setEditingSessionId(session.sessionId);
                          setEditingTitle(session.title);
                          setActiveMenuSessionId(null);
                        }}
                        className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left ${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#2B2F36] transition-all hover:bg-[#F5F6F7] active:bg-[#F0F5FF]`}
                      >
                        <Edit3 size={13} className="shrink-0 text-[#646A73]" />
                        {t("sessions.rename")}
                      </button>
                      <div className="my-1 border-t border-[#EFF0F1]" />
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onDeleteSession(session.sessionId, event);
                          setActiveMenuSessionId(null);
                        }}
                        className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left ${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#B42318] transition-colors hover:bg-[#FFF1F0] active:bg-[#FFE3E0]`}
                      >
                        <Trash2 size={13} className="shrink-0 text-[#B42318]" />
                        {t("sessions.delete")}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
