"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  CalendarPlus,
  ChevronDown,
  ChevronRight,
  Download,
  Edit3,
  Eye,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { IconTile } from "@/components/icons/IconTile";
import { useI18n } from "@/i18n";
import {
  AuthError,
  deleteSchedule,
  deleteScheduleRun,
  downloadRunOutput,
  fetchSchedules,
  fetchScheduleRuns,
  fetchRunOutputText,
  runScheduleNow,
  updateSchedule,
} from "@/lib/api";
import { formatModelName } from "@/lib/models";
import { saveBlobAsDownload } from "@/lib/platform";
import type { AgentRunInfo, ScheduleInfo, ScheduleKind } from "@/types";
import {
  LUCIDE_NAV_STROKE_WIDTH,
  MOBILE_DETAIL_HEADER_TITLE_CLASS,
  MOBILE_DETAIL_PAGE_HEADER_CLASS,
  MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS,
  MOBILE_PAGE_TOP_SAFE_AREA_CLASS,
  TYPOGRAPHY_BODY_CLASS,
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_META_MEDIUM_CLASS,
  TYPOGRAPHY_MICRO_MEDIUM_CLASS,
  TYPOGRAPHY_PAGE_TITLE_CLASS,
  WORKBENCH_FIELD_CLASS,
  WORKBENCH_MOBILE_ICON_BUTTON_CLASS,
  WORKBENCH_PAGE_BACKGROUND_CLASS,
  WORKBENCH_PAGE_CONTENT_CLASS,
  WORKBENCH_SECTION_CLASS,
} from "./stylePrimitives";
import {
  mobilePageSwitchTransition,
  mobilePageVariants,
  mobileStackCommitTransition,
  mobileStackReturnTransition,
  mobileSwipeBackConfig,
  reducedMobilePageVariants,
  reducedMotionTransition,
  resolveMobileSwipeBackRelease,
  shouldCancelMobileSwipeBack,
  shouldClaimMobileSwipeBack,
  shouldGuardMobileSwipeBackScroll,
  shouldReleaseMobileSwipeBackScrollGuard,
} from "./motionPrimitives";
import {
  currentMobileSwipeBackTimeMs,
  ensureMobileSwipeBackScrollLock,
  isInteractiveMobileSwipeBackTarget,
  mobileSwipeBackViewportWidth,
  releaseMobileSwipeBackScrollLock,
  type MobileSwipeBackDragState,
  type MobileSwipeBackScrollLockState,
  type MobileSwipeBackTouchGuardState,
} from "./mobileSwipeBack";
import MobilePageHeader from "./MobilePageHeader";
import {
  automationsPageCacheByUserId,
  browserTimezone,
  datetimeInputValue,
  defaultMaxRuntimeSeconds,
  defaultRunAt,
  failurePolicyOptions,
  formatDate,
  hasRunOutput,
  intervalLabel,
  intervalParts,
  intervalUnitSeconds,
  isActiveRunStatus,
  isAutomationsPageCacheStale,
  missedRunPolicyOptions,
  overlapPolicyOptions,
  runCountLabel,
  runErrorText,
  runStatusClass,
  statusClass,
  timezoneLabel,
  timezoneOptions,
  type FailurePolicy,
  type IntervalUnit,
  type MissedRunPolicy,
  type OverlapPolicy,
} from "./automationsFormatting";

interface AutomationsPageProps {
  userId: string;
  selectedModel: string;
  models: { id: string; owned_by: string }[];
  onAuthExpired: (message: string) => void;
  onOpenChat?: (prompt: string, options?: { autoSend?: boolean; newSession?: boolean }) => void;
  onBack?: () => void;
}

type OutputPreviewState = {
  jobId: string;
  title: string;
  text: string;
  loading: boolean;
  error: string | null;
} | null;

interface AutomationBackSwipeIntentInput {
  startX?: number;
  deltaX: number;
  deltaY: number;
  viewportWidth: number;
}

interface AutomationBackSwipeReleaseInput {
  x: number;
  velocityX: number;
  viewportWidth: number;
}

interface AutomationBackSwipeReleaseResolution {
  shouldCloseDetail: boolean;
  commitDistance: number;
}

const AUTOMATIONS_BACK_SWIPE_INTERACTIVE_SELECTOR =
  "button, a, input, textarea, select, [role='button'], [data-ripple-ignore-automations-swipe]";

function isInteractiveAutomationBackSwipeTarget(target: EventTarget | null): boolean {
  return isInteractiveMobileSwipeBackTarget(target, AUTOMATIONS_BACK_SWIPE_INTERACTIVE_SELECTOR);
}

export function shouldGuardAutomationBackSwipeScroll({
  startX,
  deltaX,
  deltaY,
  viewportWidth,
}: AutomationBackSwipeIntentInput): boolean {
  return shouldGuardMobileSwipeBackScroll({ startX, deltaX, deltaY, viewportWidth });
}

export function shouldClaimAutomationBackSwipe({
  startX,
  deltaX,
  deltaY,
  viewportWidth,
}: AutomationBackSwipeIntentInput): boolean {
  return shouldClaimMobileSwipeBack({ startX, deltaX, deltaY, viewportWidth });
}

export function shouldCancelAutomationBackSwipe({
  startX,
  deltaX,
  deltaY,
  viewportWidth,
}: AutomationBackSwipeIntentInput): boolean {
  return shouldCancelMobileSwipeBack({ startX, deltaX, deltaY, viewportWidth });
}

export function shouldReleaseAutomationBackSwipeScrollGuard({
  startX,
  deltaX,
  deltaY,
  viewportWidth,
}: AutomationBackSwipeIntentInput): boolean {
  return shouldReleaseMobileSwipeBackScrollGuard({ startX, deltaX, deltaY, viewportWidth });
}

export function resolveAutomationBackSwipeRelease({
  x,
  velocityX,
  viewportWidth,
}: AutomationBackSwipeReleaseInput): AutomationBackSwipeReleaseResolution {
  const release = resolveMobileSwipeBackRelease({ x, velocityX, viewportWidth });

  return { shouldCloseDetail: release.shouldCommit, commitDistance: release.commitDistance };
}

const automationActionButtonClass = `inline-flex h-8 w-full min-w-0 items-center justify-center gap-1 rounded-full border border-[#DEE0E3] bg-white px-2 text-[#2B2F36] hover:bg-[#F8F9FA] ${TYPOGRAPHY_META_MEDIUM_CLASS} [&>span]:min-w-0 [&>span]:truncate [&>svg]:shrink-0`;

const automationDeleteButtonClass = `inline-flex h-8 w-full min-w-0 items-center justify-center gap-1 rounded-full border px-2 ${TYPOGRAPHY_META_MEDIUM_CLASS} [&>span]:min-w-0 [&>span]:truncate [&>svg]:shrink-0`;

const mobileAutomationActionButtonClass = `inline-flex h-11 w-full min-w-0 items-center justify-center gap-1.5 rounded-xl border border-[#DEE0E3] bg-white px-2.5 text-[#2B2F36] hover:bg-[#F8F9FA] active:bg-[#F8F9FA] ${TYPOGRAPHY_META_MEDIUM_CLASS} [&>span]:min-w-0 [&>span]:truncate [&>svg]:shrink-0`;

const mobileAutomationDeleteButtonClass = `inline-flex h-11 w-full min-w-0 items-center justify-center gap-1.5 rounded-xl border px-2.5 ${TYPOGRAPHY_META_MEDIUM_CLASS} [&>span]:min-w-0 [&>span]:truncate [&>svg]:shrink-0`;

const mobileRunActionButtonClass = `inline-flex h-8 shrink-0 items-center justify-center gap-0.5 rounded-full border border-[#DEE0E3] bg-white px-1.5 text-[#2B2F36] hover:bg-[#F8F9FA] disabled:cursor-not-allowed disabled:opacity-60 min-[380px]:gap-1 ${TYPOGRAPHY_MICRO_MEDIUM_CLASS} [&>span]:min-w-0 [&>span]:truncate [&>svg]:shrink-0`;

const AUTOMATION_PRIMARY_ACTION_BUTTON_CLASS = `inline-flex h-11 w-11 items-center justify-center rounded-xl border border-[#1456F0]/30 bg-[#1456F0] text-white shadow-[0_8px_18px_rgba(20,86,240,0.18)] transition-all hover:bg-[#0F4BD8] active:scale-[0.98] disabled:opacity-60 lg:h-10 lg:w-auto lg:gap-1.5 lg:px-3 ${TYPOGRAPHY_META_MEDIUM_CLASS}`;

const automationFieldLabelClass =
  "mb-0.5 block text-[12px] leading-[18px] font-medium text-[#646A73] lg:leading-5";

const automationFieldControlClass = `${WORKBENCH_FIELD_CLASS} h-10 w-full px-3 text-[15px] leading-[22px] lg:h-9 lg:text-[14px] lg:leading-[22px]`;

const automationMonoFieldControlClass = `${WORKBENCH_FIELD_CLASS} h-10 w-full px-3 font-[family-name:var(--font-mono)] text-[15px] leading-[22px] lg:h-9 lg:text-[14px] lg:leading-[22px]`;

const automationTextareaClass = `${WORKBENCH_FIELD_CLASS} min-h-[88px] w-full resize-none px-3 py-2 text-[15px] leading-[22px] lg:min-h-[84px] lg:text-[14px] lg:leading-[22px]`;

