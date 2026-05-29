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
  ExternalLink,
  KeyRound,
  Loader2,
  QrCode,
  Settings2,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
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

export interface FeishuAuthOpenPayload {
  connector: ConnectorAuthKind;
  tag: FeishuTag;
  url: string;
  popup: Window | null;
}

export interface FeishuAuthWaitingState {
  connector: ConnectorAuthKind;
  url: string;
  elapsedSeconds: number;
  label: string;
}

interface ContentSegment {
  type: "text" | "thinking" | "feishu" | "google" | "bilibili";
  content: string;
  tag?: FeishuTag;
  url?: string;
  qrcodeImageUrl?: string;
  appUrl?: string;
}

type ConnectorAuthLinkVariant = "primary" | "info" | "warning" | "neutral";

function connectorAuthLinkClass(variant: ConnectorAuthLinkVariant, extra = ""): string {
  return ["connector-auth-link", `connector-auth-link--${variant}`, extra]
    .filter(Boolean)
    .join(" ");
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
 * 标签由 Ripple 的 Feishu chat auth flow 产生：
 *   [FEISHU_SETUP] ... https://open.feishu.cn/page/cli?user_code=...
 *   [FEISHU_AUTH]  ... https://accounts.feishu.cn/...
 *   [GOOGLE_AUTH]  ... https://accounts.google.com/o/oauth2/auth?...
 *
 * 匹配策略：从标签起扫到第一个 http(s) URL（含），整段替换为授权卡片；
 * 前后的普通文本保留为独立的 text segment。
 */
function parseConnectorAuthBlocks(text: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  const bilibiliRe =
    /\[BILIBILI_AUTH\][\s\S]*?(\/v1\/bilibili\/qrcode\.png\?\S+)[\s\S]*?(https?:\/\/\S+)(?:[\s\S]*?(bilibili:\/\/\S+))?/g;
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
      qrcodeImageUrl: bilibiliMatch[1],
      url: bilibiliMatch[2],
      appUrl: bilibiliMatch[3],
    });
    lastBilibili = bilibiliMatch.index + bilibiliMatch[0].length;
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
  const re = /\[(FEISHU_(SETUP|AUTH)|GOOGLE_AUTH)\][\s\S]*?(https?:\/\/\S+)/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      const before = text.slice(last, m.index).trim();
      if (before) segments.push({ type: "text", content: before });
    }
    if (m[1] === "GOOGLE_AUTH") {
      segments.push({ type: "google", content: m[0], url: m[3] });
    } else {
      const tag: FeishuTag = m[2] === "SETUP" ? "setup" : "auth";
      segments.push({ type: "feishu", content: m[0], tag, url: m[3] });
    }
    last = m.index + m[0].length;
  }

  if (last < text.length) {
    const tail = text.slice(last).trim();
    if (tail) segments.push({ type: "text", content: tail });
  }

  return segments.length > 0 ? segments : [{ type: "text", content: text }];
}

