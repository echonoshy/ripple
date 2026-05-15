"use client";

import React from "react";
import { Bot, CheckCircle2, Clock3, ShieldAlert, UserRound } from "lucide-react";
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
      <div className="flex h-full min-h-[280px] items-center justify-center rounded-md border border-dashed border-[#d0d7de] bg-[#f6f8fa] p-8 text-center text-sm text-[#6e7781]">
        Ready for a new Codex task.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {events.map((event) => (
        <article key={event.id} className="flex gap-3">
          <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#d0d7de] bg-white text-[#57606a]">
            <EventIcon type={event.type} />
          </div>
          <div className="min-w-0 flex-1 rounded-md border border-[#d0d7de] bg-white">
            <div className="flex items-center justify-between gap-3 border-b border-[#d8dee4] px-3 py-2">
              <div className="min-w-0 truncate text-sm font-semibold text-[#24292f]">
                {event.title}
              </div>
              <div className="flex shrink-0 items-center gap-1.5 text-xs text-[#6e7781]">
                {event.status && (
                  <span className="rounded-full border border-[#d0d7de] bg-[#f6f8fa] px-2 py-0.5 font-[family-name:var(--font-mono)]">
                    {event.status}
                  </span>
                )}
                {formatTime(event.createdAt) && (
                  <>
                    <Clock3 size={12} />
                    {formatTime(event.createdAt)}
                  </>
                )}
              </div>
            </div>
            <div className="min-w-0 px-3 py-3 text-sm text-[#24292f]">
              {event.type === "approval_request" ? (
                <pre className="max-h-64 overflow-auto rounded-md bg-[#0d1117] p-3 font-[family-name:var(--font-mono)] text-xs leading-relaxed whitespace-pre-wrap text-[#c9d1d9]">
                  {event.body}
                </pre>
              ) : (
                <div className="markdown-body workbench-markdown">
                  <MarkdownRenderer content={event.body} />
                </div>
              )}
            </div>
          </div>
        </article>
      ))}

      {isGenerating && lastMessage?.role === "assistant" && !lastMessage.content && (
        <article className="flex gap-3">
          <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#d0d7de] bg-white text-[#57606a]">
            <Bot size={15} />
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-[#d0d7de] bg-white px-3 py-3 text-sm text-[#57606a]">
            <span className="h-2 w-2 animate-pulse rounded-full bg-[#0969da]" />
            Codex is starting work...
          </div>
        </article>
      )}

      {pendingAskUser && (
        <div className="rounded-md border border-[#bf8700]/35 bg-[#fff8c5] p-3">
          <div className="mb-2 text-sm font-semibold text-[#7d4e00]">{pendingAskUser.question}</div>
          <div className="flex flex-wrap gap-2">
            {pendingAskUser.options.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => onQuickReply(option)}
                className="rounded-md border border-[#d0d7de] bg-white px-3 py-1.5 text-sm font-medium text-[#24292f] hover:bg-[#f6f8fa]"
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      )}

      {pendingPermission && (
        <div className="rounded-md border border-[#bf8700]/35 bg-[#fff8c5] p-3">
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
