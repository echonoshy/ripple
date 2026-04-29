"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  Check,
  Clock3,
  ChevronDown,
  ChevronRight,
  Loader2,
  Play,
  Power,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { ScheduledJob, ScheduledRun, ScheduleExecutionType, ScheduleType } from "@/types";
import {
  createSchedule,
  deleteSchedule,
  fetchScheduleRuns,
  fetchSchedules,
  runScheduleNow,
  updateSchedule,
} from "@/lib/api";

interface ScheduledTasksPanelProps {
  sandboxReady: boolean;
  userId: string;
}

interface ScheduleFormState {
  name: string;
  command: string;
  prompt: string;
  executionType: ScheduleExecutionType;
  scheduleType: ScheduleType;
  runAtLocal: string;
  intervalSeconds: string;
  maxRuns: string;
  timeoutSeconds: string;
}

const DEFAULT_FORM: ScheduleFormState = {
  name: "",
  command: "",
  prompt: "",
  executionType: "agent",
  scheduleType: "interval",
  runAtLocal: "",
  intervalSeconds: "86400",
  maxRuns: "",
  timeoutSeconds: "300",
};

const RUN_FETCH_LIMIT = 10;
const REFRESH_INTERVAL_MS = 5000;

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatInterval(seconds: number | null): string {
  if (!seconds) return "—";
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function statusClass(status: string | null): string {
  if (status === "success") return "border-emerald-500/20 bg-emerald-500/10 text-emerald-300";
  if (status === "failed" || status === "timeout") {
    return "border-[#ff4444]/20 bg-[#ff4444]/10 text-[#ff7777]";
  }
  if (status === "running") return "border-white/20 bg-white/10 text-[#ededed]";
  return "border-white/10 bg-black text-[#888888]";
}

function runHasDetails(run: ScheduledRun): boolean {
  return Boolean(run.stdout_tail || run.stderr_tail || run.error);
}

function localDateTimeToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function parsePositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalPositiveInt(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export default function ScheduledTasksPanel({ sandboxReady, userId }: ScheduledTasksPanelProps) {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [runsByJob, setRunsByJob] = useState<Record<string, ScheduledRun[]>>({});
  const [form, setForm] = useState<ScheduleFormState>(DEFAULT_FORM);
  const [loading, setLoading] = useState(false);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  const jobSummary = useMemo(
    () => ({
      total: jobs.length,
      enabled: jobs.filter((job) => job.enabled).length,
      once: jobs.filter((job) => job.schedule_type === "once").length,
      interval: jobs.filter((job) => job.schedule_type === "interval").length,
      running: jobs.filter((job) => job.running_at || job.current_run_id).length,
      failed: jobs.filter((job) => job.last_status === "failed" || job.last_status === "timeout")
        .length,
    }),
    [jobs]
  );

  const canSubmit = useMemo(() => {
    if (!sandboxReady || submitting) return false;
    if (!form.name.trim()) return false;
    if (form.executionType === "agent" && !form.prompt.trim()) return false;
    if (form.executionType === "command" && !form.command.trim()) return false;
    if (form.scheduleType === "once") return Boolean(localDateTimeToIso(form.runAtLocal));
    if (form.maxRuns.trim() && parseOptionalPositiveInt(form.maxRuns) === null) return false;
    return parsePositiveInt(form.intervalSeconds, 0) > 0;
  }, [form, sandboxReady, submitting]);

  const refresh = useCallback(async () => {
    if (!sandboxReady) {
      setJobs([]);
      setRunsByJob({});
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const loadedJobs = await fetchSchedules();
      setJobs(loadedJobs);
      const runEntries = await Promise.all(
        loadedJobs.map(
          async (job) => [job.id, await fetchScheduleRuns(job.id, RUN_FETCH_LIMIT)] as const
        )
      );
      setRunsByJob(Object.fromEntries(runEntries));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sandboxReady]);

  useEffect(() => {
    refresh();
  }, [refresh, userId]);

  useEffect(() => {
    if (!sandboxReady) return;
    const timer = window.setInterval(() => {
      refresh();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, sandboxReady]);

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await createSchedule({
        name: form.name.trim(),
        command: form.executionType === "command" ? form.command.trim() : null,
        prompt: form.executionType === "agent" ? form.prompt.trim() : null,
        execution_type: form.executionType,
        created_from: "ui",
        schedule_type: form.scheduleType,
        run_at: form.scheduleType === "once" ? localDateTimeToIso(form.runAtLocal) : null,
        interval_seconds:
          form.scheduleType === "interval" ? parsePositiveInt(form.intervalSeconds, 86400) : null,
        max_runs: form.scheduleType === "interval" ? parseOptionalPositiveInt(form.maxRuns) : null,
        timeout_seconds: parsePositiveInt(form.timeoutSeconds, 300),
        enabled: true,
      });
      setForm(DEFAULT_FORM);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (job: ScheduledJob) => {
    setBusyJobId(job.id);
    setError(null);
    try {
      await updateSchedule(job.id, { enabled: !job.enabled });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyJobId(null);
    }
  };

  const handleRunNow = async (job: ScheduledJob) => {
    setBusyJobId(job.id);
    setError(null);
    try {
      await runScheduleNow(job.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyJobId(null);
    }
  };

  const handleDelete = async (job: ScheduledJob) => {
    setBusyJobId(job.id);
    setError(null);
    try {
      const ok = await deleteSchedule(job.id);
      if (!ok) throw new Error("Delete failed");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyJobId(null);
    }
  };

  return (
    <div>
      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium tracking-wider text-[#666666] uppercase">
        <CalendarClock size={14} />
        Scheduled Tasks
      </h3>
      <div className="rounded-xl border border-white/10 bg-[#0a0a0a] p-4">
        {!sandboxReady ? (
          <div className="text-sm text-[#888888]">Create the current user sandbox first.</div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              <div className="rounded-md border border-white/10 bg-black px-2.5 py-2">
                <p className="text-[10px] tracking-wider text-[#666666] uppercase">Total</p>
                <p className="mt-1 font-[family-name:var(--font-mono)] text-sm text-[#ededed]">
                  {jobSummary.total}
                </p>
              </div>
              <div className="rounded-md border border-white/10 bg-black px-2.5 py-2">
                <p className="text-[10px] tracking-wider text-[#666666] uppercase">Enabled</p>
                <p className="mt-1 font-[family-name:var(--font-mono)] text-sm text-[#ededed]">
                  {jobSummary.enabled}
                </p>
              </div>
              <div className="rounded-md border border-white/10 bg-black px-2.5 py-2">
                <p className="text-[10px] tracking-wider text-[#666666] uppercase">Once</p>
                <p className="mt-1 font-[family-name:var(--font-mono)] text-sm text-[#ededed]">
                  {jobSummary.once}
                </p>
              </div>
              <div className="rounded-md border border-white/10 bg-black px-2.5 py-2">
                <p className="text-[10px] tracking-wider text-[#666666] uppercase">Loop</p>
                <p className="mt-1 font-[family-name:var(--font-mono)] text-sm text-[#ededed]">
                  {jobSummary.interval}
                </p>
              </div>
              <div className="rounded-md border border-white/10 bg-black px-2.5 py-2">
                <p className="text-[10px] tracking-wider text-[#666666] uppercase">Running</p>
                <p className="mt-1 font-[family-name:var(--font-mono)] text-sm text-[#ededed]">
                  {jobSummary.running}
                </p>
              </div>
              <div className="rounded-md border border-white/10 bg-black px-2.5 py-2">
                <p className="text-[10px] tracking-wider text-[#666666] uppercase">Failed</p>
                <p className="mt-1 font-[family-name:var(--font-mono)] text-sm text-[#ededed]">
                  {jobSummary.failed}
                </p>
              </div>
            </div>

            <form onSubmit={handleCreate} className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="Task name"
                  className="rounded-md border border-white/10 bg-black px-3 py-2 text-sm text-[#ededed] placeholder:text-[#666666] focus:border-[#ededed]/50 focus:outline-none"
                />
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, executionType: "agent" }))}
                    className={`rounded-md border px-3 py-2 text-sm ${
                      form.executionType === "agent"
                        ? "border-white/30 bg-white/10 text-[#ededed]"
                        : "border-white/10 bg-black text-[#888888]"
                    }`}
                  >
                    Agent
                  </button>
                  <button
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, executionType: "command" }))}
                    className={`rounded-md border px-3 py-2 text-sm ${
                      form.executionType === "command"
                        ? "border-white/30 bg-white/10 text-[#ededed]"
                        : "border-white/10 bg-black text-[#888888]"
                    }`}
                  >
                    Command
                  </button>
                </div>
              </div>
              {form.executionType === "agent" ? (
                <textarea
                  value={form.prompt}
                  onChange={(e) => setForm((prev) => ({ ...prev, prompt: e.target.value }))}
                  placeholder="At run time, use Feishu to send me a hydration reminder."
                  rows={3}
                  className="w-full resize-none rounded-md border border-white/10 bg-black px-3 py-2 text-xs text-[#ededed] placeholder:text-[#666666] focus:border-[#ededed]/50 focus:outline-none"
                />
              ) : (
                <textarea
                  value={form.command}
                  onChange={(e) => setForm((prev) => ({ ...prev, command: e.target.value }))}
                  placeholder="python scripts/daily_news.py"
                  rows={2}
                  className="w-full resize-none rounded-md border border-white/10 bg-black px-3 py-2 font-[family-name:var(--font-mono)] text-xs text-[#ededed] placeholder:text-[#666666] focus:border-[#ededed]/50 focus:outline-none"
                />
              )}
              <div className="grid gap-2 sm:grid-cols-4">
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, scheduleType: "interval" }))}
                    className={`mt-5 rounded-md border px-3 py-2 text-sm ${
                      form.scheduleType === "interval"
                        ? "border-white/30 bg-white/10 text-[#ededed]"
                        : "border-white/10 bg-black text-[#888888]"
                    }`}
                  >
                    Interval
                  </button>
                  <button
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, scheduleType: "once" }))}
                    className={`mt-5 rounded-md border px-3 py-2 text-sm ${
                      form.scheduleType === "once"
                        ? "border-white/30 bg-white/10 text-[#ededed]"
                        : "border-white/10 bg-black text-[#888888]"
                    }`}
                  >
                    Once
                  </button>
                </div>
                {form.scheduleType === "interval" ? (
                  <label className="block">
                    <span className="mb-1 block text-[10px] tracking-wider text-[#666666] uppercase">
                      Every seconds
                    </span>
                    <input
                      type="number"
                      min={1}
                      value={form.intervalSeconds}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, intervalSeconds: e.target.value }))
                      }
                      className="w-full rounded-md border border-white/10 bg-black px-3 py-2 font-[family-name:var(--font-mono)] text-xs text-[#ededed] focus:border-[#ededed]/50 focus:outline-none"
                    />
                  </label>
                ) : (
                  <label className="block">
                    <span className="mb-1 block text-[10px] tracking-wider text-[#666666] uppercase">
                      Run at
                    </span>
                    <input
                      type="datetime-local"
                      value={form.runAtLocal}
                      onChange={(e) => setForm((prev) => ({ ...prev, runAtLocal: e.target.value }))}
                      className="w-full rounded-md border border-white/10 bg-black px-3 py-2 font-[family-name:var(--font-mono)] text-xs text-[#ededed] focus:border-[#ededed]/50 focus:outline-none"
                    />
                  </label>
                )}
                <label className="block">
                  <span className="mb-1 block text-[10px] tracking-wider text-[#666666] uppercase">
                    Max runs
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={form.maxRuns}
                    onChange={(e) => setForm((prev) => ({ ...prev, maxRuns: e.target.value }))}
                    disabled={form.scheduleType !== "interval"}
                    placeholder="∞"
                    className="w-full rounded-md border border-white/10 bg-black px-3 py-2 font-[family-name:var(--font-mono)] text-xs text-[#ededed] placeholder:text-[#666666] focus:border-[#ededed]/50 focus:outline-none disabled:opacity-40"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[10px] tracking-wider text-[#666666] uppercase">
                    Timeout
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={form.timeoutSeconds}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, timeoutSeconds: e.target.value }))
                    }
                    className="w-full rounded-md border border-white/10 bg-black px-3 py-2 font-[family-name:var(--font-mono)] text-xs text-[#ededed] focus:border-[#ededed]/50 focus:outline-none"
                  />
                </label>
                <div className="flex items-end gap-2">
                  <button
                    type="button"
                    onClick={refresh}
                    disabled={loading}
                    title="Refresh, also auto-refreshes every 5 seconds"
                    className="flex h-9 w-9 items-center justify-center rounded-md border border-white/10 bg-black text-[#888888] transition-colors hover:border-white/20 hover:text-[#ededed] disabled:opacity-50"
                  >
                    <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
                  </button>
                  <button
                    type="submit"
                    disabled={!canSubmit}
                    className="btn-primary h-9 flex-1 px-3 py-0 text-xs disabled:opacity-40"
                  >
                    {submitting ? "Creating..." : "Create"}
                  </button>
                </div>
              </div>
            </form>

            {error && (
              <div className="flex items-start gap-2 rounded-md border border-[#ff4444]/20 bg-[#ff4444]/10 p-2 text-xs text-[#ff7777]">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <span className="break-all">{error}</span>
              </div>
            )}

            <div className="space-y-2">
              {loading && jobs.length === 0 ? (
                <div className="flex items-center gap-2 py-3 text-sm text-[#666666]">
                  <Loader2 size={14} className="animate-spin" />
                  <span>Loading tasks...</span>
                </div>
              ) : jobs.length === 0 ? (
                <div className="rounded-md border border-white/10 bg-black p-3 text-sm text-[#666666]">
                  No scheduled tasks.
                </div>
              ) : (
                jobs.map((job) => {
                  const busy = busyJobId === job.id;
                  const runs = runsByJob[job.id] || [];
                  const hasRunningRun =
                    Boolean(job.running_at || job.current_run_id) ||
                    runs.some((run) => run.status === "running");
                  return (
                    <div key={job.id} className="rounded-lg border border-white/10 bg-black p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-medium text-[#ededed]">
                              {job.name}
                            </p>
                            <span
                              className={`rounded-md border px-1.5 py-0.5 text-[10px] uppercase ${statusClass(
                                job.last_status
                              )}`}
                            >
                              {job.last_status || "new"}
                            </span>
                            {!job.enabled && (
                              <span className="rounded-md border border-white/10 px-1.5 py-0.5 text-[10px] text-[#888888] uppercase">
                                disabled
                              </span>
                            )}
                            {hasRunningRun && (
                              <span className="inline-flex items-center gap-1 rounded-md border border-white/20 px-1.5 py-0.5 text-[10px] text-[#ededed] uppercase">
                                <Loader2 size={10} className="animate-spin" />
                                running
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-xs break-all text-[#888888]">
                            <span className="mr-2 rounded border border-white/10 px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[10px] text-[#666666] uppercase">
                              {job.execution_type}
                            </span>
                            <span
                              className={
                                job.execution_type === "command"
                                  ? "font-[family-name:var(--font-mono)]"
                                  : ""
                              }
                            >
                              {job.execution_type === "agent" ? job.prompt : job.command}
                            </span>
                          </p>
                          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[#666666]">
                            <span className="flex items-center gap-1">
                              <Clock3 size={11} />
                              {job.schedule_type === "interval"
                                ? `every ${formatInterval(job.interval_seconds)}`
                                : `once ${formatDateTime(job.run_at)}`}
                            </span>
                            <span>next {formatDateTime(job.next_run_at)}</span>
                            <span>last {formatDateTime(job.last_run_at)}</span>
                            <span>duration {formatDuration(job.last_duration_ms)}</span>
                            {job.max_runs ? (
                              <span>
                                runs {job.run_count}/{job.max_runs}
                              </span>
                            ) : (
                              <span>runs {job.run_count}</span>
                            )}
                            {job.consecutive_errors > 0 && (
                              <span>errors {job.consecutive_errors}</span>
                            )}
                            <span>from {job.created_from}</span>
                          </div>
                          {job.last_error && (
                            <p className="mt-2 rounded-md border border-[#ff4444]/20 bg-[#ff4444]/10 px-2 py-1 font-[family-name:var(--font-mono)] text-[11px] break-all whitespace-pre-wrap text-[#ff7777]">
                              {job.last_error}
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleToggle(job)}
                            disabled={busy}
                            title={job.enabled ? "Disable" : "Enable"}
                            className="flex h-8 w-8 items-center justify-center rounded-md border border-white/10 text-[#888888] transition-colors hover:border-white/20 hover:text-[#ededed] disabled:opacity-50"
                          >
                            {busy ? (
                              <Loader2 size={13} className="animate-spin" />
                            ) : (
                              <Power size={13} />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRunNow(job)}
                            disabled={busy}
                            title="Run now"
                            className="flex h-8 w-8 items-center justify-center rounded-md border border-white/10 text-[#888888] transition-colors hover:border-white/20 hover:text-[#ededed] disabled:opacity-50"
                          >
                            <Play size={13} />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(job)}
                            disabled={busy}
                            title="Delete"
                            className="flex h-8 w-8 items-center justify-center rounded-md border border-[#ff4444]/20 text-[#ff7777] transition-colors hover:bg-[#ff4444]/10 disabled:opacity-50"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>

                      {runs.length > 0 && (
                        <div className="mt-3 space-y-1 border-t border-white/10 pt-2">
                          {runs.map((run) => (
                            <div key={run.id} className="rounded-md bg-white/[0.03] text-xs">
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedRunId((current) =>
                                    current === run.id ? null : run.id
                                  )
                                }
                                className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left"
                              >
                                <div className="flex min-w-0 items-center gap-2">
                                  {expandedRunId === run.id ? (
                                    <ChevronDown size={12} className="shrink-0 text-[#888888]" />
                                  ) : (
                                    <ChevronRight size={12} className="shrink-0 text-[#888888]" />
                                  )}
                                  <span
                                    className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] uppercase ${statusClass(
                                      run.status
                                    )}`}
                                  >
                                    {run.status === "running" && (
                                      <Loader2 size={10} className="mr-1 animate-spin" />
                                    )}
                                    {run.status === "success" && (
                                      <Check size={10} className="mr-1" />
                                    )}
                                    {run.status}
                                  </span>
                                  <span className="text-[#666666]">
                                    {formatDateTime(run.started_at)}
                                  </span>
                                  {run.finished_at && (
                                    <span className="hidden text-[#52525b] sm:inline">
                                      finished {formatDateTime(run.finished_at)}
                                    </span>
                                  )}
                                  {run.duration_ms !== null && (
                                    <span className="hidden text-[#52525b] sm:inline">
                                      {formatDuration(run.duration_ms)}
                                    </span>
                                  )}
                                </div>
                                <span className="shrink-0 font-[family-name:var(--font-mono)] text-[#888888]">
                                  code {run.exit_code ?? "—"}
                                </span>
                              </button>
                              {expandedRunId === run.id && (
                                <div className="space-y-2 border-t border-white/10 px-2 py-2">
                                  {!runHasDetails(run) ? (
                                    <p className="text-[#666666]">
                                      No output captured yet. Running tasks refresh every 5 seconds.
                                    </p>
                                  ) : (
                                    <>
                                      {run.error && (
                                        <pre className="max-h-40 overflow-auto rounded border border-[#ff4444]/20 bg-[#ff4444]/10 p-2 font-[family-name:var(--font-mono)] text-[11px] whitespace-pre-wrap text-[#ff7777]">
                                          {run.error}
                                        </pre>
                                      )}
                                      {run.stdout_tail && (
                                        <pre className="max-h-52 overflow-auto rounded border border-white/10 bg-black p-2 font-[family-name:var(--font-mono)] text-[11px] whitespace-pre-wrap text-[#d4d4d8]">
                                          {run.stdout_tail}
                                        </pre>
                                      )}
                                      {run.summary && !run.stdout_tail && (
                                        <pre className="max-h-52 overflow-auto rounded border border-white/10 bg-black p-2 text-[11px] whitespace-pre-wrap text-[#d4d4d8]">
                                          {run.summary}
                                        </pre>
                                      )}
                                      {run.stderr_tail && (
                                        <pre className="max-h-52 overflow-auto rounded border border-[#ff4444]/20 bg-black p-2 font-[family-name:var(--font-mono)] text-[11px] whitespace-pre-wrap text-[#ff9f9f]">
                                          {run.stderr_tail}
                                        </pre>
                                      )}
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
