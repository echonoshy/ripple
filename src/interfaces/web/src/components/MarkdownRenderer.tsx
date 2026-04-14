"use client";

import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import { ChevronRight, Brain } from "lucide-react";
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

interface ContentSegment {
  type: "text" | "thinking";
  content: string;
}

function parseThinkingBlocks(content: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  const regex = /<think>([\s\S]*?)<\/think>/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const text = content.slice(lastIndex, match.index).trim();
      if (text) segments.push({ type: "text", content: text });
    }
    const thinking = match[1].trim();
    if (thinking) segments.push({ type: "thinking", content: thinking });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    const text = content.slice(lastIndex).trim();
    if (text) segments.push({ type: "text", content: text });
  }

  return segments.length > 0 ? segments : [{ type: "text", content }];
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
  const hasThinking = segments.some((s) => s.type === "thinking");

  if (!hasThinking) {
    return (
      <div className={`markdown-body ${className}`}>
        <MarkdownContent content={content} />
      </div>
    );
  }

  return (
    <div className={`markdown-body ${className}`}>
      {segments.map((segment, i) =>
        segment.type === "thinking" ? (
          <ThinkingBlock key={i} content={segment.content} />
        ) : (
          <MarkdownContent key={i} content={segment.content} />
        )
      )}
    </div>
  );
}
