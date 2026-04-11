"use client";

import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { ChevronRight, Brain } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

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
    <div className="my-2 overflow-hidden rounded-xl border border-violet-200/60 bg-violet-50/50">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-violet-100/50"
      >
        <Brain size={14} className="shrink-0 text-violet-500" />
        <span className="text-sm font-semibold text-violet-600">Thinking Process</span>
        <motion.div
          animate={{ rotate: isExpanded ? 90 : 0 }}
          transition={{ duration: 0.2 }}
          className="ml-auto"
        >
          <ChevronRight size={14} className="text-violet-400" />
        </motion.div>
      </button>
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="border-t border-violet-200/40 px-4 pb-3">
              <div className="markdown-body mt-2 text-sm leading-relaxed text-slate-600">
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
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        pre({ children }) {
          return (
            <pre className="not-prose my-3 overflow-x-auto rounded-xl bg-slate-900 p-4 text-sm">
              {children}
            </pre>
          );
        },
        code({ className, children, ...props }) {
          const isInline = !className;
          if (isInline) {
            return (
              <code
                className="rounded-md border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[13px] font-medium text-violet-600"
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
              className="text-violet-600 underline underline-offset-2 hover:text-violet-700"
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
            <th className="border border-slate-200 bg-slate-50 px-3 py-2 text-left font-semibold">
              {children}
            </th>
          );
        },
        td({ children }) {
          return <td className="border border-slate-200 px-3 py-2">{children}</td>;
        },
      }}
    >
      {content}
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
