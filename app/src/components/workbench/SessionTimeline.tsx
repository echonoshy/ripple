"use client";

import React from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  FileCode2,
  ImageIcon,
  ShieldAlert,
  Terminal,
  UserRound,
  Wrench,
} from "lucide-react";
import MarkdownRenderer, {
  type FeishuAuthOpenPayload,
  type FeishuAuthWaitingState,
} from "@/components/MarkdownRenderer";
import { downloadWorkspaceFile } from "@/lib/api";
import type { Message, WorkbenchTimelineEvent } from "@/types";

function formatTime(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function EventIcon({ type }: { type: WorkbenchTimelineEvent["type"] }) {
  if (type === "user_message") return <UserRound size={13} />;
  if (type === "approval_request") return <ShieldAlert size={13} />;
  if (type === "command") return <Terminal size={13} />;
  if (type === "file_change") return <FileCode2 size={13} />;
  if (type === "image_generation" || type === "image_view") return <ImageIcon size={13} />;
  if (type === "warning" || type === "error") return <AlertTriangle size={13} />;
  if (type === "tool_call") return <Wrench size={13} />;
  if (type === "final_summary") return <CheckCircle2 size={13} />;
  return <Bot size={13} />;
}

function eventIconClass(type: WorkbenchTimelineEvent["type"]): string {
  if (type === "user_message") {
    return "border-[#c8d6ff] bg-[linear-gradient(135deg,#edf4ff,#ffffff)] text-[#2f6bff]";
  }
  if (type === "assistant_message" || type === "runtime_update") {
    return "border-[#ded3ff] bg-[linear-gradient(135deg,#f2edff,#ffffff)] text-[#7b5cff]";
  }
  if (type === "command" || type === "tool_call") {
    return "border-[#ccebd7] bg-[linear-gradient(135deg,#edfff3,#ffffff)] text-[#1a9f5c]";
  }
  if (type === "file_change" || type === "final_summary") {
    return "border-[#d3e5ff] bg-[linear-gradient(135deg,#eef7ff,#ffffff)] text-[#0b7cd3]";
  }
  if (type === "image_generation" || type === "image_view") {
    return "border-[#ccebd7] bg-[linear-gradient(135deg,#f0fff7,#ffffff)] text-[#16824a]";
  }
  if (type === "approval_request") {
    return "border-[#f7d796] bg-[linear-gradient(135deg,#fff8df,#ffffff)] text-[#c47a00]";
  }
  if (type === "warning" || type === "error") {
    return "border-[#ffd0cc] bg-[linear-gradient(135deg,#fff0ef,#ffffff)] text-[#cf222e]";
  }
  return "border-[#dfe6f4] bg-white text-[#596579]";
}

function formatBytes(value: number | undefined): string {
  if (!value || value <= 0) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function TimelineImagePreview({ event }: { event: WorkbenchTimelineEvent }) {
  const [imageUrl, setImageUrl] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(Boolean(event.workspacePath));

  React.useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    setImageUrl(null);
    setError(null);
    setLoading(Boolean(event.workspacePath));

    if (!event.workspacePath) {
      setLoading(false);
      setError("Image path is unavailable.");
      return () => undefined;
    }

    void downloadWorkspaceFile(event.workspacePath)
      .then(({ blob }) => {
        objectUrl = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setImageUrl(objectUrl);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Could not load image preview.");
        setLoading(false);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [event.workspacePath]);

  const sizeLabel = formatBytes(event.size);

  return (
    <div className="mt-2 max-w-3xl">
      <div className="overflow-hidden rounded-lg border border-[#d9e4ef] bg-white">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={event.revisedPrompt || event.title}
            className="block max-h-[460px] w-full object-contain"
          />
        ) : (
          <div className="flex min-h-44 items-center justify-center bg-[#f7fafc] px-4 py-8 text-[12px] text-[#667085]">
            {loading ? "Loading image..." : error}
          </div>
        )}
      </div>
      <div className="mt-2 space-y-1 text-[11px] leading-5 text-[#5f6b7c] sm:text-xs">
        {event.revisedPrompt && <div>{event.revisedPrompt}</div>}
        {event.workspacePath && (
          <div className="font-[family-name:var(--font-mono)] break-all text-[#6b7280]">
            {event.workspacePath}
            {sizeLabel ? ` · ${sizeLabel}` : ""}
          </div>
        )}
      </div>
    </div>
  );
}

interface SessionTimelineProps {
  messages: Message[];
  events: WorkbenchTimelineEvent[];
  isGenerating: boolean;
  onQuickReply: (option: string) => void;
  onPermissionResolve: (action: "allow" | "always" | "deny") => void;
  onFeishuAuthOpen?: (payload: FeishuAuthOpenPayload) => void;
  feishuAuthWaiting?: FeishuAuthWaitingState | null;
}

export default function SessionTimeline({
  messages,
  events,
  isGenerating,
  onQuickReply,
  onPermissionResolve,
  onFeishuAuthOpen,
  feishuAuthWaiting,
}: SessionTimelineProps) {
  const lastMessage = messages[messages.length - 1];
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const pendingAskUser = !isGenerating ? lastAssistant?.askUser : undefined;
  const pendingPermission = !isGenerating ? lastAssistant?.permissionRequest : undefined;

  if (events.length === 0 && !isGenerating) {
    return (
      <div className="relative min-h-[140px] pl-8">
        <div className="absolute top-2 bottom-2 left-[11px] w-px bg-[#dfe6f4]" />
        <div className="relative py-2">
          <span className="absolute top-2.5 -left-8 flex h-6 w-6 items-center justify-center rounded-full border border-[#c8d6ff] bg-white text-[#2f6bff] shadow-[0_8px_18px_rgba(64,92,255,0.12)]">
            <span className="h-2 w-2 rounded-full bg-current" />
          </span>
          <div className="text-[12px] font-semibold text-[#111827]">Ready</div>
          <div className="mt-1 max-w-xl text-[12px] leading-5 text-[#667085]">
            Start a session and your workspace activity will appear here as a timeline.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative pl-8">
      <div className="absolute top-3 bottom-3 left-[11px] w-px bg-[#dfe6f4]" />
      {events.map((event) => {
        const isToolEvent = [
          "approval_request",
          "command",
          "file_change",
          "tool_call",
          "warning",
          "error",
          "context_compaction",
          "runtime_update",
        ].includes(event.type);
        const eventTime = formatTime(event.createdAt);

        return (
          <article
            key={event.id}
            className="relative border-b border-[#e9eef7]/80 py-2.5 last:border-b-0 sm:py-4"
          >
            <span
              className={`absolute top-2.5 -left-8 flex h-6 w-6 items-center justify-center rounded-full border shadow-[0_8px_18px_rgba(44,63,123,0.10)] ${eventIconClass(event.type)}`}
            >
              <EventIcon type={event.type} />
            </span>
            <div className="mb-1.5 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-[12px] leading-5 font-semibold text-[#111827] sm:text-sm">
                  {event.title}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5 text-[10px] text-[#7a8496]">
                {event.status && (
                  <span className="rounded-full border border-[#dfe6f4] bg-white/80 px-1.5 py-0.5 font-[family-name:var(--font-mono)]">
                    {event.status}
                  </span>
                )}
                {eventTime && <span>{eventTime}</span>}
              </div>
            </div>
            {isToolEvent ? (
              <div className="mt-2 rounded-xl border border-[#e2e8f0] bg-[linear-gradient(135deg,rgba(248,250,252,0.7),rgba(241,245,249,0.7))] px-3 py-2.5 font-[family-name:var(--font-mono)] text-[10px] leading-[18px] text-[#334155] shadow-[0_10px_24px_rgba(44,63,123,0.04)] backdrop-blur-md sm:text-xs">
                {event.body.split("\n").map((line, index) => (
                  <div key={`${event.id}-${index}`} className="truncate" title={line}>
                    {line}
                  </div>
                ))}
              </div>
            ) : event.type === "image_generation" || event.type === "image_view" ? (
              <TimelineImagePreview event={event} />
            ) : (
              <div className="markdown-body workbench-markdown max-w-4xl text-[12px] leading-5 text-[#384152] sm:text-sm sm:leading-6">
                <MarkdownRenderer
                  content={event.body}
                  onFeishuAuthOpen={onFeishuAuthOpen}
                  feishuAuthWaiting={feishuAuthWaiting}
                />
              </div>
            )}
          </article>
        );
      })}

      {isGenerating && lastMessage?.role === "assistant" && !lastMessage.content && (
        <article className="relative border-b border-[#e9eef7]/80 py-2.5">
          <span className="absolute top-2.5 -left-8 flex h-6 w-6 items-center justify-center rounded-full border border-[#ded3ff] bg-white text-[#7b5cff] shadow-[0_8px_18px_rgba(123,92,255,0.14)]">
            <span className="h-2 w-2 animate-pulse rounded-full bg-current" />
          </span>
          <div className="flex items-center gap-2 text-[12px] text-[#667085]">
            <Bot size={13} />
            {feishuAuthWaiting
              ? `正在等待浏览器中的${feishuAuthWaiting.label}完成... 已等待 ${feishuAuthWaiting.elapsedSeconds} 秒`
              : "Starting work..."}
          </div>
        </article>
      )}

      {pendingAskUser && (
        <div className="mt-3 rounded-xl border border-[#f2cc79]/55 bg-[#fff8df]/90 p-3 shadow-[0_10px_24px_rgba(196,122,0,0.08)]">
          <div className="mb-2 text-[13px] font-semibold text-[#7d4e00]">
            {pendingAskUser.question}
          </div>
          <div className="flex flex-wrap gap-2">
            {pendingAskUser.options.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => onQuickReply(option)}
                className="rounded-full border border-[#e0e6f2] bg-white px-3 py-1.5 text-[13px] font-medium text-[#111827] hover:bg-[#f7f8fa]"
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      )}

      {pendingPermission && (
        <div className="mt-3 rounded-xl border border-[#f2cc79]/55 bg-[#fff8df]/90 p-3 shadow-[0_10px_24px_rgba(196,122,0,0.08)]">
          <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-[#7d4e00]">
            <ShieldAlert size={14} />
            Permission required: {pendingPermission.tool}
          </div>
          <pre className="mb-3 max-h-48 overflow-auto rounded-xl border border-[#e2e8f0] bg-[linear-gradient(135deg,rgba(248,250,252,0.7),rgba(241,245,249,0.7))] p-3 font-[family-name:var(--font-mono)] text-[11px] whitespace-pre-wrap text-[#334155] backdrop-blur-md">
            {typeof pendingPermission.params === "string"
              ? pendingPermission.params
              : JSON.stringify(pendingPermission.params, null, 2)}
          </pre>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onPermissionResolve("allow")}
              className="rounded-full border border-[#1a7f37]/25 bg-[#dafbe1] px-3 py-1.5 text-[13px] font-semibold text-[#1a7f37] hover:bg-[#c7f7d1]"
            >
              Allow once
            </button>
            <button
              type="button"
              onClick={() => onPermissionResolve("always")}
              className="rounded-full border border-[#4067ff]/20 bg-[linear-gradient(135deg,#2f6bff,#7b5cff)] px-3 py-1.5 text-[13px] font-semibold text-white shadow-[0_10px_22px_rgba(64,92,255,0.22)]"
            >
              Allow for session
            </button>
            <button
              type="button"
              onClick={() => onPermissionResolve("deny")}
              className="rounded-full border border-[#cf222e]/25 bg-[#ffebe9] px-3 py-1.5 text-[13px] font-semibold text-[#cf222e] hover:bg-[#ffd7d5]"
            >
              Deny
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
