"use client";

import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import { ChevronRight, Brain, ExternalLink, KeyRound, Settings2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

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
  const accent = isSetup ? "#3b82f6" : "#10b981";

  return (
    <div
      className="my-2 overflow-hidden rounded-xl border bg-[#18181b]"
      style={{ borderColor: `${accent}40` }}
    >
      <div className="flex items-center gap-2 px-4 py-3" style={{ backgroundColor: `${accent}14` }}>
        <Icon size={16} style={{ color: accent }} />
        <span className="text-sm font-medium" style={{ color: accent }}>
          {title}
        </span>
      </div>
      <div className="space-y-3 px-4 py-3">
        <p className="text-sm text-[#a1a1aa]">{subtitle}</p>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors"
          style={{
            borderColor: `${accent}66`,
            color: accent,
            backgroundColor: `${accent}0d`,
          }}
        >
          {isSetup ? "打开配置链接" : "打开授权链接"}
          <ExternalLink size={13} />
        </a>
        <div className="font-[family-name:var(--font-mono)] text-[11px] break-all text-[#52525b]">
          {url}
        </div>
      </div>
    </div>
  );
}

function ThinkingBlock({ content }: { content: string }) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-[#10b981]/20 bg-[#10b981]/[0.03]">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 rounded-t-xl px-4 py-2.5 text-left transition-colors hover:bg-[#10b981]/[0.05]"
      >
        <Brain size={14} className="shrink-0 text-[#10b981]" />
        <span className="text-xs font-medium text-[#10b981]">Thought Process</span>
        <motion.div
          animate={{ rotate: isExpanded ? 90 : 0 }}
          transition={{ duration: 0.1 }}
          className="ml-auto"
        >
          <ChevronRight size={14} className="text-[#10b981]/50" />
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
            <div className="border-t border-[#10b981]/10 px-4 pb-3">
              <div className="markdown-body mt-2 text-sm leading-relaxed text-[#a1a1aa]">
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
            <pre className="not-prose my-3 overflow-x-auto rounded-lg border border-[#27272a] bg-[#09090b] p-4 font-[family-name:var(--font-mono)] text-[13px]">
              {children}
            </pre>
          );
        },
        code({ className, children, ...props }) {
          const isInline = !className;
          if (isInline) {
            return (
              <code
                className="rounded-md border border-[#3f3f46] bg-[#27272a] px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[13px] text-[#60a5fa]"
                {...props}
              >
                {children}
              </code>
            );
          }
          return (
            <code className={`${className} text-[13px] leading-relaxed`} {...props}>
              {children}
            </code>
          );
        },
        a({ href, children }) {
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#3b82f6] underline underline-offset-2 hover:text-[#60a5fa]"
            >
              {children}
            </a>
          );
        },
        table({ children }) {
          return (
            <div className="my-3 overflow-x-auto">
              <table className="min-w-full border-collapse text-sm">{children}</table>
            </div>
          );
        },
        th({ children }) {
          return (
            <th className="border border-[#27272a] bg-[#27272a] px-3 py-2 text-left text-sm font-medium text-[#fafafa]">
              {children}
            </th>
          );
        },
        td({ children }) {
          return <td className="border border-[#27272a] px-3 py-2 text-[#fafafa]">{children}</td>;
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
