export type QuickActionId = "clear";

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
];

function clampCursorToText(text: string, cursor: number): number {
  return Math.max(0, Math.min(cursor, text.length));
}

function isFuzzyMatch(query: string, target: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;

  const haystack = target.toLowerCase();
  if (haystack.startsWith(needle) || haystack.includes(needle)) return true;

  let needleIndex = 0;
  for (const char of haystack) {
    if (char === needle[needleIndex]) needleIndex += 1;
    if (needleIndex === needle.length) return true;
  }
  return false;
}

export function getQuickActionMatches(query: string): QuickAction[] {
  return QUICK_ACTIONS.filter((action) => isFuzzyMatch(query, `${action.command} ${action.label}`));
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