export default function AutomationsPage({
  userId,
  selectedModel,
  models,
  onAuthExpired,
  onOpenChat,
  onBack,
}: AutomationsPageProps) {
  const { locale, t } = useI18n();
  const reduceMotion = useReducedMotion();
  const detailSwipeX = useMotionValue(0);
  const cachedAutomationsPageData = automationsPageCacheByUserId[userId] ?? null;
  const [schedules, setSchedules] = useState<ScheduleInfo[]>(
    () => cachedAutomationsPageData?.schedules ?? []
  );
  const [isLoading, setIsLoading] = useState(() => !cachedAutomationsPageData);
  const [isManualRefreshPending, setIsManualRefreshPending] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [formModel, setFormModel] = useState(selectedModel);
  const [kind, setKind] = useState<ScheduleKind>("once");
  const [runAt, setRunAt] = useState(defaultRunAt);
  const [timezone, setTimezone] = useState(browserTimezone);
  const [intervalValue, setIntervalValue] = useState(1);
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>("hours");
  const [maxRuns, setMaxRuns] = useState("");
  const [cwd, setCwd] = useState("");
  const [maxRuntimeSeconds, setMaxRuntimeSeconds] = useState(String(defaultMaxRuntimeSeconds));
  const [missedRunPolicy, setMissedRunPolicy] = useState<MissedRunPolicy>("run_once");
  const [overlapPolicy, setOverlapPolicy] = useState<OverlapPolicy>("skip");
  const [failurePolicy, setFailurePolicy] = useState<FailurePolicy>("pause");
  const [isAdvancedConfigOpen, setIsAdvancedConfigOpen] = useState(false);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [pendingRunActionId, setPendingRunActionId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmRunDeleteId, setConfirmRunDeleteId] = useState<string | null>(null);
  const [runsBySchedule, setRunsBySchedule] = useState<Record<string, AgentRunInfo[]>>(
    () => cachedAutomationsPageData?.runsBySchedule ?? {}
  );
  const [expandedScheduleId, setExpandedScheduleId] = useState<string | null>(null);
  const [outputPreview, setOutputPreview] = useState<OutputPreviewState>(null);
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(null);
  const [detailTransitionDirection, setDetailTransitionDirection] = useState(0);
  const [skipNextDetailTransition, setSkipNextDetailTransition] = useState(false);
  const [isDetailSwipeActive, setIsDetailSwipeActive] = useState(false);
  const automationsPageScrollRef = useRef<HTMLDivElement | null>(null);
  const detailSwipeDragStateRef = useRef<MobileSwipeBackDragState | null>(null);
  const suppressNextDetailSwipeClickRef = useRef(false);
  const detailSwipeTouchGuardStateRef = useRef<MobileSwipeBackTouchGuardState | null>(null);
  const detailSwipeScrollLockRef = useRef<MobileSwipeBackScrollLockState | null>(null);
  const detailSwipeAnimationRef = useRef<ReturnType<typeof animate> | null>(null);

  const intervalSeconds = useMemo(
    () => Math.max(1, intervalValue) * intervalUnitSeconds[intervalUnit],
    [intervalUnit, intervalValue]
  );
  const availableModels = useMemo(
    () => (models.length > 0 ? models : [{ id: selectedModel, owned_by: "ripple" }]),
    [models, selectedModel]
  );
  const availableTimezones = useMemo(() => timezoneOptions(timezone), [timezone]);
  const selectedSchedule = useMemo(
    () => schedules.find((schedule) => schedule.schedule_id === selectedScheduleId) || null,
    [schedules, selectedScheduleId]
  );

  const loadScheduleRuns = useCallback((scheduleId: string) => fetchScheduleRuns(scheduleId), []);

  const loadSchedules = useCallback(
    async (options: { background?: boolean } = {}) => {
      if (!options.background) setIsLoading(true);
      setError(null);
      try {
        const records = await fetchSchedules();
        const runEntries = await Promise.all(
          records.map(async (schedule) => {
            const runs = await loadScheduleRuns(schedule.schedule_id);
            return [schedule.schedule_id, runs] as const;
          })
        );
        const nextRunsBySchedule = Object.fromEntries(runEntries) as Record<string, AgentRunInfo[]>;
        automationsPageCacheByUserId[userId] = {
          schedules: records,
          runsBySchedule: nextRunsBySchedule,
          loadedAt: Date.now(),
        };
        setSchedules(records);
        setRunsBySchedule(nextRunsBySchedule);
      } catch (err) {
        if (err instanceof AuthError) {
          onAuthExpired(t("automations.apiKeyExpired"));
          return;
        }
        setError(err instanceof Error ? err.message : t("automations.failedToLoad"));
      } finally {
        if (!options.background) {
          setIsLoading(false);
        }
      }
    },
    [loadScheduleRuns, onAuthExpired, t, userId]
  );

  const handleManualRefresh = useCallback(async () => {
    setIsManualRefreshPending(true);
    try {
      await loadSchedules({ background: true });
    } finally {
      setIsManualRefreshPending(false);
    }
  }, [loadSchedules]);

  useEffect(() => {
    if (cachedAutomationsPageData && !isAutomationsPageCacheStale(userId)) {
      return;
    }
    void loadSchedules({ background: cachedAutomationsPageData !== null });
  }, [cachedAutomationsPageData, loadSchedules, userId]);

  useEffect(() => {
    const hasActiveRun = schedules.some((schedule) => {
      const latestRun = runsBySchedule[schedule.schedule_id]?.[0];
      return isActiveRunStatus(latestRun?.status || schedule.last_run_status);
    });
    if (!hasActiveRun) return;

    const timer = window.setInterval(() => {
      void loadSchedules({ background: true });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [loadSchedules, runsBySchedule, schedules]);

  const stopDetailSwipeAnimation = useCallback(() => {
    detailSwipeAnimationRef.current?.stop();
    detailSwipeAnimationRef.current = null;
  }, []);

  const releaseDetailSwipeScrollLock = useCallback(() => {
    releaseMobileSwipeBackScrollLock(detailSwipeScrollLockRef.current);
    detailSwipeScrollLockRef.current = null;
  }, []);

  const animateDetailSwipeTo = useCallback(
    (target: number, onComplete?: () => void, transition = mobileStackReturnTransition) => {
      stopDetailSwipeAnimation();
      if (reduceMotion) {
        detailSwipeX.set(target);
        onComplete?.();
        return;
      }

      const animation = animate(detailSwipeX, target, transition);
      detailSwipeAnimationRef.current = animation;
      void animation.then(() => {
        if (detailSwipeAnimationRef.current === animation) {
          detailSwipeAnimationRef.current = null;
        }
        onComplete?.();
      });
    },
    [detailSwipeX, reduceMotion, stopDetailSwipeAnimation]
  );

  const resetDetailSwipeState = useCallback(() => {
    stopDetailSwipeAnimation();
    detailSwipeDragStateRef.current = null;
    detailSwipeTouchGuardStateRef.current = null;
    releaseDetailSwipeScrollLock();
    setIsDetailSwipeActive(false);
    detailSwipeX.set(0);
  }, [detailSwipeX, releaseDetailSwipeScrollLock, stopDetailSwipeAnimation]);

  const scrollAutomationsPageToTop = useCallback(() => {
    automationsPageScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  const openScheduleDetail = useCallback(
    (scheduleId: string) => {
      resetDetailSwipeState();
      setSkipNextDetailTransition(true);
      setDetailTransitionDirection(0);
      setConfirmDeleteId(null);
      setConfirmRunDeleteId(null);
      setExpandedScheduleId(null);
      setSelectedScheduleId(scheduleId);
      scrollAutomationsPageToTop();
    },
    [resetDetailSwipeState, scrollAutomationsPageToTop]
  );

  const closeScheduleDetail = useCallback(() => {
    resetDetailSwipeState();
    setSkipNextDetailTransition(true);
    setDetailTransitionDirection(0);
    setConfirmDeleteId(null);
    setConfirmRunDeleteId(null);
    setExpandedScheduleId(null);
    setSelectedScheduleId(null);
    scrollAutomationsPageToTop();
  }, [resetDetailSwipeState, scrollAutomationsPageToTop]);

  const closeScheduleDetailWithSwipeCommit = useCallback(() => {
    detailSwipeDragStateRef.current = null;
    detailSwipeTouchGuardStateRef.current = null;
    releaseDetailSwipeScrollLock();
    setIsDetailSwipeActive(false);
    setSkipNextDetailTransition(true);
    setDetailTransitionDirection(-1);
    setConfirmDeleteId(null);
    setConfirmRunDeleteId(null);
    setExpandedScheduleId(null);
    setSelectedScheduleId(null);
    const resetSwipeX = () => detailSwipeX.set(0);
    if (typeof window === "undefined") {
      resetSwipeX();
    } else {
      window.requestAnimationFrame(resetSwipeX);
    }
  }, [detailSwipeX, releaseDetailSwipeScrollLock]);

  useEffect(
    () => () => {
      stopDetailSwipeAnimation();
      releaseMobileSwipeBackScrollLock(detailSwipeScrollLockRef.current);
      detailSwipeScrollLockRef.current = null;
    },
    [stopDetailSwipeAnimation]
  );

  useEffect(() => {
    if (!selectedScheduleId) return;
    if (schedules.some((schedule) => schedule.schedule_id === selectedScheduleId)) return;
    closeScheduleDetail();
  }, [closeScheduleDetail, schedules, selectedScheduleId]);

  useEffect(() => {
    if (!skipNextDetailTransition || selectedScheduleId) return;
    if (typeof window === "undefined") {
      setSkipNextDetailTransition(false);
      return;
    }
    const frame = window.requestAnimationFrame(() => setSkipNextDetailTransition(false));
    return () => window.cancelAnimationFrame(frame);
  }, [selectedScheduleId, skipNextDetailTransition]);

  const handleDetailSwipePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!selectedScheduleId) return;
      if (!event.isPrimary || event.pointerType !== "touch") return;
      const viewportWidth = mobileSwipeBackViewportWidth();
      if (viewportWidth >= mobileSwipeBackConfig.desktopMinWidth) return;
      suppressNextDetailSwipeClickRef.current = false;
      if (isInteractiveAutomationBackSwipeTarget(event.target)) return;
      stopDetailSwipeAnimation();
      const scrollElement = event.currentTarget;

      detailSwipeDragStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        viewportWidth,
        claimed: false,
        lastX: event.clientX,
        lastTime: currentMobileSwipeBackTimeMs(),
        velocityX: 0,
        scrollElement,
        startScrollTop: scrollElement.scrollTop,
      };
    },
    [selectedScheduleId, stopDetailSwipeAnimation]
  );

  const handleDetailSwipePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const dragState = detailSwipeDragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) return;

      const deltaX = event.clientX - dragState.startX;
      const deltaY = event.clientY - dragState.startY;

      if (
        !dragState.claimed &&
        shouldCancelAutomationBackSwipe({
          startX: dragState.startX,
          deltaX,
          deltaY,
          viewportWidth: dragState.viewportWidth,
        })
      ) {
        detailSwipeDragStateRef.current = null;
        releaseDetailSwipeScrollLock();
        return;
      }

      if (
        !dragState.claimed &&
        shouldClaimAutomationBackSwipe({
          startX: dragState.startX,
          deltaX,
          deltaY,
          viewportWidth: dragState.viewportWidth,
        })
      ) {
        dragState.claimed = true;
        suppressNextDetailSwipeClickRef.current = true;
        setIsDetailSwipeActive(true);
        detailSwipeScrollLockRef.current = ensureMobileSwipeBackScrollLock(
          detailSwipeScrollLockRef.current,
          dragState.scrollElement,
          dragState.startScrollTop
        );
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture can fail when the platform has already ended the gesture.
        }
      }

      if (!dragState.claimed) return;

      event.preventDefault();
      const currentTime = currentMobileSwipeBackTimeMs();
      const elapsed = Math.max(1, currentTime - dragState.lastTime);
      dragState.velocityX = ((event.clientX - dragState.lastX) / elapsed) * 1000;
      dragState.lastX = event.clientX;
      dragState.lastTime = currentTime;
      detailSwipeX.set(Math.max(0, deltaX));
    },
    [detailSwipeX, releaseDetailSwipeScrollLock]
  );

  const handleDetailSwipePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const dragState = detailSwipeDragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) return;

      detailSwipeDragStateRef.current = null;
      releaseDetailSwipeScrollLock();
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Matching setPointerCapture may not have succeeded on every platform.
      }

      if (!dragState.claimed) return;
      event.preventDefault();

      const release = resolveAutomationBackSwipeRelease({
        x: detailSwipeX.get(),
        velocityX: dragState.velocityX,
        viewportWidth: dragState.viewportWidth,
      });

      if (!release.shouldCloseDetail) {
        animateDetailSwipeTo(0, () => {
          setIsDetailSwipeActive(false);
        });
        return;
      }

      setIsDetailSwipeActive(true);
      animateDetailSwipeTo(
        dragState.viewportWidth,
        closeScheduleDetailWithSwipeCommit,
        mobileStackCommitTransition
      );
    },
    [
      animateDetailSwipeTo,
      closeScheduleDetailWithSwipeCommit,
      detailSwipeX,
      releaseDetailSwipeScrollLock,
    ]
  );

  const handleDetailSwipePointerCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const dragState = detailSwipeDragStateRef.current;
      if (dragState && dragState.pointerId === event.pointerId) {
        detailSwipeDragStateRef.current = null;
        releaseDetailSwipeScrollLock();
        animateDetailSwipeTo(0, () => {
          setIsDetailSwipeActive(false);
        });
      }
    },
    [animateDetailSwipeTo, releaseDetailSwipeScrollLock]
  );

  const handleDetailSwipeTouchStartCapture = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      if (!selectedScheduleId) return;
      if (event.touches.length !== 1) return;
      const viewportWidth = mobileSwipeBackViewportWidth();
      if (viewportWidth >= mobileSwipeBackConfig.desktopMinWidth) return;
      if (isInteractiveAutomationBackSwipeTarget(event.target)) return;
      const touch = event.touches[0];
      if (!touch) return;
      stopDetailSwipeAnimation();
      const scrollElement = event.currentTarget;

      detailSwipeTouchGuardStateRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        viewportWidth,
        isGuarding: false,
        scrollElement,
        startScrollTop: scrollElement.scrollTop,
      };
    },
    [selectedScheduleId, stopDetailSwipeAnimation]
  );

  const handleDetailSwipeTouchMoveCapture = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const guardState = detailSwipeTouchGuardStateRef.current;
      const touch = event.touches[0];
      if (!guardState || !touch) return;

      const deltaX = touch.clientX - guardState.startX;
      const deltaY = touch.clientY - guardState.startY;

      if (
        guardState.isGuarding &&
        shouldReleaseAutomationBackSwipeScrollGuard({
          startX: guardState.startX,
          deltaX,
          deltaY,
          viewportWidth: guardState.viewportWidth,
        })
      ) {
        detailSwipeTouchGuardStateRef.current = null;
        releaseDetailSwipeScrollLock();
        return;
      }

      if (
        !guardState.isGuarding &&
        shouldCancelAutomationBackSwipe({
          startX: guardState.startX,
          deltaX,
          deltaY,
          viewportWidth: guardState.viewportWidth,
        })
      ) {
        detailSwipeTouchGuardStateRef.current = null;
        releaseDetailSwipeScrollLock();
        return;
      }

      if (
        guardState.isGuarding ||
        shouldGuardAutomationBackSwipeScroll({
          startX: guardState.startX,
          deltaX,
          deltaY,
          viewportWidth: guardState.viewportWidth,
        })
      ) {
        guardState.isGuarding = true;
        event.preventDefault();
        detailSwipeScrollLockRef.current = ensureMobileSwipeBackScrollLock(
          detailSwipeScrollLockRef.current,
          guardState.scrollElement,
          guardState.startScrollTop
        );
      }
    },
    [releaseDetailSwipeScrollLock]
  );

  const clearDetailSwipeTouchGuard = useCallback(() => {
    detailSwipeTouchGuardStateRef.current = null;
    if (!detailSwipeDragStateRef.current?.claimed) releaseDetailSwipeScrollLock();
  }, [releaseDetailSwipeScrollLock]);

  const handleDetailSwipeClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!suppressNextDetailSwipeClickRef.current) return;
    suppressNextDetailSwipeClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const resetForm = useCallback(() => {
    setTitle("");
    setPrompt("");
    setFormModel(selectedModel);
    setKind("once");
    setRunAt(defaultRunAt());
    setTimezone(browserTimezone());
    setIntervalValue(1);
    setIntervalUnit("hours");
    setMaxRuns("");
    setCwd("");
    setMaxRuntimeSeconds(String(defaultMaxRuntimeSeconds));
    setMissedRunPolicy("run_once");
    setOverlapPolicy("skip");
    setFailurePolicy("pause");
    setIsAdvancedConfigOpen(false);
  }, [selectedModel]);

  function beginEditSchedule(schedule: ScheduleInfo) {
    const interval = intervalParts(schedule.interval_seconds);
    setEditingScheduleId(schedule.schedule_id);
    setTitle(schedule.title);
    setPrompt(schedule.prompt);
    setFormModel(schedule.model || selectedModel);
    setKind(schedule.kind);
    setRunAt(datetimeInputValue(schedule.run_at));
    setTimezone(schedule.timezone || browserTimezone());
    setIntervalValue(interval.value);
    setIntervalUnit(interval.unit);
    setMaxRuns(schedule.max_runs ? String(schedule.max_runs) : "");
    setCwd(schedule.cwd || "");
    setMaxRuntimeSeconds(String(schedule.max_runtime_seconds || defaultMaxRuntimeSeconds));
    setMissedRunPolicy((schedule.missed_run_policy as MissedRunPolicy) || "run_once");
    setOverlapPolicy((schedule.overlap_policy as OverlapPolicy) || "skip");
    setFailurePolicy((schedule.failure_policy as FailurePolicy) || "pause");
    setIsAdvancedConfigOpen(false);
    setConfirmDeleteId(null);
    setError(null);
    setIsCreating(true);
  }

  const openCreateAutomationChat = useCallback(() => {
    onOpenChat?.(t("automations.createChatPrompt"), { autoSend: true, newSession: true });
  }, [onOpenChat, t]);

  const closeForm = useCallback(() => {
    resetForm();
    setEditingScheduleId(null);
    setIsCreating(false);
  }, [resetForm]);

  const handleSubmitSchedule = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!editingScheduleId || !title.trim() || !prompt.trim()) return;
      setIsSubmitting(true);
      setError(null);
      try {
        const parsedMaxRuns = Number(maxRuns);
        const maxRunsLimit =
          kind === "interval" && maxRuns.trim() && Number.isFinite(parsedMaxRuns)
            ? Math.max(1, Math.floor(parsedMaxRuns))
            : null;
        const parsedMaxRuntimeSeconds = Number(maxRuntimeSeconds);
        const maxRuntimeSecondsLimit =
          maxRuntimeSeconds.trim() && Number.isFinite(parsedMaxRuntimeSeconds)
            ? Math.max(1, Math.floor(parsedMaxRuntimeSeconds))
            : defaultMaxRuntimeSeconds;
        const payload = {
          title: title.trim(),
          prompt: prompt.trim(),
          kind,
          timezone,
          run_at: runAt,
          interval_seconds: kind === "interval" ? intervalSeconds : null,
          max_runs: maxRunsLimit,
          model: formModel,
          cwd: cwd.trim() || null,
          max_runtime_seconds: maxRuntimeSecondsLimit,
          missed_run_policy: missedRunPolicy,
          overlap_policy: overlapPolicy,
          failure_policy: failurePolicy,
        };
        await updateSchedule(editingScheduleId, payload);
        resetForm();
        setEditingScheduleId(null);
        setIsCreating(false);
        await loadSchedules({ background: true });
      } catch (err) {
        if (err instanceof AuthError) {
          onAuthExpired(t("automations.apiKeyExpired"));
          return;
        }
        setError(err instanceof Error ? err.message : t("automations.failedToSave"));
      } finally {
        setIsSubmitting(false);
      }
    },
    [
      cwd,
      editingScheduleId,
      failurePolicy,
      formModel,
      intervalSeconds,
      kind,
      loadSchedules,
      maxRuns,
      maxRuntimeSeconds,
      missedRunPolicy,
      onAuthExpired,
      overlapPolicy,
      prompt,
      resetForm,
      runAt,
      t,
      timezone,
      title,
    ]
  );

  const handleAction = useCallback(
    async (scheduleId: string, action: "toggle" | "run" | "delete", enabled?: boolean) => {
      setPendingActionId(`${scheduleId}:${action}`);
      setError(null);
      try {
        if (action === "toggle") {
          await updateSchedule(scheduleId, { enabled: !enabled });
        } else if (action === "run") {
          const run = await runScheduleNow(scheduleId);
          setRunsBySchedule((current) => ({
            ...current,
            [scheduleId]: [
              run,
              ...(current[scheduleId] || []).filter((item) => item.job_id !== run.job_id),
            ].slice(0, 5),
          }));
        } else {
          if (confirmDeleteId !== scheduleId) {
            setConfirmDeleteId(scheduleId);
            return;
          }
          await deleteSchedule(scheduleId);
          setConfirmDeleteId(null);
        }
        await loadSchedules({ background: true });
      } catch (err) {
        if (err instanceof AuthError) {
          onAuthExpired(t("automations.apiKeyExpired"));
          return;
        }
        setError(err instanceof Error ? err.message : t("automations.actionFailed"));
      } finally {
        setPendingActionId(null);
      }
    },
    [confirmDeleteId, loadSchedules, onAuthExpired, t]
  );

  const handleViewOutput = useCallback(
    async (run: AgentRunInfo, title: string) => {
      setPendingRunActionId(`${run.job_id}:view`);
      setOutputPreview({
        jobId: run.job_id,
        title,
        text: "",
        loading: true,
        error: null,
      });
      try {
        const text = await fetchRunOutputText(run.job_id);
        setOutputPreview({
          jobId: run.job_id,
          title,
          text,
          loading: false,
          error: null,
        });
      } catch (err) {
        if (err instanceof AuthError) {
          onAuthExpired(t("automations.apiKeyExpired"));
          return;
        }
        setOutputPreview({
          jobId: run.job_id,
          title,
          text: "",
          loading: false,
          error: err instanceof Error ? err.message : t("automations.failedToLoadOutput"),
        });
      } finally {
        setPendingRunActionId(null);
      }
    },
    [onAuthExpired, t]
  );

  const handleDownloadOutput = useCallback(
    async (run: AgentRunInfo) => {
      setPendingRunActionId(`${run.job_id}:download`);
      setError(null);
      try {
        const downloaded = await downloadRunOutput(run.job_id);
        saveBlobAsDownload(downloaded.blob, downloaded.filename);
      } catch (err) {
        if (err instanceof AuthError) {
          onAuthExpired(t("automations.apiKeyExpired"));
          return;
        }
        setError(err instanceof Error ? err.message : t("automations.failedToDownloadOutput"));
      } finally {
        setPendingRunActionId(null);
      }
    },
    [onAuthExpired, t]
  );

  const handleDeleteRun = useCallback(
    async (scheduleId: string, run: AgentRunInfo) => {
      const confirmKey = `${scheduleId}:${run.job_id}`;
      if (confirmRunDeleteId !== confirmKey) {
        setConfirmRunDeleteId(confirmKey);
        return;
      }
      setPendingRunActionId(`${run.job_id}:delete`);
      setError(null);
      try {
        await deleteScheduleRun(scheduleId, run.job_id);
        setConfirmRunDeleteId(null);
        setRunsBySchedule((current) => ({
          ...current,
          [scheduleId]: (current[scheduleId] || []).filter((item) => item.job_id !== run.job_id),
        }));
        setOutputPreview((current) => (current?.jobId === run.job_id ? null : current));
        await loadSchedules({ background: true });
      } catch (err) {
        if (err instanceof AuthError) {
          onAuthExpired(t("automations.apiKeyExpired"));
          return;
        }
        setError(err instanceof Error ? err.message : t("automations.failedToDeleteRunRecord"));
      } finally {
        setPendingRunActionId(null);
      }
    },
    [confirmRunDeleteId, loadSchedules, onAuthExpired, t]
  );

  return (
    <div
      className={`h-full min-h-0 overflow-y-auto ${WORKBENCH_PAGE_BACKGROUND_CLASS} px-3 ${MOBILE_PAGE_TOP_SAFE_AREA_CLASS} ${MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS} text-[#1F2329] md:px-6 lg:pb-5`}
    >
      <div className={`${WORKBENCH_PAGE_CONTENT_CLASS} space-y-4`}>
        <header className="flex flex-wrap items-center justify-between gap-3 pb-1">
          <div className="flex min-w-0 items-center gap-3">
            {onBack ? (
              <button
                type="button"
                onClick={onBack}
                aria-label={t("automations.backToSettings")}
                title={t("automations.backToSettings")}
                className={`${WORKBENCH_MOBILE_ICON_BUTTON_CLASS} lg:hidden`}
              >
                <ArrowLeft size={16} strokeWidth={LUCIDE_NAV_STROKE_WIDTH} />
              </button>
            ) : null}
            <div className="min-w-0">
              <h1 className={TYPOGRAPHY_PAGE_TITLE_CLASS}>{t("automations.title")}</h1>
              <div
                className={`mt-1 font-[family-name:var(--font-mono)] text-[#646A73] ${TYPOGRAPHY_META_CLASS}`}
              >
                {t("automations.total", { count: schedules.length })}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={openCreateAutomationChat}
              disabled={!onOpenChat}
              className={AUTOMATION_PRIMARY_ACTION_BUTTON_CLASS}
              aria-label={t("automations.new")}
              title={t("automations.new")}
            >
              <CalendarPlus size={18} strokeWidth={LUCIDE_NAV_STROKE_WIDTH} />
              <span className="hidden lg:inline">{t("automations.new")}</span>
            </button>
            <button
              type="button"
              onClick={() => void handleManualRefresh()}
              disabled={isLoading || isManualRefreshPending}
              aria-label={t("automations.refreshAutomations")}
              title={t("automations.refreshAutomations")}
              className={`${WORKBENCH_MOBILE_ICON_BUTTON_CLASS} shrink-0 disabled:cursor-not-allowed disabled:opacity-60 lg:h-10 lg:w-auto lg:gap-1.5 lg:px-3 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
            >
              {isLoading || isManualRefreshPending ? (
                <Loader2 size={18} strokeWidth={LUCIDE_NAV_STROKE_WIDTH} className="animate-spin" />
              ) : (
                <RefreshCw size={18} strokeWidth={LUCIDE_NAV_STROKE_WIDTH} />
              )}
              <span className="hidden lg:inline">{t("automations.refresh")}</span>
            </button>
          </div>
        </header>

        {error ? (
          <div
            className={`flex items-start gap-2 rounded-xl border border-[#B42318]/25 bg-[#FFF1F0] px-3 py-3 text-[#B42318] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
          >
            <IconTile tone="danger" size="sm" className="mt-0.5">
              <AlertTriangle size={14} />
            </IconTile>
            <span className="min-w-0 break-words">{error}</span>
          </div>
        ) : null}

        {isCreating ? (
          <form
            data-ripple-automation-form-sheet
            data-ripple-automation-edit-page="true"
            onSubmit={handleSubmitSchedule}
            className="fixed inset-x-0 top-0 z-40 flex h-dvh min-h-0 flex-col overflow-hidden bg-[#F5F6F7] md:static md:z-auto md:grid md:h-auto md:gap-3 md:overflow-visible md:rounded-xl md:border md:border-[#DEE0E3] md:bg-white md:p-4 md:shadow-[0_1px_2px_rgba(31,35,41,0.04)]"
          >
            <MobilePageHeader
              title={t("automations.edit")}
              subtitle={title.trim() || undefined}
              titleClassName={MOBILE_DETAIL_HEADER_TITLE_CLASS}
              backButtonVariant="ghost"
              backLabel={t("automations.cancel")}
              onBack={closeForm}
              className="md:hidden"
            />

            <div
              data-ripple-automation-form-page
              className="grid min-h-0 flex-1 auto-rows-max content-start gap-2.5 overflow-y-auto px-3 py-2 md:contents"
            >
              <section className="grid gap-2.5 rounded-xl border border-[#DEE0E3] bg-white p-3 shadow-[0_1px_2px_rgba(31,35,41,0.03)] md:gap-3 md:rounded-none md:border-0 md:bg-transparent md:p-0 md:shadow-none">
                <div className="grid gap-2.5 md:grid-cols-[minmax(0,1fr)_220px_220px]">
                  <label className="block min-w-0">
                    <span className={automationFieldLabelClass}>{t("automations.titleLabel")}</span>
                    <input
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      className={automationFieldControlClass}
                    />
                  </label>
                  <label className="block min-w-0">
                    <span className={automationFieldLabelClass}>{t("automations.model")}</span>
                    <select
                      value={formModel}
                      onChange={(event) => setFormModel(event.target.value)}
                      className={automationFieldControlClass}
                    >
                      {availableModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {formatModelName(model.id)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block min-w-0">
                    <span className={automationFieldLabelClass}>{t("automations.timezone")}</span>
                    <select
                      value={timezone}
                      onChange={(event) => setTimezone(event.target.value)}
                      className={automationMonoFieldControlClass}
                    >
                      {availableTimezones.map((option) => (
                        <option key={option} value={option}>
                          {timezoneLabel(option)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <label className="block">
                  <span className={automationFieldLabelClass}>{t("automations.prompt")}</span>
                  <textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    rows={3}
                    className={automationTextareaClass}
                  />
                </label>
              </section>

              <section className="grid gap-2.5 rounded-xl border border-[#DEE0E3] bg-white p-3 shadow-[0_1px_2px_rgba(31,35,41,0.03)] md:gap-3 md:rounded-none md:border-0 md:bg-transparent md:p-0 md:shadow-none">
                <div className="grid gap-2.5 md:grid-cols-[180px_minmax(0,1fr)] md:items-end">
                  <div>
                    <span className={automationFieldLabelClass}>{t("automations.mode")}</span>
                    <div className="grid grid-cols-2 rounded-lg border border-[#DEE0E3] bg-white p-0.5">
                      {(["once", "interval"] as ScheduleKind[]).map((option) => (
                        <button
                          key={option}
                          type="button"
                          onClick={() => setKind(option)}
                          className={`h-9 rounded-md ${TYPOGRAPHY_BODY_MEDIUM_CLASS} ${
                            kind === option
                              ? "bg-[#1456F0] text-white"
                              : "text-[#2B2F36] hover:bg-[#F8F9FA]"
                          }`}
                        >
                          {option === "once" ? t("automations.once") : t("automations.interval")}
                        </button>
                      ))}
                    </div>
                  </div>

                  {kind === "once" ? (
                    <label className="block min-w-0">
                      <span className={automationFieldLabelClass}>{t("automations.runAt")}</span>
                      <input
                        type="datetime-local"
                        value={runAt}
                        onChange={(event) => setRunAt(event.target.value)}
                        className={automationFieldControlClass}
                      />
                    </label>
                  ) : (
                    <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_120px_130px]">
                      <label className="block min-w-0">
                        <span className={automationFieldLabelClass}>{t("automations.every")}</span>
                        <input
                          type="number"
                          min={1}
                          value={intervalValue}
                          onChange={(event) => setIntervalValue(Number(event.target.value) || 1)}
                          className={automationFieldControlClass}
                        />
                      </label>
                      <label className="block min-w-0">
                        <span className={automationFieldLabelClass}>{t("automations.unit")}</span>
                        <select
                          value={intervalUnit}
                          onChange={(event) => setIntervalUnit(event.target.value as IntervalUnit)}
                          className={automationFieldControlClass}
                        >
                          <option value="minutes">{t("automations.minutes")}</option>
                          <option value="hours">{t("automations.hours")}</option>
                          <option value="days">{t("automations.days")}</option>
                        </select>
                      </label>
                      <label className="block min-w-0">
                        <span className={automationFieldLabelClass}>
                          {t("automations.maxRuns")}
                        </span>
                        <input
                          type="number"
                          min={1}
                          placeholder={t("automations.noLimit")}
                          value={maxRuns}
                          onChange={(event) => setMaxRuns(event.target.value)}
                          className={automationFieldControlClass}
                        />
                      </label>
                    </div>
                  )}
                </div>
              </section>

              <section
                data-ripple-automation-advanced-section
                className="overflow-hidden rounded-xl border border-[#DEE0E3] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.03)] md:grid md:gap-3 md:overflow-visible md:rounded-none md:border-0 md:bg-transparent md:p-0 md:shadow-none"
              >
                <button
                  type="button"
                  onClick={() => setIsAdvancedConfigOpen((current) => !current)}
                  aria-expanded={isAdvancedConfigOpen}
                  data-ripple-automation-advanced-trigger
                  className={`flex h-11 w-full items-center justify-between gap-2 px-3 text-left text-[#2B2F36] hover:bg-[#F8F9FA] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1456F0]/20 focus-visible:ring-inset md:h-9 md:w-fit md:justify-start md:rounded-lg md:border md:border-[#DEE0E3] md:bg-white ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <ChevronDown
                      size={14}
                      className={
                        isAdvancedConfigOpen
                          ? "rotate-180 transition-transform"
                          : "transition-transform"
                      }
                    />
                    <span className="truncate">{t("automations.advancedConfig")}</span>
                  </span>
                </button>

                {isAdvancedConfigOpen ? (
                  <div
                    data-ripple-automation-advanced-config
                    className="grid gap-2.5 border-t border-[#EFF0F1] bg-[#F8F9FA] p-3 md:grid-cols-2 md:gap-3 md:rounded-lg md:border xl:grid-cols-5"
                  >
                    <label className="block min-w-0 md:col-span-2 xl:col-span-1">
                      <span className={automationFieldLabelClass}>{t("automations.cwd")}</span>
                      <input
                        value={cwd}
                        onChange={(event) => setCwd(event.target.value)}
                        placeholder="/workspace"
                        className={automationMonoFieldControlClass}
                      />
                    </label>
                    <label className="block min-w-0">
                      <span className={automationFieldLabelClass}>
                        {t("automations.maxRuntimeSeconds")}
                      </span>
                      <input
                        type="number"
                        min={1}
                        value={maxRuntimeSeconds}
                        onChange={(event) => setMaxRuntimeSeconds(event.target.value)}
                        className={automationFieldControlClass}
                      />
                    </label>
                    <label className="block min-w-0">
                      <span className={automationFieldLabelClass}>
                        {t("automations.missedRunPolicy")}
                      </span>
                      <select
                        value={missedRunPolicy}
                        onChange={(event) =>
                          setMissedRunPolicy(event.target.value as MissedRunPolicy)
                        }
                        className={automationFieldControlClass}
                      >
                        {missedRunPolicyOptions.map((option) => (
                          <option key={option} value={option}>
                            {option === "run_once"
                              ? t("automations.missedRunPolicyRunOnce")
                              : t("automations.missedRunPolicySkip")}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block min-w-0">
                      <span className={automationFieldLabelClass}>
                        {t("automations.overlapPolicy")}
                      </span>
                      <select
                        value={overlapPolicy}
                        onChange={(event) => setOverlapPolicy(event.target.value as OverlapPolicy)}
                        className={automationFieldControlClass}
                      >
                        {overlapPolicyOptions.map((option) => (
                          <option key={option} value={option}>
                            {option === "skip"
                              ? t("automations.overlapPolicySkip")
                              : t("automations.overlapPolicyAllow")}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block min-w-0">
                      <span className={automationFieldLabelClass}>
                        {t("automations.failurePolicy")}
                      </span>
                      <select
                        value={failurePolicy}
                        onChange={(event) => setFailurePolicy(event.target.value as FailurePolicy)}
                        className={automationFieldControlClass}
                      >
                        {failurePolicyOptions.map((option) => (
                          <option key={option} value={option}>
                            {option === "pause"
                              ? t("automations.failurePolicyPause")
                              : t("automations.failurePolicyKeepActive")}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : null}
              </section>
            </div>

            <div
              data-ripple-automation-form-actions
              className="relative z-10 flex shrink-0 items-center justify-end gap-2 border-t border-[#DEE0E3] bg-white px-3 py-2 pb-[max(env(safe-area-inset-bottom),12px)] md:border-0 md:bg-transparent md:p-0"
            >
              <button
                type="button"
                onClick={closeForm}
                className={`inline-flex h-11 items-center justify-center rounded-xl border border-[#DEE0E3] bg-white px-4 text-[#2B2F36] hover:bg-[#F8F9FA] disabled:cursor-not-allowed disabled:opacity-60 md:h-10 md:rounded-lg ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
                disabled={isSubmitting}
              >
                {t("automations.cancel")}
              </button>
              <button
                type="submit"
                disabled={isSubmitting || !editingScheduleId || !title.trim() || !prompt.trim()}
                className={`inline-flex h-11 min-w-[112px] items-center justify-center gap-2 rounded-xl bg-[#1456F0] px-4 text-white hover:bg-[#0F4BD8] disabled:cursor-not-allowed disabled:bg-[#EFF0F1] disabled:text-[#8F959E] md:h-10 md:min-w-0 md:rounded-lg ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
              >
                {isSubmitting ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <CalendarClock size={14} />
                )}
                {t("automations.save")}
              </button>
            </div>
          </form>
        ) : null}

        {schedules.length === 0 ? (
          <div className={`overflow-hidden ${WORKBENCH_SECTION_CLASS}`}>
            <div
              className={`flex h-44 items-center justify-center text-[#646A73] ${TYPOGRAPHY_BODY_CLASS}`}
            >
              {isLoading ? null : t("automations.noAutomations")}
            </div>
          </div>
        ) : (
          <div data-ripple-automation-list className="grid gap-2.5">
            {schedules.map((schedule) => {
              const runs = runsBySchedule[schedule.schedule_id] || [];
              const latestRun = runs[0] || null;
              const latestRunStatus = latestRun?.status || schedule.last_run_status || null;
              const latestRunAt = latestRun?.updated_at || schedule.last_run_at;
              const scheduleError = schedule.status === "error" ? schedule.last_error : null;
              const latestRunError = runErrorText(latestRun) || scheduleError;
              const isExpanded = expandedScheduleId === schedule.schedule_id;
              const isConfirmingDelete = confirmDeleteId === schedule.schedule_id;

              return (
                <div
                  key={schedule.schedule_id}
                  data-ripple-automation-card-main
                  className="overflow-hidden rounded-xl border border-[#DEE0E3] bg-white px-3 py-2 shadow-[0_1px_2px_rgba(31,35,41,0.04)] sm:px-4 sm:py-2.5 xl:px-5"
                >
                  <button
                    type="button"
                    data-ripple-automation-mobile-summary-card
                    onClick={() => openScheduleDetail(schedule.schedule_id)}
                    className="flex w-full min-w-0 items-start gap-2.5 text-left md:hidden"
                  >
                    <IconTile
                      tone={schedule.enabled ? "accent" : "neutral"}
                      size="xs"
                      className="mt-0.5"
                    >
                      <CalendarClock size={14} />
                    </IconTile>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className={`min-w-0 truncate ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>
                          {schedule.title}
                        </span>
                        <span
                          className={`shrink-0 rounded-full border px-1.5 py-0.5 capitalize ${TYPOGRAPHY_MICRO_MEDIUM_CLASS} ${statusClass(
                            schedule.status
                          )}`}
                        >
                          {schedule.status}
                        </span>
                      </span>
                      <span
                        className={`mt-0.5 block truncate text-[#646A73] ${TYPOGRAPHY_BODY_CLASS}`}
                      >
                        {schedule.prompt}
                      </span>
                      <span
                        className={`mt-1 flex min-w-0 items-center gap-1.5 text-[#8F959E] ${TYPOGRAPHY_META_CLASS}`}
                      >
                        <span className="shrink-0">{t("automations.next")}</span>
                        <span className="min-w-0 truncate text-[#646A73]">
                          {formatDate(schedule.next_run_at, locale, t)}
                        </span>
                      </span>
                    </span>
                    <ChevronRight
                      size={18}
                      strokeWidth={LUCIDE_NAV_STROKE_WIDTH}
                      className="mt-2 shrink-0 text-[#8F959E]"
                    />
                  </button>

                  <div className="hidden gap-2 md:grid xl:grid-cols-[minmax(260px,0.82fr)_minmax(0,1.35fr)] xl:items-start">
                    <div data-ripple-automation-summary className="min-w-0">
                      <div className="flex min-w-0 items-start gap-2.5">
                        <IconTile
                          tone={schedule.enabled ? "accent" : "neutral"}
                          size="xs"
                          className="mt-0.5"
                        >
                          <CalendarClock size={14} />
                        </IconTile>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className={`min-w-0 truncate ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>
                              {schedule.title}
                            </span>
                            <span
                              className={`shrink-0 rounded-full border px-1.5 py-0.5 capitalize ${TYPOGRAPHY_MICRO_MEDIUM_CLASS} ${statusClass(
                                schedule.status
                              )}`}
                            >
                              {schedule.status}
                            </span>
                          </div>
                          <div
                            className={`mt-0.5 line-clamp-2 text-[#646A73] ${TYPOGRAPHY_BODY_CLASS}`}
                          >
                            {schedule.prompt}
                          </div>
                          {schedule.status === "error" && schedule.last_error ? (
                            <div
                              className={`mt-1 truncate text-[#B42318] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                            >
                              {schedule.last_error}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>

                    <div
                      data-ripple-automation-detail-grid
                      className="grid gap-1.5 md:grid-cols-[minmax(150px,220px)_minmax(0,1fr)]"
                    >
                      <div
                        data-ripple-automation-meta-grid
                        className="grid grid-cols-2 gap-1.5 md:grid-cols-1"
                      >
                        <div
                          data-ripple-automation-meta-cell
                          className="min-w-0 rounded-lg border border-[#EFF0F1] bg-[#F8F9FA]/80 px-2 py-1"
                        >
                          <div
                            className={`tracking-normal text-[#8F959E] uppercase ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                          >
                            {t("automations.next")}
                          </div>
                          <div
                            className={`mt-0.5 truncate text-[#2B2F36] ${TYPOGRAPHY_META_CLASS}`}
                          >
                            {formatDate(schedule.next_run_at, locale, t)}
                          </div>
                        </div>
                        <div
                          data-ripple-automation-meta-cell
                          className="min-w-0 rounded-lg border border-[#EFF0F1] bg-[#F8F9FA]/80 px-2 py-1"
                        >
                          <div
                            className={`tracking-normal text-[#8F959E] uppercase ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                          >
                            {t("automations.repeat")}
                          </div>
                          <div
                            className={`mt-0.5 truncate font-[family-name:var(--font-mono)] text-[#2B2F36] ${TYPOGRAPHY_META_CLASS}`}
                          >
                            {schedule.kind === "interval"
                              ? `${intervalLabel(schedule.interval_seconds, t)} · ${runCountLabel(schedule, t)}`
                              : t("automations.once")}
                          </div>
                        </div>
                      </div>

                      <div
                        data-ripple-automation-latest-run
                        className={`grid min-w-0 gap-1.5 rounded-lg border border-[#EFF0F1] bg-[#F8F9FA] px-2 py-1.5 ${TYPOGRAPHY_META_CLASS}`}
                      >
                        <div className="flex min-w-0 items-start justify-between gap-2">
                          <span
                            className={`tracking-normal text-[#8F959E] uppercase ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                          >
                            {t("automations.latestRun")}
                          </span>
                          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                            <span className={`text-[#646A73] ${TYPOGRAPHY_META_CLASS}`}>
                              {latestRunAt
                                ? formatDate(latestRunAt, locale, t)
                                : t("automations.never")}
                            </span>
                            <span
                              className={`rounded-full border px-1.5 py-0.5 ${TYPOGRAPHY_MICRO_MEDIUM_CLASS} ${runStatusClass(
                                latestRunStatus
                              )}`}
                            >
                              {latestRunStatus || t("automations.none")}
                            </span>
                          </div>
                        </div>
                        {latestRunError ? (
                          <div
                            className={`truncate text-[#B42318] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                          >
                            {latestRunError}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div
                    data-ripple-automation-actions
                    className="mt-2 hidden grid-cols-3 gap-1.5 md:grid md:grid-cols-5"
                  >
                    {isConfirmingDelete ? (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        aria-label={t("automations.cancelDeleteAutomation")}
                        title={t("automations.cancelDeleteAutomation")}
                        className={automationActionButtonClass}
                      >
                        <X size={14} />
                        {t("automations.cancel")}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => beginEditSchedule(schedule)}
                      aria-label={t("automations.editAutomation")}
                      title={t("automations.editAutomation")}
                      className={automationActionButtonClass}
                    >
                      <Edit3 size={14} />
                      <span>{t("automations.edit")}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void handleAction(schedule.schedule_id, "toggle", schedule.enabled)
                      }
                      aria-label={
                        schedule.enabled
                          ? t("automations.pauseAutomation")
                          : t("automations.resumeAutomation")
                      }
                      title={
                        schedule.enabled
                          ? t("automations.pauseAutomation")
                          : t("automations.resumeAutomation")
                      }
                      className={automationActionButtonClass}
                    >
                      {pendingActionId === `${schedule.schedule_id}:toggle` ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : schedule.enabled ? (
                        <Pause size={14} />
                      ) : (
                        <Play size={14} />
                      )}
                      {schedule.enabled ? (
                        <span>{t("automations.pause")}</span>
                      ) : (
                        <span>{t("automations.resume")}</span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleAction(schedule.schedule_id, "run")}
                      aria-label={t("automations.runAutomationNow")}
                      title={t("automations.runAutomationNow")}
                      className={automationActionButtonClass}
                    >
                      {pendingActionId === `${schedule.schedule_id}:run` ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Zap size={14} />
                      )}
                      <span>{t("automations.runNow")}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedScheduleId((current) =>
                          current === schedule.schedule_id ? null : schedule.schedule_id
                        )
                      }
                      aria-label={t("automations.toggleRunHistory")}
                      title={t("automations.toggleRunHistory")}
                      className={automationActionButtonClass}
                    >
                      <ChevronDown
                        size={14}
                        className={
                          isExpanded ? "rotate-180 transition-transform" : "transition-transform"
                        }
                      />
                      <span>{t("automations.runHistory")}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleAction(schedule.schedule_id, "delete")}
                      aria-label={t("automations.deleteAutomation")}
                      title={
                        isConfirmingDelete
                          ? t("automations.confirmDeleteAutomation")
                          : t("automations.deleteAutomation")
                      }
                      className={`${automationDeleteButtonClass} ${
                        isConfirmingDelete
                          ? "border-[#B42318]/25 bg-[#FFF1F0] text-[#B42318]"
                          : "border-[#DEE0E3] bg-white text-[#8F959E] hover:bg-[#FFF1F0] hover:text-[#B42318]"
                      }`}
                    >
                      {pendingActionId === `${schedule.schedule_id}:delete` ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : isConfirmingDelete ? (
                        <span className={TYPOGRAPHY_META_MEDIUM_CLASS}>
                          {t("automations.confirm")}
                        </span>
                      ) : (
                        <>
                          <Trash2 size={14} />
                          <span>{t("automations.delete")}</span>
                        </>
                      )}
                    </button>
                  </div>

                  {isExpanded ? (
                    <div
                      data-ripple-automation-run-history
                      className="mt-2 rounded-lg border border-[#EFF0F1] bg-[#F8F9FA]/60 p-2"
                    >
                      <div className="mb-1 flex items-center justify-between gap-3">
                        <div
                          className={`tracking-normal text-[#646A73] uppercase ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                        >
                          {t("automations.runHistory")}
                        </div>
                        <div
                          className={`font-[family-name:var(--font-mono)] text-[#8F959E] ${TYPOGRAPHY_META_CLASS}`}
                        >
                          {t("automations.runCount", {
                            count: runs.length,
                            label: runs.length === 1 ? "run" : "runs",
                          })}
                        </div>
                      </div>
                      {runs.length === 0 ? (
                        <div className={`text-[#646A73] ${TYPOGRAPHY_META_CLASS}`}>
                          {t("automations.noRunsYet")}
                        </div>
                      ) : (
                        <div className="max-h-44 overflow-y-auto">
                          <div className="divide-y divide-[#EFF0F1]">
                            {runs.map((run) => {
                              const errorText = runErrorText(run);
                              const runDeleteKey = `${schedule.schedule_id}:${run.job_id}`;
                              const confirmingRunDelete = confirmRunDeleteId === runDeleteKey;
                              return (
                                <div
                                  key={run.job_id}
                                  data-ripple-automation-run-row
                                  className={`grid gap-1.5 py-1.5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center ${TYPOGRAPHY_META_CLASS}`}
                                >
                                  <div className="min-w-0">
                                    <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
                                      <span
                                        className={`w-fit shrink-0 rounded-full border px-1.5 py-0.5 ${TYPOGRAPHY_MICRO_MEDIUM_CLASS} ${runStatusClass(
                                          run.status
                                        )}`}
                                      >
                                        {run.status}
                                      </span>
                                      <span
                                        className={`truncate font-[family-name:var(--font-mono)] text-[#2B2F36] ${TYPOGRAPHY_META_CLASS}`}
                                      >
                                        {run.job_id}
                                      </span>
                                      <span
                                        className={`shrink-0 whitespace-nowrap text-[#646A73] ${TYPOGRAPHY_META_CLASS}`}
                                      >
                                        {formatDate(run.updated_at, locale, t)}
                                      </span>
                                    </div>
                                    {errorText ? (
                                      <div
                                        className={`mt-1 truncate text-[#B42318] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                                      >
                                        {errorText}
                                      </div>
                                    ) : null}
                                  </div>
                                  <div className="flex flex-wrap gap-1.5 md:justify-end">
                                    {hasRunOutput(run) ? (
                                      <>
                                        <button
                                          type="button"
                                          onClick={() => void handleViewOutput(run, schedule.title)}
                                          disabled={pendingRunActionId === `${run.job_id}:view`}
                                          className={mobileRunActionButtonClass}
                                        >
                                          <Eye size={14} />
                                          <span className="sm:hidden">
                                            {t("automations.outputShort")}
                                          </span>
                                          <span className="hidden sm:inline">
                                            {t("automations.viewOutput")}
                                          </span>
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => void handleDownloadOutput(run)}
                                          disabled={pendingRunActionId === `${run.job_id}:download`}
                                          className={mobileRunActionButtonClass}
                                        >
                                          <Download size={14} />
                                          <span className="sm:hidden">
                                            {t("automations.downloadShort")}
                                          </span>
                                          <span className="hidden sm:inline">
                                            {t("automations.downloadOutput")}
                                          </span>
                                        </button>
                                      </>
                                    ) : null}
                                    {confirmingRunDelete ? (
                                      <button
                                        type="button"
                                        onClick={() => setConfirmRunDeleteId(null)}
                                        className={mobileRunActionButtonClass}
                                      >
                                        <span>{t("automations.cancel")}</span>
                                      </button>
                                    ) : null}
                                    <button
                                      type="button"
                                      onClick={() =>
                                        void handleDeleteRun(schedule.schedule_id, run)
                                      }
                                      disabled={
                                        pendingRunActionId === `${run.job_id}:delete` ||
                                        isActiveRunStatus(run.status)
                                      }
                                      title={
                                        isActiveRunStatus(run.status)
                                          ? t("automations.waitUntilRunFinishes")
                                          : confirmingRunDelete
                                            ? t("automations.confirmDeleteRunRecord")
                                            : t("automations.deleteRunRecord")
                                      }
                                      aria-label={
                                        confirmingRunDelete
                                          ? t("automations.confirmDeleteRunRecord")
                                          : t("automations.deleteRunRecord")
                                      }
                                      className={`${mobileRunActionButtonClass} ${
                                        confirmingRunDelete
                                          ? "border-[#B42318]/25 bg-[#FFF1F0] text-[#B42318]"
                                          : "text-[#8F959E] hover:bg-[#FFF1F0] hover:text-[#B42318]"
                                      }`}
                                    >
                                      {pendingRunActionId === `${run.job_id}:delete` ? (
                                        <Loader2 size={14} className="animate-spin" />
                                      ) : confirmingRunDelete ? (
                                        <span>{t("automations.confirmDelete")}</span>
                                      ) : (
                                        <>
                                          <Trash2 size={14} />
                                          <span className="sm:hidden">
                                            {t("automations.deleteShort")}
                                          </span>
                                          <span className="hidden sm:inline">
                                            {t("automations.deleteRecord")}
                                          </span>
                                        </>
                                      )}
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        <div
          data-ripple-automation-detail-swipe-stack="true"
          className="pointer-events-none fixed inset-0 z-30 md:hidden"
        >
          <AnimatePresence
            mode="popLayout"
            initial={false}
            custom={skipNextDetailTransition ? 0 : detailTransitionDirection}
          >
            {selectedSchedule ? (
              <motion.div
                key={`detail:${selectedSchedule.schedule_id}`}
                data-ripple-automation-detail-motion-stage="true"
                custom={skipNextDetailTransition ? 0 : detailTransitionDirection}
                variants={
                  skipNextDetailTransition || reduceMotion
                    ? reducedMobilePageVariants
                    : mobilePageVariants
                }
                initial={skipNextDetailTransition ? false : "enter"}
                animate="center"
                exit="exit"
                transition={
                  skipNextDetailTransition || reduceMotion
                    ? reducedMotionTransition
                    : mobilePageSwitchTransition
                }
                className="pointer-events-none h-full min-h-0 w-full min-w-0"
              >
                <motion.div
                  data-ripple-automation-detail-swipe-sheet="true"
                  data-ripple-automation-detail-scroll="detail"
                  data-ripple-automation-detail-swiping={isDetailSwipeActive ? "true" : "false"}
                  style={{ x: detailSwipeX }}
                  className={`pointer-events-auto h-full min-h-0 touch-pan-y overflow-y-auto border-l bg-[#F5F6F7] px-3 ${MOBILE_PAGE_TOP_SAFE_AREA_CLASS} ${MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS} ${isDetailSwipeActive ? "border-[#D0D3D6]" : "border-transparent"} ${isDetailSwipeActive ? "will-change-transform" : "will-change-auto"}`}
                  onPointerDownCapture={handleDetailSwipePointerDown}
                  onPointerMoveCapture={handleDetailSwipePointerMove}
                  onPointerUpCapture={handleDetailSwipePointerUp}
                  onPointerCancelCapture={handleDetailSwipePointerCancel}
                  onClickCapture={handleDetailSwipeClickCapture}
                  onTouchStartCapture={handleDetailSwipeTouchStartCapture}
                  onTouchMoveCapture={handleDetailSwipeTouchMoveCapture}
                  onTouchEndCapture={clearDetailSwipeTouchGuard}
                  onTouchCancelCapture={clearDetailSwipeTouchGuard}
                >
                  {(() => {
                    const schedule = selectedSchedule;
                    const runs = runsBySchedule[schedule.schedule_id] || [];
                    const latestRun = runs[0] || null;
                    const latestRunStatus = latestRun?.status || schedule.last_run_status || null;
                    const latestRunAt = latestRun?.updated_at || schedule.last_run_at;
                    const scheduleError = schedule.status === "error" ? schedule.last_error : null;
                    const latestRunError = runErrorText(latestRun) || scheduleError;
                    const isExpanded = expandedScheduleId === schedule.schedule_id;
                    const isConfirmingDelete = confirmDeleteId === schedule.schedule_id;

                    return (
                      <div data-ripple-automation-detail-page="true" className="space-y-2.5">
                        <MobilePageHeader
                          title={schedule.title}
                          subtitle={formatDate(schedule.next_run_at, locale, t)}
                          titleClassName={MOBILE_DETAIL_HEADER_TITLE_CLASS}
                          backButtonVariant="ghost"
                          backLabel={t("automations.backToAutomations")}
                          onBack={closeScheduleDetail}
                          className={MOBILE_DETAIL_PAGE_HEADER_CLASS}
                        />

                        <section className={`grid gap-2 p-3 ${WORKBENCH_SECTION_CLASS}`}>
                          <div className="flex min-w-0 items-start gap-2.5">
                            <IconTile
                              tone={schedule.enabled ? "accent" : "neutral"}
                              size="xs"
                              className="mt-0.5"
                            >
                              <CalendarClock size={14} />
                            </IconTile>
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-center gap-2">
                                <span
                                  className={`min-w-0 truncate ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
                                >
                                  {schedule.title}
                                </span>
                                <span
                                  className={`shrink-0 rounded-full border px-1.5 py-0.5 capitalize ${TYPOGRAPHY_MICRO_MEDIUM_CLASS} ${statusClass(
                                    schedule.status
                                  )}`}
                                >
                                  {schedule.status}
                                </span>
                              </div>
                              <div
                                className={`mt-1 whitespace-pre-wrap text-[#646A73] ${TYPOGRAPHY_BODY_CLASS}`}
                              >
                                {schedule.prompt}
                              </div>
                              {schedule.status === "error" && schedule.last_error ? (
                                <div
                                  className={`mt-2 break-words text-[#B42318] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                                >
                                  {schedule.last_error}
                                </div>
                              ) : null}
                            </div>
                          </div>
                        </section>

                        <div data-ripple-automation-detail-grid className="grid gap-2">
                          <div
                            data-ripple-automation-meta-grid
                            className="grid grid-cols-2 gap-1.5"
                          >
                            <div
                              data-ripple-automation-meta-cell
                              className="min-w-0 rounded-lg border border-[#EFF0F1] bg-white px-2 py-1"
                            >
                              <div
                                className={`tracking-normal text-[#8F959E] uppercase ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                              >
                                {t("automations.next")}
                              </div>
                              <div
                                className={`mt-0.5 truncate text-[#2B2F36] ${TYPOGRAPHY_META_CLASS}`}
                              >
                                {formatDate(schedule.next_run_at, locale, t)}
                              </div>
                            </div>
                            <div
                              data-ripple-automation-meta-cell
                              className="min-w-0 rounded-lg border border-[#EFF0F1] bg-white px-2 py-1"
                            >
                              <div
                                className={`tracking-normal text-[#8F959E] uppercase ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                              >
                                {t("automations.repeat")}
                              </div>
                              <div
                                className={`mt-0.5 font-[family-name:var(--font-mono)] break-words text-[#2B2F36] ${TYPOGRAPHY_META_CLASS}`}
                              >
                                {schedule.kind === "interval"
                                  ? `${intervalLabel(schedule.interval_seconds, t)} · ${runCountLabel(schedule, t)}`
                                  : t("automations.once")}
                              </div>
                            </div>
                          </div>

                          <div
                            data-ripple-automation-latest-run
                            className={`grid min-w-0 gap-1.5 rounded-lg border border-[#EFF0F1] bg-white px-2 py-1.5 ${TYPOGRAPHY_META_CLASS}`}
                          >
                            <div className="flex min-w-0 items-start justify-between gap-2">
                              <span
                                className={`tracking-normal text-[#8F959E] uppercase ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                              >
                                {t("automations.latestRun")}
                              </span>
                              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                                <span className={`text-[#646A73] ${TYPOGRAPHY_META_CLASS}`}>
                                  {latestRunAt
                                    ? formatDate(latestRunAt, locale, t)
                                    : t("automations.never")}
                                </span>
                                <span
                                  className={`rounded-full border px-1.5 py-0.5 ${TYPOGRAPHY_MICRO_MEDIUM_CLASS} ${runStatusClass(
                                    latestRunStatus
                                  )}`}
                                >
                                  {latestRunStatus || t("automations.none")}
                                </span>
                              </div>
                            </div>
                            {latestRunError ? (
                              <div
                                className={`break-words text-[#B42318] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                              >
                                {latestRunError}
                              </div>
                            ) : null}
                          </div>
                        </div>

                        <div
                          data-ripple-automation-mobile-detail-actions
                          data-ripple-ignore-automations-swipe
                          className="grid grid-cols-2 gap-1.5"
                        >
                          <button
                            type="button"
                            onClick={() => void handleAction(schedule.schedule_id, "run")}
                            aria-label={t("automations.runAutomationNow")}
                            title={t("automations.runAutomationNow")}
                            className={mobileAutomationActionButtonClass}
                          >
                            {pendingActionId === `${schedule.schedule_id}:run` ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <Zap size={14} />
                            )}
                            <span>{t("automations.runNow")}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleAction(schedule.schedule_id, "delete")}
                            aria-label={t("automations.deleteAutomation")}
                            title={
                              isConfirmingDelete
                                ? t("automations.confirmDeleteAutomation")
                                : t("automations.deleteAutomation")
                            }
                            className={`${mobileAutomationDeleteButtonClass} ${
                              isConfirmingDelete
                                ? "border-[#B42318]/25 bg-[#FFF1F0] text-[#B42318]"
                                : "border-[#DEE0E3] bg-white text-[#8F959E] active:bg-[#FFF1F0] active:text-[#B42318]"
                            }`}
                          >
                            {pendingActionId === `${schedule.schedule_id}:delete` ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : isConfirmingDelete ? (
                              <span>{t("automations.confirm")}</span>
                            ) : (
                              <>
                                <Trash2 size={14} />
                                <span>{t("automations.delete")}</span>
                              </>
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              beginEditSchedule(schedule);
                            }}
                            aria-label={t("automations.editAutomation")}
                            title={t("automations.editAutomation")}
                            className={mobileAutomationActionButtonClass}
                          >
                            <Edit3 size={14} />
                            <span>{t("automations.edit")}</span>
                          </button>
                          {isConfirmingDelete ? (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              aria-label={t("automations.cancelDeleteAutomation")}
                              title={t("automations.cancelDeleteAutomation")}
                              className={mobileAutomationActionButtonClass}
                            >
                              <X size={14} />
                              <span>{t("automations.cancel")}</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() =>
                                void handleAction(schedule.schedule_id, "toggle", schedule.enabled)
                              }
                              aria-label={
                                schedule.enabled
                                  ? t("automations.pauseAutomation")
                                  : t("automations.resumeAutomation")
                              }
                              title={
                                schedule.enabled
                                  ? t("automations.pauseAutomation")
                                  : t("automations.resumeAutomation")
                              }
                              className={mobileAutomationActionButtonClass}
                            >
                              {pendingActionId === `${schedule.schedule_id}:toggle` ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : schedule.enabled ? (
                                <Pause size={14} />
                              ) : (
                                <Play size={14} />
                              )}
                              <span>
                                {schedule.enabled
                                  ? t("automations.pause")
                                  : t("automations.resume")}
                              </span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedScheduleId((current) =>
                                current === schedule.schedule_id ? null : schedule.schedule_id
                              )
                            }
                            aria-label={t("automations.toggleRunHistory")}
                            title={t("automations.toggleRunHistory")}
                            className={`${mobileAutomationActionButtonClass} col-span-2`}
                          >
                            <ChevronDown
                              size={14}
                              className={
                                isExpanded
                                  ? "rotate-180 transition-transform"
                                  : "transition-transform"
                              }
                            />
                            <span>{t("automations.runHistory")}</span>
                          </button>
                        </div>

                        {isExpanded ? (
                          <div
                            data-ripple-automation-run-history
                            className="rounded-lg border border-[#EFF0F1] bg-white p-2"
                          >
                            <div className="mb-1 flex items-center justify-between gap-3">
                              <div
                                className={`tracking-normal text-[#646A73] uppercase ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                              >
                                {t("automations.runHistory")}
                              </div>
                              <div
                                className={`font-[family-name:var(--font-mono)] text-[#8F959E] ${TYPOGRAPHY_META_CLASS}`}
                              >
                                {t("automations.runCount", {
                                  count: runs.length,
                                  label: runs.length === 1 ? "run" : "runs",
                                })}
                              </div>
                            </div>
                            {runs.length === 0 ? (
                              <div className={`text-[#646A73] ${TYPOGRAPHY_META_CLASS}`}>
                                {t("automations.noRunsYet")}
                              </div>
                            ) : (
                              <div className="max-h-64 overflow-y-auto">
                                <div className="divide-y divide-[#EFF0F1]">
                                  {runs.map((run) => {
                                    const errorText = runErrorText(run);
                                    const runDeleteKey = `${schedule.schedule_id}:${run.job_id}`;
                                    const confirmingRunDelete = confirmRunDeleteId === runDeleteKey;
                                    return (
                                      <div
                                        key={run.job_id}
                                        data-ripple-automation-run-row
                                        className={`grid gap-1.5 py-1.5 ${TYPOGRAPHY_META_CLASS}`}
                                      >
                                        <div className="min-w-0">
                                          <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
                                            <span
                                              className={`w-fit shrink-0 rounded-full border px-1.5 py-0.5 ${TYPOGRAPHY_MICRO_MEDIUM_CLASS} ${runStatusClass(
                                                run.status
                                              )}`}
                                            >
                                              {run.status}
                                            </span>
                                            <span
                                              className={`truncate font-[family-name:var(--font-mono)] text-[#2B2F36] ${TYPOGRAPHY_META_CLASS}`}
                                            >
                                              {run.job_id}
                                            </span>
                                          </div>
                                          <div
                                            className={`mt-0.5 text-[#646A73] ${TYPOGRAPHY_META_CLASS}`}
                                          >
                                            {formatDate(run.updated_at, locale, t)}
                                          </div>
                                          {errorText ? (
                                            <div
                                              className={`mt-1 break-words text-[#B42318] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                                            >
                                              {errorText}
                                            </div>
                                          ) : null}
                                        </div>
                                        <div
                                          data-ripple-ignore-automations-swipe
                                          className="flex flex-wrap gap-1.5"
                                        >
                                          {hasRunOutput(run) ? (
                                            <>
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  void handleViewOutput(run, schedule.title)
                                                }
                                                disabled={
                                                  pendingRunActionId === `${run.job_id}:view`
                                                }
                                                className={mobileRunActionButtonClass}
                                              >
                                                <Eye size={14} />
                                                <span>{t("automations.outputShort")}</span>
                                              </button>
                                              <button
                                                type="button"
                                                onClick={() => void handleDownloadOutput(run)}
                                                disabled={
                                                  pendingRunActionId === `${run.job_id}:download`
                                                }
                                                className={mobileRunActionButtonClass}
                                              >
                                                <Download size={14} />
                                                <span>{t("automations.downloadShort")}</span>
                                              </button>
                                            </>
                                          ) : null}
                                          {confirmingRunDelete ? (
                                            <button
                                              type="button"
                                              onClick={() => setConfirmRunDeleteId(null)}
                                              className={mobileRunActionButtonClass}
                                            >
                                              <span>{t("automations.cancel")}</span>
                                            </button>
                                          ) : null}
                                          <button
                                            type="button"
                                            onClick={() =>
                                              void handleDeleteRun(schedule.schedule_id, run)
                                            }
                                            disabled={
                                              pendingRunActionId === `${run.job_id}:delete` ||
                                              isActiveRunStatus(run.status)
                                            }
                                            title={
                                              isActiveRunStatus(run.status)
                                                ? t("automations.waitUntilRunFinishes")
                                                : confirmingRunDelete
                                                  ? t("automations.confirmDeleteRunRecord")
                                                  : t("automations.deleteRunRecord")
                                            }
                                            aria-label={
                                              confirmingRunDelete
                                                ? t("automations.confirmDeleteRunRecord")
                                                : t("automations.deleteRunRecord")
                                            }
                                            className={`${mobileRunActionButtonClass} ${
                                              confirmingRunDelete
                                                ? "border-[#B42318]/25 bg-[#FFF1F0] text-[#B42318]"
                                                : "text-[#8F959E] hover:bg-[#FFF1F0] hover:text-[#B42318]"
                                            }`}
                                          >
                                            {pendingRunActionId === `${run.job_id}:delete` ? (
                                              <Loader2 size={14} className="animate-spin" />
                                            ) : confirmingRunDelete ? (
                                              <span>{t("automations.confirmDelete")}</span>
                                            ) : (
                                              <>
                                                <Trash2 size={14} />
                                                <span>{t("automations.deleteShort")}</span>
                                              </>
                                            )}
                                          </button>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })()}
                </motion.div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        {outputPreview ? (
          <div className="fixed inset-0 z-50 flex items-end bg-black/30 p-3 sm:items-center sm:justify-center">
            <div className="max-h-[82vh] w-full overflow-hidden rounded-2xl border border-[#DEE0E3] bg-white shadow-[0_24px_80px_rgba(15,23,42,0.22)] sm:max-w-3xl">
              <div className="flex items-start justify-between gap-3 border-b border-[#EFF0F1] px-4 py-3">
                <div className="min-w-0">
                  <div className={`truncate ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>
                    {outputPreview.title}
                  </div>
                  <div
                    className={`mt-1 truncate font-[family-name:var(--font-mono)] text-[#646A73] ${TYPOGRAPHY_META_CLASS}`}
                  >
                    {outputPreview.jobId}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setOutputPreview(null)}
                  className={`inline-flex h-9 shrink-0 items-center justify-center rounded-full border border-[#DEE0E3] bg-white px-3 text-[#2B2F36] hover:bg-[#F8F9FA] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                >
                  {t("automations.close")}
                </button>
              </div>
              <div className="max-h-[calc(82vh-64px)] overflow-auto p-4">
                {outputPreview.loading ? (
                  <div
                    className={`flex h-32 items-center justify-center text-[#646A73] ${TYPOGRAPHY_BODY_CLASS}`}
                  >
                    <Loader2 size={16} className="mr-2 animate-spin" />
                    {t("automations.loadingOutput")}
                  </div>
                ) : outputPreview.error ? (
                  <div
                    className={`rounded-xl border border-[#B42318]/25 bg-[#FFF1F0] px-3 py-2 text-[#B42318] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
                  >
                    {outputPreview.error}
                  </div>
                ) : (
                  <pre
                    className={`font-[family-name:var(--font-mono)] break-words whitespace-pre-wrap text-[#1f2937] ${TYPOGRAPHY_BODY_CLASS}`}
                  >
                    {outputPreview.text || t("automations.emptyOutput")}
                  </pre>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
