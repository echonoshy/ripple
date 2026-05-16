"use client";

import React from "react";
import {
  Bot,
  CheckCircle2,
  Clock3,
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
      <div className="flex min-h-[180px] items-center justify-center rounded-lg border border-dashed border-[#dde2ea] bg-[#f7f8fa] p-8 text-center text-sm text-[#68707d]">
        Ready.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {events.map((event) => {
        const isToolEvent = ["approval_request", "command", "file_change", "tool_call"].includes(
          event.type
        );
        const eventTime = formatTime(event.createdAt);

        if (event.type === "user_message") {
          return (
            <article key={event.id} className="flex justify-end">
              <div className="max-w-[78%] rounded-xl bg-[#eef1f5] px-4 py-3 text-sm leading-6 text-[#171a1f]">
                <div className="markdown-body workbench-markdown">
                  <MarkdownRenderer content={event.body} />
                </div>
              </div>
            </article>
          );
        }

        if (!isToolEvent) {
          return (
            <article
              key={event.id}
              className="rounded-xl border border-[#dde2ea] bg-white px-4 py-3"
            >
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-[#171a1f]">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#171a1f] text-white">
                    <Bot size={13} />
                  </span>
                  Codex
                </div>
                {eventTime && (
                  <div className="flex shrink-0 items-center gap-1 text-xs text-[#8b8f94]">
                    <Clock3 size={12} />
                    {eventTime}
                  </div>
                )}
              </div>
              <div className="markdown-body workbench-markdown text-sm">
                <MarkdownRenderer content={event.body} />
              </div>
            </article>
          );
        }

        return (
          <article key={event.id} className="rounded-lg border border-[#dde2ea] bg-[#f7f8fa] p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-[#68707d]">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[#dde2ea] bg-white">
                  <EventIcon type={event.type} />
                </span>
                <span className="truncate">{event.title}</span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5 text-xs text-[#8b8f94]">
                {event.status && (
                  <span className="rounded-md border border-[#dde2ea] bg-white px-1.5 py-0.5 font-[family-name:var(--font-mono)]">
                    {event.status}
                  </span>
                )}
                {eventTime && (
                  <>
                    <Clock3 size={12} />
                    {eventTime}
                  </>
                )}
              </div>
            </div>
            <pre className="max-h-64 overflow-auto rounded-md border border-[#dde2ea] bg-white p-3 font-[family-name:var(--font-mono)] text-xs leading-relaxed whitespace-pre-wrap text-[#394150]">
              {event.body}
            </pre>
          </article>
        );
      })}

      {isGenerating && lastMessage?.role === "assistant" && !lastMessage.content && (
        <article className="rounded-xl border border-[#dde2ea] bg-white px-4 py-3">
          <div className="flex items-center gap-2 text-sm text-[#68707d]">
            <Bot size={15} />
            <span className="h-2 w-2 animate-pulse rounded-full bg-[#2f6bff]" />
            Codex is starting work...
          </div>
        </article>
      )}

      {pendingAskUser && (
        <div className="rounded-lg border border-[#bf8700]/35 bg-[#fff8c5] p-3">
          <div className="mb-2 text-sm font-semibold text-[#7d4e00]">{pendingAskUser.question}</div>
          <div className="flex flex-wrap gap-2">
            {pendingAskUser.options.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => onQuickReply(option)}
                className="rounded-md border border-[#dde2ea] bg-white px-3 py-1.5 text-sm font-medium text-[#171a1f] hover:bg-[#f7f8fa]"
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      )}

      {pendingPermission && (
        <div className="rounded-lg border border-[#bf8700]/35 bg-[#fff8c5] p-3">
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
