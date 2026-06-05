"use client";

import React from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Copy,
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
import { IconTile, type IconTileTone } from "@/components/icons/IconTile";
import { useI18n, type MessageKey } from "@/i18n";
import { downloadWorkspaceFile } from "@/lib/api";
import { copyTextToClipboard } from "@/lib/clipboard";
import { getWorkspaceImagePreviewUrl } from "@/lib/workspaceImageCache";
import type { Message, WorkbenchTimelineEvent } from "@/types";
import {
  TYPOGRAPHY_BODY_CLASS,
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_MICRO_CLASS,
} from "./stylePrimitives";

export const WAITING_STATUS_MESSAGES = [
  "On it...",
  "Hmm, let me see...",
  "Okay, one sec...",
  "Alright, let me think...",
  "Hmm, interesting...",
  "Give me a moment...",
  "Let me sit with that...",
  "Okay, I'm thinking...",
  "Let's see...",
  "Hold on a sec...",
  "Alright, one moment...",
  "Mm, okay...",
  "Ah, I see...",
  "Let me mull it over...",
  "Thinking out loud...",
  "Okay, let's untangle this...",
  "Hmm, let's make sense of it...",
  "I have a thought...",
  "One sec, thinking...",
  "Let me chew on that...",
  "Okay, I follow...",
  "Hmm, almost there...",
  "Give me a beat...",
  "Alright, let's think...",
  "Interesting, one moment...",
  "Okay, let me work it out...",
  "Hmm, this is a nice one...",
  "Let me get my head around it...",
  "Okay, I see the shape...",
  "One moment, please...",
  "Let me reason this out...",
  "Hmm, I am with you...",
  "Okay, taking a look...",
  "Let me think for a sec...",
  "Aha, one second...",
  "Hmm, fair question...",
  "Okay, let me sort this out...",
  "Just a moment...",
  "I am on it...",
  "Let's think...",
  "Hmm, okay...",
  "Let me pause on that...",
  "Okay, making sense of it...",
  "Give me a second...",
  "Alright, I am thinking...",
  "Hmm, let me feel this out...",
  "Okay, small pause...",
  "Let me turn that over...",
  "One tiny moment...",
  "Okay, I am working on it...",
  "Hmm, I see what you mean...",
  "Let me hold that thought...",
  "Alright, thinking cap on...",
  "Okay, let's figure this out...",
  "Hmm, let me try this angle...",
  "Give me half a second...",
  "Okay, I have got this...",
  "Let me make this neat...",
  "Hmm, curious...",
  "Alright, here we go...",
  "Thinking it through...",
  "Working through this...",
  "Putting it together...",
  "One moment...",
  "Let's untangle this...",
] as const;

export const ZH_WAITING_STATUS_MESSAGES = [
  "我看一下。",
  "等我理一理。",
  "这个有点意思。",
  "我先把思路捋顺。",
  "稍等，我在处理。",
  "我想一下。",
  "让我琢磨一下。",
  "好，我来看看。",
  "等我把这事想清楚。",
  "我先顺一下逻辑。",
  "稍等片刻。",
  "我来处理。",
  "让我想想怎么做更合适。",
  "好，我跟上了。",
  "我先看一眼。",
  "给我一点时间。",
  "我在整理答案。",
  "让我换个角度想想。",
  "好，马上。",
  "我来把它拆开看。",
] as const;

function randomWaitingStatusMessage(messages: readonly string[]): string {
  const index = Math.floor(Math.random() * messages.length);
  return messages[index] || messages[0] || "";
}

type Translator = ReturnType<typeof useI18n>["t"];

const TIMELINE_ICON_ROW_CLASS = "grid min-h-6 grid-cols-[24px_minmax(0,1fr)] items-center gap-2";
const TIMELINE_CONTENT_INDENT_CLASS = "ml-8";
const TIMELINE_EVENT_DIVIDER_CLASS =
  "after:absolute after:right-0 after:bottom-0 after:left-8 after:h-px after:bg-[#e9eef7]/80 last:after:hidden";

