"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowBigLeft,
  CalendarClock,
  ChevronDown,
  Download,
  Edit3,
  Eye,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Zap,
} from "lucide-react";
import { IconTile } from "@/components/icons/IconTile";
import { useI18n } from "@/i18n";
import {
  AuthError,
  createSchedule,
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
  COMPACT_IOS_PAGE_BACKGROUND,
  LUCIDE_NAV_STROKE_WIDTH,
  MOBILE_GLASS_ICON_BUTTON_CLASS,
  MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS,
  MOBILE_PAGE_TOP_SAFE_AREA_CLASS,
} from "./stylePrimitives";

interface AutomationsPageProps {
  selectedModel: string;
  models: { id: string; owned_by: string }[];
  onAuthExpired: (message: string) => void;
  onBack?: () => void;
}

type IntervalUnit = "minutes" | "hours" | "days";

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
  if (status === "active") return "border-[#1a7f37]/25 bg-[#dafbe1] text-[#1a7f37]";
  if (status === "paused") return "border-[#bf8700]/25 bg-[#fff8c5] text-[#7d4e00]";
  if (status === "completed") return "border-[#0969da]/20 bg-[#ddf4ff] text-[#0969da]";
  if (status === "error") return "border-[#cf222e]/25 bg-[#ffebe9] text-[#cf222e]";
  return "border-[#d7dce3] bg-[#f7f8fa] text-[#374151]";
}

function runStatusClass(status: string | null | undefined): string {
  if (status === "completed") return "border-[#1a7f37]/25 bg-[#dafbe1] text-[#1a7f37]";
  if (status === "failed" || status === "cancelled") {
    return "border-[#cf222e]/25 bg-[#ffebe9] text-[#cf222e]";
  }
  if (status === "queued" || status === "running") {
    return "border-[#0969da]/20 bg-[#ddf4ff] text-[#0969da]";
  }
  return "border-[#d7dce3] bg-[#f7f8fa] text-[#667085]";
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
  return Boolean(run?.output_available || run?.output_file);
}

const automationActionButtonClass =
  "inline-flex h-7 w-full min-w-0 items-center justify-center gap-1 rounded-full border border-[#dfe6f4] bg-white px-2 text-[10px] font-semibold text-[#384152] hover:bg-[#f7f8fa] [&>span]:min-w-0 [&>span]:truncate [&>svg]:shrink-0";

const automationDeleteButtonClass =
  "inline-flex h-7 w-full min-w-0 items-center justify-center gap-1 rounded-full border px-2 text-[10px] font-semibold [&>span]:min-w-0 [&>span]:truncate [&>svg]:shrink-0";