function FeishuCard({
  tag,
  url,
  onOpen,
  waiting,
}: {
  tag: FeishuTag;
  url: string;
  onOpen?: (payload: FeishuAuthOpenPayload) => void;
  waiting?: FeishuAuthWaitingState | null;
}) {
  const isSetup = tag === "setup";
  const title = isSetup ? "第 1/2 步：准备飞书连接" : "第 2/2 步：授权你的飞书账号";
  const subtitle = isSetup
    ? "首次使用需要在飞书页面完成一次性准备，之后会自动进入账号授权。"
    : "授权后 Ripple 会以你的飞书账号继续执行刚才的请求，发送消息会显示为你本人。";
  const hint = isSetup
    ? "完成后 Ripple 会自动打开第 2 步授权链接。"
    : "授权完成后 Ripple 会自动继续当前任务。";
  const Icon = isSetup ? Settings2 : KeyRound;
  const accentClass = isSetup ? "bg-[#eef3ff]/60 text-[#2f6bff]" : "bg-[#dafbe1]/60 text-[#1a7f37]";
  const href = resolveBackendUrl(url) || url;
  const isWaiting =
    waiting?.connector === "feishu" && (waiting.url === href || waiting.url === url);

  const handleOpen = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!onOpen) return;
    event.preventDefault();
    void (async () => {
      const result = await openExternalUrl(href, "ripple-connector-auth");
      if (!result.opened) return;
      onOpen({ connector: "feishu", tag, url: href, popup: result.popup });
    })();
  };

  return (
    <div className="my-3 overflow-hidden rounded-2xl border border-[#dfe6f4] bg-white/74 shadow-[0_12px_30px_rgba(44,63,123,0.06)] backdrop-blur-xl">
      <div className={`flex items-center gap-2 border-b border-[#dfe6f4] px-4 py-3 ${accentClass}`}>
        <Icon size={16} />
        <span className="text-sm font-semibold">{title}</span>
      </div>
      <div className="space-y-3 px-4 py-3">
        <p className="text-sm font-medium text-[#374151]">{subtitle}</p>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={handleOpen}
          className={connectorAuthLinkClass("info")}
        >
          {isSetup ? "打开飞书页面" : "打开授权页面"}
          <ExternalLink size={13} />
        </a>
        <p className="text-xs font-medium text-[#6b7280]">{hint}</p>
        {isWaiting && (
          <div className="flex items-start gap-2 rounded-xl border border-[#0969da]/20 bg-[#f6fbff] px-3 py-2 text-xs font-medium text-[#374151]">
            <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-[#0969da]" />
            <span>
              正在等待你在浏览器完成飞书操作，Ripple 会自动继续。已等待 {waiting.elapsedSeconds}{" "}
              秒。
            </span>
          </div>
        )}
        <div className="font-[family-name:var(--font-mono)] text-[11px] break-all text-[#6b7280]">
          {url}
        </div>
      </div>
    </div>
  );
}

function GoogleAuthCard({
  url,
  onOpen,
  waiting,
}: {
  url: string;
  onOpen?: (payload: FeishuAuthOpenPayload) => void;
  waiting?: FeishuAuthWaitingState | null;
}) {
  const href = resolveBackendUrl(url) || url;
  const isWaiting =
    waiting?.connector === "google_workspace" && (waiting.url === href || waiting.url === url);

  const handleOpen = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!onOpen) return;
    event.preventDefault();
    void (async () => {
      const result = await openExternalUrl(href, "ripple-connector-auth");
      if (!result.opened) return;
      onOpen({ connector: "google_workspace", tag: "auth", url: href, popup: result.popup });
    })();
  };

  return (
    <div className="my-3 overflow-hidden rounded-2xl border border-[#dfe6f4] bg-white/74 shadow-[0_12px_30px_rgba(44,63,123,0.06)] backdrop-blur-xl">
      <div className="flex items-center gap-2 border-b border-[#dfe6f4] bg-[#eef3ff]/60 px-4 py-3 text-[#2f6bff]">
        <KeyRound size={16} />
        <span className="text-sm font-semibold">授权 Google Workspace</span>
      </div>
      <div className="space-y-3 px-4 py-3">
        <p className="text-sm font-medium text-[#374151]">
          请在 Google 页面选择要绑定的账号并点击允许，授权后 Ripple 会自动继续刚才的请求。
        </p>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={handleOpen}
          className={connectorAuthLinkClass("primary")}
        >
          打开 Google 授权
          <ExternalLink size={13} />
        </a>
        {isWaiting && (
          <div className="flex items-start gap-2 rounded-xl border border-[#2f6bff]/20 bg-[#f6fbff] px-3 py-2 text-xs font-medium text-[#374151]">
            <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-[#2463eb]" />
            <span>
              正在等待你在浏览器完成 Google 授权，Ripple 会自动继续。已等待 {waiting.elapsedSeconds}{" "}
              秒。
            </span>
          </div>
        )}
        <div className="font-[family-name:var(--font-mono)] text-[11px] break-all text-[#6b7280]">
          {url}
        </div>
      </div>
    </div>
  );
}

