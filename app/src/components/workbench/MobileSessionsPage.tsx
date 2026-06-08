"use client";

import React, { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  Loader2,
  MessageCircle,
  MessageCircleMore,
  MessageSquarePlus,
  Pin,
  Search,
  Edit3,
  Trash2,
} from "lucide-react";
import { IconTile } from "@/components/icons/IconTile";
import { type MessageKey, useI18n } from "@/i18n";
import { formatSessionActivityTime } from "@/lib/workbench";
import type { WorkbenchSessionSummary } from "@/types";
import SessionAttentionDot from "./SessionAttentionDot";
import RippleIcon from "@/components/icons/RippleIcon";
import SwipeActionRow from "./SwipeActionRow";
import MobileActionSheet from "./MobileActionSheet";
import {
  listItemVariants,
  menuTransition,
  reducedMotionTransition,
  searchExpandVariants,
} from "./motionPrimitives";
import {
  MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS,
  MOBILE_PAGE_TOP_SAFE_AREA_CLASS,
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_META_MEDIUM_CLASS,
  TYPOGRAPHY_MICRO_CLASS,
  TYPOGRAPHY_MOBILE_BODY_CLASS,
  TYPOGRAPHY_PAGE_TITLE_CLASS,
  WORKBENCH_FIELD_CLASS,
  WORKBENCH_MOBILE_ICON_BUTTON_CLASS,
  WORKBENCH_PAGE_BACKGROUND_CLASS,
  WORKBENCH_TOP_BAR_CLASS,
} from "./stylePrimitives";

interface MobileSessionsPageProps {
  sessions: WorkbenchSessionSummary[];
  isLoading: boolean;
  sessionLoadError?: string | null;
  selectedSessionId: string | null;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string, event: React.MouseEvent) => void;
  onUpdateSession: (
    sessionId: string,
    updates: { title?: string; pinned?: boolean }
  ) => Promise<unknown>;
}

function sessionPreview(
  session: WorkbenchSessionSummary,
  t: (
    key: MessageKey,
    values?: Record<string, string | number | boolean | null | undefined>
  ) => string
): string {
  const parts = [
    t("sessions.messageUnit", {
      count: session.messageCount,
      label: session.messageCount === 1 ? "message" : "messages",
    }),
  ];
  if (session.changedFileCount > 0) {
    parts.push(
      t("sessions.fileUnit", {
        count: session.changedFileCount,
        label: session.changedFileCount === 1 ? "file" : "files",
      })
    );
  }
  if (session.pendingApprovalCount > 0) {
    parts.push(
      t("sessions.approvalUnit", {
        count: session.pendingApprovalCount,
        label: session.pendingApprovalCount === 1 ? "approval" : "approvals",
      })
    );
  }
  return parts.join(" · ");
}

const mobileHeaderActionClass = WORKBENCH_MOBILE_ICON_BUTTON_CLASS;
const SESSION_OPTIONS_LONG_PRESS_MS = 420;
const SESSION_OPTIONS_LONG_PRESS_MOVE_TOLERANCE_PX = 10;

interface SessionLongPressState {
  sessionId: string;
  startX: number;
  startY: number;
}

