"use client";

import React, { useMemo, useState } from "react";
import { Boxes, Files, ShieldAlert, SplitSquareHorizontal, SquareTerminal } from "lucide-react";
import WorkspaceExplorer from "@/components/WorkspaceExplorer";
import { formatTerminalOutputPreview } from "@/lib/terminalOutput";
import type { Message, TaskInfo, TaskProgress, ToolCall, WorkbenchTaskSummary } from "@/types";
import StatusChip from "./StatusChip";

type InspectorTab = "files" | "terminal" | "diff" | "context" | "approvals";

const tabs: {
  id: InspectorTab;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
}[] = [
  { id: "files", label: "Files", icon: Files },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "diff", label: "Diff", icon: SplitSquareHorizontal },
  { id: "context", label: "Context", icon: Boxes },
  { id: "approvals", label: "Approvals", icon: ShieldAlert },
];

function collectToolCalls(messages: Message[]): ToolCall[] {
  return messages.flatMap((message) =>
    message.role === "assistant" && message.toolCalls ? message.toolCalls : []
  );
}

function collectPermissionMessages(messages: Message[]): Message[] {
  return messages.filter((message) => Boolean(message.permissionRequest));
}

interface InspectorPanelProps {
  messages: Message[];
  task: WorkbenchTaskSummary | null;
  taskSteps: TaskInfo[];
  taskProgress: TaskProgress | null;
  userId: string;
  selectedModel: string;
  sessionId: string | null;
  workspaceRefreshToken: number;
  onPermissionResolve: (action: "allow" | "always" | "deny") => void;
}

