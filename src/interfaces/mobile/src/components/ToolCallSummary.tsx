import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { ToolCallUpdate } from "../api/types";

interface ToolCallSummaryProps {
  toolCalls: ToolCallUpdate[];
}

export function ToolCallSummary({ toolCalls }: ToolCallSummaryProps) {
  const [expanded, setExpanded] = useState(false);

  if (toolCalls.length === 0) return null;

  return (
    <View style={styles.container}>
      <Pressable style={styles.header} onPress={() => setExpanded((value) => !value)}>
        <Text style={styles.headerText}>
          {expanded ? "Hide" : "Show"} {toolCalls.length} tool call{toolCalls.length > 1 ? "s" : ""}
        </Text>
        <Text style={styles.chevron}>{expanded ? "up" : "down"}</Text>
      </Pressable>

      {expanded &&
        toolCalls.map((tool) => (
          <View key={tool.id} style={styles.tool}>
            <View style={styles.toolHeader}>
              <Text style={styles.toolName}>{tool.name}</Text>
              <Text style={[styles.status, tool.status === "running" ? styles.running : styles.done]}>
                {tool.status}
              </Text>
            </View>
            <Text style={styles.code}>{stringifyCompact(tool.arguments)}</Text>
            {tool.result ? <Text style={styles.result}>{tool.result}</Text> : null}
          </View>
        ))}
    </View>
  );
}

function stringifyCompact(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const styles = StyleSheet.create({
  container: {
    borderColor: "#111",
    borderWidth: 1,
    marginTop: 10,
  },
  header: {
    alignItems: "center",
    backgroundColor: "#f4f0ea",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  headerText: {
    color: "#111",
    fontSize: 12,
    fontWeight: "700",
  },
  chevron: {
    color: "#555",
    fontSize: 11,
  },
  tool: {
    borderTopColor: "#111",
    borderTopWidth: 1,
    padding: 10,
  },
  toolHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  toolName: {
    color: "#111",
    fontSize: 12,
    fontWeight: "800",
  },
  status: {
    borderColor: "#111",
    borderWidth: 1,
    fontSize: 10,
    fontWeight: "800",
    overflow: "hidden",
    paddingHorizontal: 6,
    paddingVertical: 2,
    textTransform: "uppercase",
  },
  running: {
    backgroundColor: "#ffd83d",
  },
  done: {
    backgroundColor: "#00e676",
  },
  code: {
    color: "#333",
    fontFamily: "Menlo",
    fontSize: 11,
    marginTop: 8,
  },
  result: {
    color: "#555",
    fontFamily: "Menlo",
    fontSize: 11,
    marginTop: 8,
  },
});
