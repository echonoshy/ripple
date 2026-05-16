"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  BriefcaseBusiness,
  CheckCircle2,
  FileText,
  Loader2,
  Plug,
  Plus,
} from "lucide-react";
import { fetchConnectorStatuses, fetchConnectors, fetchCurrentSandbox } from "@/lib/api";
import type { ConnectorInfo, ConnectorStatus, SandboxInfo, WorkbenchTaskSummary } from "@/types";
import type { WorkspaceView } from "@/lib/workspaceViews";
import StatusChip from "./StatusChip";

interface HomePageProps {
  userId: string;
  tasks: WorkbenchTaskSummary[];
  isLoadingTasks: boolean;
  onNewTask: () => void;
  onSelectTask: (id: string) => void;
  onSelectView: (view: WorkspaceView) => void;
}

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

export default function HomePage({
  userId,
  tasks,
  isLoadingTasks,
  onNewTask,
  onSelectTask,
  onSelectView,
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

  const recentTasks = useMemo(() => tasks.slice(0, 5), [tasks]);
  const connected = connectedCount(connectors, connectorStatuses);

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-white px-5 py-5 text-[#0d0d0d] md:px-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[#e5e7eb] pb-5">
          <div>
            <h1 className="text-[24px] leading-tight font-semibold tracking-normal">Home</h1>
            <div className="mt-2 font-[family-name:var(--font-mono)] text-xs text-[#6b7280]">
              {userId}
            </div>
          </div>
          <button
            type="button"
            onClick={onNewTask}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-[#2463eb] px-3 text-sm font-semibold text-white hover:bg-[#1d56d8]"
          >
            <Plus size={15} />
            New Task
          </button>
        </header>

        <section className="grid gap-3 md:grid-cols-3">
          <button
            type="button"
            onClick={() => onSelectView("tasks")}
            className="min-w-0 rounded-lg border border-[#e5e7eb] bg-white p-4 text-left hover:bg-[#f7f8fa]"
          >
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <BriefcaseBusiness size={15} />
              Tasks
            </div>
            <div className="text-2xl font-semibold">{tasks.length}</div>
            <div className="mt-1 text-xs text-[#6b7280]">
              {isLoadingTasks ? "Loading" : "Total"}
            </div>
          </button>
          <button
            type="button"
            onClick={() => onSelectView("files")}
            className="min-w-0 rounded-lg border border-[#e5e7eb] bg-white p-4 text-left hover:bg-[#f7f8fa]"
          >
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <FileText size={15} />
              Files
            </div>
            <div className="text-2xl font-semibold">
              {sandbox ? formatBytes(sandbox.workspace_size_bytes) : "0 B"}
            </div>
            <div className="mt-1 text-xs text-[#6b7280]">Workspace size</div>
          </button>
          <button
            type="button"
            onClick={() => onSelectView("connectors")}
            className="min-w-0 rounded-lg border border-[#e5e7eb] bg-white p-4 text-left hover:bg-[#f7f8fa]"
          >
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Plug size={15} />
              Connectors
            </div>
            <div className="text-2xl font-semibold">
              {connected}/{connectors.length || 0}
            </div>
            <div className="mt-1 text-xs text-[#6b7280]">Connected</div>
          </button>
        </section>

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 rounded-lg border border-[#e5e7eb] bg-white">
            <div className="flex h-11 items-center justify-between border-b border-[#e5e7eb] px-4">
              <div className="text-sm font-semibold">Recent tasks</div>
              <button
                type="button"
                onClick={() => onSelectView("tasks")}
                className="inline-flex items-center gap-1 text-xs font-medium text-[#6b7280] hover:text-[#0d0d0d]"
              >
                View all
                <ArrowRight size={12} />
              </button>
            </div>
            <div className="divide-y divide-[#e5e7eb]">
              {recentTasks.length === 0 ? (
                <div className="flex h-32 items-center justify-center text-sm text-[#6b7280]">
                  {isLoadingTasks ? "Loading" : "No tasks yet"}
                </div>
              ) : (
                recentTasks.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => onSelectTask(task.id)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[#f7f8fa]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{task.title}</span>
                      <span className="mt-1 block text-xs text-[#6b7280]">
                        {task.messageCount} messages
                      </span>
                    </span>
                    <StatusChip status={task.status} compact />
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="rounded-lg border border-[#e5e7eb] bg-white">
            <div className="flex h-11 items-center justify-between border-b border-[#e5e7eb] px-4">
              <div className="text-sm font-semibold">Connector status</div>
              {isLoadingSummary && <Loader2 size={14} className="animate-spin text-[#6b7280]" />}
            </div>
            <div className="divide-y divide-[#e5e7eb]">
              {connectors.slice(0, 5).map((connector) => {
                const status = connectorStatuses[connector.name];
                return (
                  <div key={connector.name} className="flex items-center gap-3 px-4 py-3">
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border ${
                        status?.connected
                          ? "border-[#1a7f37]/25 bg-[#dafbe1] text-[#1a7f37]"
                          : "border-[#e5e7eb] bg-[#f7f8fa] text-[#6b7280]"
                      }`}
                    >
                      <CheckCircle2 size={14} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {connector.display_name}
                      </span>
                      <span className="mt-0.5 block text-xs text-[#6b7280]">
                        {status?.connected ? "Connected" : "Needs setup"}
                      </span>
                    </span>
                  </div>
                );
              })}
              {connectors.length === 0 && (
                <div className="flex h-32 items-center justify-center text-sm text-[#6b7280]">
                  {isLoadingSummary ? "Loading" : "No connectors"}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
