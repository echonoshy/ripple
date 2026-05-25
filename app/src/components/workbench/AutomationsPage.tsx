"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  AuthError,
  createSchedule,
  deleteSchedule,
  fetchSchedules,
  runScheduleNow,
  updateSchedule,
} from "@/lib/api";
import type { ScheduleInfo, ScheduleKind } from "@/types";

interface AutomationsPageProps {
  selectedModel: string;
  onAuthExpired: (message: string) => void;
  onBack?: () => void;
}

type IntervalUnit = "minutes" | "hours" | "days";

const intervalUnitSeconds: Record<IntervalUnit, number> = {
  minutes: 60,
  hours: 3600,
  days: 86_400,
};

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function localDatetimeValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function formatDate(value: string | null): string {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function intervalLabel(seconds: number | null): string {
  if (!seconds) return "";
  if (seconds % 86_400 === 0) return `Every ${seconds / 86_400}d`;
  if (seconds % 3600 === 0) return `Every ${seconds / 3600}h`;
  if (seconds % 60 === 0) return `Every ${seconds / 60}m`;
  return `Every ${seconds}s`;
}

function runCountLabel(schedule: ScheduleInfo): string {
  const runCount = Math.max(0, schedule.run_count || 0);
  if (schedule.kind !== "interval") return `${runCount} run${runCount === 1 ? "" : "s"}`;
  return schedule.max_runs ? `Runs ${runCount}/${schedule.max_runs}` : `Runs ${runCount}/unlimited`;
}

function statusClass(status: string): string {
  if (status === "active") return "border-[#1a7f37]/25 bg-[#dafbe1] text-[#1a7f37]";
  if (status === "paused") return "border-[#bf8700]/25 bg-[#fff8c5] text-[#7d4e00]";
  if (status === "completed") return "border-[#0969da]/20 bg-[#ddf4ff] text-[#0969da]";
  if (status === "error") return "border-[#cf222e]/25 bg-[#ffebe9] text-[#cf222e]";
  return "border-[#d7dce3] bg-[#f7f8fa] text-[#374151]";
}

function defaultRunAt(): string {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setSeconds(0, 0);
  return localDatetimeValue(date);
}

export default function AutomationsPage({
  selectedModel,
  onAuthExpired,
  onBack,
}: AutomationsPageProps) {
  const [schedules, setSchedules] = useState<ScheduleInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<ScheduleKind>("once");
  const [runAt, setRunAt] = useState(defaultRunAt);
  const [timezone, setTimezone] = useState(browserTimezone);
  const [intervalValue, setIntervalValue] = useState(1);
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>("hours");
  const [maxRuns, setMaxRuns] = useState("");
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);

  const intervalSeconds = useMemo(
    () => Math.max(1, intervalValue) * intervalUnitSeconds[intervalUnit],
    [intervalUnit, intervalValue]
  );

  const loadSchedules = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      setSchedules(await fetchSchedules());
    } catch (err) {
      if (err instanceof AuthError) {
        onAuthExpired("API Key 已失效");
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to load automations");
    } finally {
      setIsLoading(false);
    }
  }, [onAuthExpired]);

  useEffect(() => {
    void loadSchedules();
  }, [loadSchedules]);

  const resetForm = useCallback(() => {
    setTitle("");
    setPrompt("");
    setKind("once");
    setRunAt(defaultRunAt());
    setTimezone(browserTimezone());
    setIntervalValue(1);
    setIntervalUnit("hours");
    setMaxRuns("");
  }, []);

  const handleCreate = useCallback(
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
        await createSchedule({
          title: title.trim(),
          prompt: prompt.trim(),
          kind,
          timezone,
          run_at: runAt,
          interval_seconds: kind === "interval" ? intervalSeconds : null,
          max_runs: maxRunsLimit,
          model: selectedModel,
        });
        resetForm();
        setIsCreating(false);
        await loadSchedules();
      } catch (err) {
        if (err instanceof AuthError) {
          onAuthExpired("API Key 已失效");
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to create automation");
      } finally {
        setIsSubmitting(false);
      }
    },
    [
      intervalSeconds,
      kind,
      loadSchedules,
      maxRuns,
      onAuthExpired,
      prompt,
      resetForm,
      runAt,
      selectedModel,
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
          await runScheduleNow(scheduleId);
        } else {
          if (!window.confirm("Delete this automation?")) return;
          await deleteSchedule(scheduleId);
        }
        await loadSchedules();
      } catch (err) {
        if (err instanceof AuthError) {
          onAuthExpired("API Key 已失效");
          return;
        }
        setError(err instanceof Error ? err.message : "Action failed");
      } finally {
        setPendingActionId(null);
      }
    },
    [loadSchedules, onAuthExpired]
  );

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-[radial-gradient(circle_at_16%_0%,rgba(47,107,255,0.10),transparent_34%),radial-gradient(circle_at_90%_10%,rgba(139,92,246,0.09),transparent_32%),#fbfdff] px-4 pt-4 pb-[calc(88px+env(safe-area-inset-bottom))] text-[#111827] md:px-6 lg:pb-4">
      <div className="mx-auto max-w-6xl space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3 pb-1">
          <div className="flex min-w-0 items-center gap-3">
            {onBack ? (
              <button
                type="button"
                onClick={onBack}
                aria-label="Back to settings"
                title="Back to settings"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#dfe6f4] bg-white text-[#384152] hover:bg-[#f7f8fa] lg:hidden"
              >
                <ArrowLeft size={17} />
              </button>
            ) : null}
            <div className="min-w-0">
              <h1 className="text-[22px] leading-7 font-semibold tracking-normal">Automations</h1>
              <div className="mt-1 font-[family-name:var(--font-mono)] text-[11px] text-[#7a8496]">
                {schedules.length} total
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadSchedules()}
              disabled={isLoading}
              aria-label="Refresh automations"
              title="Refresh automations"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[#dfe6f4] bg-white/78 text-[#384152] shadow-[0_10px_24px_rgba(44,63,123,0.06)] hover:bg-white disabled:opacity-60"
            >
              {isLoading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            </button>
            <button
              type="button"
              onClick={() => setIsCreating((open) => !open)}
              className="inline-flex h-9 items-center gap-2 rounded-full bg-[linear-gradient(135deg,#2f6bff,#7b5cff)] px-3 text-[13px] font-semibold text-white shadow-[0_12px_26px_rgba(64,92,255,0.24)]"
            >
              <Plus size={15} />
              New
            </button>
          </div>
        </header>

        {error ? (
          <div className="flex items-start gap-2 rounded-xl border border-[#cf222e]/25 bg-[#ffebe9] px-3 py-3 text-sm font-medium text-[#cf222e]">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        ) : null}

        {isCreating ? (
          <form
            onSubmit={handleCreate}
            className="grid gap-4 rounded-2xl border border-[#dfe6f4] bg-white/74 p-4 shadow-[0_12px_30px_rgba(44,63,123,0.06)] backdrop-blur-xl"
          >
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
              <label className="block min-w-0">
                <span className="mb-1 block text-[11px] font-medium text-[#667085]">Title</span>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  className="h-9 w-full rounded-xl border border-[#dfe6f4] bg-white px-3 text-[13px] outline-none focus:border-[#8da0ff]"
                />
              </label>
              <label className="block min-w-0">
                <span className="mb-1 block text-[11px] font-medium text-[#667085]">Timezone</span>
                <input
                  value={timezone}
                  onChange={(event) => setTimezone(event.target.value)}
                  className="h-9 w-full rounded-xl border border-[#dfe6f4] bg-white px-3 font-[family-name:var(--font-mono)] text-xs outline-none focus:border-[#8da0ff]"
                />
              </label>
            </div>

            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-[#667085]">Prompt</span>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={4}
                className="w-full resize-none rounded-xl border border-[#dfe6f4] bg-white px-3 py-2 text-[13px] leading-5 outline-none focus:border-[#8da0ff]"
              />
            </label>

            <div className="grid gap-3 md:grid-cols-[190px_minmax(0,1fr)_auto] md:items-end">
              <div>
                <span className="mb-1 block text-[11px] font-medium text-[#667085]">Mode</span>
                <div className="grid grid-cols-2 rounded-xl border border-[#dfe6f4] bg-white p-0.5">
                  {(["once", "interval"] as ScheduleKind[]).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setKind(option)}
                      className={`h-8 rounded text-xs font-semibold capitalize ${
                        kind === option
                          ? "bg-[linear-gradient(135deg,#2f6bff,#7b5cff)] text-white"
                          : "text-[#384152] hover:bg-[#f7f8fa]"
                      }`}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>

              {kind === "once" ? (
                <label className="block min-w-0">
                  <span className="mb-1 block text-[11px] font-medium text-[#667085]">Run at</span>
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
                    <span className="mb-1 block text-[11px] font-medium text-[#667085]">Every</span>
                    <input
                      type="number"
                      min={1}
                      value={intervalValue}
                      onChange={(event) => setIntervalValue(Number(event.target.value) || 1)}
                      className="h-9 w-full rounded-xl border border-[#dfe6f4] bg-white px-3 text-[13px] outline-none focus:border-[#8da0ff]"
                    />
                  </label>
                  <label className="block min-w-0">
                    <span className="mb-1 block text-[11px] font-medium text-[#667085]">Unit</span>
                    <select
                      value={intervalUnit}
                      onChange={(event) => setIntervalUnit(event.target.value as IntervalUnit)}
                      className="h-9 w-full rounded-xl border border-[#dfe6f4] bg-white px-3 text-[13px] outline-none focus:border-[#8da0ff]"
                    >
                      <option value="minutes">Minutes</option>
                      <option value="hours">Hours</option>
                      <option value="days">Days</option>
                    </select>
                  </label>
                  <label className="block min-w-0">
                    <span className="mb-1 block text-[11px] font-medium text-[#667085]">
                      Max runs
                    </span>
                    <input
                      type="number"
                      min={1}
                      placeholder="No limit"
                      value={maxRuns}
                      onChange={(event) => setMaxRuns(event.target.value)}
                      className="h-9 w-full rounded-xl border border-[#dfe6f4] bg-white px-3 text-[13px] outline-none focus:border-[#8da0ff]"
                    />
                  </label>
                </div>
              )}

              <button
                type="submit"
                disabled={isSubmitting || !title.trim() || !prompt.trim()}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-[linear-gradient(135deg,#2f6bff,#7b5cff)] px-4 text-[13px] font-semibold text-white shadow-[0_12px_26px_rgba(64,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-[#e5e7eb] disabled:bg-none disabled:text-[#8b8f94] disabled:shadow-none"
              >
                {isSubmitting ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <CalendarClock size={14} />
                )}
                Create
              </button>
            </div>
          </form>
        ) : null}

        <div className="overflow-hidden rounded-2xl border border-[#dfe6f4] bg-white/74 shadow-[0_12px_30px_rgba(44,63,123,0.06)] backdrop-blur-xl">
          {schedules.length === 0 && !isLoading ? (
            <div className="flex h-44 items-center justify-center text-[13px] text-[#667085]">
              No automations
            </div>
          ) : (
            <div className="divide-y divide-[#e8edf7]">
              {schedules.map((schedule) => (
                <div
                  key={schedule.schedule_id}
                  className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_180px_160px_auto] md:items-center"
                >
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-[13px] font-semibold">{schedule.title}</span>
                      <span
                        className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize ${statusClass(
                          schedule.status
                        )}`}
                      >
                        {schedule.status}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-[12px] text-[#667085]">
                      {schedule.prompt}
                    </div>
                    {schedule.last_error ? (
                      <div className="mt-1 truncate text-xs font-medium text-[#cf222e]">
                        {schedule.last_error}
                      </div>
                    ) : null}
                  </div>

                  <div className="min-w-0 text-[13px]">
                    <div className="font-medium">{formatDate(schedule.next_run_at)}</div>
                    <div className="mt-1 font-[family-name:var(--font-mono)] text-[11px] text-[#667085]">
                      {schedule.kind === "interval"
                        ? `${intervalLabel(schedule.interval_seconds)} · ${runCountLabel(schedule)}`
                        : "Once"}
                    </div>
                  </div>

                  <div className="min-w-0 text-[13px]">
                    <div className="truncate font-[family-name:var(--font-mono)] text-[11px] text-[#384152]">
                      {schedule.last_run_id || "No run"}
                    </div>
                    <div className="mt-1 text-[11px] text-[#667085]">
                      {schedule.last_run_at ? formatDate(schedule.last_run_at) : "Never"}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 justify-self-start md:justify-self-end">
                    <button
                      type="button"
                      onClick={() =>
                        void handleAction(schedule.schedule_id, "toggle", schedule.enabled)
                      }
                      aria-label={schedule.enabled ? "Pause automation" : "Resume automation"}
                      title={schedule.enabled ? "Pause automation" : "Resume automation"}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[#dfe6f4] bg-white text-[#384152] hover:bg-[#f7f8fa]"
                    >
                      {pendingActionId === `${schedule.schedule_id}:toggle` ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : schedule.enabled ? (
                        <Pause size={14} />
                      ) : (
                        <Play size={14} />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleAction(schedule.schedule_id, "run")}
                      aria-label="Run automation now"
                      title="Run automation now"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[#dfe6f4] bg-white text-[#384152] hover:bg-[#f7f8fa]"
                    >
                      {pendingActionId === `${schedule.schedule_id}:run` ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Play size={14} />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleAction(schedule.schedule_id, "delete")}
                      aria-label="Delete automation"
                      title="Delete automation"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[#dfe6f4] bg-white text-[#8b8f94] hover:bg-[#ffebe9] hover:text-[#cf222e]"
                    >
                      {pendingActionId === `${schedule.schedule_id}:delete` ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Trash2 size={14} />
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