const EVENT_TITLE_KEYS_BY_TITLE = {
  "User request": "timeline.eventTitles.userRequest",
  Update: "timeline.eventTitles.assistantUpdate",
  Response: "timeline.eventTitles.response",
  "Permission required": "timeline.eventTitles.permissionRequired",
  "Working with tools": "timeline.eventTitles.workingWithTools",
  "Tool activity failed": "timeline.eventTitles.toolActivityFailed",
  "Tool activity": "timeline.eventTitles.toolActivity",
  "Command output": "timeline.eventTitles.commandOutput",
  "File output": "timeline.eventTitles.fileOutput",
  "Folder context search": "timeline.eventTitles.folderContextSearch",
  "File patch updated": "timeline.eventTitles.filePatchUpdated",
  "System warning": "timeline.eventTitles.systemWarning",
  "System error": "timeline.eventTitles.systemError",
  "Context compacted": "timeline.eventTitles.contextCompacted",
  "Workspace diff": "timeline.eventTitles.workspaceDiff",
  "Generated image": "timeline.eventTitles.generatedImage",
  Image: "timeline.eventTitles.image",
  "Runtime update": "timeline.eventTitles.runtimeUpdate",
} as const satisfies Record<string, MessageKey>;

const EVENT_TITLE_KEYS_BY_TYPE = {
  user_message: "timeline.eventTitles.userRequest",
  assistant_message: "timeline.eventTitles.assistantUpdate",
  final_summary: "timeline.eventTitles.response",
  approval_request: "timeline.eventTitles.permissionRequired",
  command: "timeline.eventTitles.commandOutput",
  file_change: "timeline.eventTitles.workspaceDiff",
  tool_call: "timeline.eventTitles.toolActivity",
  warning: "timeline.eventTitles.systemWarning",
  error: "timeline.eventTitles.systemError",
  context_compaction: "timeline.eventTitles.contextCompacted",
  runtime_update: "timeline.eventTitles.runtimeUpdate",
  image_generation: "timeline.eventTitles.generatedImage",
  image_view: "timeline.eventTitles.image",
} as const satisfies Partial<Record<WorkbenchTimelineEvent["type"], MessageKey>>;

const STATUS_KEYS_BY_VALUE = {
  running: "timeline.status.running",
  completed: "timeline.status.completed",
  success: "timeline.status.success",
  error: "timeline.status.error",
  dangerous: "timeline.status.dangerous",
  stdout: "timeline.status.stdout",
  stderr: "timeline.status.stderr",
  pending: "timeline.status.pending",
  failed: "timeline.status.failed",
  cancelled: "timeline.status.cancelled",
  canceled: "timeline.status.cancelled",
} as const satisfies Record<string, MessageKey>;

function timelineEventTitle(event: WorkbenchTimelineEvent, t: Translator): string {
  const titleKey =
    EVENT_TITLE_KEYS_BY_TITLE[event.title as keyof typeof EVENT_TITLE_KEYS_BY_TITLE] ||
    EVENT_TITLE_KEYS_BY_TYPE[event.type];
  return titleKey ? t(titleKey) : event.title;
}

function timelineStatusLabel(status: string, t: Translator): string {
  const statusKey = STATUS_KEYS_BY_VALUE[status.toLowerCase() as keyof typeof STATUS_KEYS_BY_VALUE];
  return statusKey ? t(statusKey) : status;
}

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

function eventIconTone(type: WorkbenchTimelineEvent["type"]): IconTileTone {
  if (type === "user_message") {
    return "neutral";
  }
  if (type === "assistant_message" || type === "runtime_update") {
    return "accent";
  }
  if (type === "command" || type === "tool_call") {
    return "success";
  }
  if (type === "file_change" || type === "final_summary") {
    return "accent";
  }
  if (type === "image_generation" || type === "image_view") {
    return "success";
  }
  if (type === "approval_request") {
    return "warning";
  }
  if (type === "warning" || type === "error") {
    return "danger";
  }
  return "neutral";
}

