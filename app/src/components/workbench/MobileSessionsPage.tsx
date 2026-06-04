"use client";

import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  Ellipsis,
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
import {
  getMeasuredViewportMenuPosition,
  getResponsiveMenuBottomInsetPx,
  VIEWPORT_MENU_MARGIN_PX,
  type ViewportMenuAnchorRect,
} from "@/lib/menuPosition";
import type { WorkbenchSessionSummary } from "@/types";
import SessionAttentionDot from "./SessionAttentionDot";
import RippleIcon from "@/components/icons/RippleIcon";
import SwipeActionRow from "./SwipeActionRow";
import {
  listItemVariants,
  menuTransition,
  menuVariants,
  reducedMotionTransition,
  searchExpandVariants,
} from "./motionPrimitives";
import {
  MOBILE_GLASS_ICON_BUTTON_CLASS,
  MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS,
  MOBILE_PAGE_TOP_SAFE_AREA_CLASS,
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_META_MEDIUM_CLASS,
  TYPOGRAPHY_MICRO_CLASS,
  TYPOGRAPHY_MOBILE_BODY_CLASS,
  TYPOGRAPHY_PAGE_TITLE_CLASS,
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

const MOBILE_SESSION_MENU_WIDTH = 144;
const MOBILE_SESSION_MENU_HEIGHT = 132;
const mobileHeaderActionClass = MOBILE_GLASS_ICON_BUTTON_CLASS;

interface ActiveSessionMenu {
  sessionId: string;
  top: number;
  left: number;
  anchorRect: ViewportMenuAnchorRect;
  measuredHeight: number | null;
}

export function getMobileSessionMenuPosition(
  anchorRect: ViewportMenuAnchorRect,
  measuredMenuHeight?: number | null
): {
  top: number;
  left: number;
} {
  const position = getMeasuredViewportMenuPosition({
    anchorRect,
    menuWidth: MOBILE_SESSION_MENU_WIDTH,
    estimatedMenuHeight: MOBILE_SESSION_MENU_HEIGHT,
    measuredMenuHeight,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    bottomInset: getResponsiveMenuBottomInsetPx(),
    margin: VIEWPORT_MENU_MARGIN_PX,
    align: "right",
  });

  return { top: position.top, left: position.left };
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

  const [activeMenu, setActiveMenu] = useState<ActiveSessionMenu | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string>("");
  const isCancellingRef = React.useRef(false);
  const activeMenuRef = useRef<HTMLDivElement | null>(null);
  const activeMenuSessionId = activeMenu?.sessionId ?? null;

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

  useLayoutEffect(() => {
    if (!activeMenu) return;
    const menuNode = activeMenuRef.current;
    if (!menuNode) return;

    const measuredMenuHeight = Math.ceil(menuNode.getBoundingClientRect().height);
    if (!measuredMenuHeight || measuredMenuHeight === activeMenu.measuredHeight) return;

    const position = getMobileSessionMenuPosition(activeMenu.anchorRect, measuredMenuHeight);
    setActiveMenu((current) => {
      if (!current || current.sessionId !== activeMenu.sessionId) return current;
      if (
        current.measuredHeight === measuredMenuHeight &&
        current.top === position.top &&
        current.left === position.left
      ) {
        return current;
      }
      return {
        ...current,
        ...position,
        measuredHeight: measuredMenuHeight,
      };
    });
  }, [activeMenu]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#f2f2f7] text-[#111827] lg:hidden">
      {typeof document !== "undefined"
        ? createPortal(
            <AnimatePresence>
              {activeMenu && activeMenuSession ? (
                <>
                  <motion.div
                    key="mobile-session-menu-backdrop"
                    className="fixed inset-0 z-40 bg-transparent"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={shortTransition}
                    onClick={() => {
                      setActiveMenu(null);
                    }}
                  />
                  <motion.div
                    key="mobile-session-menu"
                    ref={activeMenuRef}
                    style={{ top: activeMenu.top, left: activeMenu.left, position: "fixed" }}
                    variants={menuVariants}
                    initial="hidden"
                    animate="visible"
                    exit="hidden"
                    transition={shortTransition}
                    className="z-50 max-h-[calc(100dvh-104px)] w-36 origin-top-right overflow-y-auto rounded-2xl border border-white/78 bg-white/90 p-1.5 shadow-[0_14px_34px_rgba(60,60,67,0.16)] backdrop-blur-2xl"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onUpdateSession(activeMenuSession.sessionId, {
                          pinned: !activeMenuSession.pinned,
                        });
                        setActiveMenu(null);
                      }}
                      className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left ${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#3c3c43] transition-colors hover:bg-[#f2f2f7] active:bg-[#eaf4ff]`}
                    >
                      <Pin size={13} className="shrink-0 text-[#6b7280]" />
                      {activeMenuSession.pinned ? t("sessions.unpin") : t("sessions.pin")}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingSessionId(activeMenuSession.sessionId);
                        setEditingTitle(activeMenuSession.title);
                        setActiveMenu(null);
                      }}
                      className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left ${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#3c3c43] transition-colors hover:bg-[#f2f2f7] active:bg-[#eaf4ff]`}
                    >
                      <Edit3 size={13} className="shrink-0 text-[#6b7280]" />
                      {t("sessions.rename")}
                    </button>
                    <div className="my-1 border-t border-[#e5e5ea]" />
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteSession(activeMenuSession.sessionId, e);
                        setActiveMenu(null);
                      }}
                      className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left ${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#cf222e] transition-colors hover:bg-[#ffebe9] active:bg-[#ffd5d6]`}
                    >
                      <Trash2 size={13} className="shrink-0 text-[#cf222e]" />
                      {t("sessions.delete")}
                    </button>
                  </motion.div>
                </>
              ) : null}
            </AnimatePresence>,
            document.body
          )
        : null}
      <header
        className={`shrink-0 border-b border-white/74 bg-white/76 px-4 ${MOBILE_PAGE_TOP_SAFE_AREA_CLASS} pb-2 shadow-[0_8px_24px_rgba(60,60,67,0.06)] backdrop-blur-2xl`}
      >
        <div className="flex h-10 items-center justify-between">
          <div className="flex items-center gap-2.5">
            <RippleIcon size={28} className="h-7 w-7 shrink-0 rounded-lg" />
            <span
              data-ripple-mobile-brand-wordmark="true"
              className={`inline-flex ${TYPOGRAPHY_PAGE_TITLE_CLASS} text-[#111827] drop-shadow-[0_1px_0_rgba(255,255,255,0.78)]`}
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
              <div className="flex h-10 items-center gap-2 rounded-full border border-white/76 bg-white/72 px-3 shadow-[0_8px_24px_rgba(60,60,67,0.06)] backdrop-blur-xl">
                <Search size={15} className="shrink-0 text-[#7a8496]" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("sessions.search")}
                  className="search-sessions-input min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-[15px] placeholder:text-[#9aa3af] focus:ring-0 focus:outline-none focus-visible:ring-0 focus-visible:outline-none"
                  autoFocus
                />
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </header>

      <main
        className={`min-h-0 flex-1 overflow-y-auto px-3 pt-2.5 ${MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS}`}
      >
        {sessionLoadError && !isLoading ? (
          <div className={`mt-2 flex items-start gap-2 rounded-xl border border-[#cf222e]/25 bg-[#ffebe9] p-3 ${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#cf222e]`}>
            <IconTile tone="danger" size="sm" className="mt-0.5">
              <AlertTriangle size={14} />
            </IconTile>
            <span className="min-w-0 break-words">{sessionLoadError}</span>
          </div>
        ) : null}

        {isLoading ? (
          <div className="flex h-40 items-center justify-center text-[#6b7280]">
            <Loader2 size={20} className="animate-spin" />
          </div>
        ) : visibleSessions.length === 0 ? (
          <div className="flex h-72 flex-col items-center justify-center px-8 text-center">
            <IconTile
              tone="accent"
              size="xl"
              className="mb-4 h-[60px] w-[60px] rounded-2xl shadow-[0_8px_24px_rgba(44,63,123,0.06)]"
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
                className={`mt-5 inline-flex h-10 items-center gap-2 rounded-full border border-[#cfe4ff] bg-[#eaf4ff]/86 px-4 ${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#007aff] shadow-[0_8px_22px_rgba(0,122,255,0.12)] backdrop-blur-xl hover:bg-[#dff0ff]`}
              >
                <MessageSquarePlus size={16} strokeWidth={2.1} />
                {t("sessions.newSession")}
              </button>
            ) : null}
          </div>
        ) : (
          <div className="space-y-1.5">
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
                      className="flex w-full items-center rounded-2xl border border-[#cfe4ff] bg-white/84 px-3 py-2.5 text-[#111827] shadow-[0_8px_24px_rgba(60,60,67,0.06)] backdrop-blur-xl"
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
                        className={`min-w-0 flex-1 bg-transparent py-0.5 ${TYPOGRAPHY_MOBILE_BODY_CLASS} font-medium text-[#0d0d0d] outline-none`}
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
                      className={isMenuActive ? "z-50 rounded-2xl" : "z-10 rounded-2xl"}
                    >
                      <div
                        className={`relative flex w-full items-center gap-2 rounded-2xl border bg-white/78 px-3 py-2.5 text-left shadow-[0_8px_24px_rgba(60,60,67,0.05)] backdrop-blur-xl transition-all ${
                          selected
                            ? "border-[#cfe4ff] bg-white/90"
                            : "border-white/78 active:bg-white/88"
                        }`}
                      >
                        {selected ? (
                          <span
                            aria-hidden="true"
                            className="absolute top-2 bottom-2 left-0 w-[3px] rounded-r-full bg-[#007aff]"
                          />
                        ) : null}
                        <button
                          type="button"
                          onClick={() => onSelectSession(session.sessionId)}
                          className="flex min-w-0 flex-1 items-center gap-2 py-0.5 pr-1 text-left outline-none"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center gap-2">
                              <span className={`truncate ${TYPOGRAPHY_MOBILE_BODY_CLASS} font-medium text-[#111827]`}>
                                {session.title}
                              </span>
                              {session.pinned ? (
                                <Pin size={12} className="shrink-0 text-[#6b7280]" />
                              ) : null}
                              <SessionAttentionDot attention={session.attention} reserveSpace />
                            </span>
                            <span className={`mt-0.5 block truncate ${TYPOGRAPHY_META_CLASS} text-[#667085]`}>
                              {sessionPreview(session, t)}
                            </span>
                          </span>
                          {activityTime ? (
                            <span className={`shrink-0 self-start pt-0.5 font-[family-name:var(--font-mono)] ${TYPOGRAPHY_MICRO_CLASS} text-[#8b95a5]`}>
                              {activityTime}
                            </span>
                          ) : null}
                        </button>

                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            const anchorRect = e.currentTarget.getBoundingClientRect();
                            setActiveMenu((current) => {
                              if (current?.sessionId === session.sessionId) return null;
                              const position = getMobileSessionMenuPosition(anchorRect);
                              return {
                                sessionId: session.sessionId,
                                ...position,
                                anchorRect,
                                measuredHeight: null,
                              };
                            });
                          }}
                          className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/62 bg-white/42 text-[#6e6e73] shadow-[0_4px_12px_rgba(60,60,67,0.05)] backdrop-blur-xl active:bg-[#eaf4ff]/78 ${
                            activeMenuSessionId === session.sessionId
                              ? "bg-[#eaf4ff]/78 text-[#111827]"
                              : ""
                          }`}
                          aria-label={t("sessions.options")}
                          title={t("sessions.options")}
                        >
                          <Ellipsis size={18} strokeWidth={2.2} />
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
