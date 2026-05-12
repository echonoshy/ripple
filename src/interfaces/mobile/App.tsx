import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { createRippleClient, RippleApiError, RippleAuthError } from "./src/api/rippleClient";
import { ModelInfo, PermissionAction, SessionDetail, SessionSummary, ToolCallUpdate } from "./src/api/types";
import { ChatMessageItem } from "./src/chat/types";
import { ChatInput } from "./src/components/ChatInput";
import { ChatMessage } from "./src/components/ChatMessage";
import { DEFAULT_SETTINGS, MobileSettings, createSecureSettingsStore, normalizeSettings } from "./src/storage/settings";

export default function App() {
  const settingsStore = useMemo(() => createSecureSettingsStore(), []);
  const scrollRef = useRef<ScrollView>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [settings, setSettings] = useState<MobileSettings>(DEFAULT_SETTINGS);
  const [settingsDraft, setSettingsDraft] = useState<MobileSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [input, setInput] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const client = useMemo(
    () =>
      createRippleClient({
        serverUrl: settings.serverUrl,
        apiKey: settings.apiKey,
        userId: settings.userId,
      }),
    [settings],
  );

  const reportError = useCallback((error: unknown) => {
    if (error instanceof RippleAuthError) {
      setConnectionError("Authentication failed. Check the API key in Settings.");
      Alert.alert("Authentication failed", "Check the API key in Settings.");
      return;
    }
    if (error instanceof RippleApiError) {
      setConnectionError(error.message);
      return;
    }
    if (error instanceof Error) {
      setConnectionError(error.message);
      return;
    }
    setConnectionError(String(error));
  }, []);

  useEffect(() => {
    settingsStore
      .load()
      .then((loaded) => {
        setSettings(loaded);
        setSettingsDraft(loaded);
        setSettingsOpen(!loaded.serverUrl);
      })
      .finally(() => setSettingsLoaded(true));
  }, [settingsStore]);

  const refresh = useCallback(async () => {
    if (!settings.serverUrl) return;
    setLoading(true);
    setConnectionError(null);
    try {
      const [loadedModels, loadedSessions] = await Promise.all([client.listModels(), client.listSessions()]);
      setModels(loadedModels);
      setSessions(loadedSessions);
      if (loadedModels.length > 0 && !loadedModels.some((model) => model.id === settings.model)) {
        setSettings((current) => ({ ...current, model: loadedModels[0].id }));
      }
    } catch (error) {
      reportError(error);
    } finally {
      setLoading(false);
    }
  }, [client, reportError, settings.model, settings.serverUrl]);

  useEffect(() => {
    if (settingsLoaded && settings.serverUrl) {
      refresh();
    }
  }, [refresh, settingsLoaded, settings.serverUrl]);

  useEffect(() => {
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(timer);
  }, [messages]);

  const saveSettings = useCallback(async () => {
    const normalized = normalizeSettings(settingsDraft);
    await settingsStore.save(normalized);
    abortRef.current?.abort();
    setSettings(normalized);
    setSessionId(null);
    setMessages([]);
    setSessions([]);
    setSettingsOpen(false);
  }, [settingsDraft, settingsStore]);

  const ensureSession = useCallback(async (): Promise<string> => {
    if (sessionId) return sessionId;
    const created = await client.createSession(settings.model);
    setSessionId(created);
    await refresh();
    return created;
  }, [client, refresh, sessionId, settings.model]);

  const updateLastAssistant = useCallback((updater: (message: ChatMessageItem) => ChatMessageItem) => {
    setMessages((current) => {
      const next = [...current];
      for (let index = next.length - 1; index >= 0; index -= 1) {
        if (next[index].role === "assistant") {
          next[index] = updater(next[index]);
          break;
        }
      }
      return next;
    });
  }, []);

  const sendMessage = useCallback(
    async (overrideText?: string) => {
      const content = (overrideText ?? input).trim();
      if (!content || isGenerating || !settings.serverUrl) return;

      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      setInput("");
      setIsGenerating(true);
      setConnectionError(null);

      try {
        const activeSessionId = await ensureSession();
        const userMessage: ChatMessageItem = {
          id: `${Date.now()}-user`,
          role: "user",
          content,
          createdAt: new Date().toISOString(),
        };
        const assistantMessage: ChatMessageItem = {
          id: `${Date.now()}-assistant`,
          role: "assistant",
          content: "",
          toolCalls: [],
        };
        setMessages((current) => [...current, userMessage, assistantMessage]);

        let accumulated = "";
        await client.streamChat(
          {
            sessionId: activeSessionId,
            content,
            model: settings.model,
            thinking: settings.thinkingEnabled,
            signal: controller.signal,
          },
          {
            onMessageDelta: (delta) => {
              accumulated += delta;
              updateLastAssistant((message) => ({ ...message, content: accumulated }));
            },
            onToolCall: (toolCall) => {
              updateLastAssistant((message) => ({
                ...message,
                toolCalls: upsertToolCall(message.toolCalls ?? [], toolCall),
              }));
            },
            onToolResult: (toolUseId, result, isError) => {
              updateLastAssistant((message) => ({
                ...message,
                toolCalls: (message.toolCalls ?? []).map((tool) =>
                  tool.id === toolUseId ? { ...tool, result, status: isError ? "error" : "success" } : tool,
                ),
              }));
            },
            onAgentStop: (stop) => {
              if (stop.stop_reason === "ask_user" && typeof stop.metadata.question === "string") {
                updateLastAssistant((message) => ({
                  ...message,
                  askUser: {
                    question: stop.metadata.question as string,
                    options: Array.isArray(stop.metadata.options)
                      ? stop.metadata.options.filter((option): option is string => typeof option === "string")
                      : [],
                  },
                }));
              }
            },
            onPermissionRequest: (request) => {
              updateLastAssistant((message) => ({ ...message, permissionRequest: request }));
            },
            onComplete: () => {
              setIsGenerating(false);
              abortRef.current = null;
              refresh();
            },
            onError: (error) => {
              setIsGenerating(false);
              abortRef.current = null;
              reportError(error);
              updateLastAssistant((message) =>
                message.content ? message : { ...message, content: "Unable to connect to Ripple Server." },
              );
            },
          },
        );
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          reportError(error);
        }
        setIsGenerating(false);
      }
    },
    [client, ensureSession, input, isGenerating, refresh, reportError, settings, updateLastAssistant],
  );

  const stopGeneration = useCallback(async () => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (sessionId) {
      await client.stopSession(sessionId).catch(() => false);
    }
    setIsGenerating(false);
  }, [client, sessionId]);

  const switchSession = useCallback(
    async (id: string) => {
      if (isGenerating) return;
      setSessionsOpen(false);
      setLoading(true);
      try {
        const detail = await client.getSession(id);
        setSessionId(detail.session_id);
        setMessages(mapBackendMessages(detail));
      } catch (error) {
        reportError(error);
      } finally {
        setLoading(false);
      }
    },
    [client, isGenerating, reportError],
  );

  const newSession = useCallback(async () => {
    if (isGenerating) return;
    setSessionId(null);
    setMessages([]);
    setSessionsOpen(false);
  }, [isGenerating]);

  const resolvePermission = useCallback(
    async (action: PermissionAction) => {
      if (!sessionId || isGenerating) return;
      try {
        await client.resolvePermission(sessionId, action);
        const reply =
          action === "deny"
            ? "Denied."
            : action === "always"
              ? "Approved for this session. Please proceed."
              : "Approved. Please proceed.";
        await sendMessage(reply);
      } catch (error) {
        reportError(error);
      }
    },
    [client, isGenerating, reportError, sendMessage, sessionId],
  );

  if (!settingsLoaded) {
    return (
      <SafeAreaView style={styles.loadingScreen}>
        <ActivityIndicator color="#111" />
        <Text style={styles.loadingText}>Loading Ripple...</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView style={styles.app} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.header}>
          <Pressable style={styles.headerButton} onPress={() => setSessionsOpen(true)}>
            <Text style={styles.headerButtonText}>Sessions</Text>
          </Pressable>
          <View style={styles.titleBlock}>
            <Text style={styles.title}>Ripple</Text>
            <Text style={styles.subtitle}>{sessionId ? sessionId : settings.userId}</Text>
          </View>
          <Pressable
            style={styles.headerButton}
            onPress={() => {
              setSettingsDraft(settings);
              setSettingsOpen(true);
            }}
          >
            <Text style={styles.headerButtonText}>Settings</Text>
          </Pressable>
        </View>

        {connectionError ? <Text style={styles.errorBanner}>{connectionError}</Text> : null}

        <ScrollView ref={scrollRef} style={styles.messages} contentContainerStyle={styles.messagesContent}>
          {messages.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyTitle}>Ready</Text>
              <Text style={styles.emptyText}>Connect to your Ripple Server and start a mobile session.</Text>
            </View>
          ) : (
            messages.map((message, index) => (
              <ChatMessage
                key={message.id}
                message={message}
                isLast={index === messages.length - 1}
                isGenerating={isGenerating}
                onQuickReply={sendMessage}
                onPermissionResolve={resolvePermission}
              />
            ))
          )}
          {loading ? <ActivityIndicator color="#111" style={styles.inlineLoader} /> : null}
        </ScrollView>

        <ChatInput value={input} onChange={setInput} onSend={() => sendMessage()} onStop={stopGeneration} isGenerating={isGenerating} />
      </KeyboardAvoidingView>

      <SettingsModal
        visible={settingsOpen}
        settingsDraft={settingsDraft}
        models={models}
        onChange={setSettingsDraft}
        onClose={() => setSettingsOpen(false)}
        onSave={saveSettings}
      />
      <SessionsModal
        visible={sessionsOpen}
        sessions={sessions}
        currentSessionId={sessionId}
        onClose={() => setSessionsOpen(false)}
        onRefresh={refresh}
        onNew={newSession}
        onSelect={switchSession}
      />
    </SafeAreaView>
  );
}

