"use client";

import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import {
  ChevronRight,
  Brain,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  QrCode,
  Settings2,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { IconTile } from "@/components/icons/IconTile";
import { useI18n } from "@/i18n";
import { resolveBackendUrl, parseWorkspaceLink } from "@/lib/api";
import { openExternalUrl } from "@/lib/platform";

/**
 * LLM 常把矩阵换行写成单反斜杠加空格 `\ `，KaTeX 需要 `\\`。
 * 仅在疑似「行尾单反斜杠+空格+下一行起始」处替换，避免误伤普通 `\ ` 空白命令。
 */
function fixLlmMatrixNewlinesInMath(block: string): string {
  return block.replace(/(\d+|\})\s\\\s+(?=\d|\\)/g, "$1 \\\\ ");
}

function normalizeLlmMatrixNewlines(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const d = text.indexOf("$$", i);
    if (d === -1) {
      out += fixInlineMathSpans(text.slice(i));
      break;
    }
    out += fixInlineMathSpans(text.slice(i, d));
    const end = text.indexOf("$$", d + 2);
    if (end === -1) {
      out += text.slice(d);
      break;
    }
    const inner = text.slice(d + 2, end);
    out += `$$${fixLlmMatrixNewlinesInMath(inner)}$$`;
    i = end + 2;
  }
  return out;
}

function fixInlineMathSpans(fragment: string): string {
  const result: string[] = [];
  let pos = 0;
  const re = /\$([^$\n]+)\$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) !== null) {
    result.push(fragment.slice(pos, m.index));
    result.push(`$${fixLlmMatrixNewlinesInMath(m[1])}$`);
    pos = m.index + m[0].length;
  }
  result.push(fragment.slice(pos));
  return result.join("");
}

interface MarkdownRendererProps {
  content: string;
  className?: string;
  onFeishuAuthOpen?: (payload: FeishuAuthOpenPayload) => void;
  feishuAuthWaiting?: FeishuAuthWaitingState | null;
}

export type FeishuTag = "setup" | "auth";
export type ConnectorAuthKind = "feishu" | "google_workspace";
export type ConnectorAuthMode = "connect" | "skill";

export interface FeishuAuthOpenPayload {
  connector: ConnectorAuthKind;
  tag: FeishuTag;
  url: string;
  popup: Window | null;
  mode?: ConnectorAuthMode;
}

export interface FeishuAuthWaitingState {
  connector: ConnectorAuthKind;
  url: string;
  elapsedSeconds: number;
  label: string;
}

interface ContentSegment {
  type:
    | "text"
    | "thinking"
    | "feishu"
    | "feishuAuthorized"
    | "google"
    | "googleAuthorized"
    | "notionToken"
    | "notionAuthorized"
    | "bilibili"
    | "bilibiliAuthorized";
  content: string;
  tag?: FeishuTag;
  url?: string;
  qrcodeImageUrl?: string;
  appUrl?: string;
  authMode?: ConnectorAuthMode;
  bilibiliMode?: "connect" | "skill";
}

type ConnectorAuthLinkVariant = "primary" | "info" | "warning" | "neutral";

const CONNECTOR_AUTH_CARD_CLASS =
  "my-3 overflow-hidden rounded-xl border border-[#DEE0E3] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.04)]";

function connectorAuthLinkClass(variant: ConnectorAuthLinkVariant, extra = ""): string {
  return ["connector-auth-link", `connector-auth-link--${variant}`, extra]
    .filter(Boolean)
    .join(" ");
}

function isExternalHref(href: string | undefined): href is string {
  if (!href) return false;
  const trimmed = href.trim();
  return /^(https?:|mailto:|tel:|sms:|bilibili:)/i.test(trimmed);
}

function parseThinkingBlocks(content: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  const regex = /<think>([\s\S]*?)<\/think>/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const text = content.slice(lastIndex, match.index).trim();
      if (text) segments.push(...parseConnectorAuthBlocks(text));
    }
    const thinking = match[1].trim();
    if (thinking) segments.push({ type: "thinking", content: thinking });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    const text = content.slice(lastIndex).trim();
    if (text) segments.push(...parseConnectorAuthBlocks(text));
  }

  return segments.length > 0 ? segments : parseConnectorAuthBlocks(content);
}

