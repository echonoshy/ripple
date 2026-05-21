import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CodexRuntimeEvent,
  ConnectorAuthChatEvent,
  Message,
  SessionDetail,
  PlanStep,
  PlanProgress,
  UsageInfo,
  WorkbenchTimelineEvent,
} from "@/types";
import {
  AuthError,
  fetchSessionDetails,
  pollSessionConnectorAuth,
  resolveSessionPermissionRequest,
  sendChatMessage,
  uploadWorkspaceAttachment,
} from "@/lib/api";
import { chatErrorContent } from "@/lib/chatErrors";
import { describeChatFilesForDisplay, type ChatFileRef } from "@/lib/chatInput";
import {
  applyPlanUpdate,
  applyPlanStepUpdate,
  clearPlanState,
  upsertPlanStep,
} from "@/lib/chatState";
import { bumpInputFocusToken } from "@/lib/inputFocus";
import { mapSessionMessages } from "@/lib/sessionMessages";
import {
  codexRuntimeEventToTimelineEvent,
  extractChangedFilePaths,
  messagesToTimelineEvents,
} from "@/lib/workbench";
import { openExternalUrl } from "@/lib/platform";
import type { FeishuAuthOpenPayload, FeishuAuthWaitingState } from "@/components/MarkdownRenderer";

export interface ChatRunSessionActions {
  getSessionId: () => string | null;
  ensureSession: () => Promise<string | null>;
  loadSessions: () => Promise<unknown>;
  clearCurrentSessionContext: () => Promise<boolean>;
  stopCurrentSession: () => Promise<boolean>;
  stopSession: (sessionId: string) => Promise<boolean>;
}

interface UseChatRunOptions {
  selectedModel: string;
  onSelectedModelChange: (model: string) => void;
  onAuthExpired: (message: string) => void;
  onWorkspaceRefresh: () => void;
  getSessionActions: () => ChatRunSessionActions;
}

const emptyUsage: UsageInfo = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
};

function shouldShowRuntimeEvent(event: CodexRuntimeEvent): boolean {
  return event.type !== "tool_output_delta";
}

interface ChatRunViewState {
  sessionId: string;
  messages: Message[];
  runtimeTimelineEvents: WorkbenchTimelineEvent[];
  pendingFiles: ChatFileRef[];
  tokenUsage: UsageInfo;
  lastContextTokens: number;
  planSteps: PlanStep[];
  planProgress: PlanProgress | null;
}

interface ConnectorAuthPollOptions {
  baseMessages?: Message[];
  allowWhileGenerating?: boolean;
  openAuthWindow?: boolean;
}

