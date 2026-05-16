"use client";

import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  FileText,
  ListChecks,
  ShieldAlert,
} from "lucide-react";
import WorkspaceExplorer from "@/components/WorkspaceExplorer";
import type { PermissionRequestData, WorkbenchTimelineEvent } from "@/types";

type InspectorTab = "files" | "activity" | "approvals";

interface InspectorPanelProps {
  userId: string;
  refreshToken: number;
  events: WorkbenchTimelineEvent[];
  changedFiles: string[];
  pendingPermission: PermissionRequestData | null;
  onPermissionResolve: (action: "allow" | "always" | "deny") => void;
}

const tabs: Array<{
  id: InspectorTab;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
}> = [
  { id: "files", label: "Files", icon: FileText },
  { id: "activity", label: "Activity", icon: ListChecks },
  { id: "approvals", label: "Approvals", icon: ShieldAlert },
];

function formatBody(body: string): string {
  return body.length > 900 ? `${body.slice(0, 900)}\n...` : body;
}

export default function InspectorPanel({
  userId,
  refreshToken,
  events,
  changedFiles,
  pendingPermission,
  onPermissionResolve,
}: InspectorPanelProps) {
  const [activeTab, setActiveTab] = useState<InspectorTab>("files");
  const activityEvents = useMemo(
    () => events.filter((event) => ["command", "file_change", "tool_call"].includes(event.type)),
    [events]
  );

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-[#e5e7eb] bg-white">
      <div className="shrink-0 border-b border-[#e5e7eb] bg-white px-4">
        <div className="flex h-[52px] items-end gap-6">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const selected = activeTab === tab.id;
            const badge = tab.id === "approvals" && pendingPermission ? 1 : 0;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`relative inline-flex h-9 items-center gap-1.5 border-b-2 text-sm font-medium ${
                  selected ? "border-[#2463eb] text-[#2463eb]" : "border-transparent text-[#374151]"
                }`}
              >
                <Icon size={14} />
                {tab.label}
                {badge > 0 && <span className="h-1.5 w-1.5 rounded-full bg-[#bf8700]" />}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === "files" && <WorkspaceExplorer userId={userId} refreshToken={refreshToken} />}

        {activeTab === "activity" && (
          <div className="h-full overflow-y-auto p-4">
            {changedFiles.length > 0 && (
              <section className="mb-3 rounded-lg border border-[#e5e7eb] bg-white">
                <div className="flex items-center gap-2 border-b border-[#e5e7eb] px-3 py-2 text-sm font-semibold text-[#0d0d0d]">
                  <Code2 size={14} />
                  Changed files
                </div>
                <div className="divide-y divide-[#e5e7eb]">
                  {changedFiles.map((path) => (
                    <div
                      key={path}
                      className="truncate px-3 py-2 font-[family-name:var(--font-mono)] text-xs text-[#6b7280]"
                      title={path}
                    >
                      {path}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {activityEvents.length === 0 ? (
              <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-[#e5e7eb] bg-white px-4 text-center text-sm text-[#6b7280]">
                Codex activity will appear here while it reads files, runs commands, or changes
                files.
              </div>
            ) : (
              <div className="space-y-2">
                {activityEvents.map((event) => (
                  <article key={event.id} className="rounded-lg border border-[#e5e7eb] bg-white">
                    <div className="flex items-center justify-between gap-2 border-b border-[#e5e7eb] px-3 py-2">
                      <div className="truncate text-sm font-semibold text-[#0d0d0d]">
                        {event.title}
                      </div>
                      {event.status && (
                        <span className="rounded-md border border-[#e5e7eb] bg-[#f7f8fa] px-2 py-0.5 font-[family-name:var(--font-mono)] text-[11px] text-[#6b7280]">
                          {event.status}
                        </span>
                      )}
                    </div>
                    <pre className="max-h-56 overflow-auto p-3 font-[family-name:var(--font-mono)] text-xs leading-relaxed whitespace-pre-wrap text-[#6b7280]">
                      {formatBody(event.body)}
                    </pre>
                  </article>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "approvals" && (
          <div className="h-full overflow-y-auto p-4">
            {pendingPermission ? (
              <div className="rounded-lg border border-[#bf8700]/35 bg-[#fff8c5] p-3">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[#7d4e00]">
                  <ShieldAlert size={15} />
                  Permission required: {pendingPermission.tool}
                </div>
                <pre className="mb-3 max-h-72 overflow-auto rounded-md bg-[#0d1117] p-3 font-[family-name:var(--font-mono)] text-xs whitespace-pre-wrap text-[#c9d1d9]">
                  {typeof pendingPermission.params === "string"
                    ? pendingPermission.params
                    : JSON.stringify(pendingPermission.params, null, 2)}
                </pre>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onPermissionResolve("allow")}
                    className="rounded-md border border-[#1a7f37]/30 bg-[#dafbe1] px-3 py-1.5 text-sm font-semibold text-[#1a7f37] hover:bg-[#c7f7d1]"
                  >
                    Allow once
                  </button>
                  <button
                    type="button"
                    onClick={() => onPermissionResolve("always")}
                    className="rounded-md border border-[#0969da]/25 bg-[#ddf4ff] px-3 py-1.5 text-sm font-semibold text-[#0969da] hover:bg-[#cbeeff]"
                  >
                    Allow task
                  </button>
                  <button
                    type="button"
                    onClick={() => onPermissionResolve("deny")}
                    className="rounded-md border border-[#cf222e]/25 bg-[#ffebe9] px-3 py-1.5 text-sm font-semibold text-[#cf222e] hover:bg-[#ffd7d5]"
                  >
                    Deny
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex h-40 items-center justify-center gap-2 rounded-lg border border-dashed border-[#e5e7eb] bg-white px-4 text-center text-sm text-[#6b7280]">
                <CheckCircle2 size={16} />
                No pending approvals
              </div>
            )}

            {pendingPermission?.riskLevel === "dangerous" && (
              <div className="mt-3 flex items-start gap-2 rounded-md border border-[#cf222e]/25 bg-[#ffebe9] p-3 text-xs font-medium text-[#cf222e]">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                Review the requested action before approving it.
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