/**
 * 识别服务端 connector auth 消息里的授权标签，转换为可交互的按钮卡片。
 *
 * 标签由 Ripple 的 chat auth flow 产生：
 *   [FEISHU_SETUP_CONNECT] ... https://open.feishu.cn/page/cli?user_code=...
 *   [FEISHU_AUTH_SKILL]    ... https://accounts.feishu.cn/...
 *   [GOOGLE_AUTH_CONNECT]  ... https://accounts.google.com/o/oauth2/auth?...
 *   [NOTION_TOKEN_SKILL]
 *
 * 匹配策略：从标签起扫到第一个 http(s) URL（含），整段替换为授权卡片；
 * 前后的普通文本保留为独立的 text segment。
 */
function parseConnectorAuthBlocks(text: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  const bilibiliRe =
    /\[BILIBILI_AUTH(?:_(CONNECT|SKILL))?\][\s\S]*?(\/v1\/bilibili\/qrcode\.png\?\S+)[\s\S]*?(https?:\/\/\S+)(?:[\s\S]*?(bilibili:\/\/\S+))?/g;
  let lastBilibili = 0;
  let bilibiliMatch: RegExpExecArray | null;

  while ((bilibiliMatch = bilibiliRe.exec(text)) !== null) {
    if (bilibiliMatch.index > lastBilibili) {
      const before = text.slice(lastBilibili, bilibiliMatch.index).trim();
      if (before) segments.push(...parseBrowserConnectorAuthBlocks(before));
    }
    segments.push({
      type: "bilibili",
      content: bilibiliMatch[0],
      bilibiliMode: bilibiliMatch[1] === "SKILL" ? "skill" : "connect",
      qrcodeImageUrl: bilibiliMatch[2],
      url: bilibiliMatch[3],
      appUrl: bilibiliMatch[4],
    });
    lastBilibili =
      bilibiliMatch.index +
      bilibiliMatch[0].length +
      legacyBilibiliAuthTailLength(text.slice(bilibiliMatch.index + bilibiliMatch[0].length));
  }

  if (segments.length > 0) {
    if (lastBilibili < text.length) {
      const tail = text.slice(lastBilibili).trim();
      if (tail) segments.push(...parseBrowserConnectorAuthBlocks(tail));
    }
    return segments;
  }

  return parseBrowserConnectorAuthBlocks(text);
}

function parseBrowserConnectorAuthBlocks(text: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  const re =
    /\[(GOOGLE_AUTH(?:_(?:CONNECT|SKILL))?|GOOGLE_AUTHORIZED(?:_(?:CONNECT|SKILL))?|FEISHU_(?:SETUP|AUTH)(?:_(?:CONNECT|SKILL))?|FEISHU_AUTHORIZED(?:_(?:CONNECT|SKILL))?|NOTION_TOKEN(?:_(?:CONNECT|SKILL))?|NOTION_AUTHORIZED(?:_(?:CONNECT|SKILL))?|BILIBILI_AUTHORIZED(?:_(?:CONNECT|SKILL))?)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    const marker = m[1];
    let segmentEnd = re.lastIndex;
    let url: string | undefined;
    if (connectorAuthMarkerNeedsUrl(marker)) {
      const urlMatch = text.slice(segmentEnd).match(/https?:\/\/\S+/);
      if (!urlMatch?.index && urlMatch?.index !== 0) {
        continue;
      }
      url = urlMatch[0];
      segmentEnd += urlMatch.index + url.length;
    }
    if (m.index > last) {
      const before = text.slice(last, m.index).trim();
      if (before) segments.push({ type: "text", content: before });
    }
    if (marker.startsWith("GOOGLE_AUTHORIZED")) {
      segments.push({
        type: "googleAuthorized",
        content: text.slice(m.index, segmentEnd),
        authMode: authModeFromMarker(marker, "skill"),
      });
    } else if (marker.startsWith("GOOGLE_AUTH")) {
      segments.push({
        type: "google",
        content: text.slice(m.index, segmentEnd),
        url,
        authMode: authModeFromMarker(marker, "skill"),
      });
    } else if (marker.startsWith("FEISHU_AUTHORIZED")) {
      segments.push({
        type: "feishuAuthorized",
        content: text.slice(m.index, segmentEnd),
        authMode: authModeFromMarker(marker, "skill"),
      });
    } else if (marker.startsWith("FEISHU_")) {
      const tag: FeishuTag = marker.includes("SETUP") ? "setup" : "auth";
      segments.push({
        type: "feishu",
        content: text.slice(m.index, segmentEnd),
        tag,
        url,
        authMode: authModeFromMarker(marker, "connect"),
      });
    } else if (marker.startsWith("NOTION_TOKEN")) {
      segments.push({
        type: "notionToken",
        content: text.slice(m.index, segmentEnd),
        authMode: authModeFromMarker(marker, "skill"),
      });
    } else if (marker.startsWith("NOTION_AUTHORIZED")) {
      segments.push({
        type: "notionAuthorized",
        content: text.slice(m.index, segmentEnd),
        authMode: authModeFromMarker(marker, "skill"),
      });
    } else if (marker.startsWith("BILIBILI_AUTHORIZED")) {
      segments.push({
        type: "bilibiliAuthorized",
        content: text.slice(m.index, segmentEnd),
        bilibiliMode: authModeFromMarker(marker, "connect"),
      });
    }
    last = segmentEnd + legacyConnectorAuthTailLength(text.slice(segmentEnd));
  }

  if (last < text.length) {
    const tail = text.slice(last).trim();
    if (tail) segments.push({ type: "text", content: tail });
  }

  return segments.length > 0 ? segments : [{ type: "text", content: text }];
}

