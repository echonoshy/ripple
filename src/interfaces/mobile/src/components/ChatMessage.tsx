import { Pressable, StyleSheet, Text, View } from "react-native";

import { PermissionAction } from "../api/types";
import { ChatMessageItem } from "../chat/types";
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
      <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}>
        <Text style={styles.label}>{isUser ? "You" : "Ripple"}</Text>
        {message.content ? <Text style={styles.content}>{message.content}</Text> : null}
        {!message.content && !isUser && isGenerating ? <Text style={styles.thinking}>Thinking...</Text> : null}
        {message.toolCalls ? <ToolCallSummary toolCalls={message.toolCalls} /> : null}
        {showPrompts && message.askUser ? (
          <View style={styles.askBox}>
            <Text style={styles.askTitle}>{message.askUser.question}</Text>
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
    marginBottom: 14,
  },
  userRow: {
    alignItems: "flex-end",
  },
  bubble: {
    borderColor: "#111",
    borderWidth: 2,
    maxWidth: "92%",
    padding: 13,
    shadowColor: "#111",
    shadowOffset: { width: 3, height: 3 },
    shadowOpacity: 1,
    shadowRadius: 0,
  },
  assistantBubble: {
    backgroundColor: "#fff",
  },
  userBubble: {
    backgroundColor: "#d8e8ff",
  },
  label: {
    color: "#666",
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 0.5,
    marginBottom: 6,
    textTransform: "uppercase",
  },
  content: {
    color: "#111",
    fontSize: 15,
    lineHeight: 22,
  },
  thinking: {
    color: "#555",
    fontSize: 15,
    fontWeight: "700",
  },
  askBox: {
    backgroundColor: "#fff7ce",
    borderColor: "#111",
    borderWidth: 2,
    marginTop: 12,
    padding: 10,
  },
  askTitle: {
    color: "#111",
    fontSize: 14,
    fontWeight: "800",
    marginBottom: 8,
  },
  option: {
    backgroundColor: "#fff",
    borderColor: "#111",
    borderWidth: 2,
    marginTop: 8,
    padding: 10,
  },
  optionText: {
    color: "#111",
    fontSize: 13,
    fontWeight: "800",
  },
});
