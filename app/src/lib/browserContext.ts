import type { ChatBrowserContext } from "./api";

export const BROWSER_CONTEXT_VISIBLE_TEXT_LIMIT = 8000;
const BROWSER_CONTEXT_ITEM_LIMIT = 40;

export interface BrowserCapturedHeading {
  level: number;
  text: string;
}

export interface BrowserCapturedLink {
  text: string;
  href: string;
}

export interface BrowserCapturedImage {
  alt: string;
  src: string;
}

export interface BrowserCapturedFormField {
  label: string;
  name: string;
  type: string;
  placeholder: string;
}

export interface BrowserCapturedPage {
  url: string;
  title?: string | null;
  text: string;
  selected_text?: string | null;
  headings?: BrowserCapturedHeading[];
  links?: BrowserCapturedLink[];
  images?: BrowserCapturedImage[];
  form_fields?: BrowserCapturedFormField[];
  truncated: boolean;
  captured_at: string;
}

export interface BrowserContextInput {
  address: string;
  page: BrowserCapturedPage | null;
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
  const selectedText =
    typeof page?.selected_text === "string" ? limitText(page.selected_text, BROWSER_CONTEXT_VISIBLE_TEXT_LIMIT) : "";
  const textTruncated = Boolean(page?.truncated || visibleText.length > boundedText.length);
  const headings = normalizeHeadings(page?.headings);
  const links = normalizeLinks(page?.links);
  const images = normalizeImages(page?.images);
  const formFields = normalizeFormFields(page?.form_fields);

  return {
    schema_version: "ripple.browser_context.v1",
    captured_at: page?.captured_at || new Date().toISOString(),
    active: Boolean(normalizedAddress || page),
    page: {
      url: page?.url || normalizedAddress,
      title: page?.title || null,
      visible_text: boundedText,
      selected_text: selectedText || null,
      text_truncated: textTruncated,
      headings,
      links,
      images,
      form_fields: formFields,
    },
  };
}

function limitText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(0, limit).trimEnd();
}

function normalizeHeadings(value: BrowserCapturedHeading[] | undefined): BrowserCapturedHeading[] {
  return (value || [])
    .map((heading) => ({
      level: Math.min(Math.max(Math.round(Number(heading.level) || 0), 1), 6),
      text: limitText(String(heading.text || "").trim(), 240),
    }))
    .filter((heading) => heading.text)
    .slice(0, BROWSER_CONTEXT_ITEM_LIMIT);
}

function normalizeLinks(value: BrowserCapturedLink[] | undefined): BrowserCapturedLink[] {
  return (value || [])
    .map((link) => ({
      text: limitText(String(link.text || "").trim(), 240),
      href: String(link.href || "").trim(),
    }))
    .filter((link) => link.text && /^https?:\/\//i.test(link.href))
    .slice(0, BROWSER_CONTEXT_ITEM_LIMIT);
}

function normalizeImages(value: BrowserCapturedImage[] | undefined): BrowserCapturedImage[] {
  return (value || [])
    .map((image) => ({
      alt: limitText(String(image.alt || "").trim(), 240),
      src: String(image.src || "").trim(),
    }))
    .filter((image) => /^https?:\/\//i.test(image.src))
    .slice(0, BROWSER_CONTEXT_ITEM_LIMIT);
}

function normalizeFormFields(value: BrowserCapturedFormField[] | undefined): BrowserCapturedFormField[] {
  return (value || [])
    .map((field) => ({
      label: limitText(String(field.label || "").trim(), 240),
      name: limitText(String(field.name || "").trim(), 160),
      type: limitText(String(field.type || "").trim(), 80),
      placeholder: limitText(String(field.placeholder || "").trim(), 240),
    }))
    .filter((field) => field.label || field.name || field.placeholder)
    .slice(0, BROWSER_CONTEXT_ITEM_LIMIT);
}