function formatBytes(value: number | undefined): string {
  if (!value || value <= 0) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function TimelineImagePreview({
  event,
  userId,
}: {
  event: WorkbenchTimelineEvent;
  userId?: string;
}) {
  const { t } = useI18n();
  const [imageUrl, setImageUrl] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(Boolean(event.workspacePath));

  React.useEffect(() => {
    let cancelled = false;

    setImageUrl(null);
    setError(null);
    setLoading(Boolean(event.workspacePath));

    if (!event.workspacePath) {
      setLoading(false);
      setError(t("timeline.imagePathUnavailable"));
      return () => undefined;
    }

    const workspacePath = event.workspacePath;
    void getWorkspaceImagePreviewUrl(
      {
        userId,
        path: workspacePath,
        size: event.size,
        mimeType: event.mimeType,
      },
      async () => {
        const downloaded = await downloadWorkspaceFile(workspacePath);
        return downloaded.blob;
      }
    )
      .then((url) => {
        if (cancelled) return;
        setImageUrl(url);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(t("timeline.imagePreviewFailed"));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [event.mimeType, event.size, event.workspacePath, t, userId]);

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
          <div
            className={`flex min-h-44 items-center justify-center bg-[#f7fafc] px-4 py-8 ${TYPOGRAPHY_META_CLASS} text-[#646A73]`}
          >
            {loading ? t("timeline.loadingImage") : error}
          </div>
        )}
      </div>
      <div className={`mt-2 space-y-1 ${TYPOGRAPHY_META_CLASS} text-[#5f6b7c]`}>
        {event.revisedPrompt && <div>{event.revisedPrompt}</div>}
        {event.workspacePath && (
          <div className="font-[family-name:var(--font-mono)] break-all text-[#646A73]">
            {event.workspacePath}
            {sizeLabel ? ` · ${sizeLabel}` : ""}
          </div>
        )}
      </div>
    </div>
  );
}

interface SessionTimelineProps {
  userId?: string;
  messages: Message[];
  events: WorkbenchTimelineEvent[];
  isGenerating: boolean;
  onQuickReply: (option: string) => void;
  onPermissionResolve: (action: "allow" | "always" | "deny") => void;
  onFeishuAuthOpen?: (payload: FeishuAuthOpenPayload) => void;
  feishuAuthWaiting?: FeishuAuthWaitingState | null;
}

export default function SessionTimeline({
  userId,
  messages,
  events,
  isGenerating,
  onQuickReply,
  onPermissionResolve,
  onFeishuAuthOpen,
  feishuAuthWaiting,
}: SessionTimelineProps) {
  const { locale, t } = useI18n();
  const lastMessage = messages[messages.length - 1];
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const pendingAskUser = !isGenerating ? lastAssistant?.askUser : undefined;
  const pendingPermission = !isGenerating ? lastAssistant?.permissionRequest : undefined;
  const [copiedEventId, setCopiedEventId] = React.useState<string | null>(null);
  const [activeCopyEventId, setActiveCopyEventId] = React.useState<string | null>(null);
  const copyResetTimerRef = React.useRef<number | null>(null);
  const waitingStatusKey =
    isGenerating && lastMessage?.role === "assistant" && !lastMessage.content
      ? String(lastMessage.id)
      : "";
  const waitingStatusMessage = React.useMemo(() => {
    const messages = locale === "zh-CN" ? ZH_WAITING_STATUS_MESSAGES : WAITING_STATUS_MESSAGES;
    return waitingStatusKey ? randomWaitingStatusMessage(messages) : messages[0];
  }, [locale, waitingStatusKey]);

  React.useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  const handleCopyEvent = React.useCallback(async (event: WorkbenchTimelineEvent) => {
    const didCopy = await copyTextToClipboard(event.body);
    if (!didCopy) return;

    setCopiedEventId(event.id);
    setActiveCopyEventId(event.id);
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = window.setTimeout(() => {
      setCopiedEventId(null);
      setActiveCopyEventId(null);
      copyResetTimerRef.current = null;
    }, 1400);
  }, []);

  const handleMobileCopyReveal = React.useCallback(
    (pointerEvent: React.PointerEvent<HTMLElement>, event: WorkbenchTimelineEvent) => {
      if (pointerEvent.pointerType !== "touch") return;
      setActiveCopyEventId(event.id);
    },
    []
  );

  if (events.length === 0 && !isGenerating) {
    return (
      <div className="relative min-h-[140px]">
        <div className="absolute top-2 bottom-2 left-[11px] w-px bg-[#DEE0E3]" />
        <div className="relative py-2">
          <div className={TIMELINE_ICON_ROW_CLASS}>
            <IconTile
              tone="accent"
              size="xs"
              className="rounded-full shadow-[0_8px_18px_rgba(64,92,255,0.12)]"
            >
              <span className="h-2 w-2 rounded-full bg-current" />
            </IconTile>
            <div className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}>
              {t("timeline.ready")}
            </div>
          </div>
          <div
            className={`mt-1 max-w-xl ${TIMELINE_CONTENT_INDENT_CLASS} ${TYPOGRAPHY_BODY_CLASS} text-[#646A73]`}
          >
            {t("timeline.activityWillAppear")}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="absolute top-3 bottom-3 left-[11px] w-px bg-[#DEE0E3]" />
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
        const displayTitle = timelineEventTitle(event, t);
        const displayStatus = event.status ? timelineStatusLabel(event.status, t) : "";
        const canCopyEvent =
          !isToolEvent &&
          event.type !== "image_generation" &&
          event.type !== "image_view" &&
          event.body.trim().length > 0;
        const isCopied = copiedEventId === event.id;
        const isMobileCopyVisible = activeCopyEventId === event.id || isCopied;

        return (
          <article
            key={event.id}
            data-ripple-copyable-event-id={canCopyEvent ? event.id : undefined}
            onPointerDown={
              canCopyEvent
                ? (pointerEvent) => handleMobileCopyReveal(pointerEvent, event)
                : undefined
            }
            className={`group/timeline-event relative py-2.5 sm:py-4 ${TIMELINE_EVENT_DIVIDER_CLASS}`}
          >
            <div className={`mb-1.5 ${TIMELINE_ICON_ROW_CLASS}`}>
              <IconTile
                tone={eventIconTone(event.type)}
                size="xs"
                className="rounded-full shadow-[0_8px_18px_rgba(31,35,41,0.10)]"
              >
                <EventIcon type={event.type} />
              </IconTile>
              <div className="flex min-w-0 items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className={`truncate ${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}>
                    {displayTitle}
                  </div>
                </div>
                <div
                  className={`flex shrink-0 items-center gap-1.5 ${TYPOGRAPHY_MICRO_CLASS} text-[#646A73]`}
                >
                  {event.status && (
                    <span className="rounded-full border border-[#DEE0E3] bg-white/80 px-1.5 py-0.5 font-[family-name:var(--font-mono)]">
                      {displayStatus}
                    </span>
                  )}
                  {eventTime && <span>{eventTime}</span>}
                  {canCopyEvent && (
                    <button
                      type="button"
                      aria-label={t("timeline.copyEventContent", { title: displayTitle })}
                      title={t("timeline.copyContent")}
                      data-ripple-mobile-copy-visible={isMobileCopyVisible ? "true" : "false"}
                      onClick={() => void handleCopyEvent(event)}
                      className={`inline-flex h-7 w-7 items-center justify-center rounded-full border border-[#DEE0E3] bg-white/82 text-[#646A73] shadow-[0_6px_14px_rgba(31,35,41,0.06)] transition-all hover:bg-[#F5F6F7] hover:text-[#1456F0] focus:pointer-events-auto focus:opacity-100 active:bg-[#F0F5FF] lg:pointer-events-none lg:opacity-0 lg:group-focus-within/timeline-event:pointer-events-auto lg:group-focus-within/timeline-event:opacity-100 lg:group-hover/timeline-event:pointer-events-auto lg:group-hover/timeline-event:opacity-100 ${
                        isMobileCopyVisible
                          ? "pointer-events-auto opacity-100"
                          : "pointer-events-none opacity-0"
                      }`}
                    >
                      {isCopied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                    </button>
                  )}
                </div>
              </div>
            </div>
            {isToolEvent ? (
              <div
                className={`${TIMELINE_CONTENT_INDENT_CLASS} mt-2 rounded-xl border border-[#e2e8f0] bg-[linear-gradient(135deg,rgba(248,250,252,0.7),rgba(241,245,249,0.7))] px-3 py-2.5 font-[family-name:var(--font-mono)] ${TYPOGRAPHY_META_CLASS} text-[#334155] shadow-[0_10px_24px_rgba(31,35,41,0.04)] backdrop-blur-md`}
              >
                {event.body.split("\n").map((line, index) => (
                  <div key={`${event.id}-${index}`} className="truncate" title={line}>
                    {line}
                  </div>
                ))}
              </div>
            ) : event.type === "image_generation" || event.type === "image_view" ? (
              <div className={TIMELINE_CONTENT_INDENT_CLASS}>
                <TimelineImagePreview event={event} userId={userId} />
              </div>
            ) : (
              <div
                className={`${TIMELINE_CONTENT_INDENT_CLASS} markdown-body workbench-markdown max-w-4xl ${TYPOGRAPHY_BODY_CLASS} text-[#2B2F36]`}
              >
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
        <article className={`relative py-2.5 ${TIMELINE_EVENT_DIVIDER_CLASS}`}>
          <div className={`${TIMELINE_ICON_ROW_CLASS} ${TYPOGRAPHY_BODY_CLASS} text-[#646A73]`}>
            <IconTile
              tone="accent"
              size="xs"
              className="rounded-full shadow-[0_8px_18px_rgba(123,92,255,0.14)]"
            >
              <span className="h-2 w-2 animate-pulse rounded-full bg-current" />
            </IconTile>
            <div className="flex min-w-0 items-center gap-2">
              <Bot size={13} className="shrink-0" />
              {feishuAuthWaiting
                ? t("timeline.feishuWaiting", {
                    label: feishuAuthWaiting.label,
                  })
                : waitingStatusMessage}
            </div>
          </div>
        </article>
      )}

      {pendingAskUser && (
        <div
          className={`${TIMELINE_CONTENT_INDENT_CLASS} mt-3 rounded-xl border border-[#FAD355]/55 bg-[#FFF8DB]/90 p-3 shadow-[0_10px_24px_rgba(196,122,0,0.08)]`}
        >
          <div className={`mb-2 ${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#8B5E00]`}>
            {pendingAskUser.question}
          </div>
          <div className="flex flex-wrap gap-2">
            {pendingAskUser.options.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => onQuickReply(option)}
                className={`rounded-full border border-[#DEE0E3] bg-white px-3 py-1.5 ${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329] hover:bg-[#F8F9FA]`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      )}

      {pendingPermission && (
        <div
          className={`${TIMELINE_CONTENT_INDENT_CLASS} mt-3 rounded-xl border border-[#FAD355]/55 bg-[#FFF8DB]/90 p-3 shadow-[0_10px_24px_rgba(196,122,0,0.08)]`}
        >
          <div
            className={`mb-2 flex items-center gap-2 ${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#8B5E00]`}
          >
            <ShieldAlert size={14} />
            {t("timeline.permissionRequired", { tool: pendingPermission.tool })}
          </div>
          <pre
            className={`mb-3 max-h-48 overflow-auto rounded-xl border border-[#e2e8f0] bg-[linear-gradient(135deg,rgba(248,250,252,0.7),rgba(241,245,249,0.7))] p-3 font-[family-name:var(--font-mono)] ${TYPOGRAPHY_META_CLASS} whitespace-pre-wrap text-[#334155] backdrop-blur-md`}
          >
            {typeof pendingPermission.params === "string"
              ? pendingPermission.params
              : JSON.stringify(pendingPermission.params, null, 2)}
          </pre>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onPermissionResolve("allow")}
              className={`rounded-full border border-[#16845B]/25 bg-[#E4F8EE] px-3 py-1.5 ${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#16845B] hover:bg-[#DDF7E9]`}
            >
              {t("timeline.allowOnce")}
            </button>
            <button
              type="button"
              onClick={() => onPermissionResolve("always")}
              className={`rounded-full border border-[#1456F0]/20 bg-[#1456F0] px-3 py-1.5 ${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-white shadow-[0_10px_22px_rgba(20,86,240,0.22)] hover:bg-[#0F4BD8]`}
            >
              {t("timeline.allowForSession")}
            </button>
            <button
              type="button"
              onClick={() => onPermissionResolve("deny")}
              className={`rounded-full border border-[#B42318]/25 bg-[#FFF1F0] px-3 py-1.5 ${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#B42318] hover:bg-[#FFE3E0]`}
            >
              {t("timeline.deny")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