export default function InspectorPanel({
  messages,
  task,
  taskSteps,
  taskProgress,
  userId,
  selectedModel,
  sessionId,
  workspaceRefreshToken,
  onPermissionResolve,
}: InspectorPanelProps) {
  const [activeTab, setActiveTab] = useState<InspectorTab>("files");
  const toolCalls = useMemo(() => collectToolCalls(messages), [messages]);
  const permissionMessages = useMemo(() => collectPermissionMessages(messages), [messages]);
  const pendingPermission = [...permissionMessages]
    .reverse()
    .find((message) => message.permissionRequest)?.permissionRequest;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[#d0d7de] bg-[#f6f8fa] p-2">
        <div className="grid grid-cols-3 gap-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex h-8 items-center justify-center gap-1 rounded-md border px-2 text-xs font-medium ${
                  selected
                    ? "border-[#0969da] bg-white text-[#0969da]"
                    : "border-[#d0d7de] bg-white text-[#57606a] hover:bg-[#f6f8fa] hover:text-[#24292f]"
                }`}
              >
                <Icon size={13} />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === "files" && (
          <div className="h-full">
            <WorkspaceExplorer userId={userId} refreshToken={workspaceRefreshToken} />
          </div>
        )}

        {activeTab === "terminal" && (
          <div className="h-full overflow-y-auto p-3">
            {toolCalls.length === 0 ? (
              <div className="flex h-52 items-center justify-center rounded-md border border-dashed border-[#d0d7de] bg-white text-sm text-[#6e7781]">
                Command and tool output will appear here.
              </div>
            ) : (
              <div className="space-y-3">
                {toolCalls.map((tool) => {
                  const resultPreview =
                    typeof tool.result === "string"
                      ? formatTerminalOutputPreview(tool.result)
                      : null;
                  return (
                    <article key={tool.id} className="rounded-md border border-[#d0d7de] bg-white">
                      <div className="flex items-center justify-between gap-2 border-b border-[#d8dee4] px-3 py-2">
                        <span className="truncate font-[family-name:var(--font-mono)] text-xs font-semibold text-[#24292f]">
                          {tool.name}
                        </span>
                        <StatusChip
                          tone={
                            tool.status === "error"
                              ? "red"
                              : tool.status === "running"
                                ? "blue"
                                : "green"
                          }
                          label={tool.status}
                        />
                      </div>
                      <div className="space-y-3 p-3">
                        <div>
                          <div className="mb-1 text-xs font-semibold text-[#6e7781]">args</div>
                          <pre className="max-h-40 overflow-auto rounded-md bg-[#0d1117] p-2 font-[family-name:var(--font-mono)] text-xs whitespace-pre-wrap text-[#c9d1d9]">
                            {typeof tool.arguments === "string"
                              ? tool.arguments
                              : JSON.stringify(tool.arguments, null, 2)}
                          </pre>
                        </div>
                        {resultPreview && (
                          <div>
                            <div className="mb-1 text-xs font-semibold text-[#6e7781]">result</div>
                            <pre className="max-h-64 overflow-auto rounded-md bg-[#0d1117] p-2 font-[family-name:var(--font-mono)] text-xs whitespace-pre-wrap text-[#c9d1d9]">
                              {resultPreview.text}
                            </pre>
                            {resultPreview.isTruncated && (
                              <div className="mt-2 text-xs text-[#6e7781]">
                                Showing first {resultPreview.text.length.toLocaleString()} chars;{" "}
                                {resultPreview.hiddenChars.toLocaleString()} hidden.
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {activeTab === "diff" && (
          <div className="h-full overflow-y-auto p-3">
            <div className="rounded-md border border-dashed border-[#d0d7de] bg-white p-6 text-sm text-[#6e7781]">
              Diff metadata is not exposed by the current server API. This panel is reserved for a
              future git/snapshot-backed change review.
            </div>
          </div>
        )}

        {activeTab === "context" && (
          <div className="h-full overflow-y-auto p-3">
            <div className="space-y-3">
              <section className="rounded-md border border-[#d0d7de] bg-white p-3">
                <div className="mb-2 text-xs font-semibold tracking-wide text-[#6e7781] uppercase">
                  Runtime
                </div>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-[#57606a]">User</dt>
                    <dd className="truncate font-[family-name:var(--font-mono)] text-[#24292f]">
                      {userId}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-[#57606a]">Model</dt>
                    <dd className="truncate font-[family-name:var(--font-mono)] text-[#24292f]">
                      {selectedModel}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-[#57606a]">Session</dt>
                    <dd className="truncate font-[family-name:var(--font-mono)] text-[#24292f]">
                      {sessionId || "not started"}
                    </dd>
                  </div>
                </dl>
              </section>

              <section className="rounded-md border border-[#d0d7de] bg-white p-3">
                <div className="mb-2 text-xs font-semibold tracking-wide text-[#6e7781] uppercase">
                  Task state
                </div>
                <div className="mb-2">{task ? <StatusChip status={task.status} /> : "Ready"}</div>
                <div className="text-sm text-[#57606a]">
                  {taskProgress
                    ? `${taskProgress.completed}/${taskProgress.total} plan steps complete`
                    : "No structured progress event yet."}
                </div>
                {taskSteps.length > 0 && (
                  <ul className="mt-3 space-y-2 text-sm text-[#24292f]">
                    {taskSteps.slice(0, 6).map((step) => (
                      <li key={step.id} className="flex items-start gap-2">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#8c959f]" />
                        <span>{step.subject}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </div>
        )}

        {activeTab === "approvals" && (
          <div className="h-full overflow-y-auto p-3">
            {!pendingPermission ? (
              <div className="flex h-52 items-center justify-center rounded-md border border-dashed border-[#d0d7de] bg-white text-sm text-[#6e7781]">
                No pending approvals.
              </div>
            ) : (
              <div className="rounded-md border border-[#bf8700]/35 bg-[#fff8c5] p-3">
                <div className="mb-2 text-sm font-semibold text-[#7d4e00]">
                  {pendingPermission.tool}
                </div>
                <pre className="mb-3 max-h-64 overflow-auto rounded-md bg-[#0d1117] p-3 font-[family-name:var(--font-mono)] text-xs whitespace-pre-wrap text-[#c9d1d9]">
                  {typeof pendingPermission.params === "string"
                    ? pendingPermission.params
                    : JSON.stringify(pendingPermission.params, null, 2)}
                </pre>
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => onPermissionResolve("allow")}
                    className="rounded-md border border-[#1a7f37]/30 bg-[#dafbe1] px-3 py-1.5 text-sm font-semibold text-[#1a7f37]"
                  >
                    Allow once
                  </button>
                  <button
                    type="button"
                    onClick={() => onPermissionResolve("always")}
                    className="rounded-md border border-[#0969da]/25 bg-[#ddf4ff] px-3 py-1.5 text-sm font-semibold text-[#0969da]"
                  >
                    Allow for session
                  </button>
                  <button
                    type="button"
                    onClick={() => onPermissionResolve("deny")}
                    className="rounded-md border border-[#cf222e]/25 bg-[#ffebe9] px-3 py-1.5 text-sm font-semibold text-[#cf222e]"
                  >
                    Deny
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