export function useChatRun({
  selectedModel,
  onSelectedModelChange,
  onAuthExpired,
  onWorkspaceRefresh,
  getSessionActions,
}: UseChatRunOptions) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [pendingFiles, setPendingFiles] = useState<ChatFileRef[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [runningSessionId, setRunningSessionId] = useState<string | null>(null);
  const [runtimeTimelineEvents, setRuntimeTimelineEvents] = useState<WorkbenchTimelineEvent[]>([]);
  const [inputFocusToken, setInputFocusToken] = useState(0);
  const [tokenUsage, setTokenUsage] = useState<UsageInfo>(emptyUsage);
  const [lastContextTokens, setLastContextTokens] = useState(0);
  const [planSteps, setPlanSteps] = useState<PlanStep[]>([]);
  const [planProgress, setPlanProgress] = useState<PlanProgress | null>(null);
  const [feishuAuthWaiting, setFeishuAuthWaiting] = useState<FeishuAuthWaitingState | null>(null);

  const activeRequestIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const runningSessionIdRef = useRef<string | null>(null);
  const runningViewStateRef = useRef<ChatRunViewState | null>(null);
  const connectorAuthPollAbortRef = useRef<AbortController | null>(null);
  const connectorAuthPollTimerRef = useRef<number | null>(null);
  const connectorAuthPollIdRef = useRef(0);
  const feishuAuthPopupRef = useRef<Window | null>(null);
  const feishuAuthPopupUrlRef = useRef<string | null>(null);
  const feishuAuthWaitingTimerRef = useRef<number | null>(null);
  const beginConnectorAuthPollRef = useRef<
    ((payload: FeishuAuthOpenPayload, options?: ConnectorAuthPollOptions) => void) | null
  >(null);

  const setActiveRunningSession = useCallback((sessionId: string | null) => {
    runningSessionIdRef.current = sessionId;
    setRunningSessionId(sessionId);
  }, []);

  const applyViewState = useCallback((state: ChatRunViewState) => {
    setMessages(state.messages);
    setRuntimeTimelineEvents(state.runtimeTimelineEvents);
    setPendingFiles(state.pendingFiles);
    setTokenUsage(state.tokenUsage);
    setLastContextTokens(state.lastContextTokens);
    setPlanSteps(state.planSteps);
    setPlanProgress(state.planProgress);
  }, []);

  const clearFeishuAuthWaiting = useCallback(() => {
    if (feishuAuthWaitingTimerRef.current) {
      window.clearInterval(feishuAuthWaitingTimerRef.current);
      feishuAuthWaitingTimerRef.current = null;
    }
    setFeishuAuthWaiting(null);
  }, []);

  const startFeishuAuthWaiting = useCallback(
    (url: string, connector: ConnectorAuthChatEvent["connector"] = "feishu") => {
      const nextUrl = url.trim();
      if (!nextUrl) return;
      clearFeishuAuthWaiting();
      const startedAt = Date.now();
      const knownConnector = connector === "google_workspace" ? "google_workspace" : "feishu";
      const label = knownConnector === "google_workspace" ? "Google 授权" : "飞书操作";
      setFeishuAuthWaiting({ connector: knownConnector, url: nextUrl, elapsedSeconds: 0, label });
      feishuAuthWaitingTimerRef.current = window.setInterval(() => {
        setFeishuAuthWaiting((current) =>
          current?.url === nextUrl
            ? { ...current, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000) }
            : current
        );
      }, 1000);
    },
    [clearFeishuAuthWaiting]
  );

  const clearConnectorAuthPoll = useCallback(() => {
    connectorAuthPollIdRef.current += 1;
    connectorAuthPollAbortRef.current?.abort();
    connectorAuthPollAbortRef.current = null;
    if (connectorAuthPollTimerRef.current) {
      window.clearTimeout(connectorAuthPollTimerRef.current);
      connectorAuthPollTimerRef.current = null;
    }
    clearFeishuAuthWaiting();
  }, [clearFeishuAuthWaiting]);

  useEffect(() => clearConnectorAuthPoll, [clearConnectorAuthPoll]);

  const handleAuthExpired = useCallback(() => {
    clearConnectorAuthPoll();
    abortControllerRef.current = null;
    runningViewStateRef.current = null;
    setActiveRunningSession(null);
    onAuthExpired("API Key 已失效");
  }, [clearConnectorAuthPoll, onAuthExpired, setActiveRunningSession]);

  const resetSessionView = useCallback(() => {
    setMessages([]);
    setRuntimeTimelineEvents([]);
    setPendingFiles([]);
    setPlanSteps([]);
    setPlanProgress(null);
    setTokenUsage(emptyUsage);
    setLastContextTokens(0);
  }, []);

  const resetCurrentContextView = useCallback(() => {
    resetSessionView();
    setInput("");
  }, [resetSessionView]);

  const abortRunAndResetSessionView = useCallback(() => {
    activeRequestIdRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    clearConnectorAuthPoll();
    runningViewStateRef.current = null;
    setActiveRunningSession(null);
    setIsGenerating(false);
    resetSessionView();
  }, [clearConnectorAuthPoll, resetSessionView, setActiveRunningSession]);

  const applySessionDetails = useCallback(
    (details: SessionDetail) => {
      onSelectedModelChange(details.model);
      const runningState = runningViewStateRef.current;
      if (runningState?.sessionId === details.sessionId) {
        applyViewState(runningState);
        onWorkspaceRefresh();
        return;
      }
      setMessages(mapSessionMessages(details));
      setRuntimeTimelineEvents([]);
      setPendingFiles([]);
      setTokenUsage(emptyUsage);
      setLastContextTokens(0);
      setPlanSteps(details.planSteps || []);
      setPlanProgress(details.planProgress || null);
      onWorkspaceRefresh();
    },
    [applyViewState, onSelectedModelChange, onWorkspaceRefresh]
  );

  const handleStop = useCallback(async () => {
    const targetSessionId = runningSessionIdRef.current || getSessionActions().getSessionId();
    activeRequestIdRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    clearConnectorAuthPoll();
    if (targetSessionId) {
      await getSessionActions().stopSession(targetSessionId);
    } else {
      await getSessionActions().stopCurrentSession();
    }
    runningViewStateRef.current = null;
    setActiveRunningSession(null);
    setIsGenerating(false);
    setInputFocusToken((prev) => bumpInputFocusToken(prev));
  }, [clearConnectorAuthPoll, getSessionActions, setActiveRunningSession]);

  const handleClearContext = useCallback(async () => {
    if (isGenerating) return;
    try {
      const ok = await getSessionActions().clearCurrentSessionContext();
      if (!ok) throw new Error("Failed to clear session context");
      resetCurrentContextView();
      setInputFocusToken((prev) => bumpInputFocusToken(prev));
      await getSessionActions().loadSessions();
    } catch (err) {
      if (err instanceof AuthError) {
        handleAuthExpired();
        return;
      }
      console.error("Clear context error:", err);
    }
  }, [getSessionActions, handleAuthExpired, isGenerating, resetCurrentContextView]);

  const handleAttachFiles = useCallback(
    async (files: File[]) => {
      if (isGenerating || files.length === 0) return;
      try {
        const uploaded = await Promise.all(files.map((file) => uploadWorkspaceAttachment(file)));
        setPendingFiles((prev) => {
          const next = new Map(prev.map((file) => [file.path, file]));
          for (const file of uploaded) {
            next.set(file.path, {
              path: file.path,
              name: file.name,
              mime_type: file.mime_type,
              kind: file.kind,
            });
          }
          return [...next.values()];
        });
        onWorkspaceRefresh();
        setInputFocusToken((prev) => bumpInputFocusToken(prev));
      } catch (err) {
        if (err instanceof AuthError) {
          handleAuthExpired();
          return;
        }
        console.error("Attachment upload error:", err);
      }
    },
    [handleAuthExpired, isGenerating, onWorkspaceRefresh]
  );

  const handleRemovePendingFile = useCallback((path: string) => {
    setPendingFiles((prev) => prev.filter((file) => file.path !== path));
  }, []);

  const handleSendMessage = useCallback(
    async (overrideText?: string) => {
      const text = typeof overrideText === "string" ? overrideText.trim() : input.trim();
      const filesForSend = typeof overrideText === "string" ? [] : pendingFiles;
      if (text === "/clear") {
        await handleClearContext();
        return;
      }
      if ((!text && filesForSend.length === 0) || isGenerating) return;

      const requestId = activeRequestIdRef.current + 1;
      activeRequestIdRef.current = requestId;
      abortControllerRef.current?.abort();
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      const isStaleRequest = () => activeRequestIdRef.current !== requestId;

      const activeSessionId = await getSessionActions().ensureSession();
      if (!activeSessionId) {
        abortControllerRef.current = null;
        return;
      }

      const sentAt = new Date().toISOString();
      const displayText = describeChatFilesForDisplay(text, filesForSend);
      const userMessageId = Date.now();
      const assistantMessageId = `${userMessageId}-assistant`;
      const initialMessages: Message[] = [
        ...messages,
        { id: userMessageId, role: "user", content: displayText, created_at: sentAt },
        { id: assistantMessageId, role: "assistant", content: "", toolCalls: [] },
      ];
      runningViewStateRef.current = {
        sessionId: activeSessionId,
        messages: initialMessages,
        runtimeTimelineEvents,
        pendingFiles: [],
        tokenUsage,
        lastContextTokens,
        planSteps,
        planProgress,
      };
      setActiveRunningSession(activeSessionId);
      setMessages(initialMessages);
      setInput("");
      setPendingFiles([]);
      setIsGenerating(true);

      const isRunVisible = () => getSessionActions().getSessionId() === activeSessionId;
      const getRunningState = () => {
        const state = runningViewStateRef.current;
        return state?.sessionId === activeSessionId ? state : null;
      };
      const updateRunningMessages = (updater: (prev: Message[]) => Message[]) => {
        const state = getRunningState();
        if (!state) return;
        const nextMessages = updater(state.messages);
        runningViewStateRef.current = { ...state, messages: nextMessages };
        if (isRunVisible()) setMessages(nextMessages);
      };
      const updateRunningTimelineEvents = (
        updater: (prev: WorkbenchTimelineEvent[]) => WorkbenchTimelineEvent[]
      ) => {
        const state = getRunningState();
        if (!state) return;
        const nextEvents = updater(state.runtimeTimelineEvents);
        runningViewStateRef.current = { ...state, runtimeTimelineEvents: nextEvents };
        if (isRunVisible()) setRuntimeTimelineEvents(nextEvents);
      };
      const updateRunningPlanSteps = (updater: (prev: PlanStep[]) => PlanStep[]) => {
        const state = getRunningState();
        if (!state) return;
        const nextSteps = updater(state.planSteps);
        runningViewStateRef.current = { ...state, planSteps: nextSteps };
        if (isRunVisible()) setPlanSteps(nextSteps);
      };
      const updateRunningPlanProgress = (nextProgress: PlanProgress | null) => {
        const state = getRunningState();
        if (!state) return;
        runningViewStateRef.current = { ...state, planProgress: nextProgress };
        if (isRunVisible()) setPlanProgress(nextProgress);
      };
      const updateRunningUsage = (updater: (prev: UsageInfo) => UsageInfo) => {
        const state = getRunningState();
        if (!state) return;
        const nextUsage = updater(state.tokenUsage);
        runningViewStateRef.current = { ...state, tokenUsage: nextUsage };
        if (isRunVisible()) setTokenUsage(nextUsage);
      };
      const updateRunningContextTokens = (nextContextTokens: number) => {
        const state = getRunningState();
        if (!state) return;
        runningViewStateRef.current = { ...state, lastContextTokens: nextContextTokens };
        if (isRunVisible()) setLastContextTokens(nextContextTokens);
      };
      const replaceRunningPlan = (nextPlan: {
        planSteps: PlanStep[];
        planProgress: PlanProgress | null;
      }) => {
        const state = getRunningState();
        if (!state) return;
        runningViewStateRef.current = {
          ...state,
          planSteps: nextPlan.planSteps,
          planProgress: nextPlan.planProgress,
        };
        if (isRunVisible()) {
          setPlanSteps(nextPlan.planSteps);
          setPlanProgress(nextPlan.planProgress);
        }
      };

      let currentContent = "";
      let pendingConnectorAuthPayload: FeishuAuthOpenPayload | null = null;
      const assistantUpdates = new Map<string, string>();
      const upsertAssistantUpdate = (id: string, content: string) => {
        updateRunningMessages((prev) => {
          const updateId = `assistant-update-${id}`;
          const existingIndex = prev.findIndex((message) => message.id === updateId);
          if (existingIndex >= 0) {
            return prev.map((message, index) =>
              index === existingIndex ? { ...message, content } : message
            );
          }

          const updateMessage: Message = {
            id: updateId,
            role: "assistant",
            content,
            created_at: new Date().toISOString(),
          };
          const placeholderIndex = prev.findIndex((message) => message.id === assistantMessageId);
          if (placeholderIndex < 0) {
            return [...prev, updateMessage];
          }
          return [
            ...prev.slice(0, placeholderIndex),
            updateMessage,
            ...prev.slice(placeholderIndex),
          ];
        });
      };

      await sendChatMessage(
        activeSessionId,
        text,
        selectedModel,
        {
          onMessageDelta: (delta) => {
            if (isStaleRequest()) return;
            currentContent += delta;
            updateRunningMessages((prev) => {
              const msgs = [...prev];
              const last = msgs[msgs.length - 1];
              if (last.role === "assistant") last.content = currentContent;
              return msgs;
            });
          },
          onAssistantUpdateDelta: (id, delta) => {
            if (isStaleRequest()) return;
            const next = (assistantUpdates.get(id) || "") + delta;
            assistantUpdates.set(id, next);
            upsertAssistantUpdate(id, next);
          },
          onAssistantUpdate: (id, content) => {
            if (isStaleRequest()) return;
            assistantUpdates.set(id, content);
            upsertAssistantUpdate(id, content);
          },
          onToolCall: (toolCall) => {
            if (isStaleRequest()) return;
            updateRunningMessages((prev) => {
              const msgs = [...prev];
              const last = msgs[msgs.length - 1];
              if (last.role === "assistant") {
                const idx = last.toolCalls?.findIndex((t) => t.id === toolCall.id) ?? -1;
                if (idx >= 0 && last.toolCalls) {
                  last.toolCalls[idx] = toolCall;
                } else {
                  last.toolCalls = [...(last.toolCalls || []), toolCall];
                }
                if (toolCall.name === "AskUser") {
                  try {
                    const args =
                      typeof toolCall.arguments === "string"
                        ? JSON.parse(toolCall.arguments)
                        : toolCall.arguments;
                    if (args?.question) {
                      last.askUser = { question: args.question, options: args.options || [] };
                    }
                  } catch {
                    /* ignore parse error */
                  }
                }
              }
              return msgs;
            });
          },
          onNewTurn: () => {
            if (isStaleRequest()) return;
            currentContent = "";
            updateRunningMessages((prev) => [
              ...prev,
              {
                id: Date.now() + Math.random(),
                role: "assistant",
                content: "",
                toolCalls: [],
              },
            ]);
          },
          onToolResult: (toolId, result) => {
            if (isStaleRequest()) return;
            updateRunningMessages((prev) => {
              const msgs = [...prev];
              const last = msgs[msgs.length - 1];
              if (last.role === "assistant") {
                const tc = last.toolCalls?.find((t) => t.id === toolId);
                if (tc) {
                  tc.status = "success";
                  tc.result = result;
                }
              }
              return msgs;
            });
          },
          onPlanStepCreated: (step) => {
            if (isStaleRequest()) return;
            updateRunningPlanSteps((prev) => upsertPlanStep(prev, step));
          },
          onPlanStepUpdated: (step) => {
            if (isStaleRequest()) return;
            updateRunningPlanSteps((prev) => applyPlanStepUpdate(prev, step));
          },
          onPlanProgress: (progress) => {
            if (isStaleRequest()) return;
            updateRunningPlanProgress(progress);
          },
          onPlanUpdated: (update) => {
            if (isStaleRequest()) return;
            const next = applyPlanUpdate([], update);
            replaceRunningPlan(next);
          },
          onRuntimeEvent: (event) => {
            if (isStaleRequest()) return;
            if (!shouldShowRuntimeEvent(event)) return;
            const createdAt = new Date().toISOString();
            updateRunningTimelineEvents((prev) => [
              ...prev,
              codexRuntimeEventToTimelineEvent(event, {
                id: `runtime-${requestId}-${prev.length}`,
                createdAt,
              }),
            ]);
          },
          onAgentStop: (data) => {
            if (isStaleRequest()) return;
            updateRunningMessages((prev) => {
              const msgs = [...prev];
              const last = msgs[msgs.length - 1];
              if (last.role !== "assistant") return msgs;

              if (data.stop_reason === "ask_user" && typeof data.metadata.question === "string") {
                if (typeof data.metadata.message === "string") {
                  last.content = data.metadata.message;
                }
                last.askUser = {
                  question: data.metadata.question,
                  options: Array.isArray(data.metadata.options)
                    ? data.metadata.options.filter(
                        (option): option is string => typeof option === "string"
                      )
                    : [],
                };
              }

              if (data.stop_reason === "permission_request") {
                last.permissionRequest = {
                  tool: typeof data.metadata.tool === "string" ? data.metadata.tool : "unknown",
                  params:
                    typeof data.metadata.params === "string" ||
                    (data.metadata.params && typeof data.metadata.params === "object")
                      ? (data.metadata.params as Record<string, unknown> | string)
                      : {},
                  riskLevel:
                    typeof data.metadata.riskLevel === "string"
                      ? data.metadata.riskLevel
                      : "dangerous",
                };
              }

              return msgs;
            });
          },
          onPermissionRequest: (request) => {
            if (isStaleRequest()) return;
            setIsGenerating(false);
            if (isRunVisible()) setInputFocusToken((prev) => bumpInputFocusToken(prev));
            updateRunningMessages((prev) => {
              const msgs = [...prev];
              const last = msgs[msgs.length - 1];
              if (last.role === "assistant") last.permissionRequest = request;
              return msgs;
            });
          },
          onUsage: (usage) => {
            if (isStaleRequest()) return;
            updateRunningUsage((prev) => ({
              prompt_tokens: prev.prompt_tokens + usage.prompt_tokens,
              completion_tokens: prev.completion_tokens + usage.completion_tokens,
              total_tokens: prev.total_tokens + usage.total_tokens,
              last_prompt_tokens: usage.last_prompt_tokens ?? prev.last_prompt_tokens,
              cached_input_tokens:
                (prev.cached_input_tokens ?? 0) + (usage.cached_input_tokens ?? 0),
              reasoning_output_tokens:
                (prev.reasoning_output_tokens ?? 0) + (usage.reasoning_output_tokens ?? 0),
              model_context_window: usage.model_context_window ?? prev.model_context_window,
            }));
            const ctx = usage.last_prompt_tokens ?? usage.prompt_tokens;
            if (ctx > 0) updateRunningContextTokens(ctx);
          },
          onConnectorAuth: (event) => {
            if (isStaleRequest()) return;
            const data = event.action?.data || {};
            const nextUrl = typeof data.oauth_url === "string" ? data.oauth_url : "";
            if (
              event.connector === "google_workspace" &&
              event.type === "connector_auth_required" &&
              event.stage === "awaiting_browser_callback" &&
              nextUrl
            ) {
              pendingConnectorAuthPayload = {
                connector: "google_workspace",
                tag: "auth",
                url: nextUrl,
                popup: null,
              };
            }
          },
          onComplete: () => {
            if (isStaleRequest()) return;
            abortControllerRef.current = null;
            if (pendingConnectorAuthPayload && beginConnectorAuthPollRef.current) {
              const baseMessages = runningViewStateRef.current?.messages || initialMessages;
              beginConnectorAuthPollRef.current?.(pendingConnectorAuthPayload, {
                baseMessages,
                allowWhileGenerating: true,
                openAuthWindow: false,
              });
              return;
            }
            setIsGenerating(false);
            setActiveRunningSession(null);
            const nextPlan = clearPlanState();
            replaceRunningPlan(nextPlan);
            runningViewStateRef.current = null;
            if (isRunVisible()) setInputFocusToken((prev) => bumpInputFocusToken(prev));
            getSessionActions().loadSessions();
            onWorkspaceRefresh();
          },
          onError: (err) => {
            if (isStaleRequest()) return;
            abortControllerRef.current = null;
            if (err instanceof AuthError) {
              handleAuthExpired();
              setIsGenerating(false);
              setActiveRunningSession(null);
              if (isRunVisible()) setInputFocusToken((prev) => bumpInputFocusToken(prev));
              return;
            }
            console.error("Chat error:", err);
            setIsGenerating(false);
            setActiveRunningSession(null);
            if (isRunVisible()) setInputFocusToken((prev) => bumpInputFocusToken(prev));
            updateRunningMessages((prev) => {
              const msgs = [...prev];
              const last = msgs[msgs.length - 1];
              if (last.role === "assistant" && !last.content) {
                last.content = chatErrorContent(err);
              }
              return msgs;
            });
          },
        },
        { signal: abortController.signal, files: filesForSend }
      );
    },
    [
      getSessionActions,
      handleAuthExpired,
      handleClearContext,
      input,
      isGenerating,
      lastContextTokens,
      messages,
      onWorkspaceRefresh,
      pendingFiles,
      runtimeTimelineEvents,
      selectedModel,
      setActiveRunningSession,
      planProgress,
      planSteps,
      tokenUsage,
    ]
  );

  const handleQuickReply = useCallback(
    (option: string) => {
      setInput(option);
      handleSendMessage(option);
    },
    [handleSendMessage]
  );

  const handlePermissionResolve = useCallback(
    async (action: "allow" | "always" | "deny") => {
      if (isGenerating) return;
      const sessionId = getSessionActions().getSessionId();
      if (!sessionId) return;

      try {
        const ok = await resolveSessionPermissionRequest(sessionId, action);
        if (!ok) {
          throw new Error("Failed to resolve permission request");
        }

        const text =
          action === "deny"
            ? "Denied."
            : action === "always"
              ? "Approved for this session. Please proceed."
              : "Approved. Please proceed.";
        setInput(text);
        await handleSendMessage(text);
      } catch (err) {
        if (err instanceof AuthError) {
          handleAuthExpired();
          return;
        }

        console.error("Permission resolve error:", err);
      }
    },
    [getSessionActions, handleAuthExpired, handleSendMessage, isGenerating]
  );

  const navigateFeishuAuthPopup = useCallback((url: string, popup?: Window | null) => {
    const nextUrl = url.trim();
    if (!nextUrl) return;

    if (popup) {
      feishuAuthPopupRef.current = popup;
      feishuAuthPopupUrlRef.current = nextUrl;
      return;
    }

    const existing = feishuAuthPopupRef.current;
    try {
      if (existing && !existing.closed) {
        if (feishuAuthPopupUrlRef.current === nextUrl) {
          existing.focus();
          return;
        }
        existing.location.href = nextUrl;
        feishuAuthPopupUrlRef.current = nextUrl;
        existing.focus();
        return;
      }
    } catch {
      /* fall through to opening a new window */
    }
    if (feishuAuthPopupUrlRef.current === nextUrl) return;
    feishuAuthPopupUrlRef.current = nextUrl;
    void (async () => {
      const result = await openExternalUrl(nextUrl, "ripple-connector-auth");
      if (!result.opened) {
        if (feishuAuthPopupUrlRef.current === nextUrl) {
          feishuAuthPopupUrlRef.current = null;
        }
        return;
      }
      if (result.popup) {
        feishuAuthPopupRef.current = result.popup;
      }
    })();
  }, []);

  const beginConnectorAuthPoll = useCallback(
    ({ connector, url, popup }: FeishuAuthOpenPayload, options: ConnectorAuthPollOptions = {}) => {
      const targetConnector = connector === "google_workspace" ? "google_workspace" : "feishu";
      const activeSessionId = getSessionActions().getSessionId();
      if (!activeSessionId) return;
      if (isGenerating && !options.allowWhileGenerating) return;

      clearConnectorAuthPoll();
      const shouldOpenAuthWindow = options.openAuthWindow !== false || Boolean(popup);
      if (shouldOpenAuthWindow) {
        navigateFeishuAuthPopup(url, popup);
      }
      startFeishuAuthWaiting(url, targetConnector);
      const pollId = connectorAuthPollIdRef.current + 1;
      connectorAuthPollIdRef.current = pollId;
      const baseMessages = options.baseMessages || messages;
      const initialMessages: Message[] = [
        ...baseMessages,
        {
          id: `${targetConnector}-auth-${Date.now()}-assistant`,
          role: "assistant",
          content: "",
          toolCalls: [],
        },
      ];
      runningViewStateRef.current = {
        sessionId: activeSessionId,
        messages: initialMessages,
        runtimeTimelineEvents,
        pendingFiles: [],
        tokenUsage,
        lastContextTokens,
        planSteps,
        planProgress,
      };
      setActiveRunningSession(activeSessionId);
      setMessages(initialMessages);
      setIsGenerating(true);

      const isStalePoll = () => connectorAuthPollIdRef.current !== pollId;
      const isRunVisible = () => getSessionActions().getSessionId() === activeSessionId;
      const getRunningState = () => {
        const state = runningViewStateRef.current;
        return state?.sessionId === activeSessionId ? state : null;
      };
      const updateRunningMessages = (updater: (prev: Message[]) => Message[]) => {
        const state = getRunningState();
        if (!state) return;
        const nextMessages = updater(state.messages);
        runningViewStateRef.current = { ...state, messages: nextMessages };
        if (isRunVisible()) setMessages(nextMessages);
      };
      const updateRunningTimelineEvents = (
        updater: (prev: WorkbenchTimelineEvent[]) => WorkbenchTimelineEvent[]
      ) => {
        const state = getRunningState();
        if (!state) return;
        const nextEvents = updater(state.runtimeTimelineEvents);
        runningViewStateRef.current = { ...state, runtimeTimelineEvents: nextEvents };
        if (isRunVisible()) setRuntimeTimelineEvents(nextEvents);
      };
      const updateRunningPlanSteps = (updater: (prev: PlanStep[]) => PlanStep[]) => {
        const state = getRunningState();
        if (!state) return;
        const nextSteps = updater(state.planSteps);
        runningViewStateRef.current = { ...state, planSteps: nextSteps };
        if (isRunVisible()) setPlanSteps(nextSteps);
      };
      const updateRunningPlanProgress = (nextProgress: PlanProgress | null) => {
        const state = getRunningState();
        if (!state) return;
        runningViewStateRef.current = { ...state, planProgress: nextProgress };
        if (isRunVisible()) setPlanProgress(nextProgress);
      };
      const updateRunningUsage = (updater: (prev: UsageInfo) => UsageInfo) => {
        const state = getRunningState();
        if (!state) return;
        const nextUsage = updater(state.tokenUsage);
        runningViewStateRef.current = { ...state, tokenUsage: nextUsage };
        if (isRunVisible()) setTokenUsage(nextUsage);
      };
      const updateRunningContextTokens = (nextContextTokens: number) => {
        const state = getRunningState();
        if (!state) return;
        runningViewStateRef.current = { ...state, lastContextTokens: nextContextTokens };
        if (isRunVisible()) setLastContextTokens(nextContextTokens);
      };
      const replaceRunningPlan = (nextPlan: {
        planSteps: PlanStep[];
        planProgress: PlanProgress | null;
      }) => {
        const state = getRunningState();
        if (!state) return;
        runningViewStateRef.current = {
          ...state,
          planSteps: nextPlan.planSteps,
          planProgress: nextPlan.planProgress,
        };
        if (isRunVisible()) {
          setPlanSteps(nextPlan.planSteps);
          setPlanProgress(nextPlan.planProgress);
        }
      };
      const appendAssistantPlaceholder = () => {
        updateRunningMessages((prev) => [
          ...prev,
          {
            id: Date.now() + Math.random(),
            role: "assistant",
            content: "",
            toolCalls: [],
          },
        ]);
      };

      let renderedPollContent = false;
      const refreshSession = async () => {
        try {
          const details = await fetchSessionDetails(activeSessionId);
          if (!isStalePoll() && details) {
            applySessionDetails(details);
          }
          return true;
        } catch (error) {
          if (error instanceof AuthError) {
            handleAuthExpired();
            return false;
          }
          console.error("Connector auth session refresh error:", error);
          return true;
        }
      };
      const finishPoll = async () => {
        connectorAuthPollAbortRef.current = null;
        clearFeishuAuthWaiting();
        if (!renderedPollContent) {
          runningViewStateRef.current = null;
        }
        const refreshed = await refreshSession();
        if (!refreshed) return;
        if (isStalePoll()) return;
        runningViewStateRef.current = null;
        setIsGenerating(false);
        setActiveRunningSession(null);
        setInputFocusToken((prev) => bumpInputFocusToken(prev));
        await getSessionActions().loadSessions();
        onWorkspaceRefresh();
      };

      const runPoll = async () => {
        if (isStalePoll()) return;
        const abortController = new AbortController();
        connectorAuthPollAbortRef.current = abortController;
        const pollState: {
          lastEvent: ConnectorAuthChatEvent | null;
          streamError: Error | null;
        } = {
          lastEvent: null,
          streamError: null,
        };
        let responseHasContent = false;
        let currentContent = "";
        const ensureResponseAssistant = () => {
          if (responseHasContent) return;
          responseHasContent = true;
          updateRunningMessages((prev) => {
            const last = prev[prev.length - 1];
            if (
              last?.role === "assistant" &&
              !last.content &&
              (!last.toolCalls || last.toolCalls.length === 0)
            ) {
              return prev;
            }
            return [
              ...prev,
              {
                id: Date.now() + Math.random(),
                role: "assistant",
                content: "",
                toolCalls: [],
              },
            ];
          });
        };

        await pollSessionConnectorAuth(
          activeSessionId,
          selectedModel,
          {
            onMessageDelta: (delta) => {
              if (isStalePoll()) return;
              renderedPollContent = true;
              ensureResponseAssistant();
              currentContent += delta;
              updateRunningMessages((prev) => {
                const msgs = [...prev];
                const last = msgs[msgs.length - 1];
                if (last.role === "assistant") last.content = currentContent;
                return msgs;
              });
            },
            onNewTurn: () => {
              if (isStalePoll()) return;
              renderedPollContent = true;
              currentContent = "";
              responseHasContent = true;
              appendAssistantPlaceholder();
            },
            onToolCall: (toolCall) => {
              if (isStalePoll()) return;
              renderedPollContent = true;
              updateRunningMessages((prev) => {
                const msgs = [...prev];
                const last = msgs[msgs.length - 1];
                if (last.role !== "assistant") {
                  return [
                    ...msgs,
                    {
                      id: Date.now() + Math.random(),
                      role: "assistant",
                      content: "",
                      toolCalls: [toolCall],
                    },
                  ];
                }
                const idx = last.toolCalls?.findIndex((t) => t.id === toolCall.id) ?? -1;
                if (idx >= 0 && last.toolCalls) {
                  last.toolCalls[idx] = toolCall;
                } else {
                  last.toolCalls = [...(last.toolCalls || []), toolCall];
                }
                return msgs;
              });
            },
            onToolResult: (toolId, result) => {
              if (isStalePoll()) return;
              renderedPollContent = true;
              updateRunningMessages((prev) => {
                const msgs = [...prev];
                const last = msgs[msgs.length - 1];
                if (last.role === "assistant") {
                  const tc = last.toolCalls?.find((t) => t.id === toolId);
                  if (tc) {
                    tc.status = "success";
                    tc.result = result;
                  }
                }
                return msgs;
              });
            },
            onPlanStepCreated: (step) => {
              if (isStalePoll()) return;
              updateRunningPlanSteps((prev) => upsertPlanStep(prev, step));
            },
            onPlanStepUpdated: (step) => {
              if (isStalePoll()) return;
              updateRunningPlanSteps((prev) => applyPlanStepUpdate(prev, step));
            },
            onPlanProgress: (progress) => {
              if (isStalePoll()) return;
              updateRunningPlanProgress(progress);
            },
            onPlanUpdated: (update) => {
              if (isStalePoll()) return;
              const next = applyPlanUpdate([], update);
              replaceRunningPlan(next);
            },
            onRuntimeEvent: (event) => {
              if (isStalePoll()) return;
              if (!shouldShowRuntimeEvent(event)) return;
              renderedPollContent = true;
              const createdAt = new Date().toISOString();
              updateRunningTimelineEvents((prev) => [
                ...prev,
                codexRuntimeEventToTimelineEvent(event, {
                  id: `runtime-${targetConnector}-${pollId}-${prev.length}`,
                  createdAt,
                }),
              ]);
            },
            onUsage: (usage) => {
              if (isStalePoll()) return;
              updateRunningUsage((prev) => ({
                prompt_tokens: prev.prompt_tokens + usage.prompt_tokens,
                completion_tokens: prev.completion_tokens + usage.completion_tokens,
                total_tokens: prev.total_tokens + usage.total_tokens,
                last_prompt_tokens: usage.last_prompt_tokens ?? prev.last_prompt_tokens,
                cached_input_tokens:
                  (prev.cached_input_tokens ?? 0) + (usage.cached_input_tokens ?? 0),
                reasoning_output_tokens:
                  (prev.reasoning_output_tokens ?? 0) + (usage.reasoning_output_tokens ?? 0),
                model_context_window: usage.model_context_window ?? prev.model_context_window,
              }));
              const ctx = usage.last_prompt_tokens ?? usage.prompt_tokens;
              if (ctx > 0) updateRunningContextTokens(ctx);
            },
            onConnectorAuth: (event) => {
              pollState.lastEvent = event;
              if (event.type === "connector_auth_updated") {
                clearFeishuAuthWaiting();
              }
              const data = event.action?.data || {};
              const nextUrl =
                typeof data.oauth_url === "string"
                  ? data.oauth_url
                  : typeof data.setup_url === "string"
                    ? data.setup_url
                    : "";
              if (event.connector === targetConnector && nextUrl) {
                if (shouldOpenAuthWindow) {
                  navigateFeishuAuthPopup(nextUrl);
                }
                startFeishuAuthWaiting(nextUrl, targetConnector);
              }
            },
            onComplete: () => {},
            onError: (error) => {
              pollState.streamError = error;
            },
          },
          { signal: abortController.signal }
        );

        connectorAuthPollAbortRef.current = null;
        if (isStalePoll()) return;
        if (pollState.streamError) {
          if (pollState.streamError instanceof AuthError) {
            handleAuthExpired();
            return;
          }
          console.error("Connector auth poll error:", pollState.streamError);
          updateRunningMessages((prev) => {
            const msgs = [...prev];
            const last = msgs[msgs.length - 1];
            if (last.role === "assistant" && !last.content) {
              last.content = chatErrorContent(pollState.streamError);
            }
            return msgs;
          });
          await finishPoll();
          return;
        }

        const refreshed = await refreshSession();
        if (!refreshed) return;
        if (isStalePoll()) return;
        const lastEvent = pollState.lastEvent;
        const shouldContinue =
          lastEvent !== null &&
          lastEvent.connector === targetConnector &&
          lastEvent.type === "connector_auth_required" &&
          lastEvent.stage !== "auth_failed" &&
          lastEvent.stage !== "invalid_request";
        if (shouldContinue) {
          connectorAuthPollTimerRef.current = window.setTimeout(runPoll, 2000);
          return;
        }
        await finishPoll();
      };

      void runPoll();
    },
    [
      applySessionDetails,
      clearFeishuAuthWaiting,
      clearConnectorAuthPoll,
      getSessionActions,
      handleAuthExpired,
      isGenerating,
      lastContextTokens,
      messages,
      navigateFeishuAuthPopup,
      onWorkspaceRefresh,
      runtimeTimelineEvents,
      selectedModel,
      setActiveRunningSession,
      startFeishuAuthWaiting,
      planProgress,
      planSteps,
      tokenUsage,
    ]
  );

  const handleFeishuAuthOpen = useCallback(
    (payload: FeishuAuthOpenPayload) => {
      beginConnectorAuthPoll(payload);
    },
    [beginConnectorAuthPoll]
  );

  useEffect(() => {
    beginConnectorAuthPollRef.current = beginConnectorAuthPoll;
  }, [beginConnectorAuthPoll]);

  const pendingInteractionMessage = useMemo(
    () => [...messages].reverse().find((message) => message.permissionRequest || message.askUser),
    [messages]
  );
  const pendingPermission = pendingInteractionMessage?.permissionRequest || null;
  const currentSessionRuntimeStatus = isGenerating
    ? ("running" as const)
    : pendingInteractionMessage?.permissionRequest
      ? ("waiting_for_approval" as const)
      : pendingInteractionMessage?.askUser
        ? ("waiting_for_user" as const)
        : null;
  const timelineEvents = useMemo(
    () => [
      ...messagesToTimelineEvents(messages, {
        showToolActivity: true,
        maxToolActivityItems: 4,
      }),
      ...runtimeTimelineEvents,
    ],
    [messages, runtimeTimelineEvents]
  );
  const changedFiles = useMemo(() => extractChangedFilePaths(messages), [messages]);

  return {
    input,
    setInput,
    messages,
    pendingFiles,
    isGenerating,
    runningSessionId,
    inputFocusToken,
    tokenUsage,
    lastContextTokens,
    planSteps,
    planProgress,
    pendingPermission,
    currentSessionRuntimeStatus,
    timelineEvents,
    changedFiles,
    feishuAuthWaiting,
    resetSessionView,
    resetCurrentContextView,
    abortRunAndResetSessionView,
    applySessionDetails,
    handleStop,
    handleClearContext,
    handleAttachFiles,
    handleRemovePendingFile,
    handleSendMessage,
    handleQuickReply,
    handlePermissionResolve,
    handleFeishuAuthOpen,
  };
}
