import React, { useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { Wrench, Loader2, CheckCircle2, Circle, ListTodo, Settings } from "lucide-react";
import { TaskInfo, TaskProgress, ToolCall } from "@/types";
import { formatTerminalOutputPreview, TERMINAL_OUTPUT_PREVIEW_LIMIT } from "@/lib/terminalOutput";

interface TaskExecutionPanelProps {
  tasks: TaskInfo[];
  taskProgress: TaskProgress | null;
  toolCalls: ToolCall[];
  isGenerating: boolean;
}

export default function TaskExecutionPanel({
  tasks,
  taskProgress,
  toolCalls,
}: TaskExecutionPanelProps) {
  const [topHeight, setTopHeight] = useState(250);
  const isResizingRef = useRef(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll logs to bottom
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [toolCalls]);

  const handleVerticalResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    const startY = e.clientY;
    const startHeight = topHeight;
    const onMove = (ev: MouseEvent) => {
      if (!isResizingRef.current) return;
      setTopHeight(
        Math.max(100, Math.min(window.innerHeight - 100, startHeight + ev.clientY - startY))
      );
    };
    const onUp = () => {
      isResizingRef.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const hasTopContent = tasks.length > 0;

  return (
    <div className="bg-ripple-sidebar flex h-full flex-col overflow-hidden">
      {/* Top Section: Tasks (Light) */}
      {hasTopContent && (
        <>
          <div
            style={{ height: topHeight, flexShrink: 0 }}
            className="bg-ripple-sidebar flex flex-col space-y-5 overflow-y-auto p-4"
          >
            {/* Tasks Section */}
            {tasks.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-ripple-ink/65 flex items-center gap-2 text-xs font-bold tracking-wider uppercase">
                  <ListTodo size={14} />
                  Tasks
                </h3>
                <div className="border-ripple-ink overflow-hidden border-2 bg-white shadow-[4px_4px_0_#111111]">
                  <div className="border-ripple-ink bg-ripple-lime/55 border-b-2 px-4 py-3">
                    <div className="flex items-center justify-between">
                      <span className="text-ripple-ink text-xs font-bold">Progress</span>
                      {taskProgress && (
                        <span className="brutal-stamp bg-white">
                          {Math.round((taskProgress.completed / taskProgress.total) * 100)}%
                        </span>
                      )}
                    </div>
                    {taskProgress && (
                      <div className="mt-3 flex h-4 w-full gap-1">
                        {Array.from({ length: taskProgress.total }).map((_, i) => (
                          <motion.div
                            key={i}
                            className={`border-ripple-ink h-full flex-1 border-2 ${
                              i < taskProgress.completed ? "bg-ripple-lime" : "bg-white"
                            }`}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ delay: i * 0.1 }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="max-h-60 overflow-y-auto p-2">
                    <div className="space-y-0.5">
                      {tasks.map((task) => (
                        <div
                          key={task.id}
                          className={`flex items-start gap-3 border-2 p-2 transition-colors ${
                            task.status === "in_progress"
                              ? "border-ripple-ink bg-ripple-yellow/35"
                              : "border-transparent"
                          }`}
                        >
                          <div className="mt-0.5 flex-shrink-0">
                            {task.status === "completed" ? (
                              <motion.div
                                initial={{ scale: 0, rotate: -90 }}
                                animate={{ scale: 1, rotate: 0 }}
                                transition={{
                                  type: "spring",
                                  stiffness: 500,
                                  damping: 25,
                                }}
                              >
                                <CheckCircle2 size={16} className="text-ripple-ink" />
                              </motion.div>
                            ) : task.status === "in_progress" ? (
                              <Loader2 size={16} className="text-ripple-ink animate-spin" />
                            ) : (
                              <Circle size={16} className="text-ripple-ink/45" />
                            )}
                          </div>
                          <div className="flex-1">
                            <p
                              className={`text-sm ${
                                task.status === "completed"
                                  ? "text-ripple-ink/45 line-through"
                                  : task.status === "in_progress"
                                    ? "text-ripple-ink font-bold"
                                    : "text-ripple-ink/65"
                              }`}
                            >
                              {task.subject}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Vertical Resizer */}
          <div
            className="border-ripple-ink bg-ripple-yellow hover:bg-ripple-pink z-10 h-2 w-full shrink-0 cursor-row-resize border-y-2 transition-colors"
            onMouseDown={handleVerticalResizeStart}
          />
        </>
      )}

      {/* Bottom Section: Live Terminal Logs */}
      <div className="border-ripple-ink m-4 flex flex-1 flex-col overflow-hidden rounded-lg border-2 bg-white shadow-[4px_4px_0_#111111]">
        <div className="terminal-titlebar">
          <Wrench size={13} className="text-ripple-ink" />
          <span className="text-[13px] font-bold tracking-wider uppercase">Terminal</span>
        </div>
        <div className="bg-ripple-paper flex-1 overflow-y-auto p-4 font-[family-name:var(--font-mono)] text-[13px] leading-relaxed text-ripple-ink/80">
          {toolCalls.length === 0 ? (
            <div className="flex h-full items-center justify-center text-[13px] text-ripple-ink/50">
              {">"} Ready
              <span
                className="bg-ripple-yellow ml-1 inline-block h-[15px] w-0.5"
                style={{ animation: "blink-cursor 1s step-end infinite" }}
              />
            </div>
          ) : (
            <div className="space-y-2 pb-8">
              {toolCalls.map((tool) => {
                const resultPreview =
                  typeof tool.result === "string" ? formatTerminalOutputPreview(tool.result) : null;

                return (
                  <motion.div
                    key={tool.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2 }}
                    className="hover-glow-card border-ripple-ink rounded-md border-2 bg-white p-3 font-mono text-[12px]"
                  >
                    <div className="flex items-center gap-2 text-ripple-ink">
                      <Settings size={12} className="text-ripple-pink" />
                      <span className="font-bold">{tool.name}</span>
                      <span
                        className={`rounded-sm border-2 px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                          tool.status === "running"
                            ? "border-ripple-pink text-ripple-pink bg-ripple-pink/10"
                            : "border-ripple-ink text-ripple-ink bg-ripple-lime/30"
                        }`}
                      >
                        {tool.status === "running" ? "running..." : "done"}
                      </span>
                      {tool.status === "running" && (
                        <Loader2 size={10} className="text-ripple-pink ml-auto animate-spin" />
                      )}
                    </div>
                    <div className="border-ripple-ink/20 mt-2 ml-4 space-y-2 border-l-2 pl-3">
                      <div>
                        <span className="text-ripple-ink/40 select-none font-bold">{"// args"}</span>
                        <pre className="text-ripple-ink/75 mt-1 overflow-x-auto break-all whitespace-pre-wrap">
                          {typeof tool.arguments === "string"
                            ? tool.arguments
                            : JSON.stringify(tool.arguments, null, 2)}
                        </pre>
                      </div>
                      {resultPreview && (
                        <div>
                          <span className="text-ripple-ink/40 select-none font-bold">{"// result"}</span>
                          <pre className="text-ripple-ink/65 mt-1 overflow-x-auto break-all whitespace-pre-wrap">
                            {resultPreview.text}
                          </pre>
                          {resultPreview.isTruncated && (
                            <div className="border-ripple-pink text-ripple-pink mt-2 rounded-sm border-2 px-2 py-1 text-[10px] font-bold uppercase">
                              Showing first {TERMINAL_OUTPUT_PREVIEW_LIMIT.toLocaleString()} chars;
                              {resultPreview.hiddenChars.toLocaleString()} chars hidden in UI.
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </motion.div>
                );
              })}
              <div ref={logsEndRef} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