const runActionButtonClass =
  "inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-full border border-[#dfe6f4] bg-white px-1.5 text-[10px] font-semibold text-[#384152] hover:bg-[#f7f8fa] disabled:cursor-not-allowed disabled:opacity-60";

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
    setConfirmDeleteId(null);
    setError(null);
    setIsCreating(true);
  }

  const beginCreateSchedule = useCallback(() => {
    resetForm();
    setEditingScheduleId(null);
    setConfirmDeleteId(null);
    setError(null);
    setIsCreating(true);
  }, [resetForm]);

  const closeForm = useCallback(() => {
    resetForm();
    setEditingScheduleId(null);
    setIsCreating(false);
  }, [resetForm]);

  const handleSubmitSchedule = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!title.trim() || !prompt.trim()) return;
      setIsSubmitting(true);
      setError(null);
      try {
        const parsedMaxRuns = Number(maxRuns);
        const maxRunsLimit =
          kind === "interval" && maxRuns.trim() && Number.isFinite(parsedMaxRuns)
            ? Math.max(1, Math.floor(parsedMaxRuns))
            : null;
        const payload = {
          title: title.trim(),
          prompt: prompt.trim(),
          kind,
          timezone,
          run_at: runAt,
          interval_seconds: kind === "interval" ? intervalSeconds : null,
          max_runs: maxRunsLimit,
          model: formModel,
        };
        if (editingScheduleId) {
          await updateSchedule(editingScheduleId, payload);
        } else {
          await createSchedule(payload);
        }
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
      editingScheduleId,
      formModel,
      intervalSeconds,
      kind,
      loadSchedules,
      maxRuns,
      onAuthExpired,
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

  const handleRefreshRuns = useCallback(
    async (scheduleId: string) => {
      setPendingRunActionId(`${scheduleId}:refresh`);
      setError(null);
      try {
        await loadScheduleRuns(scheduleId);
      } catch (err) {
        if (err instanceof AuthError) {
          onAuthExpired(t("automations.apiKeyExpired"));
          return;
        }
        setError(err instanceof Error ? err.message : t("automations.failedToRefreshRuns"));
      } finally {
        setPendingRunActionId(null);
      }
    },
    [loadScheduleRuns, onAuthExpired, t]
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
      className={`h-full min-h-0 overflow-y-auto ${COMPACT_IOS_PAGE_BACKGROUND} px-4 ${MOBILE_PAGE_TOP_SAFE_AREA_CLASS} ${MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS} text-[#111827] md:px-6 lg:pb-4`}
    >
      <div className="mx-auto max-w-6xl space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3 pb-1">
          <div className="flex min-w-0 items-center gap-3">
            {onBack ? (
              <button
                type="button"
                onClick={onBack}
                aria-label={t("automations.backToSettings")}
                title={t("automations.backToSettings")}
                className={`${MOBILE_GLASS_ICON_BUTTON_CLASS} lg:hidden`}
              >
                <ArrowBigLeft size={16} strokeWidth={LUCIDE_NAV_STROKE_WIDTH} />
              </button>
            ) : null}
            <div className="min-w-0">
              <h1 className="text-[20px] leading-7 font-semibold tracking-normal">
                {t("automations.title")}
              </h1>
              <div className="mt-1 font-[family-name:var(--font-mono)] text-[11px] text-[#7a8496]">
                {t("automations.total", { count: schedules.length })}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadSchedules()}
              disabled={isLoading}
              aria-label={t("automations.refreshAutomations")}
              title={t("automations.refreshAutomations")}
              className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-[#dfe6f4] bg-white/78 text-[#384152] shadow-[0_10px_24px_rgba(44,63,123,0.06)] hover:bg-white disabled:opacity-60"
            >
              {isLoading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            </button>
            <button
              type="button"
              onClick={() => {
                if (isCreating && !editingScheduleId) {
                  closeForm();
                } else {
                  beginCreateSchedule();
                }
              }}
              className="inline-flex h-10 items-center gap-2 rounded-full bg-[#007aff] px-3 text-[13px] font-semibold text-white shadow-[0_12px_26px_rgba(0,122,255,0.22)] hover:bg-[#006ee6]"
            >
              <Plus size={15} />
              {t("automations.new")}
            </button>
          </div>
        </header>

        {error ? (
          <div className="flex items-start gap-2 rounded-xl border border-[#cf222e]/25 bg-[#ffebe9] px-3 py-3 text-sm font-medium text-[#cf222e]">
            <IconTile tone="danger" size="sm" className="mt-0.5">
              <AlertTriangle size={14} />
            </IconTile>
            <span className="min-w-0 break-words">{error}</span>
          </div>
        ) : null}

        {isCreating ? (
          <form
            onSubmit={handleSubmitSchedule}
            className="grid gap-4 rounded-2xl border border-[#dfe6f4] bg-white/74 p-4 shadow-[0_12px_30px_rgba(44,63,123,0.06)] backdrop-blur-xl"
          >
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px_220px]">
              <label className="block min-w-0">
                <span className="mb-1 block text-[11px] font-medium text-[#667085]">
                  {t("automations.titleLabel")}
                </span>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  className="h-9 w-full rounded-xl border border-[#dfe6f4] bg-white px-3 text-[13px] outline-none focus:border-[#8da0ff]"
                />
              </label>
              <label className="block min-w-0">
                <span className="mb-1 block text-[11px] font-medium text-[#667085]">
                  {t("automations.model")}
                </span>
                <select
                  value={formModel}
                  onChange={(event) => setFormModel(event.target.value)}
                  className="h-9 w-full rounded-xl border border-[#dfe6f4] bg-white px-3 text-[13px] outline-none focus:border-[#8da0ff]"
                >
                  {availableModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {formatModelName(model.id)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block min-w-0">
                <span className="mb-1 block text-[11px] font-medium text-[#667085]">
                  {t("automations.timezone")}
                </span>
                <select
                  value={timezone}
                  onChange={(event) => setTimezone(event.target.value)}
                  className="h-9 w-full rounded-xl border border-[#dfe6f4] bg-white px-3 font-[family-name:var(--font-mono)] text-xs outline-none focus:border-[#8da0ff]"
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
              <span className="mb-1 block text-[11px] font-medium text-[#667085]">
                {t("automations.prompt")}
              </span>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={4}
                className="w-full resize-none rounded-xl border border-[#dfe6f4] bg-white px-3 py-2 text-[13px] leading-5 outline-none focus:border-[#8da0ff]"
              />
            </label>

            <div className="grid gap-3 md:grid-cols-[190px_minmax(0,1fr)_auto] md:items-end">
              <div>
                <span className="mb-1 block text-[11px] font-medium text-[#667085]">
                  {t("automations.mode")}
                </span>
                <div className="grid grid-cols-2 rounded-xl border border-[#dfe6f4] bg-white p-0.5">
                  {(["once", "interval"] as ScheduleKind[]).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setKind(option)}
                      className={`h-8 rounded text-xs font-semibold ${
                        kind === option
                          ? "bg-[#007aff] text-white"
                          : "text-[#384152] hover:bg-[#f7f8fa]"
                      }`}
                    >
                      {option === "once" ? t("automations.once") : t("automations.interval")}
                    </button>
                  ))}
                </div>
              </div>

              {kind === "once" ? (
                <label className="block min-w-0">
                  <span className="mb-1 block text-[11px] font-medium text-[#667085]">
                    {t("automations.runAt")}
                  </span>
                  <input
                    type="datetime-local"
                    value={runAt}
                    onChange={(event) => setRunAt(event.target.value)}
                    className="h-9 w-full rounded-xl border border-[#dfe6f4] bg-white px-3 text-[13px] outline-none focus:border-[#8da0ff]"
                  />
                </label>
              ) : (
                <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_120px_130px]">
                  <label className="block min-w-0">
                    <span className="mb-1 block text-[11px] font-medium text-[#667085]">
                      {t("automations.every")}
                    </span>
                    <input
                      type="number"
                      min={1}
                      value={intervalValue}
                      onChange={(event) => setIntervalValue(Number(event.target.value) || 1)}
                      className="h-9 w-full rounded-xl border border-[#dfe6f4] bg-white px-3 text-[13px] outline-none focus:border-[#8da0ff]"
                    />
                  </label>
                  <label className="block min-w-0">
                    <span className="mb-1 block text-[11px] font-medium text-[#667085]">
                      {t("automations.unit")}
                    </span>
                    <select
                      value={intervalUnit}
                      onChange={(event) => setIntervalUnit(event.target.value as IntervalUnit)}
                      className="h-9 w-full rounded-xl border border-[#dfe6f4] bg-white px-3 text-[13px] outline-none focus:border-[#8da0ff]"
                    >
                      <option value="minutes">{t("automations.minutes")}</option>
                      <option value="hours">{t("automations.hours")}</option>
                      <option value="days">{t("automations.days")}</option>
                    </select>
                  </label>
                  <label className="block min-w-0">
                    <span className="mb-1 block text-[11px] font-medium text-[#667085]">
                      {t("automations.maxRuns")}
                    </span>
                    <input
                      type="number"
                      min={1}
                      placeholder={t("automations.noLimit")}
                      value={maxRuns}
                      onChange={(event) => setMaxRuns(event.target.value)}
                      className="h-9 w-full rounded-xl border border-[#dfe6f4] bg-white px-3 text-[13px] outline-none focus:border-[#8da0ff]"
                    />
                  </label>
                </div>
              )}

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={closeForm}
                  className="inline-flex h-10 items-center justify-center rounded-full border border-[#dfe6f4] bg-white px-4 text-[13px] font-semibold text-[#384152] shadow-[0_10px_24px_rgba(44,63,123,0.04)] hover:bg-[#f7f8fa]"
                  disabled={isSubmitting}
                >
                  {t("automations.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !title.trim() || !prompt.trim()}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-[#007aff] px-4 text-[13px] font-semibold text-white shadow-[0_12px_26px_rgba(0,122,255,0.22)] hover:bg-[#006ee6] disabled:cursor-not-allowed disabled:bg-[#e5e7eb] disabled:bg-none disabled:text-[#8b8f94] disabled:shadow-none"
                >
                  {isSubmitting ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <CalendarClock size={14} />
                  )}
                  {editingScheduleId ? t("automations.save") : t("automations.create")}
                </button>
              </div>
            </div>
          </form>
        ) : null}

        <div className="overflow-hidden rounded-2xl border border-[#dfe6f4] bg-white/74 shadow-[0_12px_30px_rgba(44,63,123,0.06)] backdrop-blur-xl">
          {schedules.length === 0 && !isLoading ? (
            <div className="flex h-44 items-center justify-center text-[13px] text-[#667085]">
              {t("automations.noAutomations")}
            </div>
          ) : (
            <div className="divide-y divide-[#e8edf7]">
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
                    className="px-3 py-2 sm:px-4 sm:py-2.5 xl:px-5"
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
                              <span className="min-w-0 truncate text-[13px] font-semibold sm:text-[14px]">
                                {schedule.title}
                              </span>
                              <span
                                className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold capitalize ${statusClass(
                                  schedule.status
                                )}`}
                              >
                                {schedule.status}
                              </span>
                            </div>
                            <div className="mt-0.5 line-clamp-1 text-[12px] leading-4 text-[#667085]">
                              {schedule.prompt}
                            </div>
                            {schedule.status === "error" && schedule.last_error ? (
                              <div className="mt-1 truncate text-xs font-medium text-[#cf222e]">
                                {schedule.last_error}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>

                      <div
                        data-ripple-automation-detail-grid
                        className="grid gap-1.5 md:grid-cols-[minmax(0,1fr)_minmax(260px,320px)]"
                      >
                        <div data-ripple-automation-meta-grid className="grid grid-cols-2 gap-1.5">
                          <div
                            data-ripple-automation-meta-cell
                            className="min-w-0 rounded-lg border border-[#eef2fb] bg-[#f8fbff]/80 px-2 py-1"
                          >
                            <div className="text-[10px] font-semibold tracking-normal text-[#8b8f94] uppercase">
                              {t("automations.next")}
                            </div>
                            <div className="mt-0.5 truncate text-[11px] font-semibold text-[#111827]">
                              {formatDate(schedule.next_run_at, locale, t)}
                            </div>
                          </div>
                          <div
                            data-ripple-automation-meta-cell
                            className="min-w-0 rounded-lg border border-[#eef2fb] bg-[#f8fbff]/80 px-2 py-1"
                          >
                            <div className="text-[10px] font-semibold tracking-normal text-[#8b8f94] uppercase">
                              {t("automations.repeat")}
                            </div>
                            <div className="mt-0.5 truncate font-[family-name:var(--font-mono)] text-[10px] text-[#384152]">
                              {schedule.kind === "interval"
                                ? `${intervalLabel(schedule.interval_seconds, t)} · ${runCountLabel(schedule, t)}`
                                : t("automations.once")}
                            </div>
                          </div>
                        </div>

                        <div
                          data-ripple-automation-latest-run
                          className="grid min-w-0 gap-1.5 rounded-lg border border-[#e8edf7] bg-[#f8fbff]/70 px-2 py-1.5 text-[11px]"
                        >
                          <div className="flex min-w-0 items-start justify-between gap-2">
                            <span className="text-[10px] font-semibold tracking-normal text-[#8b8f94] uppercase">
                              {t("automations.latestRun")}
                            </span>
                            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                              <span className="text-[10px] text-[#667085]">
                                {latestRunAt
                                  ? formatDate(latestRunAt, locale, t)
                                  : t("automations.never")}
                              </span>
                              <span
                                className={`rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${runStatusClass(
                                  latestRunStatus
                                )}`}
                              >
                                {latestRunStatus || t("automations.none")}
                              </span>
                            </div>
                          </div>
                          {latestRunError ? (
                            <div className="truncate text-[11px] font-medium text-[#cf222e]">
                              {latestRunError}
                            </div>
                          ) : null}
                          <div className="flex flex-wrap gap-1.5">
                            <button
                              type="button"
                              onClick={() => void handleRefreshRuns(schedule.schedule_id)}
                              disabled={pendingRunActionId === `${schedule.schedule_id}:refresh`}
                              className={runActionButtonClass}
                            >
                              {pendingRunActionId === `${schedule.schedule_id}:refresh` ? (
                                <Loader2 size={11} className="animate-spin" />
                              ) : (
                                <RefreshCw size={11} />
                              )}
                              <span>{t("automations.refresh")}</span>
                            </button>
                            {hasRunOutput(latestRun) ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => void handleViewOutput(latestRun, schedule.title)}
                                  disabled={pendingRunActionId === `${latestRun.job_id}:view`}
                                  className={runActionButtonClass}
                                >
                                  {pendingRunActionId === `${latestRun.job_id}:view` ? (
                                    <Loader2 size={11} className="animate-spin" />
                                  ) : (
                                    <Eye size={11} />
                                  )}
                                  <span>{t("automations.viewOutput")}</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleDownloadOutput(latestRun)}
                                  disabled={pendingRunActionId === `${latestRun.job_id}:download`}
                                  className={runActionButtonClass}
                                >
                                  {pendingRunActionId === `${latestRun.job_id}:download` ? (
                                    <Loader2 size={11} className="animate-spin" />
                                  ) : (
                                    <Download size={11} />
                                  )}
                                  <span>{t("automations.downloadOutput")}</span>
                                </button>
                              </>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div
                      data-ripple-automation-actions
                      className="mt-2 grid grid-cols-3 gap-1.5 md:grid-cols-5"
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
                            ? "border-[#cf222e]/25 bg-[#ffebe9] text-[#cf222e]"
                            : "border-[#dfe6f4] bg-white text-[#8b8f94] hover:bg-[#ffebe9] hover:text-[#cf222e]"
                        }`}
                      >
                        {pendingActionId === `${schedule.schedule_id}:delete` ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : confirmDeleteId === schedule.schedule_id ? (
                          <span className="text-[11px] font-semibold">
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
                        className="mt-4 border-t border-[#e8edf7] pt-3"
                      >
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <div className="text-[11px] font-semibold tracking-normal text-[#667085] uppercase">
                            {t("automations.runHistory")}
                          </div>
                          <div className="font-[family-name:var(--font-mono)] text-[10px] text-[#8b8f94]">
                            {t("automations.runCount", {
                              count: runs.length,
                              label: runs.length === 1 ? "run" : "runs",
                            })}
                          </div>
                        </div>
                        {runs.length === 0 ? (
                          <div className="text-[12px] text-[#667085]">
                            {t("automations.noRunsYet")}
                          </div>
                        ) : (
                          <div className="divide-y divide-[#eef2fb]">
                            {runs.map((run) => {
                              const errorText = runErrorText(run);
                              const runDeleteKey = `${schedule.schedule_id}:${run.job_id}`;
                              const confirmingRunDelete = confirmRunDeleteId === runDeleteKey;
                              return (
                                <div
                                  key={run.job_id}
                                  data-ripple-automation-run-row
                                  className="grid gap-2 py-2.5 text-[12px] md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
                                >
                                  <div className="min-w-0">
                                    <div className="grid min-w-0 gap-1.5 sm:grid-cols-[90px_minmax(0,1fr)_120px] sm:items-center">
                                      <span
                                        className={`w-fit rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${runStatusClass(
                                          run.status
                                        )}`}
                                      >
                                        {run.status}
                                      </span>
                                      <span className="truncate font-[family-name:var(--font-mono)] text-[11px] text-[#384152]">
                                        {run.job_id}
                                      </span>
                                      <span className="text-[11px] text-[#667085]">
                                        {formatDate(run.updated_at, locale, t)}
                                      </span>
                                    </div>
                                    {errorText ? (
                                      <div className="mt-1 truncate text-[11px] font-medium text-[#cf222e]">
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
                                          <Eye size={12} />
                                          <span>{t("automations.viewOutput")}</span>
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => void handleDownloadOutput(run)}
                                          disabled={pendingRunActionId === `${run.job_id}:download`}
                                          className={runActionButtonClass}
                                        >
                                          <Download size={12} />
                                          <span>{t("automations.downloadOutput")}</span>
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
                                          ? "border-[#cf222e]/25 bg-[#ffebe9] text-[#cf222e]"
                                          : "text-[#8b8f94] hover:bg-[#ffebe9] hover:text-[#cf222e]"
                                      }`}
                                    >
                                      {pendingRunActionId === `${run.job_id}:delete` ? (
                                        <Loader2 size={12} className="animate-spin" />
                                      ) : confirmingRunDelete ? (
                                        <span>{t("automations.confirmDelete")}</span>
                                      ) : (
                                        <>
                                          <Trash2 size={12} />
                                          <span>{t("automations.deleteRecord")}</span>
                                        </>
                                      )}
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {outputPreview ? (
          <div className="fixed inset-0 z-50 flex items-end bg-black/30 p-3 sm:items-center sm:justify-center">
            <div className="max-h-[82vh] w-full overflow-hidden rounded-2xl border border-[#dfe6f4] bg-white shadow-[0_24px_80px_rgba(15,23,42,0.22)] sm:max-w-3xl">
              <div className="flex items-start justify-between gap-3 border-b border-[#e8edf7] px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold">{outputPreview.title}</div>
                  <div className="mt-1 truncate font-[family-name:var(--font-mono)] text-[11px] text-[#667085]">
                    {outputPreview.jobId}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setOutputPreview(null)}
                  className="inline-flex h-8 shrink-0 items-center justify-center rounded-full border border-[#dfe6f4] bg-white px-3 text-[11px] font-semibold text-[#384152] hover:bg-[#f7f8fa]"
                >
                  {t("automations.close")}
                </button>
              </div>
              <div className="max-h-[calc(82vh-64px)] overflow-auto p-4">
                {outputPreview.loading ? (
                  <div className="flex h-32 items-center justify-center text-[13px] text-[#667085]">
                    <Loader2 size={16} className="mr-2 animate-spin" />
                    {t("automations.loadingOutput")}
                  </div>
                ) : outputPreview.error ? (
                  <div className="rounded-xl border border-[#cf222e]/25 bg-[#ffebe9] px-3 py-2 text-[13px] font-medium text-[#cf222e]">
                    {outputPreview.error}
                  </div>
                ) : (
                  <pre className="font-[family-name:var(--font-mono)] text-[12px] leading-5 break-words whitespace-pre-wrap text-[#1f2937]">
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
