"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { resolveBackendUrl } from "@/lib/api";
import { openExternalUrl } from "@/lib/platform";

interface SkillDescriptionMarkdownProps {
  content: string;
  className?: string;
  clamp?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}

const ALLOWED_DESCRIPTION_ELEMENTS = ["p", "strong", "em", "code", "a", "br", "del"];

function descriptionTitle(content: string): string {
  return content
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isSafeDescriptionHref(href: string | undefined): href is string {
  if (!href) return false;
  return /^(https?:|mailto:|tel:|sms:)/i.test(href.trim());
}

export function SkillDescriptionMarkdown({
  content,
  className = "",
  clamp = true,
  expanded,
  onToggle,
}: SkillDescriptionMarkdownProps) {
  const normalized = content.trim();
  if (!normalized) return null;
  const isInteractive = Boolean(onToggle);

  return (
    <div
      data-ripple-skill-description="true"
      role={isInteractive ? "button" : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      aria-expanded={isInteractive ? Boolean(expanded) : undefined}
      title={descriptionTitle(normalized) || undefined}
      className={[
        clamp ? "line-clamp-2" : "",
        isInteractive ? "cursor-pointer" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (!onToggle || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        onToggle();
      }}
    >
      <ReactMarkdown
        skipHtml
        unwrapDisallowed
        allowedElements={ALLOWED_DESCRIPTION_ELEMENTS}
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          p({ children }) {
            return <span>{children}</span>;
          },
          strong({ children }) {
            return <strong className="font-semibold text-[#2B2F36]">{children}</strong>;
          },
          em({ children }) {
            return <em className="italic">{children}</em>;
          },
          del({ children }) {
            return <span className="line-through">{children}</span>;
          },
          code({ children }) {
            return (
              <code className="rounded border border-[#DEE0E3] bg-[#F8F9FA] px-1 py-0.5 font-[family-name:var(--font-mono)] text-[0.95em] text-[#2B2F36]">
                {children}
              </code>
            );
          },
          a({ href, children }) {
            const resolvedHref = resolveBackendUrl(href);
            if (!isSafeDescriptionHref(resolvedHref)) {
              return <span className="font-medium text-[#2B2F36]">{children}</span>;
            }

            return (
              <a
                href={resolvedHref}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold break-words text-[#1456F0] underline underline-offset-2"
                onClick={(event) => {
                  event.stopPropagation();
                  event.preventDefault();
                  void openExternalUrl(resolvedHref, "ripple-skill-description-link");
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}
