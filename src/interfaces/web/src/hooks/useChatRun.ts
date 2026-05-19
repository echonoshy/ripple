import { useCallback, useMemo, useRef, useState } from "react";
import type {
  Message,
  SessionDetail,
  TaskInfo,
  TaskProgress,
  UsageInfo,
  WorkbenchTimelineEvent,
} from "@/types";
import {
  AuthError,
  resolveSessionPermissionRequest,
  sendChatMessage,
  uploadWorkspaceAttachment,
} from "@/lib/api";
import { chatErrorContent } from "@/lib/chatErrors";
import { describeChatFilesForDisplay, type ChatFileRef } from "@/lib/chatInput";
import {
  applyTaskPlanUpdate,
  applyTaskUpdate,
  clearTaskPlanState,
  upsertTask,
} from "@/lib/chatState";
import { bumpInputFocusToken } from "@/lib/inputFocus";
import { mapSessionMessages } from "@/lib/sessionMessages";
import {
  codexRuntimeEventToTimelineEvent,
  extractChangedFilePaths,
  messagesToTimelineEvents,
} from "@/lib/workbench";

export interface ChatRunSessionActions {
  getSessionId: () => string | null;
  ensureSession: () => Promise<string | null>;
  loadSessions: () => Promise<unknown>;
  clearCurrentSessionContext: () => Promise<boolean>;
  stopCurrentSession: () => Promise<boolean>;
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
  const [runtimeTimelineEvents, setRuntimeTimelineEvents] = useState<WorkbenchTimelineEvent[]>([]);
  const [inputFocusToken, setInputFocusToken] = useState(0);
  const [tokenUsage, setTokenUsage] = useState<UsageInfo>(emptyUsage);
  const [lastContextTokens, setLastContextTokens] = useState(0);
  const [taskSteps, setTaskSteps] = useState<TaskInfo[]>([]);
  const [taskProgress, setTaskProgress] = useState<TaskProgress | null>(null);

  const activeRequestIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const handleAuthExpired = useCallback(() => {
    abortControllerRef.current = null;
    onAuthExpired("API Key 已失效");
  }, [onAuthExpired]);

  const resetSessionView = useCallback(() => {
    setMessages([]);
    setRuntimeTimelineEvents([]);
    setPendingFiles([]);
    setTaskSteps([]);
    setTaskProgress(null);
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
    setIsGenerating(false);
    resetSessionView();
  }, [resetSessionView]);

  const applySessionDetails = useCallback(
    (details: SessionDetail) => {
      onSelectedModelChange(details.model);
      setMessages(mapSessionMessages(details));
      setRuntimeTimelineEvents([]);
      setPendingFiles([]);
      setTokenUsage(emptyUsage);
      setLastContextTokens(0);
      setTaskSteps(details.taskSteps || []);
      setTaskProgress(details.taskProgress || null);
      onWorkspaceRefresh();
    },
    [onSelectedModelChange, onWorkspaceRefresh]
  );

  const handleStop = useCallback(async () => {
    activeRequestIdRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    await getSessionActions().stopCurrentSession();
    setIsGenerating(false);
    setInputFocusToken((prev) => bumpInputFocusToken(prev));
  }, [getSessionActions]);

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
      setMessages((prev) => [
        ...prev,
        { id: userMessageId, role: "user", content: displayText, created_at: sentAt },
        { id: assistantMessageId, role: "assistant", content: "", toolCalls: [] },
      ]);
      setInput("");
      setPendingFiles([]);
      setIsGenerating(true);

      let currentContent = "";
      const assistantUpdates = new Map<string, string>();
      const upsertAssistantUpdate = (id: string, content: string) => {
        setMessages((prev) => {
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
            setMessages((prev) => {
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
            setMessages((prev) => {
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
            setMessages((prev) => [
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
            setMessages((prev) => {
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
          onTaskCreated: (task) => {
            if (isStaleRequest()) return;
            setTaskSteps((prev) => upsertTask(prev, task));
          },
          onTaskUpdated: (task) => {
            if (isStaleRequest()) return;
            setTaskSteps((prev) => applyTaskUpdate(prev, task));
          },
          onTaskProgress: (progress) => {
            if (isStaleRequest()) return;
            setTaskProgress(progress);
          },
          onTaskPlanUpdated: (update) => {
            if (isStaleRequest()) return;
            const next = applyTaskPlanUpdate([], update);
            setTaskSteps(next.taskSteps);
            setTaskProgress(next.taskProgress);
          },
          onRuntimeEvent: (event) => {
            if (isStaleRequest()) return;
            const createdAt = new Date().toISOString();
            setRuntimeTimelineEvents((prev) => [
              ...prev,
              codexRuntimeEventToTimelineEvent(event, {
                id: `runtime-${requestId}-${prev.length}`,
                createdAt,
              }),
            ]);
          },
          onAgentStop: (data) => {
            if (isStaleRequest()) return;
            setMessages((prev) => {
              const msgs = [...prev];
              const last = msgs[msgs.length - 1];
              if (last.role !== "assistant") return msgs;

              if (data.stop_reason === "ask_user" && typeof data.metadata.question === "string") {
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
            setInputFocusToken((prev) => bumpInputFocusToken(prev));
            setMessages((prev) => {
              const msgs = [...prev];
              const last = msgs[msgs.length - 1];
              if (last.role === "assistant") last.permissionRequest = request;
              return msgs;
            });
          },
          onUsage: (usage) => {
            if (isStaleRequest()) return;
            setTokenUsage((prev) => ({
              prompt_tokens: prev.prompt_tokens + usage.prompt_tokens,
              completion_tokens: prev.completion_tokens + usage.completion_tokens,
              total_tokens: prev.total_tokens + usage.total_tokens,
            }));
            const ctx = usage.last_prompt_tokens ?? usage.prompt_tokens;
            if (ctx > 0) setLastContextTokens(ctx);
          },
          onComplete: () => {
            if (isStaleRequest()) return;
            abortControllerRef.current = null;
            setIsGenerating(false);
            const nextPlan = clearTaskPlanState();
            setTaskSteps(nextPlan.taskSteps);
            setTaskProgress(nextPlan.taskProgress);
            setInputFocusToken((prev) => bumpInputFocusToken(prev));
            getSessionActions().loadSessions();
            onWorkspaceRefresh();
          },
          onError: (err) => {
            if (isStaleRequest()) return;
            abortControllerRef.current = null;
            if (err instanceof AuthError) {
              handleAuthExpired();
              setIsGenerating(false);
              setInputFocusToken((prev) => bumpInputFocusToken(prev));
              return;
            }
            console.error("Chat error:", err);
            setIsGenerating(false);
            setInputFocusToken((prev) => bumpInputFocusToken(prev));
            setMessages((prev) => {
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
      onWorkspaceRefresh,
      pendingFiles,
      selectedModel,
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
    () => [...messagesToTimelineEvents(messages), ...runtimeTimelineEvents],
    [messages, runtimeTimelineEvents]
  );
  const changedFiles = useMemo(() => extractChangedFilePaths(messages), [messages]);

  return {
    input,
    setInput,
    messages,
    pendingFiles,
    isGenerating,
    inputFocusToken,
    tokenUsage,
    lastContextTokens,
    taskSteps,
    taskProgress,
    pendingPermission,
    currentSessionRuntimeStatus,
    timelineEvents,
    changedFiles,
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
  };
}