function connectorAuthMarkerNeedsUrl(marker: string): boolean {
  return (
    (marker.startsWith("GOOGLE_AUTH") && !marker.startsWith("GOOGLE_AUTHORIZED")) ||
    marker.startsWith("FEISHU_SETUP") ||
    (marker.startsWith("FEISHU_AUTH") && !marker.startsWith("FEISHU_AUTHORIZED"))
  );
}

function authModeFromMarker(marker: string, legacyDefault: ConnectorAuthMode): ConnectorAuthMode {
  if (marker.endsWith("_CONNECT")) return "connect";
  if (marker.endsWith("_SKILL")) return "skill";
  return legacyDefault;
}

function legacyBilibiliAuthTailLength(text: string): number {
  const match = text.match(
    /^\s*(?:扫码或点链接确认后，回到这里发送「好了」。|After confirming with the QR code or link, come back here and send "done"\.)/
  );
  return match?.[0].length ?? 0;
}

function legacyConnectorAuthTailLength(text: string): number {
  const match = text.match(
    /^\s*(?:授权完成后 Ripple 会自动继续。|After authorization, Ripple will continue automatically\.)/
  );
  return match?.[0].length ?? 0;
}

function FeishuCard({
  tag,
  url,
  mode = "connect",
  onOpen,
  waiting,
}: {
  tag: FeishuTag;
  url: string;
  mode?: ConnectorAuthMode;
  onOpen?: (payload: FeishuAuthOpenPayload) => void;
  waiting?: FeishuAuthWaitingState | null;
}) {
  const { t } = useI18n();
  const isSetup = tag === "setup";
  const title =
    mode === "skill"
      ? isSetup
        ? t("connectors.feishuSkillSetupTitle")
        : t("connectors.feishuSkillAuthTitle")
      : isSetup
        ? t("connectors.feishuSetupTitle")
        : t("connectors.feishuAuthTitle");
  const subtitle =
    mode === "skill"
      ? isSetup
        ? t("connectors.feishuSkillSetupSubtitle")
        : t("connectors.feishuSkillAuthSubtitle")
      : isSetup
        ? t("connectors.feishuSetupSubtitle")
        : t("connectors.feishuAuthSubtitle");
  const hint = isSetup ? t("connectors.feishuSetupHint") : t("connectors.feishuAuthHint");
  const Icon = isSetup ? Settings2 : KeyRound;
  const accentClass = isSetup ? "bg-[#F0F5FF]/60 text-[#1456F0]" : "bg-[#E4F8EE]/60 text-[#16845B]";
  const iconTone = isSetup ? "accent" : "success";
  const href = resolveBackendUrl(url) || url;
  const isWaiting =
    waiting?.connector === "feishu" && (waiting.url === href || waiting.url === url);

  const handleOpen = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!onOpen) return;
    event.preventDefault();
    void (async () => {
      const result = await openExternalUrl(href, "ripple-connector-auth");
      if (!result.opened) return;
      onOpen({ connector: "feishu", tag, url: href, popup: result.popup, mode });
    })();
  };

  return (
    <div className={CONNECTOR_AUTH_CARD_CLASS}>
      <div className={`flex items-center gap-2 border-b border-[#DEE0E3] px-4 py-3 ${accentClass}`}>
        <IconTile tone={iconTone} size="sm">
          <Icon size={15} />
        </IconTile>
        <span className="text-sm font-semibold">{title}</span>
      </div>
      <div className="space-y-3 px-4 py-3">
        <p className="text-sm font-medium text-[#2B2F36]">{subtitle}</p>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={handleOpen}
          className={connectorAuthLinkClass("info")}
        >
          {isSetup ? t("connectors.openFeishuSetup") : t("connectors.openAuthPage")}
          <ExternalLink size={13} />
        </a>
        <p className="text-xs font-medium text-[#646A73]">{hint}</p>
        {isWaiting && (
          <div className="flex items-start gap-2 rounded-xl border border-[#1456F0]/20 bg-[#f6fbff] px-3 py-2 text-xs font-medium text-[#2B2F36]">
            <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-[#1456F0]" />
            <span>{t("connectors.feishuWaitingCard", { seconds: waiting.elapsedSeconds })}</span>
          </div>
        )}
        <div className="font-[family-name:var(--font-mono)] text-[11px] break-all text-[#646A73]">
          {url}
        </div>
      </div>
    </div>
  );
}

