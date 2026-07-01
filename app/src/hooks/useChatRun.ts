import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CodexRuntimeEvent,
  ConnectorAuthChatEvent,
  Message,
  SessionControlAction,
  SessionDetail,
  SessionAttention,
  SkillInfo,
  PlanStep,
  PlanProgress,
  UsageInfo,
  WorkbenchTimelineEvent,
} from "@/types";
import {
  AuthError,
  cancelSessionConnectorAuth,
  type ChatStreamCallbacks,
  fetchSkills,
  fetchSessionDetails,
  pollSessionConnectorAuth,
  resolveSessionPermissionRequest,
  sendChatMessage,
  sendSessionControlAction,
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
import {
  createPendingLocalImages,
  revokePendingLocalImages,
  type PendingImageSource,
  type PendingLocalImage,
} from "@/lib/pendingImages";
import { mapSessionMessages } from "@/lib/sessionMessages";
import {
  extractChangedFilePaths,
  mergeTimelineEvents,
  messagesToTimelineEvents,
  upsertRuntimeTimelineEvent,
} from "@/lib/workbench";
import { openExternalUrl } from "@/lib/platform";
import type { FeishuAuthOpenPayload, FeishuAuthWaitingState } from "@/components/MarkdownRenderer";
import { useI18n } from "@/i18n";
import {
  attachmentUploadErrorMessage,
  summarizeAttachmentUploadErrors,
  uploadPendingLocalImagesForSend,
} from "./chatRunAttachments";
import {
  CONNECTOR_AUTH_POLL_TIMEOUT_MS,
  connectorAuthPollPayloadFromEvent,
  connectorAuthRequiresSessionAttention,
  shouldAutoOpenConnectorAuthWindow,
  shouldContinueConnectorAuthPoll,
  shouldStartConnectorAuthPoll,
} from "./chatRunConnectorAuth";

export {
  CONNECTOR_AUTH_POLL_TIMEOUT_MS,
  connectorAuthPollPayloadFromEvent,
  connectorAuthRequiresSessionAttention,
  shouldAutoOpenConnectorAuthWindow,
  shouldContinueConnectorAuthPoll,
  shouldStartConnectorAuthPoll,
} from "./chatRunConnectorAuth";
export { uploadPendingLocalImagesForSend } from "./chatRunAttachments";

export interface ChatRunSessionActions {
  getSessionId: () => string | null;
  ensureSession: (model?: string | null) => Promise<string | null>;
  createSession: (model?: string | null) => Promise<string | null>;
  loadSessions: (options?: { showLoading?: boolean }) => Promise<unknown>;
  clearCurrentSessionContext: () => Promise<boolean>;
  compactCurrentSessionContext: () => Promise<boolean>;
  stopCurrentSession: () => Promise<boolean>;
  stopSession: (sessionId: string) => Promise<boolean>;
}

interface UseChatRunOptions {
  selectedModel: string;
  onSelectedModelChange: (model: string, sessionId?: string | null) => void;
  onAuthExpired: (message: string) => void;
  onWorkspaceRefresh: () => void;
  getSessionActions: () => ChatRunSessionActions;
  onSessionAttention?: (sessionId: string, attention: SessionAttention | null) => void;
}

interface SendMessageOptions {
  controlAction?: SessionControlAction;
  newSession?: boolean;
}

const emptyUsage: UsageInfo = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
};

