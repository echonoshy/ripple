import React, { useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { Wrench, Loader2, CheckCircle2, Circle, ListTodo } from "lucide-react";
import { TaskInfo, TaskProgress, ToolCall } from "@/types";

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
    <div className="flex h-full flex-col overflow-hidden bg-[#09090b]">
      {/* Top Section: Tasks (Light) */}
      {hasTopContent && (
        <>
          <div
            style={{ height: topHeight, flexShrink: 0 }}
            className="flex flex-col space-y-5 overflow-y-auto bg-[#18181b] p-4"
          >
            {/* Tasks Section */}
            {tasks.length > 0 && (
              <div className="space-y-3">
                <h3 className="flex items-center gap-2 text-xs font-medium tracking-wider text-[#a1a1aa] uppercase">
                  <ListTodo size={14} />
                  Tasks
                </h3>
                <div className="overflow-hidden rounded-xl border border-[#27272a] bg-[#18181b]">
                  <div className="border-b border-[#27272a] bg-[#18181b] px-4 py-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-[#a1a1aa]">Progress</span>
                      {taskProgress && (
                        <span className="rounded-md border border-[#10b981]/30 bg-[#10b981]/10 px-2 py-0.5 font-[family-name:var(--font-mono)] text-xs text-[#10b981]">
                          {Math.round((taskProgress.completed / taskProgress.total) * 100)}%
                        </span>
                      )}
                    </div>
                    {taskProgress && (
                      <div className="mt-3 flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full bg-white/[0.06]">
                        {Array.from({ length: taskProgress.total }).map((_, i) => (
                          <motion.div
                            key={i}
                            className={`h-full flex-1 rounded-full ${i < taskProgress.completed ? "bg-[#10b981]" : "bg-white/[0.06]"}`}
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
                          className={`flex items-start gap-3 rounded-lg p-2 transition-colors ${task.status === "in_progress" ? "bg-[#10b981]/[0.04]" : ""}`}
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
                                <CheckCircle2 size={16} className="text-[#10b981]" />
                              </motion.div>
                            ) : task.status === "in_progress" ? (
                              <Loader2 size={16} className="animate-spin text-[#f59e0b]" />
                            ) : (
                              <Circle size={16} className="text-[#71717a]" />
                            )}
                          </div>
                          <div className="flex-1">
                            <p
                              className={`text-sm ${
                                task.status === "completed"
                                  ? "text-[#71717a] line-through"
                                  : task.status === "in_progress"
                                    ? "text-[#fafafa]"
                                    : "text-[#a1a1aa]"
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
            className="z-10 h-1 w-full shrink-0 cursor-row-resize bg-[#09090b] transition-colors hover:bg-[#10b981]/20"
            onMouseDown={handleVerticalResizeStart}
          />
        </>
      )}

      {/* Bottom Section: Live Terminal Logs (STAYS DARK) */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-[#27272a] bg-[#09090b] px-4 py-2">
          <Wrench size={13} className="text-[#10b981]" />
          <span className="text-[13px] font-medium tracking-wider text-[#10b981] uppercase">
            Terminal
          </span>
        </div>
        <div className="flex-1 overflow-y-auto bg-[#09090b] p-4 font-[family-name:var(--font-mono)] text-[13px] leading-relaxed text-[#10b981]">
          {toolCalls.length === 0 ? (
            <div className="flex h-full items-center justify-center text-[13px] text-[#71717a]">
              {">"} Ready
              <span
                className="ml-1 inline-block h-[15px] w-0.5 rounded-full bg-[#10b981]"
                style={{ animation: "blink-cursor 1s step-end infinite" }}
              />
            </div>
          ) : (
            <div className="space-y-6 pb-8">
              {toolCalls.map((tool) => (
                <motion.div
                  key={tool.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.2 }}
                  className="space-y-2"
                >
                  <div className="flex items-center gap-2 text-[13px] text-[#f59e0b]">
                    <Wrench size={13} className={tool.status === "running" ? "animate-spin" : ""} />
                    <span className="font-medium">{tool.name}</span>
                    <span className="text-[12px] text-[#71717a]">
                      {tool.status === "running" ? "running" : "done"}
                    </span>
                  </div>
                  <div className="space-y-3 border-l border-[#10b981]/20 pl-4">
                    <div>
                      <span className="text-[12px] text-[#71717a] select-none">{"// args"}</span>
                      <pre className="mt-1 overflow-x-auto text-[13px] break-all whitespace-pre-wrap text-[#3b82f6] opacity-90">
                        {typeof tool.arguments === "string"
                          ? tool.arguments
                          : JSON.stringify(tool.arguments, null, 2)}
                      </pre>
                    </div>
                    {tool.result && (
                      <div>
                        <span className="text-[12px] text-[#71717a] select-none">
                          {"// result"}
                        </span>
                        <pre className="mt-1 overflow-x-auto text-[13px] break-all whitespace-pre-wrap text-[#10b981] opacity-90">
                          {tool.result}
                        </pre>
                      </div>
                    )}
                  </div>
                </motion.div>
              ))}
              <div ref={logsEndRef} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
