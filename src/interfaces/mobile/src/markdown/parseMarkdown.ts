export type InlineToken =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; text: string; href: string };

export type MarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "code"; language?: string; code: string }
  | { type: "quote"; text: string }
  | { type: "list"; ordered: boolean; items: Array<{ text: string; checked?: boolean }> }
  | { type: "table"; rows: string[][]; headerRow: boolean }
  | { type: "divider" };

const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/;
const ORDERED_LIST_PATTERN = /^\s*(\d+)[.)]\s+(.+)$/;
const UNORDERED_LIST_PATTERN = /^\s*[-+*]\s+(.+)$/;
const TABLE_SEPARATOR_PATTERN = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const URL_START_PATTERN = /^(https?:\/\/|www\.)/i;
const URL_SEARCH_PATTERN = /<?(https?:\/\/|www\.)/i;

export function parseMarkdown(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = getFence(trimmed);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence.marker)) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language: fence.language, code: codeLines.join("\n") });
      continue;
    }

    const headingMatch = line.match(HEADING_PATTERN);
    if (headingMatch) {
      blocks.push({ type: "heading", level: headingMatch[1].length, text: headingMatch[2].trim() });
      index += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: "divider" });
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const rows: string[][] = [splitTableRow(lines[index])];
      index += 2;
      while (index < lines.length && isTableRow(lines[index])) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: "table", rows, headerRow: true });
      continue;
    }

    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "quote", text: quoteLines.join("\n").trim() });
      continue;
    }

    const ordered = parseOrderedListItem(line);
    if (ordered) {
      const items: Array<{ text: string; checked?: boolean }> = [];
      while (index < lines.length) {
        const item = parseOrderedListItem(lines[index]);
        if (!item) break;
        items.push(item);
        index += 1;
        index = appendListContinuation(lines, index, items);
      }
      blocks.push({ type: "list", ordered: true, items });
      continue;
    }

    const unordered = parseUnorderedListItem(line);
    if (unordered) {
      const items: Array<{ text: string; checked?: boolean }> = [];
      while (index < lines.length) {
        const item = parseUnorderedListItem(lines[index]);
        if (!item) break;
        items.push(item);
        index += 1;
        index = appendListContinuation(lines, index, items);
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }

    const paragraphLines: string[] = [trimmed];
    index += 1;
    while (index < lines.length && shouldContinueParagraph(lines, index)) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let index = 0;

  while (index < text.length) {
    const codeEnd = text[index] === "`" ? text.indexOf("`", index + 1) : -1;
    if (codeEnd > index) {
      tokens.push({ type: "code", text: text.slice(index + 1, codeEnd) });
      index = codeEnd + 1;
      continue;
    }

    const link = parseLink(text, index);
    if (link) {
      tokens.push(link.token);
      index = link.nextIndex;
      continue;
    }

    const autolink = parseAutolink(text, index);
    if (autolink) {
      tokens.push(autolink.token);
      index = autolink.nextIndex;
      continue;
    }

    const strong = parseDelimited(text, index, "**") ?? parseDelimited(text, index, "__");
    if (strong) {
      tokens.push({ type: "bold", text: strong.text });
      index = strong.nextIndex;
      continue;
    }

    const emphasis = parseDelimited(text, index, "*") ?? parseDelimited(text, index, "_");
    if (emphasis) {
      tokens.push({ type: "italic", text: emphasis.text });
      index = emphasis.nextIndex;
      continue;
    }

    const nextSpecial = findNextSpecial(text, index + 1);
    tokens.push({ type: "text", text: text.slice(index, nextSpecial) });
    index = nextSpecial;
  }

  return mergeTextTokens(tokens);
}

function getFence(line: string): { marker: string; language?: string } | null {
  if (!line.startsWith("```") && !line.startsWith("~~~")) return null;
  const marker = line.slice(0, 3);
  const language = line.slice(3).trim();
  return { marker, language: language || undefined };
}

function isTableStart(lines: string[], index: number): boolean {
  return index + 1 < lines.length && isTableRow(lines[index]) && TABLE_SEPARATOR_PATTERN.test(lines[index + 1]);
}

