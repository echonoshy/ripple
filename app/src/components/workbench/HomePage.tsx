"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  CalendarClock,
  BriefcaseBusiness,
  ChevronRight,
  FileText,
  KeyRound,
  Loader2,
  Plug,
  Server,
  UserRound,
  HardDrive,
  Layers,
  Cpu,
  Check,
  X,
  Settings,
} from "lucide-react";
import {
  fetchConnectorStatuses,
  fetchConnectors,
  fetchCurrentSandbox,
  getConfiguredApiUrl,
  fetchUserProfile,
} from "@/lib/api";
import type { ConnectorInfo, ConnectorStatus, SandboxInfo, WorkbenchSessionSummary } from "@/types";
import type { WorkspaceView } from "@/lib/workspaceViews";
import RippleIcon from "@/components/icons/RippleIcon";

interface HomePageProps {
  userId: string;
  sessions: WorkbenchSessionSummary[];
  onSelectView: (view: WorkspaceView) => void;
  onOpenSettings: () => void;
  onUserIdChange: (newUserId: string) => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatTokens(num: number): string {
  if (num >= 1_000_000_000) {
    return (num / 1_000_000_000).toFixed(1) + "B";
  }
  if (num >= 1_000_000) {
    return (num / 1_000_000).toFixed(1) + "M";
  }
  if (num >= 1_000) {
    return (num / 1_000).toFixed(1) + "K";
  }
  return num.toString();
}

function connectedCount(
  connectors: ConnectorInfo[],
  statuses: Record<string, ConnectorStatus>
): number {
  return connectors.filter((connector) => statuses[connector.name]?.connected).length;
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export default function HomePage({
  userId,
  sessions,
  onSelectView,
  onOpenSettings,
  onUserIdChange,
}: HomePageProps) {
  const [sandbox, setSandbox] = useState<SandboxInfo | null>(null);
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [connectorStatuses, setConnectorStatuses] = useState<Record<string, ConnectorStatus>>({});
  const [isLoadingSummary, setIsLoadingSummary] = useState(false);

  const [userUsageData, setUserUsageData] = useState<Awaited<
    ReturnType<typeof fetchUserProfile>
  > | null>(null);
  const [isLoadingUsage, setIsLoadingUsage] = useState(false);
  const [isSwitchingUser, setIsSwitchingUser] = useState(false);
  const [newUserDraft, setNewUserDraft] = useState("");
  const isSwitchCancelRef = React.useRef(false);

  const loadSummary = useCallback(async () => {
    setIsLoadingSummary(true);
    setIsLoadingUsage(true);
    try {
      const [sandboxData, connectorList, profileData] = await Promise.all([
        fetchCurrentSandbox(),
        fetchConnectors(),
        fetchUserProfile().catch(() => null),
      ]);
      setSandbox(sandboxData);
      setConnectors(connectorList);
      setConnectorStatuses(await fetchConnectorStatuses(connectorList));
      setUserUsageData(profileData);
    } catch {
      setSandbox(null);
      setConnectors([]);
      setConnectorStatuses({});
      setUserUsageData(null);
    } finally {
      setIsLoadingSummary(false);
      setIsLoadingUsage(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void loadSummary();
    });
  }, [loadSummary, userId]);

  const connected = connectedCount(connectors, connectorStatuses);
  const limits = userUsageData?.limits;
  const maxWorkspaceBytes = limits?.max_workspace_bytes || 2 * 1024 * 1024 * 1024;
  const maxSessions = limits?.max_sessions || 200;

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-[radial-gradient(circle_at_16%_0%,rgba(47,107,255,0.12),transparent_34%),radial-gradient(circle_at_88%_8%,rgba(139,92,246,0.11),transparent_32%),#fbfdff] px-4 pt-[max(env(safe-area-inset-top),16px)] pb-[calc(88px+env(safe-area-inset-bottom))] text-[#111827] md:px-8 md:pt-[max(env(safe-area-inset-top),20px)] md:pb-5">
      <div className="mx-auto max-w-5xl space-y-4">
        <header className="flex items-start justify-between gap-3 pb-1">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <RippleIcon
                size={32}
                className="h-8 w-8 shrink-0 rounded-xl shadow-[0_10px_22px_rgba(64,92,255,0.24)]"
              />
              <div className="min-w-0">
                <h1 className="text-[20px] leading-tight font-semibold tracking-normal">Ripple</h1>
                <div className="text-[11px] text-[#7a8496]">Settings</div>
              </div>
            </div>
          </div>
        </header>

        <section className="grid gap-2 md:grid-cols-2">
          <SettingsRow
            icon={<BriefcaseBusiness size={16} />}
            title="Sessions"
            detail={countLabel(sessions.length, "session")}
            onClick={() => onSelectView("sessions")}
          />
          <SettingsRow
            icon={<FileText size={16} />}
            title="Files"
            detail={sandbox ? formatBytes(sandbox.workspace_size_bytes) : "Workspace"}
            onClick={() => onSelectView("files")}
          />
          <SettingsRow
            icon={<Plug size={16} />}
            title="Connectors"
            detail={`${connected}/${connectors.length || 0} ready`}
            onClick={() => onSelectView("connectors")}
            isLoading={isLoadingSummary}
          />
          <SettingsRow
            icon={<CalendarClock size={16} />}
            title="Automations"
            detail="Scheduled runs"
            onClick={() => onSelectView("automations")}
          />
        </section>

        <section className="rounded-2xl border border-[#dfe6f4] bg-white/74 shadow-[0_12px_30px_rgba(44,63,123,0.06)] backdrop-blur-xl">
          <div className="border-b border-[#e8edf7] px-4 py-3 text-[13px] font-semibold">
            Client configuration
          </div>
          <div className="divide-y divide-[#e8edf7]">
            <SettingsInfo
              icon={<Server size={16} />}
              title="API endpoint"
              value={getConfiguredApiUrl()}
            />
            <SettingsInfo icon={<UserRound size={16} />} title="User ID" value={userId} />
            <button
              type="button"
              onClick={onOpenSettings}
              className="flex min-h-12 w-full items-center gap-3 px-4 py-3 text-left hover:bg-white/70"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-[#dfe6f4] bg-[#f6f8ff] text-[#667085]">
                <KeyRound size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium">API key</span>
                <span className="mt-0.5 block truncate font-[family-name:var(--font-mono)] text-[11px] text-[#667085]">
                  hidden
                </span>
              </span>
              <ChevronRight size={15} className="shrink-0 text-[#9aa3af]" />
            </button>
          </div>
        </section>

        <section className="rounded-2xl border border-[#dfe6f4] bg-white/74 shadow-[0_12px_30px_rgba(44,63,123,0.06)] backdrop-blur-xl">
          <div className="flex h-11 items-center justify-between border-b border-[#e8edf7] px-4">
            <div className="flex items-center gap-2">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
              </span>
              <span className="text-[13px] font-semibold">Sandbox Status</span>
            </div>
            {isLoadingUsage ? <Loader2 size={14} className="animate-spin text-[#6b7280]" /> : null}
          </div>

          <div className="space-y-4 p-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold text-[#6b7280]">
                  <span className="flex items-center gap-1.5">
                    <HardDrive size={13} className="text-[#6b7280]" />
                    Disk Usage
                  </span>
                  <span>
                    {(() => {
                      const bytes = userUsageData?.usage?.workspace_size_bytes ?? 0;
                      const percent = Math.min(100, Math.max(0, (bytes / maxWorkspaceBytes) * 100));
                      return `${percent.toFixed(1)}%`;
                    })()}
                  </span>
                </div>
                {(() => {
                  const bytes = userUsageData?.usage?.workspace_size_bytes ?? 0;
                  const percent = Math.min(100, Math.max(0, (bytes / maxWorkspaceBytes) * 100));
                  return (
                    <>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#e5e7eb]">
                        <div
                          className="h-full bg-[#2463eb] transition-all duration-300"
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                      <div className="mt-1.5 text-[11px] text-[#8b8f94]">
                        {formatBytes(bytes)} of {formatBytes(maxWorkspaceBytes)}
                      </div>
                    </>
                  );
                })()}
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold text-[#6b7280]">
                  <span className="flex items-center gap-1.5">
                    <Layers size={13} className="text-[#6b7280]" />
                    Active Sessions
                  </span>
                  <span>
                    {(() => {
                      const count = userUsageData?.usage?.session_count ?? 0;
                      const percent = Math.min(100, Math.max(0, (count / maxSessions) * 100));
                      return `${percent.toFixed(1)}%`;
                    })()}
                  </span>
                </div>
                {(() => {
                  const count = userUsageData?.usage?.session_count ?? 0;
                  const percent = Math.min(100, Math.max(0, (count / maxSessions) * 100));
                  return (
                    <>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#e5e7eb]">
                        <div
                          className="h-full bg-[#2463eb] transition-all duration-300"
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                      <div className="mt-1.5 text-[11px] text-[#8b8f94]">
                        {count} of {maxSessions} sessions
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>

            <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3 text-[11px] text-slate-500">
              <div className="mb-2 flex items-center gap-1.5 border-b border-slate-200/50 pb-1.5 font-semibold text-slate-600">
                <Cpu size={13} className="text-[#6b7280]" />
                <span>Token Usage Stats</span>
              </div>
              <div className="grid grid-cols-3 gap-1 divide-x divide-slate-200/60 text-center">
                <div>
                  <div className="text-[10px] font-medium text-slate-400">Daily</div>
                  <div className="mt-0.5 text-sm font-semibold text-slate-700">
                    {userUsageData?.usage?.daily_tokens !== undefined
                      ? formatTokens(userUsageData.usage.daily_tokens)
                      : "0"}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-medium text-slate-400">Weekly</div>
                  <div className="mt-0.5 text-sm font-semibold text-slate-700">
                    {userUsageData?.usage?.weekly_tokens !== undefined
                      ? formatTokens(userUsageData.usage.weekly_tokens)
                      : "0"}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-medium text-slate-400">All-time</div>
                  <div className="mt-0.5 text-sm font-semibold text-slate-700">
                    {userUsageData?.usage?.total_tokens !== undefined
                      ? formatTokens(userUsageData.usage.total_tokens)
                      : "0"}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-[#dfe6f4] pt-3">
              {isSwitchingUser ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (isSwitchCancelRef.current) {
                      isSwitchCancelRef.current = false;
                      return;
                    }
                    const trimmed = newUserDraft.trim();
                    if (/^[a-zA-Z0-9_-]{1,64}$/.test(trimmed)) {
                      onUserIdChange(trimmed);
                      setIsSwitchingUser(false);
                    } else {
                      alert(
                        "User ID can only contain alphanumeric characters, dashes, and underscores (1-64 characters)."
                      );
                    }
                  }}
                  className="flex w-full items-center gap-2 rounded-lg border border-[#2463eb] bg-white px-2 py-1 shadow-[0_2px_8px_rgba(36,99,235,0.06)]"
                >
                  <input
                    type="text"
                    value={newUserDraft}
                    onChange={(e) => setNewUserDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        isSwitchCancelRef.current = true;
                        setIsSwitchingUser(false);
                      }
                    }}
                    className="min-w-0 flex-1 bg-transparent px-1 py-0.5 text-xs font-semibold text-[#0d0d0d] outline-none"
                    autoFocus
                    maxLength={64}
                    placeholder="User ID"
                  />
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="submit"
                      title="Save User ID"
                      className="inline-flex h-6 w-6 items-center justify-center rounded text-[#2463eb] hover:bg-[#2463eb]/10"
                    >
                      <Check size={14} />
                    </button>
                    <button
                      type="button"
                      title="Cancel"
                      onMouseDown={() => {
                        isSwitchCancelRef.current = true;
                      }}
                      onClick={() => {
                        setIsSwitchingUser(false);
                      }}
                      className="inline-flex h-6 w-6 items-center justify-center rounded text-[#6b7280] hover:bg-[#e5e7eb]"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 text-[11px] font-semibold tracking-wider text-[#6b7280] uppercase">
                      Active Sandbox:
                    </span>
                    <span className="truncate rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs font-semibold text-[#374151]">
                      {userId}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setIsSwitchingUser(true);
                        setNewUserDraft(userId);
                      }}
                      className="inline-flex h-7 items-center justify-center rounded-lg bg-[#f3f4f6] px-2.5 text-[11px] font-semibold text-[#374151] transition-all hover:bg-[#e5e7eb] active:bg-[#eef3ff]"
                    >
                      Switch User
                    </button>
                    <button
                      type="button"
                      onClick={onOpenSettings}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-[#f3f4f6] text-[#374151] transition-all hover:bg-[#e5e7eb] active:bg-[#eef3ff]"
                      title="Settings"
                      aria-label="Settings"
                    >
                      <Settings size={13} />
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function SettingsRow({
  icon,
  title,
  detail,
  onClick,
  isLoading = false,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  onClick: () => void;
  isLoading?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-14 items-center gap-3 rounded-2xl border border-[#dfe6f4] bg-white/72 px-3 py-3 text-left shadow-[0_10px_26px_rgba(44,63,123,0.05)] backdrop-blur-xl hover:bg-white/90"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#dfe6f4] bg-[linear-gradient(135deg,#f4f7ff,#ffffff)] text-[#2457e6]">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold">{title}</span>
        <span className="mt-0.5 block truncate text-[11px] text-[#667085]">{detail}</span>
      </span>
      {isLoading ? (
        <Loader2 size={14} className="shrink-0 animate-spin text-[#6b7280]" />
      ) : (
        <ChevronRight size={15} className="shrink-0 text-[#9aa3af]" />
      )}
    </button>
  );
}

function SettingsInfo({
  icon,
  title,
  value,
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
}) {
  return (
    <div className="flex min-h-12 items-center gap-3 px-4 py-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-[#dfe6f4] bg-[#f6f8ff] text-[#667085]">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium">{title}</span>
        <span className="mt-0.5 block truncate font-[family-name:var(--font-mono)] text-[11px] text-[#667085]">
          {value}
        </span>
      </span>
    </div>
  );
}
