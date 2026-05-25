export type QuickActionId = "clear" | "compact";

export interface QuickAction {
  id: QuickActionId;
  command: string;
  label: string;
}

export interface SlashCommandTrigger {
  query: string;
  key: string;
}

export const QUICK_ACTIONS: QuickAction[] = [
  { id: "clear", command: "clear", label: "Clear context" },
  { id: "compact", command: "compact", label: "Compact context" },
];

function clampCursorToText(text: string, cursor: number): number {
  return Math.max(0, Math.min(cursor, text.length));
}

function fuzzyMatches(query: string, target: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;

  const haystack = target.toLowerCase();
  let needleIndex = 0;
  for (const char of haystack) {
    if (char === needle[needleIndex]) needleIndex += 1;
    if (needleIndex === needle.length) return true;
  }
  return false;
}

export function getQuickActionMatches(query: string): QuickAction[] {
  const needle = query.trim().toLowerCase();
  return QUICK_ACTIONS.map((action, index) => {
    const command = action.command.toLowerCase();
    const label = action.label.toLowerCase();
    const target = `${command} ${label}`;
    let rank: number | null = null;
    if (!needle) rank = 0;
    else if (command.startsWith(needle)) rank = 1;
    else if (label.startsWith(needle)) rank = 2;
    else if (target.includes(needle)) rank = 3;
    else if (fuzzyMatches(needle, target)) rank = 4;
    return rank === null ? null : { action, rank, index };
  })
    .filter((match): match is { action: QuickAction; rank: number; index: number } => match !== null)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((match) => match.action);
}

export function getSlashCommandTrigger(
  text: string,
  cursor: number = text.length
): SlashCommandTrigger | null {
  const safeCursor = clampCursorToText(text, cursor);
  const firstLineEnd = text.indexOf("\n") === -1 ? text.length : text.indexOf("\n");
  if (safeCursor > firstLineEnd) return null;

  const firstLine = text.slice(0, firstLineEnd);
  if (!firstLine.startsWith("/")) return null;

  const afterSlash = firstLine.slice(1);
  const whitespaceIndex = afterSlash.search(/\s/);
  const commandEnd = whitespaceIndex === -1 ? firstLine.length : whitespaceIndex + 1;
  if (safeCursor > commandEnd) return null;

  const query = firstLine.slice(1, commandEnd);
  if (query.includes("/")) return null;

  const rest = firstLine.slice(commandEnd).trim();
  if (!query && rest) return null;

  const trigger = { query, key: firstLine.slice(0, commandEnd) };
  return getQuickActionMatches(query).length > 0 ? trigger : null;
}