export const SESSION_TITLE_REFRESH_DELAYS_MS = [750, 2000, 5000] as const;
const CONNECTOR_AUTH_POLL_INTERVAL_MS = 2000;

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
  onSessionAttention,
}: UseChatRunOptions) {
  const { t } = useI18n();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [pendingFiles, setPendingFiles] = useState<ChatFileRef[]>([]);
  const [pendingLocalImages, setPendingLocalImages] = useState<PendingLocalImage[]>([]);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const [attachmentUploadError, setAttachmentUploadError] = useState<string | null>(null);
  const [runningSessionIds, setRunningSessionIds] = useState<string[]>([]);
  const [runtimeTimelineEvents, setRuntimeTimelineEvents] = useState<WorkbenchTimelineEvent[]>([]);
  const [inputFocusToken, setInputFocusToken] = useState(0);
  const [tokenUsage, setTokenUsage] = useState<UsageInfo>(emptyUsage);
  const [lastContextTokens, setLastContextTokens] = useState(0);
  const [planSteps, setPlanSteps] = useState<PlanStep[]>([]);
  const [planProgress, setPlanProgress] = useState<PlanProgress | null>(null);
  const [feishuAuthWaiting, setFeishuAuthWaiting] = useState<FeishuAuthWaitingState | null>(null);
  const [availableSkills, setAvailableSkills] = useState<SkillInfo[]>([]);
  const [isLoadingSkills, setIsLoadingSkills] = useState(false);
  const [selectedRequiredSkillId, setSelectedRequiredSkillId] = useState<string | null>(null);

  const activeRequestIdsRef = useRef<Map<string, number>>(new Map());
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const runningViewStatesRef = useRef<Map<string, ChatRunViewState>>(new Map());
  const pendingLocalImagesRef = useRef<PendingLocalImage[]>([]);
  const connectorAuthPollAbortRef = useRef<AbortController | null>(null);
  const connectorAuthPollTimerRef = useRef<number | null>(null);
  const connectorAuthPollIdRef = useRef(0);
  const feishuAuthPopupRef = useRef<Window | null>(null);
  const feishuAuthPopupUrlRef = useRef<string | null>(null);
  const feishuAuthWaitingTimerRef = useRef<number | null>(null);
  const beginConnectorAuthPollRef = useRef<
    ((payload: FeishuAuthOpenPayload, options?: ConnectorAuthPollOptions) => void) | null
  >(null);

  useEffect(() => {
    pendingLocalImagesRef.current = pendingLocalImages;
  }, [pendingLocalImages]);

  useEffect(
    () => () => {
      revokePendingLocalImages(pendingLocalImagesRef.current);
      pendingLocalImagesRef.current = [];
    },
    []
  );

  const clearPendingLocalImages = useCallback(() => {
    setPendingLocalImages((prev) => {
      revokePendingLocalImages(prev);
      pendingLocalImagesRef.current = [];
      return [];
    });
  }, []);

  const markSessionRunning = useCallback(
    (sessionId: string) => {
      setRunningSessionIds((prev) => (prev.includes(sessionId) ? prev : [...prev, sessionId]));
      onSessionAttention?.(sessionId, null);
    },
    [onSessionAttention]
  );

  const clearSessionRunning = useCallback((sessionId: string) => {
    setRunningSessionIds((prev) => prev.filter((id) => id !== sessionId));
  }, []);

  const isSessionRunning = useCallback(
    (sessionId: string | null | undefined) =>
      Boolean(sessionId && runningSessionIds.includes(sessionId)),
    [runningSessionIds]
  );

  const isGenerating = runningSessionIds.length > 0;
  const runningSessionId = runningSessionIds[0] || null;

  const applyViewState = useCallback(
    (state: ChatRunViewState) => {
      setMessages(state.messages);
      setRuntimeTimelineEvents(state.runtimeTimelineEvents);
      setPendingFiles(state.pendingFiles);
      clearPendingLocalImages();
      setTokenUsage(state.tokenUsage);
      setLastContextTokens(state.lastContextTokens);
      setPlanSteps(state.planSteps);
      setPlanProgress(state.planProgress);
    },
    [clearPendingLocalImages]
  );

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
      const label =
        knownConnector === "google_workspace"
          ? t("connectors.googleAuthLabel")
          : t("connectors.feishuOperationLabel");
      setFeishuAuthWaiting({ connector: knownConnector, url: nextUrl, elapsedSeconds: 0, label });
      feishuAuthWaitingTimerRef.current = window.setInterval(() => {
        setFeishuAuthWaiting((current) =>
          current?.url === nextUrl
            ? { ...current, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000) }
            : current
        );
      }, 1000);
    },
    [clearFeishuAuthWaiting, t]
  );

  const clearConnectorAuthPoll = useCallback(() => {
    connectorAuthPollIdRef.current += 1;
    connectorAuthPollAbortRef.current?.abort();
    connectorAuthPollAbortRef.current = null;
    feishuAuthPopupUrlRef.current = null;
    if (connectorAuthPollTimerRef.current) {
      window.clearTimeout(connectorAuthPollTimerRef.current);
      connectorAuthPollTimerRef.current = null;
    }
    clearFeishuAuthWaiting();
  }, [clearFeishuAuthWaiting]);

  useEffect(() => clearConnectorAuthPoll, [clearConnectorAuthPoll]);

  const handleAuthExpired = useCallback(() => {
    clearConnectorAuthPoll();
    abortControllersRef.current.forEach((controller) => controller.abort());
    abortControllersRef.current.clear();
    activeRequestIdsRef.current.clear();
    runningViewStatesRef.current.clear();
    setRunningSessionIds([]);
    clearPendingLocalImages();
    onAuthExpired(t("auth.apiKeyExpired"));
  }, [clearConnectorAuthPoll, clearPendingLocalImages, onAuthExpired, t]);

  const loadAvailableSkills = useCallback(async () => {
    if (availableSkills.length > 0 || isLoadingSkills) return;
    setIsLoadingSkills(true);
    try {
      const skills = await fetchSkills();
      setAvailableSkills(
        skills.filter(
          (skill) =>
            skill.enabled &&
            (skill.user_status === "available" || skill.status === "available")
        )
      );
    } catch (error) {
      if (error instanceof AuthError) {
        handleAuthExpired();
        return;
      }
      console.error("Failed to load skills:", error);
    } finally {
      setIsLoadingSkills(false);
    }
  }, [availableSkills.length, handleAuthExpired, isLoadingSkills]);

  const resetSessionView = useCallback(() => {
    setMessages([]);
    setRuntimeTimelineEvents([]);
    setPendingFiles([]);
    clearPendingLocalImages();
    setIsUploadingFiles(false);
    setAttachmentUploadError(null);
    setPlanSteps([]);
    setPlanProgress(null);
    setTokenUsage(emptyUsage);
    setLastContextTokens(0);
  }, [clearPendingLocalImages]);

  const resetCurrentContextView = useCallback(() => {
    resetSessionView();
    setInput("");
  }, [resetSessionView]);

  const abortRunAndResetSessionView = useCallback(() => {
    activeRequestIdsRef.current.forEach((requestId, sessionId) => {
      activeRequestIdsRef.current.set(sessionId, requestId + 1);
    });
    abortControllersRef.current.forEach((controller) => controller.abort());
    abortControllersRef.current.clear();
    clearConnectorAuthPoll();
    runningViewStatesRef.current.clear();
    setRunningSessionIds([]);
    resetSessionView();
  }, [clearConnectorAuthPoll, resetSessionView]);

  const applySessionDetails = useCallback(
    (details: SessionDetail) => {
      onSelectedModelChange(details.model, details.sessionId);
      const runningState = runningViewStatesRef.current.get(details.sessionId);
      if (runningState) {
        applyViewState(runningState);
        onWorkspaceRefresh();
        return;
      }
      setMessages(mapSessionMessages(details));
      setRuntimeTimelineEvents([]);
      setPendingFiles([]);
      clearPendingLocalImages();
      setIsUploadingFiles(false);
      setAttachmentUploadError(null);
      setTokenUsage(emptyUsage);
      setLastContextTokens(0);
      setPlanSteps(details.planSteps || []);
      setPlanProgress(details.planProgress || null);
      onWorkspaceRefresh();
    },
    [applyViewState, clearPendingLocalImages, onSelectedModelChange, onWorkspaceRefresh]
  );

  const refreshSessionDetails = useCallback(
    async (targetSessionId: string, options: { refreshList?: boolean } = {}) => {
      try {
        const details = await fetchSessionDetails(targetSessionId);
        if (details && getSessionActions().getSessionId() === targetSessionId) {
          applySessionDetails(details);
        }
        if (options.refreshList !== false) {
          await getSessionActions().loadSessions({ showLoading: false });
        }
      } catch (error) {
        if (error instanceof AuthError) {
          handleAuthExpired();
          return;
        }
        console.error("Session details refresh error:", error);
      }
    },
    [applySessionDetails, getSessionActions, handleAuthExpired]
  );

  const handleStop = useCallback(async () => {
    const currentSessionId = getSessionActions().getSessionId();
    const targetSessionId =
      (currentSessionId && runningSessionIds.includes(currentSessionId)
        ? currentSessionId
        : runningSessionIds[0]) || currentSessionId;
    if (targetSessionId) {
      const requestId = activeRequestIdsRef.current.get(targetSessionId) || 0;
      activeRequestIdsRef.current.set(targetSessionId, requestId + 1);
      abortControllersRef.current.get(targetSessionId)?.abort();
      abortControllersRef.current.delete(targetSessionId);
      runningViewStatesRef.current.delete(targetSessionId);
      clearSessionRunning(targetSessionId);
    }
    clearConnectorAuthPoll();
    if (targetSessionId) {
      await getSessionActions().stopSession(targetSessionId);
    } else {
      await getSessionActions().stopCurrentSession();
    }
    await getSessionActions().loadSessions({ showLoading: false });
    onWorkspaceRefresh();
    setInputFocusToken((prev) => bumpInputFocusToken(prev));
  }, [
    clearConnectorAuthPoll,
    clearSessionRunning,
    getSessionActions,
    onWorkspaceRefresh,
    runningSessionIds,
  ]);

  const handleClearContext = useCallback(async () => {
    if (isSessionRunning(getSessionActions().getSessionId())) return;
    try {
      const ok = await getSessionActions().clearCurrentSessionContext();
      if (!ok) throw new Error("Failed to clear session context");
      resetCurrentContextView();
      setInputFocusToken((prev) => bumpInputFocusToken(prev));
      await getSessionActions().loadSessions({ showLoading: false });
    } catch (err) {
      if (err instanceof AuthError) {
        handleAuthExpired();
        return;
      }
      console.error("Clear context error:", err);
    }
  }, [getSessionActions, handleAuthExpired, isSessionRunning, resetCurrentContextView]);

  const handleCompactContext = useCallback(async () => {
    if (isSessionRunning(getSessionActions().getSessionId())) return;
    try {
      const ok = await getSessionActions().compactCurrentSessionContext();
      if (!ok) throw new Error("Failed to compact session context");
      setRuntimeTimelineEvents((prev) =>
        upsertRuntimeTimelineEvent(
          prev,
          {
            type: "context_compaction",
            id: `manual-${Date.now()}`,
            status: "running",
          },
          { createdAt: new Date().toISOString() }
        )
      );
      setInputFocusToken((prev) => bumpInputFocusToken(prev));
      await getSessionActions().loadSessions({ showLoading: false });
      for (const delayMs of [1000, 3000, 8000]) {
        window.setTimeout(() => {
          void getSessionActions().loadSessions({ showLoading: false });
        }, delayMs);
      }
    } catch (err) {
      if (err instanceof AuthError) {
        handleAuthExpired();
        return;
      }
      console.error("Compact context error:", err);
    }
  }, [getSessionActions, handleAuthExpired, isSessionRunning]);

  const handleAttachFiles = useCallback(
    async (files: File[]) => {
      if (isSessionRunning(getSessionActions().getSessionId()) || files.length === 0) return;
      setIsUploadingFiles(true);
      setAttachmentUploadError(null);
      try {
        const uploaded: Awaited<ReturnType<typeof uploadWorkspaceAttachment>>[] = [];
        const failures: string[] = [];
        for (const file of files) {
          try {
            uploaded.push(await uploadWorkspaceAttachment(file));
          } catch (err) {
            if (err instanceof AuthError) {
              throw err;
            }
            failures.push(`${file.name}: ${attachmentUploadErrorMessage(err)}`);
          }
        }
        if (uploaded.length > 0) {
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
        }
        if (failures.length > 0) {
          setAttachmentUploadError(summarizeAttachmentUploadErrors(failures));
        }
      } catch (err) {
        if (err instanceof AuthError) {
          handleAuthExpired();
          return;
        }
        setAttachmentUploadError(attachmentUploadErrorMessage(err));
        console.error("Attachment upload error:", err);
      } finally {
        setIsUploadingFiles(false);
      }
    },
    [getSessionActions, handleAuthExpired, isSessionRunning, onWorkspaceRefresh]
  );

  const handleRemovePendingFile = useCallback((path: string) => {
    setPendingFiles((prev) => prev.filter((file) => file.path !== path));
  }, []);

  const handleAddPendingImages = useCallback(
    (files: File[], source: PendingImageSource) => {
      if (isSessionRunning(getSessionActions().getSessionId()) || files.length === 0) return;
      const images = createPendingLocalImages(files, source);
      if (images.length === 0) return;

      setPendingLocalImages((prev) => {
        const next = [...prev, ...images];
        pendingLocalImagesRef.current = next;
        return next;
      });
      setAttachmentUploadError(null);
      setInputFocusToken((prev) => bumpInputFocusToken(prev));
    },
    [getSessionActions, isSessionRunning]
  );

  const handleRemovePendingLocalImage = useCallback((id: string) => {
    setPendingLocalImages((prev) => {
      const removed = prev.filter((image) => image.id === id);
      revokePendingLocalImages(removed);
      const next = prev.filter((image) => image.id !== id);
      pendingLocalImagesRef.current = next;
      return next;
    });
  }, []);

  const handleSendMessage = useCallback(
    async (overrideText?: string, options: SendMessageOptions = {}) => {
      const isControlAction = Boolean(options.controlAction);
      const text = typeof overrideText === "string" ? overrideText.trim() : input.trim();
      let filesForSend = typeof overrideText === "string" || isControlAction ? [] : pendingFiles;
      const localImagesForSend =
        typeof overrideText === "string" || isControlAction ? [] : pendingLocalImages;
      const allowLocalCommand = !isControlAction && !options.newSession;
      if (allowLocalCommand && text === "/clear") {
        await handleClearContext();
        return;
      }
      if (allowLocalCommand && text === "/compact") {
        await handleCompactContext();
        return;
      }
      if (!text && filesForSend.length === 0 && localImagesForSend.length === 0) return;

      const sessionActions = getSessionActions();
      const activeSessionId = options.newSession
        ? await sessionActions.createSession(selectedModel)
        : await sessionActions.ensureSession(selectedModel);
      if (!activeSessionId) {
        return;
      }
      if (runningViewStatesRef.current.has(activeSessionId)) return;

      if (localImagesForSend.length > 0) {
        setIsUploadingFiles(true);
        setAttachmentUploadError(null);
        try {
          const localUpload = await uploadPendingLocalImagesForSend(
            localImagesForSend,
            uploadWorkspaceAttachment
          );
          if (localUpload.failures.length > 0) {
            setAttachmentUploadError(summarizeAttachmentUploadErrors(localUpload.failures));
            return;
          }
          filesForSend = [...filesForSend, ...localUpload.files];
          onWorkspaceRefresh();
        } catch (err) {
          if (err instanceof AuthError) {
            handleAuthExpired();
            return;
          }
          setAttachmentUploadError(attachmentUploadErrorMessage(err));
          console.error("Local image upload error:", err);
          return;
        } finally {
          setIsUploadingFiles(false);
        }
      }

      const requestId = (activeRequestIdsRef.current.get(activeSessionId) || 0) + 1;
      activeRequestIdsRef.current.set(activeSessionId, requestId);
      abortControllersRef.current.get(activeSessionId)?.abort();
      const abortController = new AbortController();
      abortControllersRef.current.set(activeSessionId, abortController);
      const isStaleRequest = () => activeRequestIdsRef.current.get(activeSessionId) !== requestId;

      const sentAt = new Date().toISOString();
      const displayText = describeChatFilesForDisplay(text, filesForSend);
      const userMessageId = Date.now();
      const assistantMessageId = `${userMessageId}-assistant`;
      const baseMessages = options.newSession ? [] : messages;
      const baseRuntimeTimelineEvents = options.newSession ? [] : runtimeTimelineEvents;
      const baseTokenUsage = options.newSession ? emptyUsage : tokenUsage;
      const baseLastContextTokens = options.newSession ? 0 : lastContextTokens;
      const basePlanSteps = options.newSession ? [] : planSteps;
      const basePlanProgress = options.newSession ? null : planProgress;
      const initialMessages: Message[] = [
        ...baseMessages,
        { id: userMessageId, role: "user", content: displayText, created_at: sentAt },
        {
          id: assistantMessageId,
          role: "assistant",
          content: "",
          toolCalls: [],
          created_at: sentAt,
        },
      ];
      runningViewStatesRef.current.set(activeSessionId, {
        sessionId: activeSessionId,
        messages: initialMessages,
        runtimeTimelineEvents: baseRuntimeTimelineEvents,
        pendingFiles: [],
        tokenUsage: baseTokenUsage,
        lastContextTokens: baseLastContextTokens,
        planSteps: basePlanSteps,
        planProgress: basePlanProgress,
      });
      markSessionRunning(activeSessionId);
      setMessages(initialMessages);
      setRuntimeTimelineEvents(baseRuntimeTimelineEvents);
      setInput("");
      setPendingFiles([]);
      clearPendingLocalImages();
      setAttachmentUploadError(null);
      setTokenUsage(baseTokenUsage);
      setLastContextTokens(baseLastContextTokens);
      setPlanSteps(basePlanSteps);
      setPlanProgress(basePlanProgress);

      const isRunVisible = () => getSessionActions().getSessionId() === activeSessionId;
      const getRunningState = () => {
        return runningViewStatesRef.current.get(activeSessionId) || null;
      };
      const updateRunningMessages = (updater: (prev: Message[]) => Message[]) => {
        const state = getRunningState();
        if (!state) return;
        const nextMessages = updater(state.messages);
        runningViewStatesRef.current.set(activeSessionId, { ...state, messages: nextMessages });
        if (isRunVisible()) setMessages(nextMessages);
      };
      const updateRunningTimelineEvents = (
        updater: (prev: WorkbenchTimelineEvent[]) => WorkbenchTimelineEvent[]
      ) => {
        const state = getRunningState();
        if (!state) return;
        const nextEvents = updater(state.runtimeTimelineEvents);
        runningViewStatesRef.current.set(activeSessionId, {
          ...state,
          runtimeTimelineEvents: nextEvents,
        });
        if (isRunVisible()) setRuntimeTimelineEvents(nextEvents);
      };
      const updateRunningPlanSteps = (updater: (prev: PlanStep[]) => PlanStep[]) => {
        const state = getRunningState();
        if (!state) return;
        const nextSteps = updater(state.planSteps);
        runningViewStatesRef.current.set(activeSessionId, { ...state, planSteps: nextSteps });
        if (isRunVisible()) setPlanSteps(nextSteps);
      };
      const updateRunningPlanProgress = (nextProgress: PlanProgress | null) => {
        const state = getRunningState();
        if (!state) return;
        runningViewStatesRef.current.set(activeSessionId, { ...state, planProgress: nextProgress });
        if (isRunVisible()) setPlanProgress(nextProgress);
      };
      const updateRunningUsage = (updater: (prev: UsageInfo) => UsageInfo) => {
        const state = getRunningState();
        if (!state) return;
        const nextUsage = updater(state.tokenUsage);
        runningViewStatesRef.current.set(activeSessionId, { ...state, tokenUsage: nextUsage });
        if (isRunVisible()) setTokenUsage(nextUsage);
      };
      const updateRunningContextTokens = (nextContextTokens: number) => {
        const state = getRunningState();
        if (!state) return;
        runningViewStatesRef.current.set(activeSessionId, {
          ...state,
          lastContextTokens: nextContextTokens,
        });
        if (isRunVisible()) setLastContextTokens(nextContextTokens);
      };
      const replaceRunningPlan = (nextPlan: {
        planSteps: PlanStep[];
        planProgress: PlanProgress | null;
      }) => {
        const state = getRunningState();
        if (!state) return;
        runningViewStatesRef.current.set(activeSessionId, {
          ...state,
          planSteps: nextPlan.planSteps,
          planProgress: nextPlan.planProgress,
        });
        if (isRunVisible()) {
          setPlanSteps(nextPlan.planSteps);
          setPlanProgress(nextPlan.planProgress);
        }
      };

      let currentContent = "";
      let pendingConnectorAuthPayload: FeishuAuthOpenPayload | null = null;
      let blockedForInteraction = false;
      let streamHadError = false;
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

      const callbacks: ChatStreamCallbacks = {
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
                    blockedForInteraction = true;
                    onSessionAttention?.(activeSessionId, "completed");
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
              created_at: new Date().toISOString(),
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
          updateRunningTimelineEvents((prev) =>
            upsertRuntimeTimelineEvent(prev, event, {
              id:
                event.type === "codex_turn_diff_updated"
                  ? `runtime-${requestId}-workspace-diff`
                  : `runtime-${requestId}-${prev.length}`,
              createdAt,
            })
          );
        },
        onChangedFiles: (files) => {
          if (isStaleRequest()) return;
          updateRunningMessages((prev) => {
            const msgs = [...prev];
            const last = msgs[msgs.length - 1];
            if (last?.role === "assistant") {
              msgs[msgs.length - 1] = { ...last, changedFiles: files };
            }
            return msgs;
          });
        },
        onAgentStop: (data) => {
          if (isStaleRequest()) return;
          updateRunningMessages((prev) => {
            const msgs = [...prev];
            const last = msgs[msgs.length - 1];
            if (last.role !== "assistant") return msgs;

            if (data.stop_reason === "ask_user" && typeof data.metadata.question === "string") {
              blockedForInteraction = true;
              onSessionAttention?.(activeSessionId, "completed");
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
              blockedForInteraction = true;
              onSessionAttention?.(activeSessionId, "needs_input");
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
          blockedForInteraction = true;
          onSessionAttention?.(activeSessionId, "needs_input");
          clearSessionRunning(activeSessionId);
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
            cached_input_tokens: (prev.cached_input_tokens ?? 0) + (usage.cached_input_tokens ?? 0),
            reasoning_output_tokens:
              (prev.reasoning_output_tokens ?? 0) + (usage.reasoning_output_tokens ?? 0),
            model_context_window: usage.model_context_window ?? prev.model_context_window,
          }));
          const ctx = usage.last_prompt_tokens ?? usage.prompt_tokens;
          if (ctx > 0) updateRunningContextTokens(ctx);
        },
        onConnectorAuth: (event) => {
          if (isStaleRequest()) return;
          const nextPayload = connectorAuthPollPayloadFromEvent(event);
          if (nextPayload) {
            pendingConnectorAuthPayload = nextPayload;
            if (connectorAuthRequiresSessionAttention(event)) {
              onSessionAttention?.(activeSessionId, "needs_input");
            }
          }
        },
        onComplete: () => {
          if (isStaleRequest()) return;
          if (streamHadError) return;
          abortControllersRef.current.delete(activeSessionId);
          if (
            pendingConnectorAuthPayload &&
            beginConnectorAuthPollRef.current &&
            shouldStartConnectorAuthPoll(pendingConnectorAuthPayload)
          ) {
            const baseMessages =
              runningViewStatesRef.current.get(activeSessionId)?.messages || initialMessages;
            beginConnectorAuthPollRef.current?.(pendingConnectorAuthPayload, {
              baseMessages,
              allowWhileGenerating: true,
              openAuthWindow: shouldAutoOpenConnectorAuthWindow(
                pendingConnectorAuthPayload.connector
              ),
            });
            return;
          }
          if (!blockedForInteraction) {
            onSessionAttention?.(activeSessionId, "completed");
          }
          clearSessionRunning(activeSessionId);
          const nextPlan = clearPlanState();
          replaceRunningPlan(nextPlan);
          runningViewStatesRef.current.delete(activeSessionId);
          if (isRunVisible()) setInputFocusToken((prev) => bumpInputFocusToken(prev));
          void refreshSessionDetails(activeSessionId, { refreshList: false });
          void getSessionActions().loadSessions({ showLoading: false });
          for (const delayMs of SESSION_TITLE_REFRESH_DELAYS_MS) {
            window.setTimeout(() => {
              void getSessionActions().loadSessions({ showLoading: false });
            }, delayMs);
          }
          onWorkspaceRefresh();
        },
        onError: (err) => {
          if (isStaleRequest()) return;
          streamHadError = true;
          abortControllersRef.current.delete(activeSessionId);
          if (err instanceof AuthError) {
            handleAuthExpired();
            clearSessionRunning(activeSessionId);
            if (isRunVisible()) setInputFocusToken((prev) => bumpInputFocusToken(prev));
            return;
          }
          console.error("Chat error:", err);
          onSessionAttention?.(activeSessionId, "error");
          clearSessionRunning(activeSessionId);
          if (isRunVisible()) setInputFocusToken((prev) => bumpInputFocusToken(prev));
          updateRunningMessages((prev) => {
            const msgs = [...prev];
            const last = msgs[msgs.length - 1];
            if (last.role === "assistant" && !last.content) {
              last.content = chatErrorContent(err);
            }
            return msgs;
          });
          const nextPlan = clearPlanState();
          replaceRunningPlan(nextPlan);
          runningViewStatesRef.current.delete(activeSessionId);
          void getSessionActions().loadSessions({ showLoading: false });
          onWorkspaceRefresh();
        },
      };

      if (options.controlAction) {
        await sendSessionControlAction(
          activeSessionId,
          text,
          options.controlAction,
          selectedModel,
          callbacks,
          { signal: abortController.signal }
        );
      } else {
        const manualRequiredSkillIds = selectedRequiredSkillId ? [selectedRequiredSkillId] : [];

        await sendChatMessage(activeSessionId, text, selectedModel, callbacks, {
          signal: abortController.signal,
          files: filesForSend,
          requiredSkillIds:
            manualRequiredSkillIds.length > 0 ? manualRequiredSkillIds : undefined,
        });
        if (selectedRequiredSkillId) setSelectedRequiredSkillId(null);
      }
    },
    [
      getSessionActions,
      handleAuthExpired,
      handleClearContext,
      handleCompactContext,
      input,
      lastContextTokens,
      markSessionRunning,
      onSessionAttention,
      messages,
      onWorkspaceRefresh,
      pendingFiles,
      pendingLocalImages,
      selectedRequiredSkillId,
      runtimeTimelineEvents,
      selectedModel,
      refreshSessionDetails,
      clearSessionRunning,
      clearPendingLocalImages,
      planProgress,
      planSteps,
      tokenUsage,
    ]
  );

  const handleSessionControlAction = useCallback(
    async (action: SessionControlAction, label: string) => {
      await handleSendMessage(label, { controlAction: action, newSession: true });
    },
    [handleSendMessage]
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
      const sessionId = getSessionActions().getSessionId();
      if (!sessionId) return;
      if (isSessionRunning(sessionId)) return;

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
    [getSessionActions, handleAuthExpired, handleSendMessage, isSessionRunning]
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
    (
      { connector, url, popup, mode }: FeishuAuthOpenPayload,
      options: ConnectorAuthPollOptions = {}
    ) => {
      if (!shouldStartConnectorAuthPoll({ connector, tag: "auth", url, popup, mode })) return;
      const targetConnector = connector === "google_workspace" ? "google_workspace" : "feishu";
      const activeSessionId = getSessionActions().getSessionId();
      if (!activeSessionId) return;
      if (isSessionRunning(activeSessionId) && !options.allowWhileGenerating) return;

      clearConnectorAuthPoll();
      const shouldOpenAuthWindow = options.openAuthWindow !== false || Boolean(popup);
      if (shouldOpenAuthWindow) {
        navigateFeishuAuthPopup(url, popup);
      }
      startFeishuAuthWaiting(url, targetConnector);
      const pollId = connectorAuthPollIdRef.current + 1;
      connectorAuthPollIdRef.current = pollId;
      const pollStartedAt = Date.now();
      const baseMessages = options.baseMessages || messages;
      const initialMessages: Message[] = [
        ...baseMessages,
        {
          id: `${targetConnector}-auth-${Date.now()}-assistant`,
          role: "assistant",
          content: "",
          toolCalls: [],
          created_at: new Date().toISOString(),
        },
      ];
      runningViewStatesRef.current.set(activeSessionId, {
        sessionId: activeSessionId,
        messages: initialMessages,
        runtimeTimelineEvents,
        pendingFiles: [],
        tokenUsage,
        lastContextTokens,
        planSteps,
        planProgress,
      });
      markSessionRunning(activeSessionId);
      onSessionAttention?.(activeSessionId, "needs_input");
      setMessages(initialMessages);

      const isStalePoll = () => connectorAuthPollIdRef.current !== pollId;
      const isRunVisible = () => getSessionActions().getSessionId() === activeSessionId;
      const getRunningState = () => {
        return runningViewStatesRef.current.get(activeSessionId) || null;
      };
      const updateRunningMessages = (updater: (prev: Message[]) => Message[]) => {
        const state = getRunningState();
        if (!state) return;
        const nextMessages = updater(state.messages);
        runningViewStatesRef.current.set(activeSessionId, { ...state, messages: nextMessages });
        if (isRunVisible()) setMessages(nextMessages);
      };
      const updateRunningTimelineEvents = (
        updater: (prev: WorkbenchTimelineEvent[]) => WorkbenchTimelineEvent[]
      ) => {
        const state = getRunningState();
        if (!state) return;
        const nextEvents = updater(state.runtimeTimelineEvents);
        runningViewStatesRef.current.set(activeSessionId, {
          ...state,
          runtimeTimelineEvents: nextEvents,
        });
        if (isRunVisible()) setRuntimeTimelineEvents(nextEvents);
      };
      const updateRunningPlanSteps = (updater: (prev: PlanStep[]) => PlanStep[]) => {
        const state = getRunningState();
        if (!state) return;
        const nextSteps = updater(state.planSteps);
        runningViewStatesRef.current.set(activeSessionId, { ...state, planSteps: nextSteps });
        if (isRunVisible()) setPlanSteps(nextSteps);
      };
      const updateRunningPlanProgress = (nextProgress: PlanProgress | null) => {
        const state = getRunningState();
        if (!state) return;
        runningViewStatesRef.current.set(activeSessionId, { ...state, planProgress: nextProgress });
        if (isRunVisible()) setPlanProgress(nextProgress);
      };
      const updateRunningUsage = (updater: (prev: UsageInfo) => UsageInfo) => {
        const state = getRunningState();
        if (!state) return;
        const nextUsage = updater(state.tokenUsage);
        runningViewStatesRef.current.set(activeSessionId, { ...state, tokenUsage: nextUsage });
        if (isRunVisible()) setTokenUsage(nextUsage);
      };
      const updateRunningContextTokens = (nextContextTokens: number) => {
        const state = getRunningState();
        if (!state) return;
        runningViewStatesRef.current.set(activeSessionId, {
          ...state,
          lastContextTokens: nextContextTokens,
        });
        if (isRunVisible()) setLastContextTokens(nextContextTokens);
      };
      const replaceRunningPlan = (nextPlan: {
        planSteps: PlanStep[];
        planProgress: PlanProgress | null;
      }) => {
        const state = getRunningState();
        if (!state) return;
        runningViewStatesRef.current.set(activeSessionId, {
          ...state,
          planSteps: nextPlan.planSteps,
          planProgress: nextPlan.planProgress,
        });
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
            created_at: new Date().toISOString(),
          },
        ]);
      };
      const setLastAssistantMessage = (content: string) => {
        renderedPollContent = true;
        updateRunningMessages((prev) => {
          const msgs = [...prev];
          const last = msgs[msgs.length - 1];
          if (last?.role === "assistant") {
            last.content = content;
            last.toolCalls = last.toolCalls || [];
            return msgs;
          }
          return [
            ...msgs,
            {
              id: Date.now() + Math.random(),
              role: "assistant",
              content,
              toolCalls: [],
              created_at: new Date().toISOString(),
            },
          ];
        });
      };
      const cancelPendingConnectorAuth = async () => {
        try {
          await cancelSessionConnectorAuth(activeSessionId);
        } catch (error) {
          if (error instanceof AuthError) {
            handleAuthExpired();
          }
        }
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
          runningViewStatesRef.current.delete(activeSessionId);
        }
        const refreshed = await refreshSession();
        if (!refreshed) return;
        if (isStalePoll()) return;
        runningViewStatesRef.current.delete(activeSessionId);
        clearSessionRunning(activeSessionId);
        setInputFocusToken((prev) => bumpInputFocusToken(prev));
        await getSessionActions().loadSessions({ showLoading: false });
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
                created_at: new Date().toISOString(),
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
              updateRunningTimelineEvents((prev) =>
                upsertRuntimeTimelineEvent(prev, event, {
                  id:
                    event.type === "codex_turn_diff_updated"
                      ? `runtime-${targetConnector}-${pollId}-workspace-diff`
                      : `runtime-${targetConnector}-${pollId}-${prev.length}`,
                  createdAt,
                })
              );
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
                onSessionAttention?.(activeSessionId, null);
              }
              const pollPayload = connectorAuthPollPayloadFromEvent(event);
              if (pollPayload?.connector === targetConnector) {
                if (shouldOpenAuthWindow) {
                  navigateFeishuAuthPopup(pollPayload.url);
                }
                startFeishuAuthWaiting(pollPayload.url, targetConnector);
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
          onSessionAttention?.(activeSessionId, "error");
          await cancelPendingConnectorAuth();
          if (isStalePoll()) return;
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
        const elapsedMs = Date.now() - pollStartedAt;
        const waitingForAuth = shouldContinueConnectorAuthPoll(
          lastEvent,
          targetConnector,
          0,
          Number.POSITIVE_INFINITY
        );
        if (waitingForAuth && elapsedMs >= CONNECTOR_AUTH_POLL_TIMEOUT_MS) {
          setLastAssistantMessage(
            targetConnector === "google_workspace"
              ? t("connectors.googleAuthTimeout")
              : t("connectors.feishuAuthTimeout")
          );
          await cancelPendingConnectorAuth();
          if (isStalePoll()) return;
          await finishPoll();
          return;
        }
        const shouldContinue = shouldContinueConnectorAuthPoll(
          lastEvent,
          targetConnector,
          elapsedMs
        );
        if (shouldContinue) {
          connectorAuthPollTimerRef.current = window.setTimeout(
            runPoll,
            CONNECTOR_AUTH_POLL_INTERVAL_MS
          );
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
      clearSessionRunning,
      getSessionActions,
      handleAuthExpired,
      isSessionRunning,
      lastContextTokens,
      markSessionRunning,
      onSessionAttention,
      messages,
      navigateFeishuAuthPopup,
      onWorkspaceRefresh,
      runtimeTimelineEvents,
      selectedModel,
      startFeishuAuthWaiting,
      t,
      planProgress,
      planSteps,
      tokenUsage,
    ]
  );

  const handleFeishuAuthOpen = useCallback(
    (payload: FeishuAuthOpenPayload) => {
      if (!shouldStartConnectorAuthPoll(payload)) return;
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
  const selectedSessionId = getSessionActions().getSessionId();
  const currentSessionRuntimeStatus = isSessionRunning(selectedSessionId)
    ? ("running" as const)
    : pendingInteractionMessage?.permissionRequest
      ? ("waiting_for_approval" as const)
      : pendingInteractionMessage?.askUser
        ? ("waiting_for_user" as const)
        : null;
  const timelineEvents = useMemo(
    () =>
      mergeTimelineEvents(
        messagesToTimelineEvents(messages, {
          showToolActivity: true,
          maxToolActivityItems: 4,
        }),
        runtimeTimelineEvents
      ),
    [messages, runtimeTimelineEvents]
  );
  const changedFiles = useMemo(() => extractChangedFilePaths(messages), [messages]);

  return {
    input,
    setInput,
    messages,
    pendingFiles,
    pendingLocalImages,
    isUploadingFiles,
    attachmentUploadError,
    isGenerating,
    runningSessionId,
    runningSessionIds,
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
    availableSkills,
    isLoadingSkills,
    selectedRequiredSkillId,
    resetSessionView,
    resetCurrentContextView,
    abortRunAndResetSessionView,
    applySessionDetails,
    handleStop,
    handleClearContext,
    handleCompactContext,
    handleAttachFiles,
    handleRemovePendingFile,
    handleAddPendingImages,
    handleRemovePendingLocalImage,
    handleSendMessage,
    handleSessionControlAction,
    handleQuickReply,
    handlePermissionResolve,
    handleFeishuAuthOpen,
    loadAvailableSkills,
    setSelectedRequiredSkillId,
  };
}