function GoogleAuthCard({
  url,
  mode = "skill",
  onOpen,
  waiting,
}: {
  url: string;
  mode?: ConnectorAuthMode;
  onOpen?: (payload: FeishuAuthOpenPayload) => void;
  waiting?: FeishuAuthWaitingState | null;
}) {
  const { t } = useI18n();
  const href = resolveBackendUrl(url) || url;
  const isWaiting =
    waiting?.connector === "google_workspace" && (waiting.url === href || waiting.url === url);

  const handleOpen = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!onOpen) return;
    event.preventDefault();
    void (async () => {
      const result = await openExternalUrl(href, "ripple-connector-auth");
      if (!result.opened) return;
      onOpen({ connector: "google_workspace", tag: "auth", url: href, popup: result.popup, mode });
    })();
  };
  const title =
    mode === "connect" ? t("connectors.googleConnectTitle") : t("connectors.googleAuthTitle");
  const subtitle =
    mode === "connect" ? t("connectors.googleConnectSubtitle") : t("connectors.googleAuthSubtitle");

  return (
    <div className={CONNECTOR_AUTH_CARD_CLASS}>
      <div className="flex items-center gap-2 border-b border-[#DEE0E3] bg-[#F0F5FF]/60 px-4 py-3 text-[#1456F0]">
        <IconTile tone="accent" size="sm">
          <KeyRound size={15} />
        </IconTile>
        <span className="text-sm font-semibold">{title}</span>
      </div>
      <div className="space-y-3 px-4 py-3">
        <p className="text-sm font-medium text-[#2B2F36]">{subtitle}</p>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={handleOpen}
          className={connectorAuthLinkClass("primary")}
        >
          {t("connectors.openGoogleAuth")}
          <ExternalLink size={13} />
        </a>
        {isWaiting && (
          <div className="flex items-start gap-2 rounded-xl border border-[#1456F0]/20 bg-[#f6fbff] px-3 py-2 text-xs font-medium text-[#2B2F36]">
            <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-[#1456F0]" />
            <span>{t("connectors.googleWaitingCard", { seconds: waiting.elapsedSeconds })}</span>
          </div>
        )}
        <div className="font-[family-name:var(--font-mono)] text-[11px] break-all text-[#646A73]">
          {url}
        </div>
      </div>
    </div>
  );
}