function isTableRow(line: string): boolean {
  return line.includes("|") && line.trim().length > 0;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function parseOrderedListItem(line: string): { text: string; checked?: boolean } | null {
  const match = line.match(ORDERED_LIST_PATTERN);
  return match ? parseTaskItem(match[2]) : null;
}

function parseUnorderedListItem(line: string): { text: string; checked?: boolean } | null {
  const match = line.match(UNORDERED_LIST_PATTERN);
  return match ? parseTaskItem(match[1]) : null;
}

function parseTaskItem(text: string): { text: string; checked?: boolean } {
  const task = text.match(/^\[([ xX])\]\s+(.+)$/);
  if (!task) return { text: text.trim() };
  return { checked: task[1].toLowerCase() === "x", text: task[2].trim() };
}

function appendListContinuation(
  lines: string[],
  index: number,
  items: Array<{ text: string; checked?: boolean }>,
): number {
  while (
    index < lines.length &&
    lines[index].trim() &&
    /^\s{2,}\S/.test(lines[index]) &&
    !parseOrderedListItem(lines[index]) &&
    !parseUnorderedListItem(lines[index])
  ) {
    items[items.length - 1].text += ` ${lines[index].trim()}`;
    index += 1;
  }
  return index;
}

function shouldContinueParagraph(lines: string[], index: number): boolean {
  const line = lines[index];
  const trimmed = line.trim();
  if (!trimmed) return false;
  return (
    !getFence(trimmed) &&
    !HEADING_PATTERN.test(line) &&
    !trimmed.startsWith(">") &&
    !parseOrderedListItem(line) &&
    !parseUnorderedListItem(line) &&
    !/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed) &&
    !isTableStart(lines, index)
  );
}

function parseLink(text: string, index: number): { token: InlineToken; nextIndex: number } | null {
  if (text[index] !== "[") return null;
  const labelEnd = text.indexOf("]", index + 1);
  if (labelEnd < 0 || text[labelEnd + 1] !== "(") return null;
  const hrefEnd = findMarkdownHrefEnd(text, labelEnd + 2);
  if (hrefEnd < 0) return null;
  const label = text.slice(index + 1, labelEnd);
  const href = text.slice(labelEnd + 2, hrefEnd).trim();
  if (!label || !href) return null;
  return { token: { type: "link", text: label, href }, nextIndex: hrefEnd + 1 };
}

function parseAutolink(text: string, index: number): { token: InlineToken; nextIndex: number } | null {
  if (!hasUrlBoundary(text, index)) return null;

  if (text[index] === "<") {
    const end = text.indexOf(">", index + 1);
    if (end > index + 1) {
      const href = text.slice(index + 1, end).trim();
      if (URL_START_PATTERN.test(href)) {
        return { token: { type: "link", text: href, href }, nextIndex: end + 1 };
      }
    }
    return null;
  }

  if (!URL_START_PATTERN.test(text.slice(index))) return null;

  let end = index;
  while (end < text.length && !/[\s<>"']/.test(text[end])) {
    end += 1;
  }

  const href = trimBareUrl(text.slice(index, end));
  if (!href) return null;
  return { token: { type: "link", text: href, href }, nextIndex: index + href.length };
}

function findMarkdownHrefEnd(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return -1;
}

function trimBareUrl(url: string): string {
  let trimmed = url;
  while (/[.,!?;:]$/.test(trimmed)) {
    trimmed = trimmed.slice(0, -1);
  }
  for (const [opening, closing] of [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ]) {
    while (trimmed.endsWith(closing) && countCharacter(trimmed, closing) > countCharacter(trimmed, opening)) {
      trimmed = trimmed.slice(0, -1);
    }
  }
  return trimmed;
}

function countCharacter(text: string, character: string): number {
  return Array.from(text).filter((value) => value === character).length;
}

function hasUrlBoundary(text: string, index: number): boolean {
  return index === 0 || /[\s([<{]/.test(text[index - 1]);
}

function parseDelimited(text: string, index: number, delimiter: string): { text: string; nextIndex: number } | null {
  if (!text.startsWith(delimiter, index)) return null;
  const end = text.indexOf(delimiter, index + delimiter.length);
  if (end <= index + delimiter.length) return null;
  return { text: text.slice(index + delimiter.length, end), nextIndex: end + delimiter.length };
}

function findNextSpecial(text: string, start: number): number {
  let next = text.length;
  for (const special of ["`", "[", "*", "_"]) {
    const found = text.indexOf(special, start);
    if (found >= 0 && found < next) next = found;
  }
  const urlStart = findNextUrlStart(text, start);
  if (urlStart >= 0 && urlStart < next) next = urlStart;
  return next;
}

function findNextUrlStart(text: string, start: number): number {
  let searchStart = start;
  while (searchStart < text.length) {
    const urlMatch = text.slice(searchStart).match(URL_SEARCH_PATTERN);
    if (urlMatch?.index === undefined) return -1;
    const found = searchStart + urlMatch.index;
    if (hasUrlBoundary(text, found)) return found;
    searchStart = found + 1;
  }
  return -1;
}

function mergeTextTokens(tokens: InlineToken[]): InlineToken[] {
  const merged: InlineToken[] = [];
  for (const token of tokens) {
    const previous = merged[merged.length - 1];
    if (token.type === "text" && previous?.type === "text") {
      previous.text += token.text;
    } else if (token.text) {
      merged.push(token);
    }
  }
  return merged;
}
