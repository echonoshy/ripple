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
  if (status === "success") return "border-ripple-ink bg-ripple-lime text-ripple-ink";
  if (status === "failed" || status === "timeout") {
    return "border-ripple-ink bg-ripple-red/45 text-ripple-ink";
  }
  if (status === "running") return "border-ripple-ink bg-ripple-yellow text-ripple-ink";
  return "border-ripple-ink bg-white text-ripple-ink/65";
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
      <h3 className="text-ripple-ink/60 mb-3 flex items-center gap-2 text-xs font-bold tracking-wider uppercase">
        <CalendarClock size={14} />
        Scheduled Tasks
      </h3>
      <div className="border-ripple-ink border-2 bg-white p-4 shadow-[3px_3px_0_#111111]">
        {!sandboxReady ? (
          <div className="text-ripple-ink/60 text-sm font-bold">
            Create the current user sandbox first.
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              <div className="border-ripple-ink bg-ripple-yellow/40 border-2 px-2.5 py-2">
                <p className="text-ripple-ink/60 text-[10px] font-bold tracking-wider uppercase">
                  Total
                </p>
                <p className="text-ripple-ink mt-1 font-[family-name:var(--font-mono)] text-sm font-bold">
                  {jobSummary.total}
                </p>
              </div>
              <div className="border-ripple-ink bg-ripple-lime/45 border-2 px-2.5 py-2">
                <p className="text-ripple-ink/60 text-[10px] font-bold tracking-wider uppercase">
                  Enabled
                </p>
                <p className="text-ripple-ink mt-1 font-[family-name:var(--font-mono)] text-sm font-bold">
                  {jobSummary.enabled}
                </p>
              </div>
              <div className="border-ripple-ink bg-ripple-cyan/35 border-2 px-2.5 py-2">
                <p className="text-ripple-ink/60 text-[10px] font-bold tracking-wider uppercase">
                  Once
                </p>
                <p className="text-ripple-ink mt-1 font-[family-name:var(--font-mono)] text-sm font-bold">
                  {jobSummary.once}
                </p>
              </div>
              <div className="border-ripple-ink bg-ripple-lavender/45 border-2 px-2.5 py-2">
                <p className="text-ripple-ink/60 text-[10px] font-bold tracking-wider uppercase">
                  Loop
                </p>
                <p className="text-ripple-ink mt-1 font-[family-name:var(--font-mono)] text-sm font-bold">
                  {jobSummary.interval}
                </p>
              </div>
              <div className="border-ripple-ink bg-ripple-orange/45 border-2 px-2.5 py-2">
                <p className="text-ripple-ink/60 text-[10px] font-bold tracking-wider uppercase">
                  Running
                </p>
                <p className="text-ripple-ink mt-1 font-[family-name:var(--font-mono)] text-sm font-bold">
                  {jobSummary.running}
                </p>
              </div>
              <div className="border-ripple-ink bg-ripple-red/25 border-2 px-2.5 py-2">
                <p className="text-ripple-ink/60 text-[10px] font-bold tracking-wider uppercase">
                  Failed
                </p>
                <p className="text-ripple-ink mt-1 font-[family-name:var(--font-mono)] text-sm font-bold">
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
                  className="brutal-input px-3 py-2 text-sm"
                />
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, executionType: "agent" }))}
                    className={`border-ripple-ink border-2 px-3 py-2 text-sm font-bold shadow-[2px_2px_0_#111111] transition-all ${
                      form.executionType === "agent"
                        ? "bg-ripple-yellow text-ripple-ink"
                        : "text-ripple-ink/60 bg-white"
                    }`}
                  >
                    Agent
                  </button>
                  <button
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, executionType: "command" }))}
                    className={`border-ripple-ink border-2 px-3 py-2 text-sm font-bold shadow-[2px_2px_0_#111111] transition-all ${
                      form.executionType === "command"
                        ? "bg-ripple-yellow text-ripple-ink"
                        : "text-ripple-ink/60 bg-white"
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
                  className="brutal-input w-full resize-none px-3 py-2 text-xs"
                />
              ) : (
                <textarea
                  value={form.command}
                  onChange={(e) => setForm((prev) => ({ ...prev, command: e.target.value }))}
                  placeholder="python scripts/daily_news.py"
                  rows={2}
                  className="brutal-input w-full resize-none px-3 py-2 font-[family-name:var(--font-mono)] text-xs"
                />
              )}
              <div className="grid gap-2 sm:grid-cols-4">
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, scheduleType: "interval" }))}
                    className={`border-ripple-ink mt-5 border-2 px-3 py-2 text-sm font-bold shadow-[2px_2px_0_#111111] ${
                      form.scheduleType === "interval"
                        ? "bg-ripple-lavender text-ripple-ink"
                        : "text-ripple-ink/60 bg-white"
                    }`}
                  >
                    Interval
                  </button>
                  <button
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, scheduleType: "once" }))}
                    className={`border-ripple-ink mt-5 border-2 px-3 py-2 text-sm font-bold shadow-[2px_2px_0_#111111] ${
                      form.scheduleType === "once"
                        ? "bg-ripple-lavender text-ripple-ink"
                        : "text-ripple-ink/60 bg-white"
                    }`}
                  >
                    Once
                  </button>
                </div>
                {form.scheduleType === "interval" ? (
                  <label className="block">
                    <span className="text-ripple-ink/60 mb-1 block text-[10px] font-bold tracking-wider uppercase">
                      Every seconds
                    </span>
                    <input
                      type="number"
                      min={1}
                      value={form.intervalSeconds}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, intervalSeconds: e.target.value }))
                      }
                      className="brutal-input w-full px-3 py-2 font-[family-name:var(--font-mono)] text-xs"
                    />
                  </label>
                ) : (
                  <label className="block">
                    <span className="text-ripple-ink/60 mb-1 block text-[10px] font-bold tracking-wider uppercase">
                      Run at
                    </span>
                    <input
                      type="datetime-local"
                      value={form.runAtLocal}
                      onChange={(e) => setForm((prev) => ({ ...prev, runAtLocal: e.target.value }))}
                      className="brutal-input w-full px-3 py-2 font-[family-name:var(--font-mono)] text-xs"
                    />
                  </label>
                )}
                <label className="block">
                  <span className="text-ripple-ink/60 mb-1 block text-[10px] font-bold tracking-wider uppercase">
                    Max runs
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={form.maxRuns}
                    onChange={(e) => setForm((prev) => ({ ...prev, maxRuns: e.target.value }))}
                    disabled={form.scheduleType !== "interval"}
                    placeholder="∞"
                    className="brutal-input w-full px-3 py-2 font-[family-name:var(--font-mono)] text-xs disabled:opacity-40"
                  />
                </label>
                <label className="block">
                  <span className="text-ripple-ink/60 mb-1 block text-[10px] font-bold tracking-wider uppercase">
                    Timeout
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={form.timeoutSeconds}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, timeoutSeconds: e.target.value }))
                    }
                    className="brutal-input w-full px-3 py-2 font-[family-name:var(--font-mono)] text-xs"
                  />
                </label>
                <div className="flex items-end gap-2">
                  <button
                    type="button"
                    onClick={refresh}
                    disabled={loading}
                    title="Refresh, also auto-refreshes every 5 seconds"
                    className="btn-icon h-9 w-9 disabled:opacity-50"
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
              <div className="border-ripple-ink bg-ripple-red/25 text-ripple-ink flex items-start gap-2 border-2 p-2 text-xs font-bold">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <span className="break-all">{error}</span>
              </div>
            )}

            <div className="space-y-2">
              {loading && jobs.length === 0 ? (
                <div className="text-ripple-ink/60 flex items-center gap-2 py-3 text-sm font-bold">
                  <Loader2 size={14} className="animate-spin" />
                  <span>Loading tasks...</span>
                </div>
              ) : jobs.length === 0 ? (
                <div className="border-ripple-ink/50 bg-ripple-paper text-ripple-ink/55 border-2 border-dashed p-3 text-sm font-bold">
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
                    <div
                      key={job.id}
                      className="border-ripple-ink bg-ripple-paper border-2 p-3 shadow-[3px_3px_0_#111111]"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-ripple-ink truncate text-sm font-bold">{job.name}</p>
                            <span
                              className={`border-2 px-1.5 py-0.5 text-[10px] font-bold uppercase ${statusClass(
                                job.last_status
                              )}`}
                            >
                              {job.last_status || "new"}
                            </span>
                            {!job.enabled && (
                              <span className="border-ripple-ink text-ripple-ink/60 border-2 bg-white px-1.5 py-0.5 text-[10px] font-bold uppercase">
                                disabled
                              </span>
                            )}
                            {hasRunningRun && (
                              <span className="border-ripple-ink bg-ripple-yellow text-ripple-ink inline-flex items-center gap-1 border-2 px-1.5 py-0.5 text-[10px] font-bold uppercase">
                                <Loader2 size={10} className="animate-spin" />
                                running
                              </span>
                            )}
                          </div>
                          <p className="text-ripple-ink/65 mt-1 text-xs break-all">
                            <span className="border-ripple-ink text-ripple-ink mr-2 border-2 bg-white px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[10px] font-bold uppercase">
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
                          <div className="text-ripple-ink/55 mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs font-medium">
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
                            <p className="border-ripple-ink bg-ripple-red/25 text-ripple-ink mt-2 border-2 px-2 py-1 font-[family-name:var(--font-mono)] text-[11px] break-all whitespace-pre-wrap">
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
                            className="btn-icon h-8 w-8 disabled:opacity-50"
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
                            className="btn-icon h-8 w-8 disabled:opacity-50"
                          >
                            <Play size={13} />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(job)}
                            disabled={busy}
                            title="Delete"
                            className="btn-icon bg-ripple-red/25 h-8 w-8 disabled:opacity-50"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>

                      {runs.length > 0 && (
                        <div className="border-ripple-ink mt-3 space-y-1 border-t-2 pt-2">
                          {runs.map((run) => (
                            <div
                              key={run.id}
                              className="border-ripple-ink border-2 bg-white text-xs"
                            >
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
                                    <ChevronDown
                                      size={12}
                                      className="text-ripple-ink/60 shrink-0"
                                    />
                                  ) : (
                                    <ChevronRight
                                      size={12}
                                      className="text-ripple-ink/60 shrink-0"
                                    />
                                  )}
                                  <span
                                    className={`inline-flex border-2 px-1.5 py-0.5 text-[10px] font-bold uppercase ${statusClass(
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
                                  <span className="text-ripple-ink/60 font-medium">
                                    {formatDateTime(run.started_at)}
                                  </span>
                                  {run.finished_at && (
                                    <span className="text-ripple-ink/45 hidden sm:inline">
                                      finished {formatDateTime(run.finished_at)}
                                    </span>
                                  )}
                                  {run.duration_ms !== null && (
                                    <span className="text-ripple-ink/45 hidden sm:inline">
                                      {formatDuration(run.duration_ms)}
                                    </span>
                                  )}
                                </div>
                                <span className="text-ripple-ink/55 shrink-0 font-[family-name:var(--font-mono)] font-bold">
                                  code {run.exit_code ?? "—"}
                                </span>
                              </button>
                              {expandedRunId === run.id && (
                                <div className="border-ripple-ink space-y-2 border-t-2 px-2 py-2">
                                  {!runHasDetails(run) ? (
                                    <p className="text-ripple-ink/55 font-medium">
                                      No output captured yet. Running tasks refresh every 5 seconds.
                                    </p>
                                  ) : (
                                    <>
                                      {run.error && (
                                        <pre className="border-ripple-ink bg-ripple-red/25 text-ripple-ink max-h-40 overflow-auto border-2 p-2 font-[family-name:var(--font-mono)] text-[11px] whitespace-pre-wrap">
                                          {run.error}
                                        </pre>
                                      )}
                                      {run.stdout_tail && (
                                        <pre className="border-ripple-ink bg-ripple-terminal max-h-52 overflow-auto border-2 p-2 font-[family-name:var(--font-mono)] text-[11px] whitespace-pre-wrap text-[#d4d4d8]">
                                          {run.stdout_tail}
                                        </pre>
                                      )}
                                      {run.summary && !run.stdout_tail && (
                                        <pre className="border-ripple-ink bg-ripple-terminal max-h-52 overflow-auto border-2 p-2 text-[11px] whitespace-pre-wrap text-[#d4d4d8]">
                                          {run.summary}
                                        </pre>
                                      )}
                                      {run.stderr_tail && (
                                        <pre className="border-ripple-ink bg-ripple-terminal max-h-52 overflow-auto border-2 p-2 font-[family-name:var(--font-mono)] text-[11px] whitespace-pre-wrap text-[#ff9f9f]">
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
