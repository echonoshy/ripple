"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";
import {
  AlertTriangle,
  Bot,
  BrainCircuit,
  ChevronLeft,
  Check,
  CheckCircle2,
  Circle,
  Folder,
  Loader2,
  MessageCircleMore,
  X,
} from "lucide-react";
import type {
  AgentContact,
  AgentDelegation,
  AgentInvocation,
  Conversation,
  ConversationMessage,
  Message,
  PlanStep,
  PlanProgress,
  SkillInfo,
  UsageInfo,
  WorkbenchSessionSummary,
  WorkbenchTimelineEvent,
} from "@/types";
import type { FeishuAuthOpenPayload, FeishuAuthWaitingState } from "@/components/MarkdownRenderer";
import { useI18n } from "@/i18n";
import type { ChatFileRef } from "@/lib/chatInput";
import { formatModelName } from "@/lib/models";
import type { ModelOption } from "@/lib/models";
import type { ReasoningEffort } from "@/lib/modelPreference";
import {
  filesFromDropData,
  partitionTransferFiles,
  type PendingImageSource,
  type PendingLocalImage,
} from "@/lib/pendingImages";
import SessionComposer from "./SessionComposer";
import type { ComposerAgentMentionOption } from "./SessionComposer";
import SessionTimeline from "./SessionTimeline";
import {
  AgentDelegationStatusCard,
  DelegatedSessionBanner,
  DelegationClarificationCard,
  controlRequestToDelegationClarification,
} from "./AgentDelegationControls";
import {
  TYPOGRAPHY_BODY_CLASS,
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_META_MEDIUM_CLASS,
  TYPOGRAPHY_MICRO_CLASS,
  TYPOGRAPHY_MICRO_MEDIUM_CLASS,
  WORKBENCH_PAGE_BACKGROUND_CLASS,
  WORKBENCH_SECTION_CLASS,
} from "./stylePrimitives";

