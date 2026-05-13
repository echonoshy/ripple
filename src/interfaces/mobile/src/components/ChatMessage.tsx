import { Pressable, StyleSheet, Text, View } from "react-native";

import { PermissionAction } from "../api/types";
import { ChatMessageItem } from "../chat/types";
import { MarkdownText } from "./MarkdownText";
import { PermissionCard } from "./PermissionCard";
import { ToolCallSummary } from "./ToolCallSummary";

interface ChatMessageProps {
  message: ChatMessageItem;
  isLast: boolean;
  isGenerating: boolean;
  onQuickReply: (reply: string) => void;
  onPermissionResolve: (action: PermissionAction) => void;
}

export function ChatMessage({
  message,
  isLast,
  isGenerating,
  onQuickReply,
  onPermissionResolve,
}: ChatMessageProps) {
  const isUser = message.role === "user";
  const showPrompts = isLast && !isGenerating && !isUser;

  return (
    <View style={[styles.row, isUser && styles.userRow]}>
      <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble, !isUser && styles.assistantWidth]}>
        <Text style={styles.label}>{isUser ? "You" : "Ripple"}</Text>
        {message.content ? (
          isUser ? (
            <Text selectable style={styles.content}>
              {message.content}
            </Text>
          ) : (
            <MarkdownText value={message.content} />
          )
        ) : null}
        {!message.content && !isUser && isGenerating ? <Text style={styles.thinking}>Thinking...</Text> : null}
        {message.toolCalls ? <ToolCallSummary toolCalls={message.toolCalls} autoExpand={isGenerating && !isUser} /> : null}
        {showPrompts && message.askUser ? (
          <View style={styles.askBox}>
            <Text selectable style={styles.askTitle}>
              {message.askUser.question}
            </Text>
            {message.askUser.options.map((option) => (
              <Pressable key={option} style={styles.option} onPress={() => onQuickReply(option)}>
                <Text style={styles.optionText}>{option}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {showPrompts && message.permissionRequest ? (
          <PermissionCard request={message.permissionRequest} onResolve={onPermissionResolve} />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: "flex-start",
    marginBottom: 9,
    width: "100%",
  },
  userRow: {
    alignItems: "flex-end",
  },
  bubble: {
    borderColor: "#111",
    borderWidth: 2,
    maxWidth: "95%",
    minWidth: 0,
    padding: 9,
    shadowColor: "#111",
    shadowOffset: { width: 2, height: 2 },
    shadowOpacity: 1,
    shadowRadius: 0,
  },
  assistantBubble: {
    backgroundColor: "#fff",
  },
  assistantWidth: {
    width: "95%",
  },
  userBubble: {
    backgroundColor: "#d8e8ff",
  },
  label: {
    color: "#666",
    fontSize: 9,
    fontWeight: "900",
    letterSpacing: 0.5,
    marginBottom: 4,
    textTransform: "uppercase",
  },
  content: {
    color: "#111",
    fontSize: 13,
    lineHeight: 19,
  },
  thinking: {
    color: "#555",
    fontSize: 13,
    fontWeight: "700",
  },
  askBox: {
    backgroundColor: "#fff7ce",
    borderColor: "#111",
    borderWidth: 2,
    marginTop: 8,
    padding: 8,
  },
  askTitle: {
    color: "#111",
    fontSize: 12,
    fontWeight: "800",
    marginBottom: 6,
  },
  option: {
    backgroundColor: "#fff",
    borderColor: "#111",
    borderWidth: 2,
    marginTop: 6,
    padding: 8,
  },
  optionText: {
    color: "#111",
    fontSize: 12,
    fontWeight: "800",
  },
});