function GoogleAuthorizedCard({ mode = "skill" }: { mode?: ConnectorAuthMode }) {
  const { t } = useI18n();
  const subtitle =
    mode === "connect"
      ? t("connectors.googleAuthorizedSubtitle")
      : t("connectors.googleSkillAuthorizedSubtitle");

  return (
    <div className={CONNECTOR_AUTH_CARD_CLASS}>
      <div className="flex items-center gap-2 border-b border-[#DEE0E3] bg-[#E4F8EE]/60 px-4 py-3 text-[#16845B]">
        <IconTile tone="success" size="sm">
          <CheckCircle2 size={15} />
        </IconTile>
        <span className="text-sm font-semibold">{t("connectors.googleAuthorizedTitle")}</span>
      </div>
      <div className="px-4 py-3">
        <p className="text-sm font-medium text-[#2B2F36]">{subtitle}</p>
      </div>
    </div>
  );
}

function FeishuAuthorizedCard({ mode = "skill" }: { mode?: ConnectorAuthMode }) {
  const { t } = useI18n();
  const subtitle =
    mode === "connect"
      ? t("connectors.feishuAuthorizedSubtitle")
      : t("connectors.feishuSkillAuthorizedSubtitle");

  return (
    <div className={CONNECTOR_AUTH_CARD_CLASS}>
      <div className="flex items-center gap-2 border-b border-[#DEE0E3] bg-[#E4F8EE]/60 px-4 py-3 text-[#16845B]">
        <IconTile tone="success" size="sm">
          <CheckCircle2 size={15} />
        </IconTile>
        <span className="text-sm font-semibold">{t("connectors.feishuAuthorizedTitle")}</span>
      </div>
      <div className="px-4 py-3">
        <p className="text-sm font-medium text-[#2B2F36]">{subtitle}</p>
      </div>
    </div>
  );
}

function NotionTokenCard({ mode = "skill" }: { mode?: ConnectorAuthMode }) {
  const { t } = useI18n();
  const title =
    mode === "connect" ? t("connectors.notionTokenTitle") : t("connectors.notionSkillTokenTitle");
  const subtitle =
    mode === "connect"
      ? t("connectors.notionTokenSubtitle")
      : t("connectors.notionSkillTokenSubtitle");

  return (
    <div className={CONNECTOR_AUTH_CARD_CLASS}>
      <div className="flex items-center gap-2 border-b border-[#DEE0E3] bg-[#F0F5FF]/60 px-4 py-3 text-[#1456F0]">
        <IconTile tone="accent" size="sm">
          <KeyRound size={15} />
        </IconTile>
        <span className="text-sm font-semibold">{title}</span>
      </div>
      <div className="space-y-3 px-4 py-3">
        <p className="text-sm font-medium text-[#2B2F36]">{subtitle}</p>
        <a
          href="https://www.notion.so/profile/integrations"
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            event.preventDefault();
            void openExternalUrl(
              "https://www.notion.so/profile/integrations",
              "ripple-connector-auth"
            );
          }}
          className={connectorAuthLinkClass("primary")}
        >
          {t("connectors.openNotionIntegrations")}
          <ExternalLink size={13} />
        </a>
        <p className="text-xs font-medium text-[#646A73]">{t("connectors.notionTokenHint")}</p>
      </div>
    </div>
  );
}

function NotionAuthorizedCard({ mode = "skill" }: { mode?: ConnectorAuthMode }) {
  const { t } = useI18n();
  const subtitle =
    mode === "connect"
      ? t("connectors.notionAuthorizedSubtitle")
      : t("connectors.notionSkillAuthorizedSubtitle");

  return (
    <div className={CONNECTOR_AUTH_CARD_CLASS}>
      <div className="flex items-center gap-2 border-b border-[#DEE0E3] bg-[#E4F8EE]/60 px-4 py-3 text-[#16845B]">
        <IconTile tone="success" size="sm">
          <CheckCircle2 size={15} />
        </IconTile>
        <span className="text-sm font-semibold">{t("connectors.notionAuthorizedTitle")}</span>
      </div>
      <div className="px-4 py-3">
        <p className="text-sm font-medium text-[#2B2F36]">{subtitle}</p>
      </div>
    </div>
  );
}

function BilibiliAuthorizedCard({ mode = "connect" }: { mode?: "connect" | "skill" }) {
  const { t } = useI18n();
  const subtitle =
    mode === "skill"
      ? t("connectors.bilibiliSkillAuthorizedSubtitle")
      : t("connectors.bilibiliAuthorizedSubtitle");

  return (
    <div className={CONNECTOR_AUTH_CARD_CLASS}>
      <div className="flex items-center gap-2 border-b border-[#DEE0E3] bg-[#E4F8EE]/60 px-4 py-3 text-[#16845B]">
        <IconTile tone="success" size="sm">
          <CheckCircle2 size={15} />
        </IconTile>
        <span className="text-sm font-semibold">{t("connectors.bilibiliAuthorizedTitle")}</span>
      </div>
      <div className="px-4 py-3">
        <p className="text-sm font-medium text-[#2B2F36]">{subtitle}</p>
      </div>
    </div>
  );
}

