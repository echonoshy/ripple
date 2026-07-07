import type { BrowserPageResponse, ChatBrowserContext } from "./api";

export const BROWSER_CONTEXT_VISIBLE_TEXT_LIMIT = 8000;

export interface BrowserContextInput {
  address: string;
  page: BrowserPageResponse | null;
}

export function normalizeBrowserUrlInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function buildBrowserContext({ address, page }: BrowserContextInput): ChatBrowserContext {
  const normalizedAddress = normalizeBrowserUrlInput(address);
  const visibleText = page?.text || "";
  const boundedText = limitText(visibleText, BROWSER_CONTEXT_VISIBLE_TEXT_LIMIT);
  const textTruncated = Boolean(page?.truncated || visibleText.length > boundedText.length);

  return {
    schema_version: "ripple.browser_context.v1",
    captured_at: page?.captured_at || new Date().toISOString(),
    active: Boolean(normalizedAddress || page),
    page: {
      url: page?.url || normalizedAddress,
      title: page?.title || null,
      visible_text: boundedText,
      text_truncated: textTruncated,
    },
  };
}

function limitText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(0, limit).trimEnd();
}
