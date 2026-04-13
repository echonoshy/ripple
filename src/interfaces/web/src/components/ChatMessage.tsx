import React from "react";
import { motion } from "framer-motion";
import { User, Loader2 } from "lucide-react";
import { Message } from "@/types";
import MarkdownRenderer from "./MarkdownRenderer";

const RippleIcon = ({ size = 24, className = "" }: { size?: number; className?: string }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <circle cx="12" cy="12" r="10" opacity="0.3" />
    <circle cx="12" cy="12" r="6" opacity="0.6" />
    <circle cx="12" cy="12" r="2" />
  </svg>
);

interface ChatMessageProps {
  msg: Message;
  isGenerating: boolean;
  isLast: boolean;
}

export default function ChatMessage({ msg, isGenerating, isLast }: ChatMessageProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.4, ease: [0.23, 1, 0.32, 1] }}
      className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}
    >
      {/* Avatar */}
      <div
        className={`mb-2 flex items-center gap-2 px-1 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}
      >
        <div
          className={`flex h-6 w-6 items-center justify-center rounded-full shadow-sm ${msg.role === "user" ? "bg-gradient-to-br from-blue-400 to-indigo-500" : "bg-gradient-to-br from-violet-500 to-fuchsia-500"}`}
        >
          {msg.role === "user" ? (
            <User size={12} className="text-white" />
          ) : (
            <RippleIcon size={12} className="text-white" />
          )}
        </div>
        <span className="text-xs font-bold tracking-wider text-slate-400 uppercase">
          {msg.role === "user" ? "You" : "Ripple"}
        </span>
      </div>

      {/* Message Bubble */}
      {msg.role === "user" ? (
        <div className="max-w-[80%] rounded-3xl rounded-tr-sm bg-gradient-to-br from-blue-500 to-indigo-600 p-5 text-[15px] leading-relaxed text-white shadow-sm shadow-blue-500/20">
          <div className="whitespace-pre-wrap">{msg.content}</div>
        </div>
      ) : (
        <div className="w-full space-y-3 md:max-w-[90%]">
          {/* Initial Loading Indicator */}
          {isGenerating &&
            !msg.content &&
            (!msg.toolCalls || msg.toolCalls.length === 0) &&
            isLast && (
              <div className="glass-bubble inline-flex items-center gap-2 rounded-2xl rounded-tl-sm p-4 text-slate-400 shadow-sm">
                <Loader2 size={16} className="animate-spin" />
                <span className="text-sm">Thinking...</span>
              </div>
            )}

          {/* Text Content */}
          {msg.content && (
            <div className="glass-bubble rounded-2xl rounded-tl-sm p-5 text-[15px] leading-relaxed text-slate-700 shadow-sm">
              <MarkdownRenderer content={msg.content} />
            </div>
          )}

          {/* Active Generation Indicator */}
          {isGenerating && isLast && (msg.toolCalls?.length || msg.content) ? (
            <div className="flex animate-pulse items-center gap-2 px-2 py-2 text-sm text-slate-400">
              <Loader2 size={16} className="animate-spin" />
              <span>
                {msg.toolCalls && msg.toolCalls.some((t) => t.status === "running")
                  ? "Executing tool..."
                  : "Thinking..."}
              </span>
            </div>
          ) : null}
        </div>
      )}
    </motion.div>
  );
}