export default function MobileSessionsPage({
  sessions,
  isLoading,
  sessionLoadError,
  selectedSessionId,
  onNewSession,
  onSelectSession,
  onDeleteSession,
  onUpdateSession,
}: MobileSessionsPageProps) {
  const { locale, t } = useI18n();
  const reduceMotion = useReducedMotion();
  const shortTransition = reduceMotion ? reducedMotionTransition : menuTransition;
  const [isSearching, setIsSearching] = useState(false);
  const [query, setQuery] = useState("");

  const [activeMenuSessionId, setActiveMenuSessionId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string>("");
  const isCancellingRef = React.useRef(false);
  const longPressTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStateRef = React.useRef<SessionLongPressState | null>(null);
  const longPressedSessionIdRef = React.useRef<string | null>(null);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleSessions = useMemo(
    () =>
      normalizedQuery
        ? sessions.filter((session) => session.title.toLowerCase().includes(normalizedQuery))
        : sessions,
    [normalizedQuery, sessions]
  );
  const activeMenuSession = useMemo(() => {
    if (!activeMenuSessionId) return null;
    return visibleSessions.find((session) => session.sessionId === activeMenuSessionId) ?? null;
  }, [activeMenuSessionId, visibleSessions]);

  const clearSessionLongPress = React.useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressStateRef.current = null;
  }, []);

  React.useEffect(() => () => clearSessionLongPress(), [clearSessionLongPress]);

  const closeSessionOptions = () => {
    clearSessionLongPress();
    longPressedSessionIdRef.current = null;
    setActiveMenuSessionId(null);
  };

  const handleSessionLongPressStart = (
    sessionId: string,
    event: React.PointerEvent<HTMLButtonElement>
  ) => {
    if (!event.isPrimary || event.pointerType === "mouse") return;

    clearSessionLongPress();
    longPressStateRef.current = {
      sessionId,
      startX: event.clientX,
      startY: event.clientY,
    };
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      longPressStateRef.current = null;
      longPressedSessionIdRef.current = sessionId;
      setActiveMenuSessionId(sessionId);
    }, SESSION_OPTIONS_LONG_PRESS_MS);
  };

  const handleSessionLongPressMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const state = longPressStateRef.current;
    if (!state) return;

    const deltaX = Math.abs(event.clientX - state.startX);
    const deltaY = Math.abs(event.clientY - state.startY);
    if (
      deltaX > SESSION_OPTIONS_LONG_PRESS_MOVE_TOLERANCE_PX ||
      deltaY > SESSION_OPTIONS_LONG_PRESS_MOVE_TOLERANCE_PX
    ) {
      clearSessionLongPress();
    }
  };

  return (
    <div
      className={`flex h-full min-h-0 flex-col ${WORKBENCH_PAGE_BACKGROUND_CLASS} text-[#1F2329] lg:hidden`}
    >
      <MobileActionSheet
        open={Boolean(activeMenuSession)}
        data-ripple-mobile-session-actions-sheet
        title={activeMenuSession?.title ?? t("sessions.options")}
        subtitle={activeMenuSession ? sessionPreview(activeMenuSession, t) : undefined}
        closeLabel={t("sessions.cancel")}
        onClose={closeSessionOptions}
        actions={
          activeMenuSession
            ? [
                {
                  key: "pin",
                  label: activeMenuSession.pinned ? t("sessions.unpin") : t("sessions.pin"),
                  icon: <Pin size={16} />,
                  tone: "accent",
                  onClick: () => {
                    void onUpdateSession(activeMenuSession.sessionId, {
                      pinned: !activeMenuSession.pinned,
                    });
                    closeSessionOptions();
                  },
                },
                {
                  key: "rename",
                  label: t("sessions.rename"),
                  icon: <Edit3 size={16} />,
                  onClick: () => {
                    setEditingSessionId(activeMenuSession.sessionId);
                    setEditingTitle(activeMenuSession.title);
                    closeSessionOptions();
                  },
                },
                {
                  key: "delete",
                  label: t("sessions.delete"),
                  icon: <Trash2 size={16} />,
                  tone: "danger",
                  onClick: (event) => {
                    onDeleteSession(activeMenuSession.sessionId, event);
                    closeSessionOptions();
                  },
                },
              ]
            : []
        }
      />
      <header
        className={`shrink-0 px-4 ${MOBILE_PAGE_TOP_SAFE_AREA_CLASS} pb-2 ${WORKBENCH_TOP_BAR_CLASS}`}
      >
        <div className="flex h-10 items-center justify-between">
          <div className="flex items-center gap-2.5">
            <RippleIcon size={28} className="h-7 w-7 shrink-0 rounded-lg" />
            <span
              data-ripple-mobile-brand-wordmark="true"
              className={`inline-flex ${TYPOGRAPHY_PAGE_TITLE_CLASS} text-[#1F2329] drop-shadow-[0_1px_0_rgba(255,255,255,0.78)]`}
            >
              Ripple
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label={t("sessions.search")}
              title={t("sessions.search")}
              onClick={() => setIsSearching((open) => !open)}
              className={mobileHeaderActionClass}
            >
              <Search size={18} strokeWidth={2.2} />
            </button>
            <button
              type="button"
              aria-label={t("sessions.newSession")}
              title={t("sessions.newSession")}
              onClick={onNewSession}
              className={mobileHeaderActionClass}
            >
              <MessageCircleMore size={18} strokeWidth={2.2} />
            </button>
          </div>
        </div>
        <AnimatePresence initial={false}>
          {isSearching ? (
            <motion.div
              data-ripple-mobile-search-motion
              variants={searchExpandVariants}
              initial="collapsed"
              animate="expanded"
              exit="collapsed"
              transition={shortTransition}
              className="overflow-hidden"
            >
              <div className={`${WORKBENCH_FIELD_CLASS} flex h-10 items-center gap-2 px-3`}>
                <Search size={15} className="shrink-0 text-[#646A73]" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("sessions.search")}
                  className="search-sessions-input min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-[15px] placeholder:text-[#9aa3af] focus:ring-0 focus:outline-none focus-visible:ring-0 focus-visible:outline-none"
                  autoFocus
                />
                <button
                  type="button"
                  data-ripple-mobile-search-cancel
                  onClick={() => {
                    setQuery("");
                    setIsSearching(false);
                  }}
                  className={`${TYPOGRAPHY_META_MEDIUM_CLASS} shrink-0 text-[#1456F0]`}
                >
                  {t("sessions.cancel")}
                </button>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </header>

      <main
        className={`min-h-0 flex-1 overflow-y-auto px-3 pt-2.5 ${MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS}`}
      >
        {sessionLoadError && !isLoading ? (
          <div
            className={`mt-2 flex items-start gap-2 rounded-xl border border-[#B42318]/25 bg-[#FFF1F0] p-3 ${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#B42318]`}
          >
            <IconTile tone="danger" size="sm" className="mt-0.5">
              <AlertTriangle size={14} />
            </IconTile>
            <span className="min-w-0 break-words">{sessionLoadError}</span>
          </div>
        ) : null}

        {isLoading ? (
          <div className="flex h-40 items-center justify-center text-[#646A73]">
            <Loader2 size={20} className="animate-spin" />
          </div>
        ) : visibleSessions.length === 0 ? (
          <div className="flex h-72 flex-col items-center justify-center px-8 text-center">
            <IconTile
              tone="accent"
              size="xl"
              className="mb-4 h-[60px] w-[60px] rounded-2xl shadow-[0_8px_24px_rgba(31,35,41,0.06)]"
            >
              <MessageCircle size={28} />
            </IconTile>
            <div className={`${TYPOGRAPHY_MOBILE_BODY_CLASS} font-medium`}>
              {normalizedQuery ? t("sessions.noMatching") : t("sessions.empty")}
            </div>
            <p className={`mt-2 ${TYPOGRAPHY_META_CLASS} text-[#687386]`}>
              {normalizedQuery ? t("sessions.tryAnotherKeyword") : t("sessions.emptyDescription")}
            </p>
            {!normalizedQuery ? (
              <button
                type="button"
                onClick={onNewSession}
                className={`mt-5 inline-flex h-10 items-center gap-2 rounded-lg border border-[#BACEFD] bg-[#F0F5FF] px-4 ${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1456F0] transition-colors hover:bg-[#E8F0FF]`}
              >
                <MessageSquarePlus size={16} strokeWidth={2.1} />
                {t("sessions.newSession")}
              </button>
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">
            <AnimatePresence initial={false}>
              {visibleSessions.map((session, sessionIndex) => {
                const selected = session.sessionId === selectedSessionId;
                const activityTime = formatSessionActivityTime(
                  session.lastActivityAt,
                  new Date(),
                  locale,
                  t("common.yesterday")
                );
                const isEditing = editingSessionId === session.sessionId;
                const isMenuActive = activeMenuSessionId === session.sessionId;

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
                    <motion.div
                      key={session.sessionId}
                      custom={sessionIndex}
                      variants={listItemVariants}
                      initial="hidden"
                      animate="visible"
                      exit="hidden"
                      transition={shortTransition}
                      className="flex w-full items-center rounded-xl border border-[#BACEFD] bg-white px-3 py-2.5 text-[#1F2329] shadow-[0_1px_2px_rgba(31,35,41,0.04)]"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="text"
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onBlur={handleSave}
                        onFocus={(e) => e.target.select()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            handleSave();
                          } else if (e.key === "Escape") {
                            isCancellingRef.current = true;
                            setEditingSessionId(null);
                          }
                        }}
                        className={`min-w-0 flex-1 bg-transparent py-0.5 ${TYPOGRAPHY_MOBILE_BODY_CLASS} font-medium text-[#1F2329] outline-none`}
                        autoFocus
                        maxLength={120}
                      />
                    </motion.div>
                  );
                }

                return (
                  <motion.div
                    key={session.sessionId}
                    custom={sessionIndex}
                    variants={listItemVariants}
                    initial="hidden"
                    animate="visible"
                    exit="hidden"
                    transition={shortTransition}
                  >
                    <SwipeActionRow
                      data-ripple-mobile-session-swipe
                      leadingActions={[
                        {
                          key: "pin",
                          label: session.pinned ? t("sessions.unpin") : t("sessions.pin"),
                          icon: <Pin size={14} />,
                          tone: "accent",
                          onClick: () => {
                            void onUpdateSession(session.sessionId, {
                              pinned: !session.pinned,
                            });
                          },
                        },
                      ]}
                      trailingActions={[
                        {
                          key: "rename",
                          label: t("sessions.rename"),
                          icon: <Edit3 size={14} />,
                          tone: "neutral",
                          onClick: () => {
                            setEditingSessionId(session.sessionId);
                            setEditingTitle(session.title);
                          },
                        },
                        {
                          key: "delete",
                          label: t("sessions.delete"),
                          icon: <Trash2 size={14} />,
                          tone: "danger",
                          onClick: (event) => {
                            onDeleteSession(session.sessionId, event);
                          },
                        },
                      ]}
                      className={isMenuActive ? "z-50 rounded-lg" : "z-10 rounded-lg"}
                    >
                      <div
                        data-ripple-mobile-session-row="true"
                        data-ripple-mobile-session-row-selected={selected ? "true" : "false"}
                        className={`relative flex w-full items-center gap-2 rounded-lg border px-3 py-3 text-left transition-colors ${
                          selected
                            ? "border-[#9DBBFF] bg-[#F0F5FF] shadow-[0_2px_8px_rgba(20,86,240,0.06)]"
                            : "border-[#D8DEE8] bg-white shadow-[0_2px_8px_rgba(31,35,41,0.05)] active:bg-[#F8F9FA]"
                        }`}
                      >
                        {selected ? (
                          <span
                            aria-hidden="true"
                            className="absolute top-2 bottom-2 left-0 w-[3px] rounded-r-full bg-[#1456F0]"
                          />
                        ) : null}
                        <button
                          type="button"
                          onClick={(event) => {
                            if (longPressedSessionIdRef.current === session.sessionId) {
                              event.preventDefault();
                              event.stopPropagation();
                              longPressedSessionIdRef.current = null;
                              return;
                            }
                            onSelectSession(session.sessionId);
                          }}
                          onPointerDown={(event) =>
                            handleSessionLongPressStart(session.sessionId, event)
                          }
                          onPointerMove={handleSessionLongPressMove}
                          onPointerUp={clearSessionLongPress}
                          onPointerCancel={clearSessionLongPress}
                          onPointerLeave={clearSessionLongPress}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            clearSessionLongPress();
                            longPressedSessionIdRef.current = session.sessionId;
                            setActiveMenuSessionId(session.sessionId);
                          }}
                          className="flex min-w-0 flex-1 items-center gap-2 py-0.5 pr-1 text-left outline-none"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center gap-2">
                              <span
                                className={`truncate ${TYPOGRAPHY_MOBILE_BODY_CLASS} font-medium text-[#1F2329]`}
                              >
                                {session.title}
                              </span>
                              {session.pinned ? (
                                <Pin size={12} className="shrink-0 text-[#646A73]" />
                              ) : null}
                              <SessionAttentionDot attention={session.attention} reserveSpace />
                            </span>
                            <span
                              className={`mt-0.5 block truncate ${TYPOGRAPHY_META_CLASS} text-[#646A73]`}
                            >
                              {sessionPreview(session, t)}
                            </span>
                          </span>
                          {activityTime ? (
                            <span
                              className={`shrink-0 self-start pt-0.5 font-[family-name:var(--font-mono)] ${TYPOGRAPHY_MICRO_CLASS} text-[#8F959E]`}
                            >
                              {activityTime}
                            </span>
                          ) : null}
                        </button>
                      </div>
                    </SwipeActionRow>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </main>
    </div>
  );
}