function upsertToolCall(existing: ToolCallUpdate[], nextTool: ToolCallUpdate): ToolCallUpdate[] {
  const found = existing.some((tool) => tool.id === nextTool.id);
  if (!found) return [...existing, nextTool];
  return existing.map((tool) => (tool.id === nextTool.id ? nextTool : tool));
}

function mapBackendMessages(detail: SessionDetail): ChatMessageItem[] {
  const mapped: ChatMessageItem[] = [];
  let counter = 0;

  for (const raw of detail.messages) {
    const type = typeof raw.type === "string" ? raw.type : "";
    if (type === "user") {
      const content = getInternalContent(raw);
      const text = extractText(content);
      if (text) {
        mapped.push({
          id: `history-${counter++}`,
          role: "user",
          content: text,
          createdAt: typeof raw.created_at === "string" ? raw.created_at : undefined,
        });
      }
      attachToolResults(mapped, content);
    }

    if (type === "assistant") {
      const content = getInternalContent(raw);
      mapped.push({
        id: `history-${counter++}`,
        role: "assistant",
        content: extractText(content),
        createdAt: typeof raw.created_at === "string" ? raw.created_at : undefined,
        toolCalls: content
          .filter((block) => block.type === "tool_use")
          .map((block) => ({
            id: typeof block.id === "string" ? block.id : `tool-${counter++}`,
            name: typeof block.name === "string" ? block.name : "unknown",
            arguments: typeof block.input === "object" && block.input !== null ? (block.input as Record<string, unknown>) : {},
            status: "success",
          })),
      });
    }
  }

  const lastAssistant = [...mapped].reverse().find((message) => message.role === "assistant");
  if (lastAssistant && detail.pending_question) {
    lastAssistant.askUser = {
      question: detail.pending_question,
      options: detail.pending_options ?? [],
    };
  }
  if (lastAssistant && detail.pending_permission_request) {
    lastAssistant.permissionRequest = detail.pending_permission_request;
  }

  return mapped;
}

