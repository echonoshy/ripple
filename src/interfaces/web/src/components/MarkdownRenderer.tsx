"use client";

import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import { ChevronRight, Brain, ExternalLink, KeyRound, Settings2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { resolveBackendUrl } from "@/lib/api";

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
}

type FeishuTag = "setup" | "auth";

interface ContentSegment {
  type: "text" | "thinking" | "feishu";
  content: string;
  tag?: FeishuTag;
  url?: string;
}

function parseThinkingBlocks(content: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  const regex = /<think>([\s\S]*?)<\/think>/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const text = content.slice(lastIndex, match.index).trim();
      if (text) segments.push(...parseFeishuBlocks(text));
    }
    const thinking = match[1].trim();
    if (thinking) segments.push({ type: "thinking", content: thinking });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    const text = content.slice(lastIndex).trim();
    if (text) segments.push(...parseFeishuBlocks(text));
  }

  return segments.length > 0 ? segments : parseFeishuBlocks(content);
}

/**
 * 识别 bash 工具返回的飞书标签，转换为可交互的按钮卡片。
 *
 * 标签由 `_ensure_lark_cli_if_needed` (bash.py) 或 SKILL 指导下的模型输出产生：
 *   [FEISHU_SETUP] ... https://open.feishu.cn/page/cli?user_code=...
 *   [FEISHU_AUTH]  ... https://accounts.feishu.cn/...
 *
 * 匹配策略：从标签起扫到第一个 http(s) URL（含），整段替换为 feishu 卡片；
 * 前后的普通文本保留为独立的 text segment。
 */
function parseFeishuBlocks(text: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  const re = /\[FEISHU_(SETUP|AUTH)\][\s\S]*?(https?:\/\/\S+)/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      const before = text.slice(last, m.index).trim();
      if (before) segments.push({ type: "text", content: before });
    }
    const tag: FeishuTag = m[1] === "SETUP" ? "setup" : "auth";
    segments.push({ type: "feishu", content: m[0], tag, url: m[2] });
    last = m.index + m[0].length;
  }

  if (last < text.length) {
    const tail = text.slice(last).trim();
    if (tail) segments.push({ type: "text", content: tail });
  }

  return segments.length > 0 ? segments : [{ type: "text", content: text }];
}

function FeishuCard({ tag, url }: { tag: FeishuTag; url: string }) {
  const isSetup = tag === "setup";
  const title = isSetup ? "配置飞书应用" : "飞书授权登录";
  const subtitle = isSetup
    ? "该 session 尚未配置飞书应用。点击下方按钮在浏览器中完成创建。"
    : "AI Agent 请求访问你的飞书数据。点击下方按钮完成授权。";
  const Icon = isSetup ? Settings2 : KeyRound;
  const accentClass = isSetup ? "bg-ripple-cyan/35" : "bg-ripple-lime/45";

  return (
    <div className="border-ripple-ink my-2 overflow-hidden border-2 bg-white shadow-[3px_3px_0_#111111]">
      <div
        className={`border-ripple-ink flex items-center gap-2 border-b-2 px-4 py-3 ${accentClass}`}
      >
        <Icon size={16} className="text-ripple-ink" />
        <span className="text-ripple-ink text-sm font-bold">{title}</span>
      </div>
      <div className="space-y-3 px-4 py-3">
        <p className="text-ripple-ink/65 text-sm font-medium">{subtitle}</p>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-ghost inline-flex items-center gap-1.5 px-3 py-2 text-sm"
        >
          {isSetup ? "打开配置链接" : "打开授权链接"}
          <ExternalLink size={13} />
        </a>
        <div className="text-ripple-ink/50 font-[family-name:var(--font-mono)] text-[11px] break-all">
          {url}
        </div>
      </div>
    </div>
  );
}

function ThinkingBlock({ content }: { content: string }) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="border-ripple-ink bg-ripple-lavender/35 my-2 overflow-hidden border-2 shadow-[3px_3px_0_#111111]">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="hover:bg-ripple-lavender/60 flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors"
      >
        <Brain size={14} className="text-ripple-ink shrink-0" />
        <span className="text-ripple-ink text-xs font-bold">Thought Process</span>
        <motion.div
          animate={{ rotate: isExpanded ? 90 : 0 }}
          transition={{ duration: 0.1 }}
          className="ml-auto"
        >
          <ChevronRight size={14} className="text-ripple-ink/50" />
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
            <div className="border-ripple-ink border-t-2 px-4 pb-3">
              <div className="markdown-body text-ripple-ink/65 mt-2 text-sm leading-relaxed">
                <MarkdownContent content={content} />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MarkdownContent({ content }: { content: string }) {
  const normalized = normalizeLlmMatrixNewlines(content);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex, rehypeHighlight]}
      components={{
        pre({ children }) {
          return (
            <pre className="not-prose border-ripple-ink bg-ripple-terminal my-4 max-w-full overflow-x-auto overflow-y-hidden border-2 p-4 font-[family-name:var(--font-mono)] text-[13px] [overflow-wrap:normal] whitespace-pre text-[#d7d7d7] shadow-[4px_4px_0_#ffd83d]">
              {children}
            </pre>
          );
        },
        code({ className, children, ...props }) {
          const isInline = !className;
          if (isInline) {
            return (
              <code
                className="border-ripple-ink bg-ripple-yellow/50 text-ripple-ink border-2 px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[13px]"
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
          return (
            <a
              href={resolveBackendUrl(href)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-ripple-pink hover:bg-ripple-pink font-bold break-words underline underline-offset-4 hover:text-white"
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
              className={`border-ripple-ink my-4 block max-h-[420px] max-w-full border-2 bg-white object-contain shadow-[4px_4px_0_#111111] ${className ?? ""}`}
              {...rest}
            />
          );
        },
        table({ children }) {
          return (
            <div className="my-4 max-w-full overflow-x-auto pb-1">
              <table className="min-w-full border-collapse text-sm shadow-[4px_4px_0_#111111]">
                {children}
              </table>
            </div>
          );
        },
        th({ children }) {
          return (
            <th className="border-ripple-ink bg-ripple-lavender text-ripple-ink border-2 px-3 py-2 text-left text-sm font-black">
              {children}
            </th>
          );
        },
        td({ children }) {
          return (
            <td className="border-ripple-ink text-ripple-ink border-2 px-3 py-2">{children}</td>
          );
        },
      }}
    >
      {normalized}
    </ReactMarkdown>
  );
}

export default function MarkdownRenderer({ content, className = "" }: MarkdownRendererProps) {
  const segments = parseThinkingBlocks(content);
  const hasSpecial = segments.some((s) => s.type !== "text");

  if (!hasSpecial) {
    return (
      <div className={`markdown-body ${className}`}>
        <MarkdownContent content={content} />
      </div>
    );
  }

  return (
    <div className={`markdown-body ${className}`}>
      {segments.map((segment, i) => {
        if (segment.type === "thinking") {
          return <ThinkingBlock key={i} content={segment.content} />;
        }
        if (segment.type === "feishu" && segment.url && segment.tag) {
          return <FeishuCard key={i} tag={segment.tag} url={segment.url} />;
        }
        return <MarkdownContent key={i} content={segment.content} />;
      })}
    </div>
  );
}
