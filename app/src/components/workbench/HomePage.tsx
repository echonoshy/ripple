"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  BriefcaseBusiness,
  ChevronRight,
  FileText,
  KeyRound,
  Loader2,
  Plug,
  Plus,
  Server,
  UserRound,
} from "lucide-react";
import { fetchConnectorStatuses, fetchConnectors, fetchCurrentSandbox } from "@/lib/api";
import type { ConnectorInfo, ConnectorStatus, SandboxInfo, WorkbenchSessionSummary } from "@/types";
import type { WorkspaceView } from "@/lib/workspaceViews";
import SessionAttentionDot from "./SessionAttentionDot";

interface HomePageProps {
  userId: string;
  sessions: WorkbenchSessionSummary[];
  isLoadingSessions: boolean;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onSelectView: (view: WorkspaceView) => void;
  onOpenSettings: () => void;
}

const PUBLIC_API_URL = "http://140.143.229.103:8810/v1";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
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
  isLoadingSessions,
  onNewSession,
  onSelectSession,
  onSelectView,
  onOpenSettings,
}: HomePageProps) {
  const [sandbox, setSandbox] = useState<SandboxInfo | null>(null);
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [connectorStatuses, setConnectorStatuses] = useState<Record<string, ConnectorStatus>>({});
  const [isLoadingSummary, setIsLoadingSummary] = useState(false);

  const loadSummary = useCallback(async () => {
    setIsLoadingSummary(true);
    try {
      const [sandboxData, connectorList] = await Promise.all([
        fetchCurrentSandbox(),
        fetchConnectors(),
      ]);
      setSandbox(sandboxData);
      setConnectors(connectorList);
      setConnectorStatuses(await fetchConnectorStatuses(connectorList));
    } catch {
      setSandbox(null);
      setConnectors([]);
      setConnectorStatuses({});
    } finally {
      setIsLoadingSummary(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void loadSummary();
    });
  }, [loadSummary, userId]);

  const recentSessions = useMemo(() => sessions.slice(0, 5), [sessions]);
  const connected = connectedCount(connectors, connectorStatuses);

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-[radial-gradient(circle_at_16%_0%,rgba(47,107,255,0.10),transparent_34%),radial-gradient(circle_at_90%_10%,rgba(139,92,246,0.10),transparent_32%),#fbfdff] px-4 pt-4 pb-[calc(88px+env(safe-area-inset-bottom))] text-[#111827] md:px-8 md:py-5 lg:pb-5">
      <div className="mx-auto max-w-5xl space-y-4">
        <header className="flex items-start justify-between gap-3 pb-1">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[linear-gradient(135deg,#2f6bff,#7b5cff)] text-sm font-semibold text-white shadow-[0_10px_22px_rgba(64,92,255,0.24)]">
                R
              </div>
              <div className="min-w-0">
                <h1 className="text-[21px] leading-tight font-semibold tracking-normal">Ripple</h1>
                <div className="text-[11px] text-[#7a8496]">Settings</div>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onNewSession}
            className="inline-flex h-9 items-center gap-2 rounded-full bg-[linear-gradient(135deg,#2f6bff,#7b5cff)] px-3 text-[13px] font-semibold text-white shadow-[0_12px_26px_rgba(64,92,255,0.24)]"
          >
            <Plus size={15} />
            <span className="sm:hidden">New</span>
            <span className="hidden sm:inline">New session</span>
          </button>
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
            detail="Scheduled tasks"
            onClick={() => onSelectView("automations")}
          />
        </section>

        <section className="rounded-2xl border border-[#dfe6f4] bg-white/74 shadow-[0_12px_30px_rgba(44,63,123,0.06)] backdrop-blur-xl">
          <div className="border-b border-[#e8edf7] px-4 py-3 text-[13px] font-semibold">
            Client configuration
          </div>
          <div className="divide-y divide-[#e8edf7]">
            <SettingsInfo icon={<Server size={16} />} title="API endpoint" value={PUBLIC_API_URL} />
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
            <div className="text-[13px] font-semibold">Recent sessions</div>
            {isLoadingSessions ? (
              <Loader2 size={14} className="animate-spin text-[#6b7280]" />
            ) : null}
          </div>
          <div className="divide-y divide-[#e8edf7]">
            {recentSessions.length === 0 ? (
              <div className="flex h-28 items-center justify-center text-[13px] text-[#667085]">
                {isLoadingSessions ? "Loading" : "No sessions yet"}
              </div>
            ) : (
              recentSessions.map((session) => (
                <button
                  key={session.sessionId}
                  type="button"
                  onClick={() => onSelectSession(session.sessionId)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-white/70"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{session.title}</span>
                    <span className="mt-1 block text-[11px] text-[#667085]">
                      {countLabel(session.messageCount, "message")}
                    </span>
                  </span>
                  <SessionAttentionDot attention={session.attention} />
                  <ChevronRight size={15} className="shrink-0 text-[#9aa3af]" />
                </button>
              ))
            )}
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