function BilibiliAuthCard({
  qrcodeImageUrl,
  scanUrl,
  appUrl,
  mode = "connect",
}: {
  qrcodeImageUrl: string;
  scanUrl: string;
  appUrl?: string;
  mode?: "connect" | "skill";
}) {
  const { t } = useI18n();
  const qrSrc = resolveBackendUrl(qrcodeImageUrl) || qrcodeImageUrl;
  const href = resolveBackendUrl(scanUrl) || scanUrl;
  const appHref = appUrl?.trim();
  const title =
    mode === "skill" ? t("connectors.bilibiliSkillAuthTitle") : t("connectors.bilibiliAuthTitle");
  const subtitle =
    mode === "skill"
      ? t("connectors.bilibiliSkillAuthSubtitle")
      : t("connectors.bilibiliAuthSubtitle");

  const handleOpen = (targetHref: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    void openExternalUrl(targetHref, "ripple-connector-auth");
  };

  return (
    <div className={CONNECTOR_AUTH_CARD_CLASS}>
      <div className="flex items-center gap-2 border-b border-[#DEE0E3] bg-[#fff4e5]/60 px-4 py-3 text-[#9a3412]">
        <IconTile tone="warning" size="sm">
          <QrCode size={15} />
        </IconTile>
        <span className="text-sm font-semibold">{title}</span>
      </div>
      <div className="space-y-3 px-4 py-3">
        <p className="text-sm font-medium text-[#2B2F36]">{subtitle}</p>
        <div className="flex flex-wrap items-start gap-4">
          <img
            src={qrSrc}
            alt={t("connectors.bilibiliQrAlt")}
            loading="lazy"
            className="h-36 w-36 rounded-xl border border-[#DEE0E3] bg-white object-contain p-2 shadow-sm"
          />
          <div className="min-w-0 flex-1 space-y-2">
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={handleOpen(href)}
              className={connectorAuthLinkClass("warning")}
            >
              {t("connectors.openBilibiliAuth")}
              <ExternalLink size={13} />
            </a>
            {appHref && (
              <a
                href={appHref}
                target="_blank"
                rel="noopener noreferrer"
                onClick={handleOpen(appHref)}
                className={connectorAuthLinkClass("neutral", "ml-2")}
              >
                {t("connectors.openBilibiliApp")}
                <ExternalLink size={13} />
              </a>
            )}
            <p className="text-xs font-medium text-[#646A73]">{t("connectors.bilibiliAuthHint")}</p>
          </div>
        </div>
        <div className="font-[family-name:var(--font-mono)] text-[11px] break-all text-[#646A73]">
          {scanUrl}
        </div>
      </div>
    </div>
  );
}

