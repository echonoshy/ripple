import type { createTranslator } from "@/i18n";
import type { AgentRunInfo, ScheduleInfo } from "@/types";

export type IntervalUnit = "minutes" | "hours" | "days";
export type MissedRunPolicy = "run_once" | "skip";
export type OverlapPolicy = "skip" | "allow";
export type FailurePolicy = "pause" | "keep_active";

export interface AutomationsPageCache {
  schedules: ScheduleInfo[];
  runsBySchedule: Record<string, AgentRunInfo[]>;
  loadedAt: number;
}

type Translator = ReturnType<typeof createTranslator>;

export const intervalUnitSeconds: Record<IntervalUnit, number> = {
  minutes: 60,
  hours: 3600,
  days: 86_400,
};
export const defaultMaxRuntimeSeconds = 1800;
export const AUTOMATIONS_PAGE_CACHE_STALE_MS = 60_000;

export const automationsPageCacheByUserId: Record<string, AutomationsPageCache> = {};

export function isAutomationsPageCacheStale(userId: string, now = Date.now()): boolean {
  const cache = automationsPageCacheByUserId[userId];
  return !cache || now - cache.loadedAt > AUTOMATIONS_PAGE_CACHE_STALE_MS;
}

export const missedRunPolicyOptions: MissedRunPolicy[] = ["run_once", "skip"];
export const overlapPolicyOptions: OverlapPolicy[] = ["skip", "allow"];
export const failurePolicyOptions: FailurePolicy[] = ["pause", "keep_active"];

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

export function browserTimezone(): string {
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

export function timezoneOptions(currentTimezone: string): string[] {
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

export function timezoneLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function localDatetimeValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

export function formatDate(value: string | null, locale: string, t: Translator): string {
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

export function intervalLabel(seconds: number | null, t: Translator): string {
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

export function runCountLabel(schedule: ScheduleInfo, t: Translator): string {
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

export function statusClass(status: string): string {
  if (status === "active") return "border-[#16845B]/25 bg-[#E4F8EE] text-[#16845B]";
  if (status === "paused") return "border-[#D99900]/25 bg-[#FFF8DB] text-[#8B5E00]";
  if (status === "completed") return "border-[#1456F0]/20 bg-[#ddf4ff] text-[#1456F0]";
  if (status === "error") return "border-[#B42318]/25 bg-[#FFF1F0] text-[#B42318]";
  return "border-[#d7dce3] bg-[#F8F9FA] text-[#2B2F36]";
}

export function runStatusClass(status: string | null | undefined): string {
  if (status === "completed") return "border-[#16845B]/25 bg-[#E4F8EE] text-[#16845B]";
  if (status === "failed" || status === "cancelled") {
    return "border-[#B42318]/25 bg-[#FFF1F0] text-[#B42318]";
  }
  if (status === "queued" || status === "running") {
    return "border-[#1456F0]/20 bg-[#ddf4ff] text-[#1456F0]";
  }
  return "border-[#d7dce3] bg-[#F8F9FA] text-[#646A73]";
}

export function isActiveRunStatus(status: string | null | undefined): boolean {
  return status === "queued" || status === "running";
}

const ansiPattern = new RegExp(String.raw`\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])`, "g");

export function stripAnsi(value: string): string {
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

export function runErrorText(run: AgentRunInfo | null | undefined): string | null {
  if (!run) return null;
  if (!(run.status === "failed" || run.status === "cancelled")) return null;
  return (
    cleanRunIssueText(run.error) ||
    cleanRunIssueText(run.stderr_tail) ||
    cleanRunIssueText(run.stdout_tail) ||
    null
  );
}

export function hasRunOutput(run: AgentRunInfo | null | undefined): boolean {
  return Boolean(run?.output_available && !isActiveRunStatus(run.status));
}

export function defaultRunAt(): string {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setSeconds(0, 0);
  return localDatetimeValue(date);
}

export function datetimeInputValue(value: string | null): string {
  if (!value) return defaultRunAt();
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return localDatetimeValue(date);
  return value.slice(0, 16);
}

export function intervalParts(seconds: number | null): { value: number; unit: IntervalUnit } {
  const normalized = Math.max(1, seconds || 3600);
  if (normalized % 86_400 === 0) return { value: normalized / 86_400, unit: "days" };
  if (normalized % 3600 === 0) return { value: normalized / 3600, unit: "hours" };
  if (normalized % 60 === 0) return { value: normalized / 60, unit: "minutes" };
  return { value: Math.ceil(normalized / 60), unit: "minutes" };
}
