"use client";

import React from "react";
import {
  Bot,
  CheckCircle2,
  FileCode2,
  ShieldAlert,
  Terminal,
  UserRound,
  Wrench,
} from "lucide-react";
import MarkdownRenderer from "@/components/MarkdownRenderer";
import type { Message, WorkbenchTimelineEvent } from "@/types";

function formatTime(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function EventIcon({ type }: { type: WorkbenchTimelineEvent["type"] }) {
  if (type === "user_message") return <UserRound size={15} />;
  if (type === "approval_request") return <ShieldAlert size={15} />;
  if (type === "command") return <Terminal size={15} />;
  if (type === "file_change") return <FileCode2 size={15} />;
  if (type === "tool_call") return <Wrench size={15} />;
  if (type === "final_summary") return <CheckCircle2 size={15} />;
  return <Bot size={15} />;
}

interface TaskTimelineProps {
  messages: Message[];
  events: WorkbenchTimelineEvent[];
  isGenerating: boolean;
  onQuickReply: (option: string) => void;
  onPermissionResolve: (action: "allow" | "always" | "deny") => void;
}

export default function TaskTimeline({
  messages,
  events,
  isGenerating,
  onQuickReply,
  onPermissionResolve,
}: TaskTimelineProps) {
  const lastMessage = messages[messages.length - 1];
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const pendingAskUser = !isGenerating ? lastAssistant?.askUser : undefined;
  const pendingPermission = !isGenerating ? lastAssistant?.permissionRequest : undefined;

  if (events.length === 0 && !isGenerating) {
    return (
      <div className="relative min-h-[180px] pl-8">
        <div className="absolute top-2 bottom-2 left-[9px] w-px bg-[#e5e7eb]" />
        <div className="relative py-2">
          <span className="absolute top-3 -left-8 flex h-5 w-5 items-center justify-center rounded-full border border-[#2463eb] bg-white text-[#2463eb]">
            <span className="h-2 w-2 rounded-full bg-current" />
          </span>
          <div className="text-sm font-semibold text-[#0d0d0d]">Ready</div>
          <div className="mt-1 max-w-xl text-sm leading-6 text-[#6b7280]">
            Start a task and Codex activity will appear here as a timeline.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative pl-8">
      <div className="absolute top-3 bottom-3 left-[9px] w-px bg-[#e5e7eb]" />
      {events.map((event) => {
        const isToolEvent = ["approval_request", "command", "file_change", "tool_call"].includes(
          event.type
        );
        const eventTime = formatTime(event.createdAt);

        return (
          <article
            key={event.id}
            className="relative border-b border-[#edf0f4] py-4 last:border-b-0"
          >
            <span
              className={`absolute top-4 -left-8 flex h-5 w-5 items-center justify-center rounded-full border bg-white ${
                isToolEvent ? "border-[#e5e7eb] text-[#374151]" : "border-[#2463eb] text-[#2463eb]"
              }`}
            >
              {isToolEvent ? (
                <EventIcon type={event.type} />
              ) : (
                <span className="h-2 w-2 rounded-full bg-current" />
              )}
            </span>
            <div className="mb-1.5 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-[#0d0d0d]">{event.title}</div>
                {event.type === "user_message" && (
                  <div className="mt-0.5 text-xs font-medium text-[#6b7280]">User request</div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2 text-xs text-[#6b7280]">
                {event.status && (
                  <span className="rounded-md border border-[#e5e7eb] bg-[#f7f8fa] px-1.5 py-0.5 font-[family-name:var(--font-mono)]">
                    {event.status}
                  </span>
                )}
                {eventTime && <span>{eventTime}</span>}
              </div>
            </div>
            {isToolEvent ? (
              <pre className="mt-2 max-h-36 overflow-auto rounded-md border border-[#e5e7eb] bg-[#f7f8fa] p-2.5 font-[family-name:var(--font-mono)] text-xs leading-relaxed whitespace-pre-wrap text-[#374151]">
                {event.body}
              </pre>
            ) : (
              <div className="markdown-body workbench-markdown max-w-2xl text-sm leading-6 text-[#374151]">
                <MarkdownRenderer content={event.body} />
              </div>
            )}
          </article>
        );
      })}

      {isGenerating && lastMessage?.role === "assistant" && !lastMessage.content && (
        <article className="relative border-b border-[#edf0f4] py-4">
          <span className="absolute top-4 -left-8 flex h-5 w-5 items-center justify-center rounded-full border border-[#2463eb] bg-white text-[#2463eb]">
            <span className="h-2 w-2 animate-pulse rounded-full bg-current" />
          </span>
          <div className="flex items-center gap-2 text-sm text-[#6b7280]">
            <Bot size={15} />
            Codex is starting work...
          </div>
        </article>
      )}

      {pendingAskUser && (
        <div className="mt-4 rounded-lg border border-[#bf8700]/35 bg-[#fff8c5] p-3">
          <div className="mb-2 text-sm font-semibold text-[#7d4e00]">{pendingAskUser.question}</div>
          <div className="flex flex-wrap gap-2">
            {pendingAskUser.options.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => onQuickReply(option)}
                className="rounded-md border border-[#e5e7eb] bg-white px-3 py-1.5 text-sm font-medium text-[#0d0d0d] hover:bg-[#f7f8fa]"
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      )}

      {pendingPermission && (
        <div className="mt-4 rounded-lg border border-[#bf8700]/35 bg-[#fff8c5] p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[#7d4e00]">
            <ShieldAlert size={15} />
            Permission required: {pendingPermission.tool}
          </div>
          <pre className="mb-3 max-h-48 overflow-auto rounded-md bg-[#0d1117] p-3 font-[family-name:var(--font-mono)] text-xs whitespace-pre-wrap text-[#c9d1d9]">
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
              Allow for session
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
      )}
    </div>
  );
}