function ThinkingBlock({
  content,
  onFeishuAuthOpen,
  feishuAuthWaiting,
}: {
  content: string;
  onFeishuAuthOpen?: (payload: FeishuAuthOpenPayload) => void;
  feishuAuthWaiting?: FeishuAuthWaitingState | null;
}) {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-[#d7dce3] bg-[#F8F9FA]">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-[#F0F5FF]"
      >
        <IconTile tone="accent" size="xs">
          <Brain size={13} />
        </IconTile>
        <span className="text-xs font-semibold text-[#2B2F36]">{t("common.thoughtProcess")}</span>
        <motion.div
          animate={{ rotate: isExpanded ? 90 : 0 }}
          transition={{ duration: 0.1 }}
          className="ml-auto"
        >
          <ChevronRight size={14} className="text-[#646A73]" />
        </motion.div>
      </button>
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="border-t border-[#d7dce3] px-4 pb-3">
              <div className="markdown-body mt-2 text-sm leading-relaxed text-[#2B2F36]">
                <MarkdownContent
                  content={content}
                  onFeishuAuthOpen={onFeishuAuthOpen}
                  feishuAuthWaiting={feishuAuthWaiting}
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MarkdownContent({
  content,
  onFeishuAuthOpen,
  feishuAuthWaiting,
}: {
  content: string;
  onFeishuAuthOpen?: (payload: FeishuAuthOpenPayload) => void;
  feishuAuthWaiting?: FeishuAuthWaitingState | null;
}) {
  const normalized = normalizeLlmMatrixNewlines(content);
  const segments = parseConnectorAuthBlocks(normalized);
  const hasConnectorAuth = segments.some(
    (segment) =>
      segment.type === "feishu" ||
      segment.type === "feishuAuthorized" ||
      segment.type === "google" ||
      segment.type === "googleAuthorized" ||
      segment.type === "notionToken" ||
      segment.type === "notionAuthorized" ||
      segment.type === "bilibili" ||
      segment.type === "bilibiliAuthorized"
  );

  if (hasConnectorAuth) {
    return (
      <>
        {segments.map((segment, index) => {
          if (segment.type === "feishu" && segment.url && segment.tag) {
            return (
              <FeishuCard
                key={index}
                tag={segment.tag}
                url={segment.url}
                mode={segment.authMode}
                onOpen={onFeishuAuthOpen}
                waiting={feishuAuthWaiting}
              />
            );
          }
          if (segment.type === "google" && segment.url) {
            return (
              <GoogleAuthCard
                key={index}
                url={segment.url}
                mode={segment.authMode}
                onOpen={onFeishuAuthOpen}
                waiting={feishuAuthWaiting}
              />
            );
          }
          if (segment.type === "googleAuthorized") {
            return <GoogleAuthorizedCard key={index} mode={segment.authMode} />;
          }
          if (segment.type === "feishuAuthorized") {
            return <FeishuAuthorizedCard key={index} mode={segment.authMode} />;
          }
          if (segment.type === "notionToken") {
            return <NotionTokenCard key={index} mode={segment.authMode} />;
          }
          if (segment.type === "notionAuthorized") {
            return <NotionAuthorizedCard key={index} mode={segment.authMode} />;
          }
          if (segment.type === "bilibiliAuthorized") {
            return <BilibiliAuthorizedCard key={index} mode={segment.bilibiliMode} />;
          }
          if (segment.type === "bilibili" && segment.qrcodeImageUrl && segment.url) {
            return (
              <BilibiliAuthCard
                key={index}
                qrcodeImageUrl={segment.qrcodeImageUrl}
                scanUrl={segment.url}
                appUrl={segment.appUrl}
                mode={segment.bilibiliMode}
              />
            );
          }
          return (
            <MarkdownContent
              key={index}
              content={segment.content}
              onFeishuAuthOpen={onFeishuAuthOpen}
              feishuAuthWaiting={feishuAuthWaiting}
            />
          );
        })}
      </>
    );
  }

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
      rehypePlugins={[rehypeKatex, rehypeHighlight]}
      components={{
        pre({ children }) {
          return (
            <pre className="not-prose my-2 max-h-40 max-w-full overflow-x-hidden overflow-y-auto rounded-md border border-[#DEE0E3] bg-[#F8F9FA] p-2.5 font-[family-name:var(--font-mono)] text-[13px] leading-[20px] [overflow-wrap:anywhere] whitespace-pre-wrap text-[#334155]">
              {children}
            </pre>
          );
        },
        code({ className, children, ...props }) {
          const isInline = !className;
          if (isInline) {
            return (
              <code
                className="rounded border border-[#DEE0E3] bg-[#F8F9FA] px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[0.95em] text-[#1F2329]"
                {...props}
              >
                {children}
              </code>
            );
          }
          return (
            <code
              className={`${className} text-[13px] leading-[20px] [overflow-wrap:anywhere] whitespace-pre-wrap`}
              {...props}
            >
              {children}
            </code>
          );
        },
        a({ href, children }) {
          const wsLink = parseWorkspaceLink(href);
          const resolvedHref = resolveBackendUrl(href);
          const opensExternally = !wsLink && isExternalHref(resolvedHref);

          const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
            if (wsLink) {
              e.preventDefault();
              window.dispatchEvent(
                new CustomEvent("open-workspace-file", {
                  detail: {
                    path: wsLink.workspacePath,
                    lineNumber: wsLink.lineNumber,
                    userId: wsLink.userId,
                  },
                })
              );
              return;
            }
            if (opensExternally) {
              e.preventDefault();
              void openExternalUrl(resolvedHref, "ripple-markdown-link");
            }
          };

          return (
            <a
              href={wsLink ? undefined : resolvedHref}
              target={wsLink ? undefined : "_blank"}
              rel="noopener noreferrer"
              data-ripple-external-link={opensExternally ? "true" : undefined}
              onClick={handleClick}
              className="cursor-pointer font-semibold break-words text-[#1456F0] underline underline-offset-4 hover:text-[#174ea6]"
            >
              {children}
            </a>
          );
        },
        img({ src, alt, className, ...rest }) {
          const resolved = typeof src === "string" ? resolveBackendUrl(src) : src;
          return (
            <img
              src={resolved}
              alt={alt ?? ""}
              loading="lazy"
              className={`my-4 block max-h-[420px] max-w-full rounded-lg border border-[#DEE0E3] bg-white object-contain ${className ?? ""}`}
              {...rest}
            />
          );
        },
        table({ children }) {
          return (
            <div className="markdown-table-wrap">
              <table className="markdown-table">{children}</table>
            </div>
          );
        },
        th({ children }) {
          return <th className="markdown-table-cell markdown-table-head">{children}</th>;
        },
        td({ children }) {
          return <td className="markdown-table-cell">{children}</td>;
        },
      }}
    >
      {normalized}
    </ReactMarkdown>
  );
}

