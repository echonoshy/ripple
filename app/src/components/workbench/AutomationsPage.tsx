"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  CalendarPlus,
  ChevronDown,
  Download,
  Edit3,
  Eye,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Trash2,
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
  MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS,
  MOBILE_PAGE_TOP_SAFE_AREA_CLASS,
  TYPOGRAPHY_BODY_CLASS,
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_META_MEDIUM_CLASS,
  TYPOGRAPHY_MICRO_MEDIUM_CLASS,
  TYPOGRAPHY_MOBILE_BODY_CLASS,
  TYPOGRAPHY_PAGE_TITLE_CLASS,
  WORKBENCH_FIELD_CLASS,
  WORKBENCH_MOBILE_ICON_BUTTON_CLASS,
  WORKBENCH_PAGE_BACKGROUND_CLASS,
  WORKBENCH_PAGE_CONTENT_CLASS,
  WORKBENCH_SECTION_CLASS,
} from "./stylePrimitives";

interface AutomationsPageProps {
  selectedModel: string;
  models: { id: string; owned_by: string }[];
  onAuthExpired: (message: string) => void;
  onOpenChat?: (prompt: string, options?: { autoSend?: boolean; newSession?: boolean }) => void;
  onBack?: () => void;
}

type IntervalUnit = "minutes" | "hours" | "days";
type MissedRunPolicy = "run_once" | "skip";
type OverlapPolicy = "skip" | "allow";
type FailurePolicy = "pause" | "keep_active";

type OutputPreviewState = {
  jobId: string;
  title: string;
  text: string;
  loading: boolean;
  error: string | null;
} | null;

type Translator = ReturnType<typeof useI18n>["t"];

const intervalUnitSeconds: Record<IntervalUnit, number> = {
  minutes: 60,
  hours: 3600,
  days: 86_400,
};
const defaultMaxRuntimeSeconds = 1800;

const missedRunPolicyOptions: MissedRunPolicy[] = ["run_once", "skip"];
const overlapPolicyOptions: OverlapPolicy[] = ["skip", "allow"];
const failurePolicyOptions: FailurePolicy[] = ["pause", "keep_active"];

const commonTimezones = [
  "UTC",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Taipei",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Singapore",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
] as const;

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function supportedTimezones(): string[] {
  try {
    const supported = Intl.supportedValuesOf?.("timeZone") || [];
    return supported.length > 0 ? supported : [...commonTimezones];
  } catch {
    return [...commonTimezones];
  }
}

function timezoneOptions(currentTimezone: string): string[] {
  const options = new Set<string>();
  const current = currentTimezone.trim();
  if (current) {
    options.add(current);
  }
  for (const timezone of commonTimezones) {
    options.add(timezone);
  }
  for (const timezone of supportedTimezones()) {
    options.add(timezone);
  }
  return [...options];
}

function timezoneLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function localDatetimeValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function formatDate(value: string | null, locale: string, t: Translator): string {
  if (!value) return t("automations.notScheduled");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function intervalLabel(seconds: number | null, t: Translator): string {
  if (!seconds) return "";
  if (seconds % 86_400 === 0) {
    return t("automations.intervalEvery", { value: seconds / 86_400, unit: "d" });
  }
  if (seconds % 3600 === 0) {
    return t("automations.intervalEvery", { value: seconds / 3600, unit: "h" });
  }
  if (seconds % 60 === 0) {
    return t("automations.intervalEvery", { value: seconds / 60, unit: "m" });
  }
  return t("automations.intervalEvery", { value: seconds, unit: "s" });
}

function runCountLabel(schedule: ScheduleInfo, t: Translator): string {
  const runCount = Math.max(0, schedule.run_count || 0);
  if (schedule.kind !== "interval") {
    return t("automations.runCount", {
      count: runCount,
      label: runCount === 1 ? "run" : "runs",
    });
  }
  return schedule.max_runs
    ? t("automations.runsProgress", { count: runCount, max: schedule.max_runs })
    : t("automations.runsUnlimited", { count: runCount });
}

function statusClass(status: string): string {
  if (status === "active") return "border-[#16845B]/25 bg-[#E4F8EE] text-[#16845B]";
  if (status === "paused") return "border-[#D99900]/25 bg-[#FFF8DB] text-[#8B5E00]";
  if (status === "completed") return "border-[#1456F0]/20 bg-[#ddf4ff] text-[#1456F0]";
  if (status === "error") return "border-[#B42318]/25 bg-[#FFF1F0] text-[#B42318]";
  return "border-[#d7dce3] bg-[#F8F9FA] text-[#2B2F36]";
}

function runStatusClass(status: string | null | undefined): string {
  if (status === "completed") return "border-[#16845B]/25 bg-[#E4F8EE] text-[#16845B]";
  if (status === "failed" || status === "cancelled") {
    return "border-[#B42318]/25 bg-[#FFF1F0] text-[#B42318]";
  }
  if (status === "queued" || status === "running") {
    return "border-[#1456F0]/20 bg-[#ddf4ff] text-[#1456F0]";
  }
  return "border-[#d7dce3] bg-[#F8F9FA] text-[#646A73]";
}

function isActiveRunStatus(status: string | null | undefined): boolean {
  return status === "queued" || status === "running";
}

const ansiPattern = new RegExp(String.raw`\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])`, "g");

function stripAnsi(value: string): string {
  return value.replace(ansiPattern, "");
}

function cleanRunIssueText(value: string | null | undefined): string {
  return stripAnsi(value || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

function runErrorText(run: AgentRunInfo | null | undefined): string | null {
  if (!run) return null;
  if (!(run.status === "failed" || run.status === "cancelled")) return null;
  return (
    cleanRunIssueText(run.error) ||
    cleanRunIssueText(run.stderr_tail) ||
    cleanRunIssueText(run.stdout_tail) ||
    null
  );
}

function hasRunOutput(run: AgentRunInfo | null | undefined): boolean {
  return Boolean(run?.output_available && !isActiveRunStatus(run.status));
}

const automationActionButtonClass = `inline-flex h-8 w-full min-w-0 items-center justify-center gap-1 rounded-full border border-[#DEE0E3] bg-white px-2 text-[#2B2F36] hover:bg-[#F8F9FA] ${TYPOGRAPHY_META_MEDIUM_CLASS} [&>span]:min-w-0 [&>span]:truncate [&>svg]:shrink-0`;

const automationDeleteButtonClass = `inline-flex h-8 w-full min-w-0 items-center justify-center gap-1 rounded-full border px-2 ${TYPOGRAPHY_META_MEDIUM_CLASS} [&>span]:min-w-0 [&>span]:truncate [&>svg]:shrink-0`;

const runActionButtonClass = `inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-full border border-[#DEE0E3] bg-white px-2 text-[#2B2F36] hover:bg-[#F8F9FA] disabled:cursor-not-allowed disabled:opacity-60 ${TYPOGRAPHY_META_MEDIUM_CLASS} [&>span]:min-w-0 [&>span]:truncate [&>svg]:shrink-0`;

const AUTOMATION_PRIMARY_ACTION_BUTTON_CLASS = `inline-flex h-11 w-11 items-center justify-center rounded-full border border-[#1456F0]/30 bg-[#1456F0] text-white shadow-[0_8px_18px_rgba(20,86,240,0.18)] transition-all hover:bg-[#0F4BD8] active:scale-[0.98] disabled:opacity-60 lg:h-10 lg:w-auto lg:gap-1.5 lg:px-3 ${TYPOGRAPHY_META_MEDIUM_CLASS}`;

const automationFieldLabelClass = `mb-1 block text-[#646A73] ${TYPOGRAPHY_META_MEDIUM_CLASS}`;

const automationFieldControlClass = `${WORKBENCH_FIELD_CLASS} h-10 w-full px-3 ${TYPOGRAPHY_MOBILE_BODY_CLASS} lg:h-9 lg:text-[14px] lg:leading-[22px]`;

const automationMonoFieldControlClass = `${WORKBENCH_FIELD_CLASS} h-10 w-full px-3 font-[family-name:var(--font-mono)] ${TYPOGRAPHY_MOBILE_BODY_CLASS} lg:h-9 lg:text-[14px] lg:leading-[22px]`;

const automationTextareaClass = `${WORKBENCH_FIELD_CLASS} w-full resize-none px-3 py-2 ${TYPOGRAPHY_MOBILE_BODY_CLASS} lg:text-[14px] lg:leading-[22px]`;

function defaultRunAt(): string {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setSeconds(0, 0);
  return localDatetimeValue(date);
}

function datetimeInputValue(value: string | null): string {
  if (!value) return defaultRunAt();
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return localDatetimeValue(date);
  return value.slice(0, 16);
}

function intervalParts(seconds: number | null): { value: number; unit: IntervalUnit } {
  const normalized = Math.max(1, seconds || 3600);
  if (normalized % 86_400 === 0) return { value: normalized / 86_400, unit: "days" };
  if (normalized % 3600 === 0) return { value: normalized / 3600, unit: "hours" };
  if (normalized % 60 === 0) return { value: normalized / 60, unit: "minutes" };
  return { value: Math.ceil(normalized / 60), unit: "minutes" };
}

export default function AutomationsPage({
  selectedModel,
  models,
  onAuthExpired,
  onOpenChat,
  onBack,
}: AutomationsPageProps) {
  const { locale, t } = useI18n();
  const [schedules, setSchedules] = useState<ScheduleInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
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
  const [runsBySchedule, setRunsBySchedule] = useState<Record<string, AgentRunInfo[]>>({});
  const [expandedScheduleId, setExpandedScheduleId] = useState<string | null>(null);
  const [outputPreview, setOutputPreview] = useState<OutputPreviewState>(null);

  const intervalSeconds = useMemo(
    () => Math.max(1, intervalValue) * intervalUnitSeconds[intervalUnit],
    [intervalUnit, intervalValue]
  );
  const availableModels = useMemo(
    () => (models.length > 0 ? models : [{ id: selectedModel, owned_by: "ripple" }]),
    [models, selectedModel]
  );
  const availableTimezones = useMemo(() => timezoneOptions(timezone), [timezone]);

  const loadScheduleRuns = useCallback(async (scheduleId: string) => {
    const runs = await fetchScheduleRuns(scheduleId);
    setRunsBySchedule((current) => ({ ...current, [scheduleId]: runs }));
    return runs;
  }, []);

  const loadSchedules = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const records = await fetchSchedules();
      setSchedules(records);
      await Promise.all(records.map((schedule) => loadScheduleRuns(schedule.schedule_id)));
    } catch (err) {
      if (err instanceof AuthError) {
        onAuthExpired(t("automations.apiKeyExpired"));
        return;
      }
      setError(err instanceof Error ? err.message : t("automations.failedToLoad"));
    } finally {
      setIsLoading(false);
    }
  }, [loadScheduleRuns, onAuthExpired, t]);

  useEffect(() => {
    void loadSchedules();
  }, [loadSchedules]);

  useEffect(() => {
    const hasActiveRun = schedules.some((schedule) => {
      const latestRun = runsBySchedule[schedule.schedule_id]?.[0];
      return isActiveRunStatus(latestRun?.status || schedule.last_run_status);
    });
    if (!hasActiveRun) return;

    const timer = window.setInterval(() => {
      void loadSchedules();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [loadSchedules, runsBySchedule, schedules]);

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
        await loadSchedules();
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
        await loadSchedules();
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
        await loadSchedules();
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
              onClick={() => void loadSchedules()}
              disabled={isLoading}
              aria-label={t("automations.refreshAutomations")}
              title={t("automations.refreshAutomations")}
              className={`${WORKBENCH_MOBILE_ICON_BUTTON_CLASS} shrink-0 disabled:cursor-not-allowed disabled:opacity-60 lg:h-10 lg:w-auto lg:gap-1.5 lg:px-3 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
            >
              {isLoading ? (
                <Loader2
                  size={18}
                  strokeWidth={LUCIDE_NAV_STROKE_WIDTH}
                  className="animate-spin"
                />
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
          <>
            <div
              data-ripple-automation-form-backdrop
              className="fixed inset-0 z-40 bg-[#1F2329]/18 backdrop-blur-[1px] md:hidden"
              onClick={closeForm}
            />
            <form
              data-ripple-automation-form-sheet
              onSubmit={handleSubmitSchedule}
              className={`${WORKBENCH_SECTION_CLASS} grid gap-4 p-4 max-md:fixed max-md:inset-x-2 max-md:bottom-[max(env(safe-area-inset-bottom),8px)] max-md:z-50 max-md:max-h-[calc(100dvh-24px-env(safe-area-inset-top))] max-md:overflow-y-auto max-md:bg-white`}
            >
              <div className="flex items-center justify-between gap-2 md:hidden">
                <div className={`text-[#1F2329] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>
                  {t("automations.edit")}
                </div>
                <button
                  type="button"
                  onClick={closeForm}
                  className={`h-9 rounded-xl border border-[#DEE0E3] bg-white px-3 text-[#646A73] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                >
                  {t("automations.cancel")}
                </button>
              </div>
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px_220px]">
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
                  rows={4}
                  className={automationTextareaClass}
                />
              </label>

              <div className="grid gap-3 md:grid-cols-[190px_minmax(0,1fr)] md:items-end">
                <div>
                  <span className={automationFieldLabelClass}>{t("automations.mode")}</span>
                  <div className="grid grid-cols-2 rounded-xl border border-[#DEE0E3] bg-white p-0.5">
                    {(["once", "interval"] as ScheduleKind[]).map((option) => (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setKind(option)}
                        className={`h-9 rounded ${TYPOGRAPHY_BODY_MEDIUM_CLASS} ${
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
                      <span className={automationFieldLabelClass}>{t("automations.maxRuns")}</span>
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

              <button
                type="button"
                onClick={() => setIsAdvancedConfigOpen((current) => !current)}
                className={`inline-flex h-9 w-fit items-center gap-1 rounded-full border border-[#DEE0E3] bg-white px-3 text-[#2B2F36] hover:bg-[#F8F9FA] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
              >
                <ChevronDown
                  size={14}
                  className={
                    isAdvancedConfigOpen ? "rotate-180 transition-transform" : "transition-transform"
                  }
                />
                {t("automations.advancedConfig")}
              </button>

              {isAdvancedConfigOpen ? (
                <div
                  data-ripple-automation-advanced-config
                  className="grid gap-3 rounded-xl border border-[#EFF0F1] bg-[#F8F9FA] p-3 md:grid-cols-2 xl:grid-cols-5"
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
                      onChange={(event) => setMissedRunPolicy(event.target.value as MissedRunPolicy)}
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

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={closeForm}
                  className={`hidden h-10 items-center justify-center rounded-lg border border-[#DEE0E3] bg-white px-4 text-[#2B2F36] hover:bg-[#F8F9FA] md:inline-flex ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
                  disabled={isSubmitting}
                >
                  {t("automations.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !editingScheduleId || !title.trim() || !prompt.trim()}
                  className={`inline-flex h-10 items-center justify-center gap-2 rounded-full bg-[#1456F0] px-4 text-white shadow-[0_12px_26px_rgba(20,86,240,0.22)] hover:bg-[#0F4BD8] disabled:cursor-not-allowed disabled:bg-[#EFF0F1] disabled:bg-none disabled:text-[#8F959E] disabled:shadow-none ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
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
          </>
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

              return (
                <div
                  key={schedule.schedule_id}
                  data-ripple-automation-card-main
                  className="overflow-hidden rounded-xl border border-[#DEE0E3] bg-white px-3 py-2 shadow-[0_1px_2px_rgba(31,35,41,0.04)] sm:px-4 sm:py-2.5 xl:px-5"
                >
                  <div className="grid gap-2 xl:grid-cols-[minmax(260px,0.82fr)_minmax(0,1.35fr)] xl:items-start">
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
                    data-ripple-automation-mobile-primary-actions
                    className="mt-2 grid grid-cols-5 gap-1.5 md:hidden"
                  >
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
                      <span>{t("automations.runShort")}</span>
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
                      <span>{t("automations.historyShort")}</span>
                    </button>
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
                      <span>
                        {schedule.enabled ? t("automations.pause") : t("automations.resume")}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleAction(schedule.schedule_id, "delete")}
                      aria-label={t("automations.deleteAutomation")}
                      title={
                        confirmDeleteId === schedule.schedule_id
                          ? t("automations.confirmDeleteAutomation")
                          : t("automations.deleteAutomation")
                      }
                      className={`${automationDeleteButtonClass} ${
                        confirmDeleteId === schedule.schedule_id
                          ? "border-[#B42318]/25 bg-[#FFF1F0] text-[#B42318]"
                          : "border-[#DEE0E3] bg-white text-[#8F959E] active:bg-[#FFF1F0] active:text-[#B42318]"
                      }`}
                    >
                      {pendingActionId === `${schedule.schedule_id}:delete` ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : confirmDeleteId === schedule.schedule_id ? (
                        <span>{t("automations.confirm")}</span>
                      ) : (
                        <>
                          <Trash2 size={14} />
                          <span>{t("automations.delete")}</span>
                        </>
                      )}
                    </button>
                  </div>

                  <div
                    data-ripple-automation-actions
                    className="mt-2 hidden grid-cols-3 gap-1.5 md:grid md:grid-cols-5"
                  >
                    {confirmDeleteId === schedule.schedule_id ? (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className={automationActionButtonClass}
                      >
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
                        confirmDeleteId === schedule.schedule_id
                          ? t("automations.confirmDeleteAutomation")
                          : t("automations.deleteAutomation")
                      }
                      className={`${automationDeleteButtonClass} ${
                        confirmDeleteId === schedule.schedule_id
                          ? "border-[#B42318]/25 bg-[#FFF1F0] text-[#B42318]"
                          : "border-[#DEE0E3] bg-white text-[#8F959E] hover:bg-[#FFF1F0] hover:text-[#B42318]"
                      }`}
                    >
                      {pendingActionId === `${schedule.schedule_id}:delete` ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : confirmDeleteId === schedule.schedule_id ? (
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
                                          className={runActionButtonClass}
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
                                          className={runActionButtonClass}
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
                                        className={runActionButtonClass}
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
                                      className={`${runActionButtonClass} ${
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