const STICK_TO_BOTTOM_MS = 1200;
const BOTTOM_LOCK_THRESHOLD_PX = 40;
const MOBILE_CHAT_HEADER_FALLBACK_HEIGHT_PX = 68;
const MOBILE_CHAT_COMPOSER_FALLBACK_HEIGHT_PX = 92;
const MOBILE_CHAT_COMPOSER_GAP_PX = 12;
const mobileChatHeaderButtonClass =
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-transparent text-[#2B2F36] transition-colors hover:bg-[#F8F9FA] active:bg-[#EFF0F1] disabled:cursor-not-allowed disabled:opacity-50";

interface VisualViewportKeyboardSource {
  innerHeight: number;
  layoutViewportHeight?: number;
  userAgent?: string | null;
  visualViewport?: { height: number; offsetTop: number } | null;
}

interface TimelineAutoScrollSuppressionInput {
  isComposerFocused: boolean;
  isGenerating: boolean;
  isWithinStickyBottomWindow: boolean;
}

interface TokenFooterRevealInput {
  previousTotalTokens: number;
  nextTotalTokens: number;
  previousVisible?: boolean;
  nextVisible?: boolean;
}

interface TokenFooterVisibilityInput {
  isGenerating: boolean;
  isSessionLoading: boolean;
  totalTokens: number;
}

const MIN_STABLE_VISUAL_VIEWPORT_HEIGHT_RATIO = 0.35;

export function getVisualViewportKeyboardInset(
  source?: VisualViewportKeyboardSource | null
): number {
  const currentSource = source || getCurrentVisualViewportKeyboardSource();
  if (!currentSource?.visualViewport) return 0;

  const layoutViewportHeight =
    currentSource.layoutViewportHeight && currentSource.layoutViewportHeight > 0
      ? currentSource.layoutViewportHeight
      : currentSource.innerHeight;
  if (
    currentSource.visualViewport.height <= 0 ||
    currentSource.visualViewport.height <
      layoutViewportHeight * MIN_STABLE_VISUAL_VIEWPORT_HEIGHT_RATIO
  ) {
    return 0;
  }
  const visualBottom = currentSource.visualViewport.offsetTop + currentSource.visualViewport.height;
  return Math.max(0, Math.round(layoutViewportHeight - visualBottom));
}

export function getMobileComposerKeyboardInset(
  source?: VisualViewportKeyboardSource | null
): number {
  const currentSource = source || getCurrentVisualViewportKeyboardSource();
  if (isAndroidUserAgent(currentSource?.userAgent)) return 0;
  return getVisualViewportKeyboardInset(currentSource);
}

export function shouldSuppressTimelineAutoScroll({
  isComposerFocused,
  isGenerating,
  isWithinStickyBottomWindow,
}: TimelineAutoScrollSuppressionInput): boolean {
  return isComposerFocused && !isGenerating && !isWithinStickyBottomWindow;
}

export function shouldRevealTokenFooterOnUsageChange({
  previousTotalTokens,
  nextTotalTokens,
  previousVisible = false,
  nextVisible = false,
}: TokenFooterRevealInput): boolean {
  return nextTotalTokens > previousTotalTokens || (!previousVisible && nextVisible);
}

export function shouldShowTokenFooter({
  isGenerating,
  isSessionLoading,
  totalTokens,
}: TokenFooterVisibilityInput): boolean {
  return !isSessionLoading && !isGenerating && totalTokens > 0;
}

export function reservedMobileComposerHeight({
  measuredHeight,
}: {
  measuredHeight: number;
}): number {
  return Math.max(measuredHeight, MOBILE_CHAT_COMPOSER_FALLBACK_HEIGHT_PX);
}

function currentTimeMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function getCurrentVisualViewportKeyboardSource(): VisualViewportKeyboardSource | null {
  if (typeof window === "undefined") return null;

  return {
    innerHeight: window.innerHeight,
    layoutViewportHeight:
      document.documentElement.clientHeight > 0
        ? document.documentElement.clientHeight
        : window.innerHeight,
    userAgent: navigator.userAgent,
    visualViewport: window.visualViewport
      ? {
          height: window.visualViewport.height,
          offsetTop: window.visualViewport.offsetTop,
        }
      : null,
  };
}

function isAndroidUserAgent(userAgent?: string | null): boolean {
  return Boolean(userAgent && /\bAndroid\b/i.test(userAgent));
}

function elementBorderBoxHeight(element: Element): number {
  return Math.ceil(element.getBoundingClientRect().height);
}

export function sessionTimelineBottomScrollTop({
  scrollHeight,
  clientHeight,
}: {
  scrollHeight: number;
  clientHeight: number;
}): number | null {
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  return maxScrollTop > 0 ? maxScrollTop : null;
}

export function composerFocusedRestoreScrollTop({
  focusedScrollTop,
  focusedComposerHeight,
  currentComposerHeight,
  scrollHeight,
  clientHeight,
}: {
  focusedScrollTop: number;
  focusedComposerHeight: number;
  currentComposerHeight: number;
  scrollHeight: number;
  clientHeight: number;
}): number {
  const composerHeightDelta = currentComposerHeight - focusedComposerHeight;
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  const nextScrollTop = Math.round(focusedScrollTop + composerHeightDelta);
  return Math.min(Math.max(0, nextScrollTop), maxScrollTop);
}

function formatCompactTokenCount(value: number): string {
  const absoluteValue = Math.abs(value);
  if (absoluteValue >= 1_000_000) return formatTokenUnit(value, 1_000_000, "m");
  if (absoluteValue >= 1_000) return formatTokenUnit(value, 1_000, "k");
  return value.toLocaleString();
}

function formatTokenUnit(value: number, unit: number, suffix: string): string {
  const scaledValue = value / unit;
  const precision = Math.abs(scaledValue) < 100 && !Number.isInteger(scaledValue) ? 1 : 0;
  return `${scaledValue.toFixed(precision).replace(/\.0$/, "")}${suffix}`;
}

function folderName(
  path: string | null | undefined,
  workspaceLabel: string,
  folderFallback: string
): string {
  if (!path || path === "/workspace") return workspaceLabel;
  return path.split("/").filter(Boolean).pop() || folderFallback;
}

interface SessionPageProps {
  userId?: string;
  session: WorkbenchSessionSummary | null;
  messages: Message[];
  timelineEvents: WorkbenchTimelineEvent[];
  planProgress: PlanProgress | null;
  planSteps: PlanStep[];
  tokenUsage: UsageInfo;
  lastContextTokens: number;
  input: string;
  pendingFiles: ChatFileRef[];
  pendingLocalImages: PendingLocalImage[];
  isUploadingFiles?: boolean;
  uploadError?: string | null;
  isGenerating: boolean;
  isSessionLoading?: boolean;
  isComposerBlocked?: boolean;
  focusToken: number;
  selectedModel: string;
  selectedReasoningEffort?: ReasoningEffort;
  models: ModelOption[];
  isModelDropdownOpen: boolean;
  availableSkills?: SkillInfo[];
  selectedRequiredSkillId?: string | null;
  isLoadingSkills?: boolean;
  sessionId: string | null;
  scrollToBottomRequest?: number;
  restoreScrollTop?: number | null;
  contextFolderPath?: string | null;
  onSelectWorkspaceFolder?: (path: string) => void | Promise<void>;
  onNewSession: () => void;
  onInputChange: (value: string) => void;
  onAttachFiles: (files: File[]) => void | Promise<void>;
  onRemovePendingFile: (path: string) => void;
  onAddPendingImages: (files: File[], source: PendingImageSource) => void;
  onRemovePendingLocalImage: (id: string) => void;
  onToggleModelDropdown: () => void;
  onCloseModelDropdown: () => void;
  onSelectModel: (model: string) => void;
  onSelectReasoningEffort?: (effort: ReasoningEffort) => void;
  onLoadSkills?: () => void | Promise<void>;
  onSelectRequiredSkill?: (skillId: string | null) => void;
  onSend: () => void;
  onStop: () => void;
  onQuickReply: (option: string) => void;
  onPermissionResolve: (action: "allow" | "always" | "deny") => void;
  onFeishuAuthOpen?: (payload: FeishuAuthOpenPayload) => void;
  feishuAuthWaiting?: FeishuAuthWaitingState | null;
  onBackToMobileSessions?: () => void;
  onRestoreScrollComplete?: () => void;
  isInspectorCollapsed?: boolean;
  agentDelegations?: AgentDelegation[];
  delegatedSession?: AgentDelegation | null;
  pendingControlRequest?: Record<string, unknown> | null;
  agentDelegationActionKey?: string | null;
  onAnswerAgentDelegation?: (delegationId: string, answer: string) => Promise<void> | void;
  collaborationContext?: CollaborationContext | null;
  agentMentionOptions?: ComposerAgentMentionOption[];
  selectedAgentMentionTargetId?: string | null;
  onSelectAgentMentionTarget?: (targetUserId: string | null) => void;
}

interface CollaborationContext {
  conversation: Conversation;
  contact: AgentContact;
  messages: ConversationMessage[];
  currentUserId: string;
  pendingActionKey?: string | null;
  onApproveInvocation?: (conversationId: string, invocationId: string) => Promise<void> | void;
  onRejectInvocation?: (conversationId: string, invocationId: string) => Promise<void> | void;
}

function collaborationMessageText(message: ConversationMessage): string {
  const text = message.body.text;
  if (typeof text === "string" && text.trim()) return text;
  const invocation = message.body.invocation;
  if (invocation?.resultText?.trim()) return invocation.resultText.trim();
  if (invocation?.prompt) return invocation.prompt;
  return "";
}

function collaborationInvocationStatusText(
  invocation: AgentInvocation,
  contact: AgentContact,
  currentUserId: string,
  t: ReturnType<typeof useI18n>["t"]
): string {
  const targetName =
    invocation.targetUserId === currentUserId
      ? currentUserId
      : contact.profile.userName || contact.profile.displayName || contact.contactUserId;
  if (invocation.status === "pending_approval") {
    return t("contacts.agentWaitingApproval", { name: targetName });
  }
  if (invocation.status === "approved") return t("contacts.agentApproved");
  if (
    invocation.status === "awaiting_target_permission" ||
    invocation.status === "awaiting_permission"
  ) {
    return t("contacts.agentAwaitingPermission", { name: targetName });
  }
  if (invocation.status === "rejected") return t("contacts.agentRejected");
  if (invocation.status === "completed") return t("contacts.agentCompleted");
  if (invocation.status === "failed") return t("contacts.agentFailed");
  return t("contacts.agentRunning");
}

function CollaborationTimeline({ context }: { context: CollaborationContext }) {
  const { t } = useI18n();
  const contactName =
    context.contact.profile.userName ||
    context.contact.profile.displayName ||
    context.contact.contactUserId;
  const participantName = (userId: string) => {
    if (userId === context.currentUserId) return t("contacts.fromMe");
    if (userId === context.contact.contactUserId) return contactName;
    return `@${userId}`;
  };
  const agentOwnerName = (userId: string) => {
    if (userId === context.currentUserId) return t("contacts.myAgent");
    if (userId === context.contact.contactUserId) return contactName;
    return `@${userId}`;
  };
  return (
    <div className="space-y-3">
      <section className="rounded-xl border border-[#BACEFD] bg-[#F0F5FF] px-3 py-2.5">
        <div className={`flex items-center gap-2 ${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}>
          <MessageCircleMore size={16} className="text-[#1456F0]" />
          {t("contacts.conversationTitle")} · {contactName}
        </div>
        <div className={`${TYPOGRAPHY_META_CLASS} mt-1 text-[#646A73]`}>
          {t("contacts.conversationSubtitle")}
        </div>
        <div className={`${TYPOGRAPHY_META_CLASS} mt-2 text-[#646A73]`}>
          @{context.contact.contactUserId}-agent · @{context.currentUserId}-agent
        </div>
      </section>

      {context.messages.length === 0 ? (
        <div
          className={`rounded-xl border border-dashed border-[#DEE0E3] bg-[#F8F9FA] px-3 py-4 ${TYPOGRAPHY_BODY_CLASS} text-[#646A73]`}
        >
          {t("contacts.conversationEmpty")}
        </div>
      ) : (
        context.messages.map((message) => {
          const invocation = message.body.invocation;
          const fromSelf = message.senderUserId === context.currentUserId;
          const isAgentRequest = message.kind === "agent_invocation" && Boolean(invocation);
          const isAgentResult =
            message.kind === "agent_invocation_event" || message.senderActorType === "agent";
          const ownerName = agentOwnerName(
            invocation?.targetUserId || message.senderUserId || context.contact.contactUserId
          );
          const authorLabel = isAgentResult
            ? t("contacts.agentOwnerLabel", { name: ownerName })
            : participantName(message.senderUserId);
          const text = collaborationMessageText(message);
          const canDecide =
            invocation?.targetUserId === context.currentUserId &&
            invocation.status === "pending_approval";
          const deciding =
            invocation &&
            (context.pendingActionKey === `approve-agent-invocation:${invocation.invocationId}` ||
              context.pendingActionKey === `reject-agent-invocation:${invocation.invocationId}`);
          return (
            <article
              key={message.messageId}
              data-ripple-collaboration-message-kind={message.kind}
              className={`max-w-[88%] rounded-xl border px-3 py-2.5 ${
                isAgentResult
                  ? "mr-auto border-[#B7EDCE] bg-[#F0FBF5]"
                  : isAgentRequest
                    ? "ml-auto border-[#FAD355]/65 bg-[#FFF8DB]"
                    : fromSelf
                      ? "ml-auto border-[#BACEFD] bg-[#F0F5FF]"
                      : "mr-auto border-[#DEE0E3] bg-white"
              }`}
            >
              <div className="flex min-w-0 items-center justify-between gap-3">
                <span className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#646A73]`}>
                  {authorLabel}
                </span>
                {isAgentRequest ? (
                  <span
                    className={`inline-flex shrink-0 items-center gap-1 ${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#8B5E00]`}
                  >
                    <Bot size={13} />
                    {t("contacts.agentTargetChip", { name: ownerName })}
                  </span>
                ) : null}
                {isAgentResult ? (
                  <span
                    className={`inline-flex shrink-0 items-center gap-1 ${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#16845B]`}
                  >
                    <Bot size={13} />
                    {t("contacts.agentResultLabel")}
                  </span>
                ) : null}
                {invocation ? (
                  <span
                    className={`inline-flex shrink-0 items-center gap-1 ${TYPOGRAPHY_META_MEDIUM_CLASS} ${
                      isAgentResult ? "text-[#16845B]" : "text-[#8B5E00]"
                    }`}
                  >
                    <Bot size={13} />
                    {collaborationInvocationStatusText(
                      invocation,
                      context.contact,
                      context.currentUserId,
                      t
                    )}
                  </span>
                ) : null}
              </div>
              {text ? (
                <div className={`mt-1 whitespace-pre-wrap ${TYPOGRAPHY_BODY_CLASS} text-[#1F2329]`}>
                  {text}
                </div>
              ) : null}
              {canDecide ? (
                <div className="mt-3 flex justify-end gap-2">
                  <button
                    type="button"
                    disabled={Boolean(deciding)}
                    onClick={() =>
                      context.onRejectInvocation?.(
                        context.conversation.conversationId,
                        invocation.invocationId
                      )
                    }
                    className={`inline-flex h-8 items-center gap-1 rounded-lg border border-[#FAD4D4] bg-white px-2.5 ${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#B42318] transition-colors hover:bg-[#FFF1F0] disabled:opacity-50`}
                  >
                    <X size={13} />
                    {t("contacts.rejectDelegation")}
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(deciding)}
                    onClick={() =>
                      context.onApproveInvocation?.(
                        context.conversation.conversationId,
                        invocation.invocationId
                      )
                    }
                    className={`inline-flex h-8 items-center gap-1 rounded-lg border border-[#1456F0] bg-[#1456F0] px-2.5 ${TYPOGRAPHY_META_MEDIUM_CLASS} text-white transition-colors hover:bg-[#0F4BD8] disabled:opacity-50`}
                  >
                    {deciding ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Check size={13} />
                    )}
                    {t("contacts.acceptDelegation")}
                  </button>
                </div>
              ) : null}
            </article>
          );
        })
      )}
    </div>
  );
}

export default function SessionPage({
  userId,
  session,
  messages,
  timelineEvents,
  planProgress,
  planSteps,
  tokenUsage,
  lastContextTokens,
  input,
  pendingFiles,
  pendingLocalImages,
  isUploadingFiles = false,
  uploadError = null,
  isGenerating,
  isSessionLoading = false,
  isComposerBlocked = false,
  focusToken,
  selectedModel,
  selectedReasoningEffort = "medium",
  models,
  isModelDropdownOpen,
  availableSkills = [],
  selectedRequiredSkillId = null,
  isLoadingSkills = false,
  sessionId,
  scrollToBottomRequest = 0,
  restoreScrollTop = null,
  contextFolderPath = null,
  onSelectWorkspaceFolder,
  onNewSession,
  onInputChange,
  onAttachFiles,
  onRemovePendingFile,
  onAddPendingImages,
  onRemovePendingLocalImage,
  onToggleModelDropdown,
  onCloseModelDropdown,
  onSelectModel,
  onSelectReasoningEffort,
  onLoadSkills,
  onSelectRequiredSkill,
  onSend,
  onStop,
  onQuickReply,
  onPermissionResolve,
  onFeishuAuthOpen,
  feishuAuthWaiting,
  onBackToMobileSessions,
  onRestoreScrollComplete,
  agentDelegations = [],
  delegatedSession = null,
  pendingControlRequest = null,
  agentDelegationActionKey = null,
  onAnswerAgentDelegation,
  collaborationContext = null,
  agentMentionOptions = [],
  selectedAgentMentionTargetId = null,
  onSelectAgentMentionTarget,
}: SessionPageProps) {
  const { t } = useI18n();
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const mobileHeaderRef = useRef<HTMLDivElement | null>(null);
  const composerOverlayRef = useRef<HTMLDivElement | null>(null);
  const previousAutoScrollSessionIdRef = useRef<string | null | undefined>(undefined);
  const previousScrollToBottomRequestRef = useRef(scrollToBottomRequest);
  const stickToBottomUntilRef = useRef(0);
  const isGeneratingRef = useRef(isGenerating);
  const isComposerFocusedRef = useRef(false);
  const composerFocusedScrollTopRef = useRef<number | null>(null);
  const composerFocusedComposerHeightRef = useRef<number | null>(null);
  const mobileComposerHeightRef = useRef(MOBILE_CHAT_COMPOSER_FALLBACK_HEIGHT_PX);
  const mobileModelMenuAnchorRef = useRef<HTMLButtonElement | null>(null);
  const desktopModelMenuAnchorRef = useRef<HTMLButtonElement | null>(null);
  const previousTokenUsageTotalRef = useRef(tokenUsage.total_tokens);
  const previousTokenFooterVisibleRef = useRef<boolean | null>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [mobileHeaderHeight, setMobileHeaderHeight] = useState(
    MOBILE_CHAT_HEADER_FALLBACK_HEIGHT_PX
  );
  const [mobileComposerHeight, setMobileComposerHeight] = useState(
    MOBILE_CHAT_COMPOSER_FALLBACK_HEIGHT_PX
  );
  const [mobileKeyboardInset, setMobileKeyboardInset] = useState(0);
  const hasMessages = messages.length > 0;
  const contextWindow =
    typeof tokenUsage.model_context_window === "number" && tokenUsage.model_context_window > 0
      ? tokenUsage.model_context_window
      : null;
  const contextPercent =
    lastContextTokens && contextWindow
      ? Math.min(Math.round((lastContextTokens / contextWindow) * 100), 100)
      : 0;
  const contextUsageLabel = lastContextTokens
    ? contextWindow
      ? `${lastContextTokens.toLocaleString()} / ${contextWindow.toLocaleString()}`
      : lastContextTokens.toLocaleString()
    : null;
  const tokenBadgeContextLabel = lastContextTokens
    ? contextWindow
      ? `${formatCompactTokenCount(lastContextTokens)} / ${formatCompactTokenCount(
          contextWindow
        )} (${contextPercent}%)`
      : formatCompactTokenCount(lastContextTokens)
    : null;
  const tokenBadgeText = t("sessions.tokenBadge", {
    input: formatCompactTokenCount(tokenUsage.prompt_tokens),
    output: formatCompactTokenCount(tokenUsage.completion_tokens),
    context: tokenBadgeContextLabel
      ? t("sessions.tokenBadgeContext", { context: tokenBadgeContextLabel })
      : "",
  });
  const tokenBadgeAccessibleLabel = t("sessions.tokenAccessible", {
    input: tokenUsage.prompt_tokens.toLocaleString(),
    output: tokenUsage.completion_tokens.toLocaleString(),
    context: contextUsageLabel
      ? t("sessions.tokenAccessibleContext", { context: contextUsageLabel })
      : "",
  });
  const shouldRenderTokenFooter = shouldShowTokenFooter({
    isGenerating,
    isSessionLoading,
    totalTokens: tokenUsage.total_tokens,
  });
  const lastTimelineEvent = timelineEvents[timelineEvents.length - 1] || null;
  const lastTimelineEventId = lastTimelineEvent?.id || "";
  const lastTimelineEventBodyLength = lastTimelineEvent?.body.length || 0;
  const modelDisplayName = formatModelName(
    models.find((model) => model.id === selectedModel) || selectedModel
  );
  const reasoningEffortLabel =
    selectedReasoningEffort === "none"
      ? t("composer.reasoningNone")
      : selectedReasoningEffort === "low"
        ? t("composer.reasoningLow")
        : selectedReasoningEffort === "high"
          ? t("composer.reasoningHigh")
          : selectedReasoningEffort === "xhigh"
            ? t("composer.reasoningXhigh")
            : selectedReasoningEffort === "max"
              ? t("composer.reasoningMax")
              : t("composer.reasoningMedium");
  const currentModelLabel = isGenerating
    ? t("composer.working")
    : `${modelDisplayName} · ${reasoningEffortLabel}`;
  const currentModelAccessibleLabel = t("sessions.currentModelAndReasoning", {
    model: modelDisplayName,
    effort: reasoningEffortLabel,
  });
  const toggleModelMenu = () => {
    if (isModelDropdownOpen) onCloseModelDropdown();
    else onToggleModelDropdown();
  };
  const modelBadgeIconClass = isGenerating ? "shrink-0 text-[#1456F0]" : "shrink-0 text-[#646A73]";
  const effectiveContextFolderPath = session?.contextFolderPath ?? contextFolderPath ?? null;
  const workspaceScopePath = effectiveContextFolderPath || "/workspace";
  const workspaceScopeLabel = folderName(
    effectiveContextFolderPath,
    t("files.workspaceName"),
    t("files.folderName")
  );
  const focusFolderLabel = effectiveContextFolderPath ? workspaceScopeLabel : null;
  const focusFolderAccessibleLabel = focusFolderLabel
    ? t("sessions.focusFolder", { label: focusFolderLabel })
    : null;
  const folderBadgeTitle = effectiveContextFolderPath || t("sessions.fullWorkspace");
  const mobileComposerReservedHeight = reservedMobileComposerHeight({
    measuredHeight: mobileComposerHeight,
  });
  const requestFolderPicker = useCallback(() => {
    if (!onSelectWorkspaceFolder) return;
    document.querySelector<HTMLButtonElement>("[data-ripple-composer-folder-button]")?.click();
  }, [onSelectWorkspaceFolder]);
  const mobileTimelineStyle = {
    "--ripple-mobile-chat-header-height": `${mobileHeaderHeight}px`,
    "--ripple-mobile-chat-composer-height": `${mobileComposerReservedHeight}px`,
    "--ripple-mobile-chat-composer-gap": `${MOBILE_CHAT_COMPOSER_GAP_PX}px`,
    "--ripple-mobile-keyboard-inset": `${mobileKeyboardInset}px`,
  } as CSSProperties;
  const composerOverlayStyle = {
    transform: mobileKeyboardInset > 0 ? `translate3d(0, -${mobileKeyboardInset}px, 0)` : undefined,
  } as CSSProperties;
  const delegationClarification = controlRequestToDelegationClarification(pendingControlRequest);
  const visibleAgentDelegations = agentDelegations.filter(
    (delegation) => delegation.requesterSessionId === sessionId
  );

  const restoreComposerFocusedScrollTop = useCallback(() => {
    if (!isComposerFocusedRef.current) return;
    const scrollContainer = scrollContainerRef.current;
    const restoreScrollTop = composerFocusedScrollTopRef.current;
    if (!scrollContainer || typeof restoreScrollTop !== "number") return;
    const focusedComposerHeight = composerFocusedComposerHeightRef.current;
    scrollContainer.scrollTop =
      typeof focusedComposerHeight === "number"
        ? composerFocusedRestoreScrollTop({
            focusedScrollTop: restoreScrollTop,
            focusedComposerHeight,
            currentComposerHeight: mobileComposerHeightRef.current,
            scrollHeight: scrollContainer.scrollHeight,
            clientHeight: scrollContainer.clientHeight,
          })
        : restoreScrollTop;
  }, []);

  const shouldSuppressCurrentTimelineAutoScroll = useCallback(
    () =>
      shouldSuppressTimelineAutoScroll({
        isComposerFocused: isComposerFocusedRef.current,
        isGenerating: isGeneratingRef.current,
        isWithinStickyBottomWindow: currentTimeMs() <= stickToBottomUntilRef.current,
      }),
    []
  );

  const handleComposerFocusStateChange = useCallback(
    (focused: boolean) => {
      isComposerFocusedRef.current = focused;
      const scrollContainer = scrollContainerRef.current;
      composerFocusedScrollTopRef.current =
        focused && scrollContainer ? scrollContainer.scrollTop : null;
      composerFocusedComposerHeightRef.current = focused ? mobileComposerHeightRef.current : null;
      if (focused) {
        window.requestAnimationFrame(() => {
          restoreComposerFocusedScrollTop();
        });
      }
    },
    [restoreComposerFocusedScrollTop]
  );

  const scrollToBottom = useCallback(
    (options: { force?: boolean } = {}) => {
      if (!options.force && shouldSuppressCurrentTimelineAutoScroll()) return;
      const scrollContainer = scrollContainerRef.current;
      if (!scrollContainer) return;
      const nextScrollTop = sessionTimelineBottomScrollTop({
        scrollHeight: scrollContainer.scrollHeight,
        clientHeight: scrollContainer.clientHeight,
      });
      if (nextScrollTop === null) return;
      scrollContainer.scrollTop = nextScrollTop;
    },
    [shouldSuppressCurrentTimelineAutoScroll]
  );

  const shouldKeepStickingToBottom = useCallback(() => {
    const isWithinStickyBottomWindow = currentTimeMs() <= stickToBottomUntilRef.current;
    return (
      !shouldSuppressTimelineAutoScroll({
        isComposerFocused: isComposerFocusedRef.current,
        isGenerating: isGeneratingRef.current,
        isWithinStickyBottomWindow,
      }) &&
      (isGeneratingRef.current || isWithinStickyBottomWindow)
    );
  }, []);

  const startStickToBottom = useCallback(() => {
    stickToBottomUntilRef.current = currentTimeMs() + STICK_TO_BOTTOM_MS;
    scrollToBottom();
  }, [scrollToBottom]);

  const handleComposerSend = useCallback(() => {
    startStickToBottom();
    onSend();
  }, [onSend, startStickToBottom]);

  const handleScroll = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;

    const distanceFromBottom =
      scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
    if (distanceFromBottom > BOTTOM_LOCK_THRESHOLD_PX) {
      stickToBottomUntilRef.current = 0;
    }
  }, []);

  useLayoutEffect(() => {
    isGeneratingRef.current = isGenerating;
  }, [isGenerating]);

  useLayoutEffect(() => {
    mobileComposerHeightRef.current = mobileComposerReservedHeight;
  }, [mobileComposerReservedHeight]);

  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observedNodes: { node: HTMLDivElement; update: (height: number) => void }[] = [];
    if (mobileHeaderRef.current) {
      observedNodes.push({ node: mobileHeaderRef.current, update: setMobileHeaderHeight });
    }
    if (composerOverlayRef.current) {
      observedNodes.push({ node: composerOverlayRef.current, update: setMobileComposerHeight });
    }
    if (observedNodes.length === 0) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const nextHeight = elementBorderBoxHeight(entry.target);
        const observed = observedNodes.find((item) => item.node === entry.target);
        if (observed && nextHeight > 0) observed.update(nextHeight);
      }
    });

    for (const { node, update } of observedNodes) {
      const height = elementBorderBoxHeight(node);
      if (height > 0) update(height);
      observer.observe(node);
    }

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const updateKeyboardInset = () => {
      setMobileKeyboardInset(getMobileComposerKeyboardInset());
      window.requestAnimationFrame(() => {
        restoreComposerFocusedScrollTop();
      });
    };

    updateKeyboardInset();
    window.visualViewport?.addEventListener("resize", updateKeyboardInset);
    window.visualViewport?.addEventListener("scroll", updateKeyboardInset);
    window.addEventListener("resize", updateKeyboardInset);

    return () => {
      window.visualViewport?.removeEventListener("resize", updateKeyboardInset);
      window.visualViewport?.removeEventListener("scroll", updateKeyboardInset);
      window.removeEventListener("resize", updateKeyboardInset);
    };
  }, [restoreComposerFocusedScrollTop]);

  useLayoutEffect(() => {
    restoreComposerFocusedScrollTop();
  }, [
    input,
    mobileComposerReservedHeight,
    mobileHeaderHeight,
    mobileKeyboardInset,
    restoreComposerFocusedScrollTop,
  ]);

  useLayoutEffect(() => {
    const previousScrollSessionId = previousAutoScrollSessionIdRef.current;
    const sessionChanged = previousScrollSessionId !== sessionId;
    previousAutoScrollSessionIdRef.current = sessionId;

    if (!sessionChanged) return;

    if (typeof restoreScrollTop === "number") {
      const scrollContainer = scrollContainerRef.current;
      if (scrollContainer) {
        scrollContainer.scrollTop = restoreScrollTop;
      }
      stickToBottomUntilRef.current = 0;
      onRestoreScrollComplete?.();
      return;
    }

    startStickToBottom();
  }, [onRestoreScrollComplete, restoreScrollTop, sessionId, startStickToBottom]);

  useLayoutEffect(() => {
    const previousScrollToBottomRequest = previousScrollToBottomRequestRef.current;
    const requestChanged = previousScrollToBottomRequest !== scrollToBottomRequest;
    previousScrollToBottomRequestRef.current = scrollToBottomRequest;

    if (!requestChanged) return;

    startStickToBottom();
  }, [scrollToBottomRequest, startStickToBottom]);

  useLayoutEffect(() => {
    if (!shouldKeepStickingToBottom()) return;
    scrollToBottom();
  }, [
    isGenerating,
    lastTimelineEventBodyLength,
    lastTimelineEventId,
    messages.length,
    planSteps.length,
    scrollToBottom,
    shouldKeepStickingToBottom,
    tokenUsage.total_tokens,
  ]);

  useLayoutEffect(() => {
    const previousTotalTokens = previousTokenUsageTotalRef.current;
    const previousVisible = previousTokenFooterVisibleRef.current;
    previousTokenUsageTotalRef.current = tokenUsage.total_tokens;
    previousTokenFooterVisibleRef.current = shouldRenderTokenFooter;
    if (previousVisible === null) return;
    if (
      shouldRevealTokenFooterOnUsageChange({
        previousTotalTokens,
        nextTotalTokens: tokenUsage.total_tokens,
        previousVisible,
        nextVisible: shouldRenderTokenFooter,
      })
    ) {
      scrollToBottom({ force: true });
    }
  }, [scrollToBottom, shouldRenderTokenFooter, tokenUsage.total_tokens]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      if (shouldKeepStickingToBottom()) {
        scrollToBottom();
      }
    });
    observer.observe(content);

    return () => observer.disconnect();
  }, [scrollToBottom, shouldKeepStickingToBottom]);

  const handlePageDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (isGenerating || isUploadingFiles) return;
      const hasFiles = Array.from(event.dataTransfer.types || []).includes("Files");
      if (!hasFiles) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setIsDraggingFiles(true);
    },
    [isGenerating, isUploadingFiles]
  );

  const handlePageDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
    setIsDraggingFiles(false);
  }, []);

  const handlePageDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (isGenerating || isUploadingFiles) return;
      const files = filesFromDropData(event.dataTransfer);
      if (files.length === 0) {
        setIsDraggingFiles(false);
        return;
      }

      event.preventDefault();
      setIsDraggingFiles(false);
      const { images, attachments: attachmentFiles } = partitionTransferFiles(files);
      if (images.length > 0) onAddPendingImages(images, "drop");
      if (attachmentFiles.length > 0) void onAttachFiles(attachmentFiles);
    },
    [isGenerating, isUploadingFiles, onAddPendingImages, onAttachFiles]
  );

  return (
    <div
      data-ripple-mobile-chat-surface
      onDragOver={handlePageDragOver}
      onDragLeave={handlePageDragLeave}
      onDrop={handlePageDrop}
      className={`relative flex h-full min-h-0 flex-col overflow-hidden ${WORKBENCH_PAGE_BACKGROUND_CLASS} ${
        isDraggingFiles ? "ring-2 ring-[#1456F0] ring-inset" : ""
      }`}
    >
      <div
        ref={mobileHeaderRef}
        data-ripple-mobile-chat-header="true"
        className="absolute inset-x-0 top-0 z-30 grid min-h-[calc(56px+env(safe-area-inset-top))] translate-y-0 grid-cols-[44px_minmax(0,1fr)_44px] items-center border-b border-[#DEE0E3] bg-white px-2.5 pt-[max(env(safe-area-inset-top),0px)] shadow-[0_1px_2px_rgba(31,35,41,0.04)] lg:hidden"
      >
        <button
          type="button"
          aria-label={t("sessions.backToSessions")}
          title={t("sessions.backToSessions")}
          onClick={onBackToMobileSessions}
          className={mobileChatHeaderButtonClass}
        >
          <ChevronLeft size={22} strokeWidth={2.2} />
        </button>
        <div className="mx-auto w-full max-w-[56vw] min-w-0 text-center">
          <div className={`truncate ${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}>
            {session?.title || t("sessions.fallbackTitle")}
          </div>
          <div
            className={`mt-1 flex min-w-0 items-center justify-center gap-1.5 ${TYPOGRAPHY_MICRO_CLASS} text-[#646A73]`}
          >
            <button
              ref={mobileModelMenuAnchorRef}
              type="button"
              data-ripple-current-model-badge="mobile"
              aria-label={currentModelAccessibleLabel}
              title={currentModelAccessibleLabel}
              aria-haspopup="menu"
              aria-expanded={isModelDropdownOpen}
              onClick={toggleModelMenu}
              className={`inline-flex max-w-[176px] min-w-0 items-center gap-1 rounded-full border border-[#DEE0E3] bg-[#F8F9FA] px-1.5 py-0.5 ${TYPOGRAPHY_MICRO_MEDIUM_CLASS} text-[#646A73] transition-colors hover:border-[#BACEFD] hover:bg-[#F0F5FF] hover:text-[#1456F0] ${
                isModelDropdownOpen ? "border-[#1456F0] bg-[#F0F5FF] text-[#1456F0]" : ""
              }`}
            >
              <BrainCircuit size={11} className={modelBadgeIconClass} strokeWidth={2.2} />
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  isGenerating ? "bg-[#1456F0]" : "bg-[#22A06B]"
                }`}
              />
              <span className="truncate">{currentModelLabel}</span>
            </button>
            {focusFolderLabel && focusFolderAccessibleLabel && (
              <button
                type="button"
                aria-label={focusFolderAccessibleLabel}
                title={folderBadgeTitle}
                onClick={requestFolderPicker}
                className={`inline-flex max-w-[144px] min-w-0 items-center gap-1 rounded-full border border-[#DEE0E3] bg-[#F8F9FA] px-1.5 py-0.5 ${TYPOGRAPHY_MICRO_MEDIUM_CLASS} text-[#646A73] hover:text-[#1456F0]`}
              >
                <Folder size={10} className="shrink-0" strokeWidth={2.2} />
                <span className="truncate">{focusFolderLabel}</span>
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            aria-label={t("sessions.newSession")}
            title={t("sessions.newSession")}
            onClick={onNewSession}
            className={mobileChatHeaderButtonClass}
          >
            <MessageCircleMore size={18} strokeWidth={2.2} />
          </button>
        </div>
      </div>

      <div className="hidden h-14 shrink-0 items-center justify-between gap-3 border-b border-[#DEE0E3] bg-white px-5 shadow-[0_1px_2px_rgba(31,35,41,0.04)] lg:flex">
        <div className="min-w-0">
          <div className={`truncate ${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}>
            {session?.title || t("sessions.fallbackTitle")}
          </div>
        </div>
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          {focusFolderLabel && focusFolderAccessibleLabel && (
            <button
              type="button"
              aria-label={focusFolderAccessibleLabel}
              title={folderBadgeTitle}
              onClick={requestFolderPicker}
              className={`inline-flex max-w-[220px] shrink-0 items-center gap-1.5 rounded-full border border-[#DEE0E3] bg-[#F8F9FA] px-3 py-1.5 ${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#2B2F36]`}
            >
              <Folder size={13} className="shrink-0 text-[#646A73]" strokeWidth={2.2} />
              <span className="truncate">{focusFolderLabel}</span>
            </button>
          )}
          <button
            ref={desktopModelMenuAnchorRef}
            type="button"
            data-ripple-current-model-badge="desktop"
            aria-label={currentModelAccessibleLabel}
            title={currentModelAccessibleLabel}
            aria-haspopup="menu"
            aria-expanded={isModelDropdownOpen}
            onClick={toggleModelMenu}
            className={`inline-flex max-w-[244px] shrink-0 items-center gap-1.5 rounded-full border border-[#DEE0E3] bg-[#F8F9FA] px-3 py-1.5 ${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#2B2F36] transition-colors hover:border-[#BACEFD] hover:bg-[#F0F5FF] hover:text-[#1456F0] ${
              isModelDropdownOpen ? "border-[#1456F0] bg-[#F0F5FF] text-[#1456F0]" : ""
            }`}
          >
            <BrainCircuit size={13} className={modelBadgeIconClass} strokeWidth={2.2} />
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                isGenerating ? "bg-[#1456F0]" : "bg-[#22A06B]"
              }`}
            />
            <span className="truncate">{currentModelLabel}</span>
          </button>
        </div>
      </div>

      <div
        ref={scrollContainerRef}
        data-ripple-session-scroll="timeline"
        onScroll={handleScroll}
        style={mobileTimelineStyle}
        className="min-h-0 flex-1 touch-pan-y overflow-y-auto bg-white px-3 pt-[calc(var(--ripple-mobile-chat-header-height)+8px)] pb-[calc(var(--ripple-mobile-chat-composer-height)+var(--ripple-mobile-chat-composer-gap))] sm:px-4 md:px-5 lg:py-5"
      >
        <div ref={contentRef} className="mx-auto max-w-5xl space-y-2 sm:space-y-5">
          {isSessionLoading ? (
            <div
              data-ripple-session-loading-skeleton="true"
              className="space-y-2 pt-1"
              aria-busy="true"
            >
              <div className="h-16 rounded-xl border border-[#EFF0F1] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.04)]" />
              <div className="ml-auto h-20 w-[82%] rounded-2xl border border-[#EFF0F1] bg-[#F8F9FA]" />
              <div className="h-24 w-[88%] rounded-xl border border-[#EFF0F1] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.04)]" />
            </div>
          ) : (
            <>
              {delegatedSession && <DelegatedSessionBanner delegation={delegatedSession} />}

              {delegationClarification && onAnswerAgentDelegation && (
                <DelegationClarificationCard
                  request={delegationClarification}
                  pending={
                    agentDelegationActionKey === `answer:${delegationClarification.delegationId}`
                  }
                  onAnswer={onAnswerAgentDelegation}
                />
              )}

              {visibleAgentDelegations.length > 0 && (
                <div className="space-y-2">
                  {visibleAgentDelegations.map((delegation) => (
                    <AgentDelegationStatusCard
                      key={delegation.delegationId}
                      delegation={delegation}
                    />
                  ))}
                </div>
              )}

              {planSteps.length > 0 && (
                <section className={WORKBENCH_SECTION_CLASS}>
                  <div className="flex items-center justify-between border-b border-[#EFF0F1] px-3 py-1.5">
                    <div className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#1F2329]`}>
                      {t("sessions.currentPlan")}
                    </div>
                    {planProgress && (
                      <div
                        className={`font-[family-name:var(--font-mono)] ${TYPOGRAPHY_MICRO_CLASS} text-[#646A73]`}
                      >
                        {planProgress.completed}/{planProgress.total}
                      </div>
                    )}
                  </div>
                  <div className="divide-y divide-[#EFF0F1]">
                    {planSteps.map((step) => {
                      const Icon =
                        step.status === "completed"
                          ? CheckCircle2
                          : step.status === "in_progress"
                            ? Loader2
                            : Circle;
                      return (
                        <div
                          key={step.id}
                          className={`flex items-start gap-2 px-3 py-1.5 ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
                        >
                          <Icon
                            size={15}
                            className={`mt-0.5 shrink-0 ${
                              step.status === "completed"
                                ? "text-[#16845B]"
                                : step.status === "in_progress"
                                  ? "animate-spin text-[#1456F0]"
                                  : "text-[#8F959E]"
                            }`}
                          />
                          <span
                            className={
                              step.status === "completed"
                                ? "text-[#646A73] line-through decoration-[#8F959E]"
                                : "text-[#1F2329]"
                            }
                          >
                            {step.subject}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {contextPercent > 75 && (
                <div
                  className={`flex items-start gap-2 rounded-xl border border-[#FAD355]/45 bg-[#FFF8DB] p-3 ${TYPOGRAPHY_BODY_CLASS} text-[#8B5E00]`}
                >
                  <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                  {t("sessions.contextWarning", { percent: `${contextPercent}%` })} (
                  {t("sessions.contextDetail", { usage: contextUsageLabel || "" })}).{" "}
                  {t("sessions.contextSuggestion")}
                </div>
              )}

              {collaborationContext ? (
                <CollaborationTimeline context={collaborationContext} />
              ) : (
                <SessionTimeline
                  userId={userId}
                  messages={messages}
                  events={timelineEvents}
                  isGenerating={isGenerating}
                  onQuickReply={onQuickReply}
                  onPermissionResolve={onPermissionResolve}
                  onFeishuAuthOpen={onFeishuAuthOpen}
                  feishuAuthWaiting={feishuAuthWaiting}
                />
              )}
            </>
          )}
        </div>

        {shouldRenderTokenFooter && (
          <div className="mx-auto mt-4 flex max-w-5xl justify-start">
            <span
              aria-label={tokenBadgeAccessibleLabel}
              title={tokenBadgeAccessibleLabel}
              className={`inline-flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-lg border border-[#DEE0E3] bg-[#F8F9FA] px-2.5 py-1 font-[family-name:var(--font-mono)] ${TYPOGRAPHY_META_CLASS} text-[#646A73] italic`}
            >
              {tokenBadgeText}
            </span>
          </div>
        )}
      </div>

      <div
        ref={composerOverlayRef}
        data-ripple-mobile-composer-overlay="true"
        data-ripple-mobile-composer-overlay-loading={isSessionLoading ? "true" : "false"}
        style={composerOverlayStyle}
        className={`absolute inset-x-0 bottom-0 z-30 transition-transform duration-150 ease-out lg:static lg:z-auto lg:shrink-0 ${
          isSessionLoading ? "pointer-events-none opacity-75" : ""
        }`}
      >
        <SessionComposer
          userId={userId}
          mode={collaborationContext ? "conversation" : "session"}
          value={isSessionLoading ? "" : input}
          onChange={onInputChange}
          onSend={handleComposerSend}
          onStop={onStop}
          onAttachFiles={onAttachFiles}
          onRemovePendingFile={onRemovePendingFile}
          onAddPendingImages={onAddPendingImages}
          onRemovePendingLocalImage={onRemovePendingLocalImage}
          pendingFiles={isSessionLoading ? [] : pendingFiles}
          pendingLocalImages={isSessionLoading ? [] : pendingLocalImages}
          isUploadingFiles={isSessionLoading ? false : isUploadingFiles}
          uploadError={isSessionLoading ? null : uploadError}
          isGenerating={isGenerating}
          isBlocked={isComposerBlocked}
          hasSession={hasMessages || Boolean(session)}
          focusToken={focusToken}
          selectedModel={selectedModel}
          selectedReasoningEffort={selectedReasoningEffort}
          models={models}
          isModelDropdownOpen={isModelDropdownOpen}
          showModelButton={false}
          modelMenuAnchorRefs={[mobileModelMenuAnchorRef, desktopModelMenuAnchorRef]}
          onToggleModelDropdown={onToggleModelDropdown}
          onCloseModelDropdown={onCloseModelDropdown}
          onSelectModel={onSelectModel}
          onSelectReasoningEffort={onSelectReasoningEffort}
          availableSkills={availableSkills}
          selectedRequiredSkillId={selectedRequiredSkillId}
          isLoadingSkills={isLoadingSkills}
          onLoadSkills={onLoadSkills}
          onSelectRequiredSkill={onSelectRequiredSkill}
          agentMentionOptions={agentMentionOptions}
          selectedAgentMentionTargetId={selectedAgentMentionTargetId}
          onSelectAgentMentionTarget={onSelectAgentMentionTarget}
          contextFolderPath={effectiveContextFolderPath}
          workspaceScopeLabel={workspaceScopeLabel}
          workspaceScopePath={workspaceScopePath}
          onSelectWorkspaceFolder={onSelectWorkspaceFolder}
          onFocusStateChange={handleComposerFocusStateChange}
        />
      </div>
    </div>
  );
}
