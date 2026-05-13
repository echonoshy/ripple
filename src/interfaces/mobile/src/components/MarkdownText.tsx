import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";

import { InlineToken, MarkdownBlock, parseInline, parseMarkdown } from "../markdown/parseMarkdown";

interface MarkdownTextProps {
  value: string;
}

export function MarkdownText({ value }: MarkdownTextProps) {
  const blocks = parseMarkdown(value);
  if (blocks.length === 0) return null;

  return (
    <View style={styles.container}>
      {blocks.map((block, index) => (
        <MarkdownBlockView key={`${block.type}-${index}`} block={block} index={index} />
      ))}
    </View>
  );
}

function MarkdownBlockView({ block, index }: { block: MarkdownBlock; index: number }) {
  const blockSpacing = index === 0 ? undefined : styles.blockSpacing;

  if (block.type === "heading") {
    return (
      <Text selectable style={[styles.text, styles.heading, headingStyle(block.level), blockSpacing]}>
        {renderInline(block.text)}
      </Text>
    );
  }

  if (block.type === "paragraph") {
    return (
      <Text selectable style={[styles.text, styles.paragraph, blockSpacing]}>
        {renderInline(block.text)}
      </Text>
    );
  }

  if (block.type === "quote") {
    return (
      <View style={[styles.quote, blockSpacing]}>
        <Text selectable style={[styles.text, styles.quoteText]}>
          {renderInline(block.text)}
        </Text>
      </View>
    );
  }

  if (block.type === "list") {
    return (
      <View style={[styles.list, blockSpacing]}>
        {block.items.map((item, itemIndex) => (
          <View key={`${item.text}-${itemIndex}`} style={styles.listItem}>
            <Text style={styles.listMarker}>{listMarker(block.ordered, itemIndex, item.checked)}</Text>
            <Text selectable style={[styles.text, styles.listText]}>
              {renderInline(item.text)}
            </Text>
          </View>
        ))}
      </View>
    );
  }

  if (block.type === "code") {
    return (
      <View style={[styles.codeFrame, blockSpacing]}>
        {block.language ? <Text style={styles.codeLanguage}>{block.language}</Text> : null}
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Text selectable style={styles.codeBlock}>
            {block.code || " "}
          </Text>
        </ScrollView>
      </View>
    );
  }

  if (block.type === "table") {
    return (
      <ScrollView horizontal style={[styles.tableScroller, blockSpacing]} showsHorizontalScrollIndicator={false}>
        <View style={styles.table}>
          {block.rows.map((row, rowIndex) => (
            <View key={`row-${rowIndex}`} style={[styles.tableRow, rowIndex === 0 && block.headerRow && styles.tableHeaderRow]}>
              {row.map((cell, cellIndex) => (
                <Text
                  key={`cell-${rowIndex}-${cellIndex}`}
                  selectable
                  style={[styles.text, styles.tableCell, rowIndex === 0 && block.headerRow && styles.tableHeaderCell]}
                >
                  {renderInline(cell)}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    );
  }

  return <View style={[styles.divider, blockSpacing]} />;
}

function renderInline(text: string): React.ReactNode[] {
  return parseInline(text).map((token, index) => <InlineTokenView key={`${token.type}-${index}`} token={token} />);
}

function InlineTokenView({ token }: { token: InlineToken }) {
  if (token.type === "bold") {
    return (
      <Text selectable style={styles.bold}>
        {token.text}
      </Text>
    );
  }
  if (token.type === "italic") {
    return (
      <Text selectable style={styles.italic}>
        {token.text}
      </Text>
    );
  }
  if (token.type === "code") {
    return (
      <Text selectable style={styles.inlineCode}>
        {token.text}
      </Text>
    );
  }
  if (token.type === "link") {
    return (
      <Text selectable style={styles.link} onPress={() => void openLink(token.href)}>
        {token.text}
      </Text>
    );
  }
  return <Text selectable>{token.text}</Text>;
}

async function openLink(href: string): Promise<void> {
  const url = /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : `https://${href}`;
  await Linking.openURL(url);
}

function headingStyle(level: number) {
  if (level === 1) return styles.heading1;
  if (level === 2) return styles.heading2;
  return styles.heading3;
}

function listMarker(ordered: boolean, index: number, checked?: boolean): string {
  if (checked === true) return "[x]";
  if (checked === false) return "[ ]";
  return ordered ? `${index + 1}.` : "-";
}

const styles = StyleSheet.create({
  container: {
    minWidth: 0,
    width: "100%",
  },
  blockSpacing: {
    marginTop: 7,
  },
  text: {
    color: "#111",
    flexShrink: 1,
    fontSize: 13,
    lineHeight: 19,
    minWidth: 0,
  },
  paragraph: {
    marginTop: 0,
  },
  heading: {
    fontWeight: "900",
  },
  heading1: {
    fontSize: 17,
    lineHeight: 22,
  },
  heading2: {
    fontSize: 16,
    lineHeight: 21,
  },
  heading3: {
    fontSize: 14,
    lineHeight: 20,
  },
  bold: {
    fontWeight: "900",
  },
  italic: {
    fontStyle: "italic",
  },
  link: {
    color: "#0047ff",
    fontWeight: "800",
    textDecorationLine: "underline",
  },
  inlineCode: {
    backgroundColor: "#f1eee8",
    borderColor: "#111",
    borderWidth: 1,
    fontFamily: "Menlo",
    fontSize: 11,
    overflow: "hidden",
    paddingHorizontal: 4,
  },
  quote: {
    backgroundColor: "#fff7ce",
    borderLeftColor: "#111",
    borderLeftWidth: 3,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  quoteText: {
    color: "#333",
    fontWeight: "600",
  },
  list: {
    gap: 5,
    minWidth: 0,
    width: "100%",
  },
  listItem: {
    alignItems: "flex-start",
    flexDirection: "row",
    minWidth: 0,
    width: "100%",
  },
  listMarker: {
    color: "#111",
    fontFamily: "Menlo",
    fontSize: 11,
    fontWeight: "900",
    lineHeight: 19,
    marginRight: 6,
    minWidth: 24,
  },
  listText: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  codeFrame: {
    backgroundColor: "#111",
    borderColor: "#111",
    borderWidth: 2,
    maxWidth: "100%",
    padding: 8,
  },
  codeLanguage: {
    color: "#ffd83d",
    fontFamily: "Menlo",
    fontSize: 10,
    fontWeight: "900",
    marginBottom: 6,
    textTransform: "uppercase",
  },
  codeBlock: {
    color: "#f9f5ed",
    fontFamily: "Menlo",
    fontSize: 11,
    lineHeight: 16,
    minWidth: "100%",
  },
  tableScroller: {
    maxWidth: "100%",
  },
  table: {
    borderColor: "#111",
    borderLeftWidth: 1,
    borderTopWidth: 1,
  },
  tableRow: {
    flexDirection: "row",
  },
  tableHeaderRow: {
    backgroundColor: "#f4f0ea",
  },
  tableCell: {
    borderBottomColor: "#111",
    borderBottomWidth: 1,
    borderRightColor: "#111",
    borderRightWidth: 1,
    minWidth: 90,
    paddingHorizontal: 6,
    paddingVertical: 5,
  },
  tableHeaderCell: {
    fontWeight: "900",
  },
  divider: {
    backgroundColor: "#111",
    height: 2,
    width: "100%",
  },
});