function getInternalContent(message: Record<string, unknown>): Array<Record<string, unknown>> {
  const nested = message.message;
  if (typeof nested !== "object" || nested === null) return [];
  const content = (nested as { content?: unknown }).content;
  return Array.isArray(content) ? content.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null) : [];
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function attachToolResults(messages: ChatMessageItem[], content: Array<Record<string, unknown>>): void {
  for (const block of content) {
    if (block.type !== "tool_result") continue;
    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== "assistant" || !message.toolCalls) continue;
      message.toolCalls = message.toolCalls.map((tool) =>
        tool.id === toolUseId
          ? {
              ...tool,
              result: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? ""),
              status: block.is_error ? "error" : "success",
            }
          : tool,
      );
      break;
    }
  }
}

function SettingsModal({
  visible,
  settingsDraft,
  models,
  onChange,
  onClose,
  onSave,
}: {
  visible: boolean;
  settingsDraft: MobileSettings;
  models: ModelInfo[];
  onChange: (settings: MobileSettings) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <Modal animationType="slide" visible={visible} presentationStyle="pageSheet">
      <SafeAreaView style={styles.modal}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Settings</Text>
          <Pressable onPress={onClose} style={styles.smallButton}>
            <Text style={styles.smallButtonText}>Close</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.modalContent}>
          <LabeledInput
            label="Server URL"
            value={settingsDraft.serverUrl}
            placeholder="http://192.168.1.8:8810"
            onChangeText={(serverUrl) => onChange({ ...settingsDraft, serverUrl })}
          />
          <LabeledInput
            label="API Key"
            value={settingsDraft.apiKey}
            placeholder="Optional if server auth is disabled"
            secureTextEntry
            onChangeText={(apiKey) => onChange({ ...settingsDraft, apiKey })}
          />
          <LabeledInput
            label="User ID"
            value={settingsDraft.userId}
            placeholder="default"
            onChangeText={(userId) => onChange({ ...settingsDraft, userId })}
          />
          <LabeledInput
            label="Model"
            value={settingsDraft.model}
            placeholder="sonnet"
            onChangeText={(model) => onChange({ ...settingsDraft, model })}
          />
          {models.length > 0 ? (
            <View style={styles.modelGrid}>
              {models.map((model) => (
                <Pressable
                  key={model.id}
                  style={[styles.modelChip, settingsDraft.model === model.id && styles.modelChipActive]}
                  onPress={() => onChange({ ...settingsDraft, model: model.id })}
                >
                  <Text style={styles.modelChipText}>{model.id}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <Pressable
            style={styles.toggle}
            onPress={() => onChange({ ...settingsDraft, thinkingEnabled: !settingsDraft.thinkingEnabled })}
          >
            <Text style={styles.toggleText}>Thinking mode</Text>
            <Text style={styles.toggleState}>{settingsDraft.thinkingEnabled ? "On" : "Off"}</Text>
          </Pressable>
          <Pressable style={styles.saveButton} onPress={onSave}>
            <Text style={styles.saveButtonText}>Save and connect</Text>
          </Pressable>
          <Text style={styles.hint}>On a phone, use a LAN, Tailscale, or HTTPS URL. The phone cannot reach your laptop's localhost.</Text>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function SessionsModal({
  visible,
  sessions,
  currentSessionId,
  onClose,
  onRefresh,
  onNew,
  onSelect,
}: {
  visible: boolean;
  sessions: SessionSummary[];
  currentSessionId: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onNew: () => void;
  onSelect: (sessionId: string) => void;
}) {
  return (
    <Modal animationType="slide" visible={visible} presentationStyle="pageSheet">
      <SafeAreaView style={styles.modal}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Sessions</Text>
          <Pressable onPress={onClose} style={styles.smallButton}>
            <Text style={styles.smallButtonText}>Close</Text>
          </Pressable>
        </View>
        <View style={styles.sessionActions}>
          <Pressable style={styles.secondaryButton} onPress={onNew}>
            <Text style={styles.secondaryButtonText}>New session</Text>
          </Pressable>
          <Pressable style={styles.secondaryButton} onPress={onRefresh}>
            <Text style={styles.secondaryButtonText}>Refresh</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.modalContent}>
          {sessions.length === 0 ? (
            <Text style={styles.hint}>No sessions yet.</Text>
          ) : (
            sessions.map((session) => (
              <Pressable
                key={session.session_id}
                style={[styles.sessionRow, currentSessionId === session.session_id && styles.sessionRowActive]}
                onPress={() => onSelect(session.session_id)}
              >
                <Text style={styles.sessionTitle}>{session.title || session.session_id}</Text>
                <Text style={styles.sessionMeta}>
                  {session.message_count} messages · {formatSessionTime(session.last_active)}
                </Text>
              </Pressable>
            ))
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function LabeledInput({
  label,
  value,
  placeholder,
  secureTextEntry,
  onChangeText,
}: {
  label: string;
  value: string;
  placeholder?: string;
  secureTextEntry?: boolean;
  onChangeText: (value: string) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        placeholder={placeholder}
        placeholderTextColor="#777"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secureTextEntry}
        onChangeText={onChangeText}
        style={styles.fieldInput}
      />
    </View>
  );
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: "#fdfbf7",
    flex: 1,
  },
  app: {
    flex: 1,
  },
  loadingScreen: {
    alignItems: "center",
    backgroundColor: "#fdfbf7",
    flex: 1,
    justifyContent: "center",
  },
  loadingText: {
    color: "#111",
    fontSize: 14,
    fontWeight: "800",
    marginTop: 10,
  },
  header: {
    alignItems: "center",
    backgroundColor: "#ffd83d",
    borderBottomColor: "#111",
    borderBottomWidth: 2,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  headerButton: {
    backgroundColor: "#fff",
    borderColor: "#111",
    borderWidth: 2,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  headerButtonText: {
    color: "#111",
    fontSize: 12,
    fontWeight: "900",
  },
  titleBlock: {
    alignItems: "center",
    flex: 1,
    paddingHorizontal: 8,
  },
  title: {
    color: "#111",
    fontSize: 20,
    fontWeight: "900",
  },
  subtitle: {
    color: "#555",
    fontSize: 11,
    fontWeight: "700",
    maxWidth: 180,
  },
  errorBanner: {
    backgroundColor: "#ffb1c5",
    borderBottomColor: "#111",
    borderBottomWidth: 2,
    color: "#111",
    fontSize: 12,
    fontWeight: "800",
    padding: 10,
  },
  messages: {
    flex: 1,
  },
  messagesContent: {
    padding: 14,
    paddingBottom: 24,
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 360,
    padding: 24,
  },
  emptyTitle: {
    color: "#111",
    fontSize: 28,
    fontWeight: "900",
  },
  emptyText: {
    color: "#555",
    fontSize: 15,
    lineHeight: 22,
    marginTop: 8,
    textAlign: "center",
  },
  inlineLoader: {
    marginVertical: 18,
  },
  modal: {
    backgroundColor: "#fdfbf7",
    flex: 1,
  },
  modalHeader: {
    alignItems: "center",
    backgroundColor: "#c4a1ff",
    borderBottomColor: "#111",
    borderBottomWidth: 2,
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 14,
  },
  modalTitle: {
    color: "#111",
    fontSize: 18,
    fontWeight: "900",
  },
  smallButton: {
    backgroundColor: "#fff",
    borderColor: "#111",
    borderWidth: 2,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  smallButtonText: {
    color: "#111",
    fontSize: 12,
    fontWeight: "900",
  },
  modalContent: {
    padding: 16,
  },
  field: {
    marginBottom: 14,
  },
  fieldLabel: {
    color: "#555",
    fontSize: 11,
    fontWeight: "900",
    marginBottom: 6,
    textTransform: "uppercase",
  },
  fieldInput: {
    backgroundColor: "#fff",
    borderColor: "#111",
    borderWidth: 2,
    color: "#111",
    fontSize: 15,
    padding: 12,
  },
  modelGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 14,
  },
  modelChip: {
    backgroundColor: "#fff",
    borderColor: "#111",
    borderWidth: 2,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  modelChipActive: {
    backgroundColor: "#ffd83d",
  },
  modelChipText: {
    color: "#111",
    fontSize: 12,
    fontWeight: "900",
  },
  toggle: {
    alignItems: "center",
    backgroundColor: "#fff",
    borderColor: "#111",
    borderWidth: 2,
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 16,
    padding: 12,
  },
  toggleText: {
    color: "#111",
    fontSize: 15,
    fontWeight: "800",
  },
  toggleState: {
    color: "#111",
    fontSize: 14,
    fontWeight: "900",
  },
  saveButton: {
    alignItems: "center",
    backgroundColor: "#ff4911",
    borderColor: "#111",
    borderWidth: 2,
    padding: 14,
  },
  saveButtonText: {
    color: "#111",
    fontSize: 15,
    fontWeight: "900",
  },
  hint: {
    color: "#555",
    fontSize: 13,
    lineHeight: 20,
    marginTop: 14,
  },
  sessionActions: {
    flexDirection: "row",
    gap: 10,
    padding: 14,
  },
  secondaryButton: {
    backgroundColor: "#fff",
    borderColor: "#111",
    borderWidth: 2,
    flex: 1,
    padding: 12,
  },
  secondaryButtonText: {
    color: "#111",
    fontSize: 13,
    fontWeight: "900",
    textAlign: "center",
  },
  sessionRow: {
    backgroundColor: "#fff",
    borderColor: "#111",
    borderWidth: 2,
    marginBottom: 10,
    padding: 12,
  },
  sessionRowActive: {
    backgroundColor: "#ffd83d",
  },
  sessionTitle: {
    color: "#111",
    fontSize: 14,
    fontWeight: "900",
  },
  sessionMeta: {
    color: "#555",
    fontSize: 12,
    fontWeight: "700",
    marginTop: 5,
  },
});
