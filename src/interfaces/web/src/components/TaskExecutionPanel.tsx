import React, { useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { Wrench, Loader2, CheckCircle2, Circle, ListTodo, AlertTriangle } from "lucide-react";
import { TaskInfo, TaskProgress, ToolCall, AskUserData, PermissionRequestData } from "@/types";

interface TaskExecutionPanelProps {
  tasks: TaskInfo[];
  taskProgress: TaskProgress | null;
  toolCalls: ToolCall[];
  askUser?: AskUserData;
  permissionRequest?: PermissionRequestData;
  onQuickReply: (option: string) => void;
  onPermissionResolve: (action: "allow" | "always" | "deny") => void;
  isGenerating: boolean;
}

export default function TaskExecutionPanel({
  tasks,
  taskProgress,
  toolCalls,
  askUser,
  permissionRequest,
  onQuickReply,
  onPermissionResolve,
  isGenerating,
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

  const hasTopContent =
    tasks.length > 0 || (permissionRequest && !isGenerating) || (askUser && !isGenerating);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#0d1117]">
      {/* Top Section: Tasks & Prompts */}
      {hasTopContent && (
        <>
          <div
            style={{ height: topHeight, flexShrink: 0 }}
            className="flex flex-col space-y-5 overflow-y-auto bg-slate-50 p-4"
          >
            {/* Tasks Section */}
            {tasks.length > 0 && (
              <div className="space-y-3">
                <h3 className="flex items-center gap-2 text-xs font-bold tracking-wider text-slate-400 uppercase">
                  <ListTodo size={14} />
                  Tasks & Progress
                </h3>
                <div className="overflow-hidden rounded-xl border border-slate-200/60 bg-white shadow-sm">
                  <div className="border-b border-slate-100 bg-slate-50/50 px-4 py-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-slate-700">Execution Plan</span>
                      {taskProgress && (
                        <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-bold text-violet-700">
                          {Math.round((taskProgress.completed / taskProgress.total) * 100)}%
                        </span>
                      )}
                    </div>
                    {taskProgress && (
                      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                        <motion.div
                          className="h-full bg-gradient-to-r from-violet-500 to-fuchsia-500"
                          initial={{ width: 0 }}
                          animate={{
                            width: `${(taskProgress.completed / taskProgress.total) * 100}%`,
                          }}
                          transition={{ duration: 0.5, ease: "easeOut" }}
                        />
                      </div>
                    )}
                  </div>
                  <div className="max-h-60 overflow-y-auto p-2">
                    <div className="space-y-1">
                      {tasks.map((task) => (
                        <div
                          key={task.id}
                          className={`flex items-start gap-3 rounded-lg p-2 transition-colors ${task.status === "in_progress" ? "bg-violet-50/50" : ""}`}
                        >
                          <div className="mt-0.5 flex-shrink-0">
                            {task.status === "completed" ? (
                              <CheckCircle2 size={16} className="text-emerald-500" />
                            ) : task.status === "in_progress" ? (
                              <Loader2 size={16} className="animate-spin text-violet-500" />
                            ) : (
                              <Circle size={16} className="text-slate-300" />
                            )}
                          </div>
                          <div className="flex-1">
                            <p
                              className={`text-sm ${
                                task.status === "completed"
                                  ? "text-slate-400 line-through"
                                  : task.status === "in_progress"
                                    ? "font-medium text-violet-700"
                                    : "text-slate-600"
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

            {/* Interactive Prompts Section */}
            {permissionRequest && !isGenerating && (
              <div className="space-y-3">
                <h3 className="flex items-center gap-2 text-xs font-bold tracking-wider text-amber-500 uppercase">
                  <AlertTriangle size={14} />
                  Permission Required
                </h3>
                <div className="rounded-xl border border-amber-200 bg-white p-4 shadow-sm">
                  <p className="mb-2 text-sm font-medium text-slate-700">
                    Tool: <span className="font-mono text-amber-600">{permissionRequest.tool}</span>
                  </p>
                  <div className="mb-4 overflow-x-auto rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-600">
                    {typeof permissionRequest.params === "string"
                      ? permissionRequest.params
                      : JSON.stringify(permissionRequest.params, null, 2)}
                  </div>
                  <div className="flex flex-col gap-2">
                    <motion.button
                      whileHover={{ scale: 1.01 }}
                      whileTap={{ scale: 0.99 }}
                      onClick={() => onPermissionResolve("allow")}
                      className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-emerald-600"
                    >
                      Allow Once
                    </motion.button>
                    <motion.button
                      whileHover={{ scale: 1.01 }}
                      whileTap={{ scale: 0.99 }}
                      onClick={() => onPermissionResolve("always")}
                      className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700 shadow-sm transition-colors hover:bg-emerald-100"
                    >
                      Always Allow for this Session
                    </motion.button>
                    <motion.button
                      whileHover={{ scale: 1.01 }}
                      whileTap={{ scale: 0.99 }}
                      onClick={() => onPermissionResolve("deny")}
                      className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-600 shadow-sm transition-colors hover:bg-red-100"
                    >
                      Deny
                    </motion.button>
                  </div>
                </div>
              </div>
            )}

            {askUser && !isGenerating && (
              <div className="space-y-3">
                <h3 className="flex items-center gap-2 text-xs font-bold tracking-wider text-slate-400 uppercase">
                  <AlertTriangle size={14} />
                  Action Required
                </h3>
                <div className="rounded-xl border border-violet-200 bg-white p-4 shadow-sm">
                  <p className="mb-3 text-sm font-medium text-slate-700">{askUser.question}</p>
                  {askUser.options && askUser.options.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {askUser.options.map((option, i) => (
                        <motion.button
                          key={i}
                          whileHover={{ scale: 1.02 }}
                          whileTap={{ scale: 0.98 }}
                          onClick={() => onQuickReply(option)}
                          className="rounded-lg border border-violet-200 bg-white px-4 py-2 text-sm font-medium text-violet-700 shadow-sm transition-colors hover:border-violet-300 hover:bg-violet-50"
                        >
                          {option}
                        </motion.button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500 italic">请在下方输入框中回复此问题。</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Vertical Resizer */}
          <div
            className="z-10 h-1.5 w-full shrink-0 cursor-row-resize bg-slate-200 transition-colors hover:bg-violet-400"
            onMouseDown={handleVerticalResizeStart}
          />
        </>
      )}

      {/* Bottom Section: Live Terminal Logs */}
      <div className="flex-1 overflow-y-auto bg-[#0d1117] p-4 font-[family-name:var(--font-mono)] text-[13px] text-slate-300">
        {toolCalls.length === 0 ? (
          <div className="flex h-full items-center justify-center text-slate-600 italic">
            Waiting for execution logs...
          </div>
        ) : (
          <div className="space-y-8 pb-8">
            {toolCalls.map((tool) => (
              <div key={tool.id} className="space-y-2">
                <div className="flex items-center gap-2 text-violet-400">
                  <Wrench size={14} className={tool.status === "running" ? "animate-spin" : ""} />
                  <span className="font-bold">{tool.name}</span>
                  <span className="text-xs text-slate-500">
                    {tool.status === "running" ? "Running..." : "Success"}
                  </span>
                </div>
                <div className="space-y-3 border-l-2 border-slate-800 pl-4">
                  <div>
                    <span className="text-slate-500 select-none">{"// Arguments"}</span>
                    <pre className="mt-1 overflow-x-auto break-all whitespace-pre-wrap text-emerald-400 opacity-90">
                      {typeof tool.arguments === "string"
                        ? tool.arguments
                        : JSON.stringify(tool.arguments, null, 2)}
                    </pre>
                  </div>
                  {tool.result && (
                    <div>
                      <span className="text-slate-500 select-none">{"// Result"}</span>
                      <pre className="mt-1 overflow-x-auto break-all whitespace-pre-wrap text-slate-300 opacity-90">
                        {tool.result}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        )}
      </div>
    </div>
  );
}