function BilibiliAuthCard({
  qrcodeImageUrl,
  scanUrl,
  appUrl,
}: {
  qrcodeImageUrl: string;
  scanUrl: string;
  appUrl?: string;
}) {
  const qrSrc = resolveBackendUrl(qrcodeImageUrl) || qrcodeImageUrl;
  const href = resolveBackendUrl(scanUrl) || scanUrl;
  const appHref = appUrl?.trim();

  const handleOpen = (targetHref: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    void openExternalUrl(targetHref, "ripple-connector-auth");
  };

  return (
    <div className="my-3 overflow-hidden rounded-2xl border border-[#dfe6f4] bg-white/74 shadow-[0_12px_30px_rgba(44,63,123,0.06)] backdrop-blur-xl">
      <div className="flex items-center gap-2 border-b border-[#dfe6f4] bg-[#fff4e5]/60 px-4 py-3 text-[#9a3412]">
        <QrCode size={16} />
        <span className="text-sm font-semibold">B 站扫码登录</span>
      </div>
      <div className="space-y-3 px-4 py-3">
        <p className="text-sm font-medium text-[#374151]">
          用 B 站 App 扫描二维码，或手动打开授权链接确认登录。
        </p>
        <div className="flex flex-wrap items-start gap-4">
          <img
            src={qrSrc}
            alt="Bilibili login QR code"
            loading="lazy"
            className="h-36 w-36 rounded-xl border border-[#dfe6f4] bg-white object-contain p-2 shadow-sm"
          />
          <div className="min-w-0 flex-1 space-y-2">
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={handleOpen(href)}
              className={connectorAuthLinkClass("warning")}
            >
              打开 B 站授权链接
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
                打开 B 站 App
                <ExternalLink size={13} />
              </a>
            )}
            <p className="text-xs font-medium text-[#6b7280]">
              扫码或点链接确认后，回到这里发送「好了」。
            </p>
          </div>
        </div>
        <div className="font-[family-name:var(--font-mono)] text-[11px] break-all text-[#6b7280]">
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
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-[#d7dce3] bg-[#f7f8fa]">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-[#eef4ff]"
      >
        <Brain size={14} className="shrink-0 text-[#2463eb]" />
        <span className="text-xs font-semibold text-[#374151]">Thought Process</span>
        <motion.div
          animate={{ rotate: isExpanded ? 90 : 0 }}
          transition={{ duration: 0.1 }}
          className="ml-auto"
        >
          <ChevronRight size={14} className="text-[#6b7280]" />
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
              <div className="markdown-body mt-2 text-sm leading-relaxed text-[#374151]">
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
      segment.type === "feishu" || segment.type === "google" || segment.type === "bilibili"
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
                onOpen={onFeishuAuthOpen}
                waiting={feishuAuthWaiting}
              />
            );
          }
          if (segment.type === "bilibili" && segment.qrcodeImageUrl && segment.url) {
            return (
              <BilibiliAuthCard
                key={index}
                qrcodeImageUrl={segment.qrcodeImageUrl}
                scanUrl={segment.url}
                appUrl={segment.appUrl}
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
            <pre className="not-prose my-4 max-w-full overflow-x-auto overflow-y-hidden rounded-md border border-[#dde2ea] bg-[#f7f8fa] p-4 font-[family-name:var(--font-mono)] text-[13px] [overflow-wrap:normal] whitespace-pre text-[#334155]">
              {children}
            </pre>
          );
        },
        code({ className, children, ...props }) {
          const isInline = !className;
          if (isInline) {
            return (
              <code
                className="rounded border border-[#dde2ea] bg-[#f7f8fa] px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[13px] text-[#171a1f]"
                {...props}
              >
                {children}
              </code>
            );
          }
          return (
            <code className={`${className} text-[13px] leading-relaxed whitespace-pre`} {...props}>
              {children}
            </code>
          );
        },
        a({ href, children }) {
          const wsLink = parseWorkspaceLink(href);

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
            }
          };

          return (
            <a
              href={wsLink ? undefined : resolveBackendUrl(href)}
              target={wsLink ? undefined : "_blank"}
              rel="noopener noreferrer"
              onClick={handleClick}
              className="font-semibold break-words text-[#2463eb] underline underline-offset-4 hover:text-[#174ea6] cursor-pointer"
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
              className={`my-4 block max-h-[420px] max-w-full rounded-lg border border-[#dde2ea] bg-white object-contain ${className ?? ""}`}
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
              onOpen={onFeishuAuthOpen}
              waiting={feishuAuthWaiting}
            />
          );
        }
        if (segment.type === "bilibili" && segment.qrcodeImageUrl && segment.url) {
          return (
            <BilibiliAuthCard
              key={i}
              qrcodeImageUrl={segment.qrcodeImageUrl}
              scanUrl={segment.url}
              appUrl={segment.appUrl}
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
