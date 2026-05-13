import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { ToolCallUpdate } from "../api/types";

interface ToolCallSummaryProps {
  toolCalls: ToolCallUpdate[];
  autoExpand?: boolean;
}

export function ToolCallSummary({ toolCalls, autoExpand }: ToolCallSummaryProps) {
  const [expanded, setExpanded] = useState(Boolean(autoExpand));

  useEffect(() => {
    setExpanded(Boolean(autoExpand && toolCalls.length > 0));
  }, [autoExpand, toolCalls.length]);

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
              <Text selectable style={styles.toolName}>
                {tool.name}
              </Text>
              <Text style={[styles.status, tool.status === "running" ? styles.running : styles.done]}>
                {tool.status}
              </Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.outputScroller}>
              <Text selectable style={styles.code}>
                {stringifyCompact(tool.arguments)}
              </Text>
            </ScrollView>
            {tool.result ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.outputScroller}>
                <Text selectable style={styles.result}>
                  {tool.result}
                </Text>
              </ScrollView>
            ) : null}
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
    marginTop: 7,
    width: "100%",
  },
  header: {
    alignItems: "center",
    backgroundColor: "#f4f0ea",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  headerText: {
    color: "#111",
    flex: 1,
    flexShrink: 1,
    fontSize: 11,
    fontWeight: "700",
  },
  chevron: {
    color: "#555",
    fontSize: 10,
  },
  tool: {
    borderTopColor: "#111",
    borderTopWidth: 1,
    padding: 8,
  },
  toolHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  toolName: {
    color: "#111",
    flex: 1,
    flexShrink: 1,
    fontSize: 11,
    fontWeight: "800",
  },
  status: {
    borderColor: "#111",
    borderWidth: 1,
    fontSize: 9,
    fontWeight: "800",
    overflow: "hidden",
    paddingHorizontal: 6,
    paddingVertical: 1,
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
    fontSize: 10,
  },
  result: {
    color: "#555",
    fontFamily: "Menlo",
    fontSize: 10,
  },
  outputScroller: {
    marginTop: 6,
    maxWidth: "100%",
  },
});