export default function MarkdownRenderer({
  content,
  className = "",
  onFeishuAuthOpen,
  feishuAuthWaiting,
}: MarkdownRendererProps) {
  const segments = parseThinkingBlocks(content);
  const hasSpecial = segments.some((s) => s.type !== "text");

  if (!hasSpecial) {
    return (
      <div className={`markdown-body ${className}`}>
        <MarkdownContent
          content={content}
          onFeishuAuthOpen={onFeishuAuthOpen}
          feishuAuthWaiting={feishuAuthWaiting}
        />
      </div>
    );
  }

  return (
    <div className={`markdown-body ${className}`}>
      {segments.map((segment, i) => {
        if (segment.type === "thinking") {
          return (
            <ThinkingBlock
              key={i}
              content={segment.content}
              onFeishuAuthOpen={onFeishuAuthOpen}
              feishuAuthWaiting={feishuAuthWaiting}
            />
          );
        }
        if (segment.type === "feishu" && segment.url && segment.tag) {
          return (
            <FeishuCard
              key={i}
              tag={segment.tag}
              url={segment.url}
              mode={segment.authMode}
              onOpen={onFeishuAuthOpen}
              waiting={feishuAuthWaiting}
            />
          );
        }
        if (segment.type === "google" && segment.url) {
          return (
            <GoogleAuthCard
              key={i}
              url={segment.url}
              mode={segment.authMode}
              onOpen={onFeishuAuthOpen}
              waiting={feishuAuthWaiting}
            />
          );
        }
        if (segment.type === "googleAuthorized") {
          return <GoogleAuthorizedCard key={i} mode={segment.authMode} />;
        }
        if (segment.type === "feishuAuthorized") {
          return <FeishuAuthorizedCard key={i} mode={segment.authMode} />;
        }
        if (segment.type === "notionToken") {
          return <NotionTokenCard key={i} mode={segment.authMode} />;
        }
        if (segment.type === "notionAuthorized") {
          return <NotionAuthorizedCard key={i} mode={segment.authMode} />;
        }
        if (segment.type === "bilibiliAuthorized") {
          return <BilibiliAuthorizedCard key={i} mode={segment.bilibiliMode} />;
        }
        if (segment.type === "bilibili" && segment.qrcodeImageUrl && segment.url) {
          return (
            <BilibiliAuthCard
              key={i}
              qrcodeImageUrl={segment.qrcodeImageUrl}
              scanUrl={segment.url}
              appUrl={segment.appUrl}
              mode={segment.bilibiliMode}
            />
          );
        }
        return (
          <MarkdownContent
            key={i}
            content={segment.content}
            onFeishuAuthOpen={onFeishuAuthOpen}
            feishuAuthWaiting={feishuAuthWaiting}
          />
        );
      })}
    </div>
  );
}
