import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Wrench,
  ChevronRight,
  Loader2,
  CheckCircle2,
  Circle,
  ListTodo,
  AlertTriangle,
} from "lucide-react";
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
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});

  const toggleTool = (id: string) => {
    setExpandedTools((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-slate-50/50">
      <div className="flex-1 space-y-6 overflow-y-auto p-4">
        {/* Tasks Section */}
        {tasks.length > 0 && (
          <div className="space-y-3">
            <h3 className="flex items-center gap-2 text-xs font-bold tracking-wider text-slate-400 uppercase">
              <ListTodo size={14} />
              Tasks & Progress
            </h3>
            <div className="overflow-hidden rounded-2xl border border-slate-200/60 bg-white/90 shadow-sm backdrop-blur-md">
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
                      className={`flex items-start gap-3 rounded-xl p-2 transition-colors ${task.status === "in_progress" ? "bg-violet-50/50" : ""}`}
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

        {/* Tool Calls Section */}
        {toolCalls.length > 0 && (
          <div className="space-y-3">
            <h3 className="flex items-center gap-2 text-xs font-bold tracking-wider text-slate-400 uppercase">
              <Wrench size={14} />
              Execution Logs
            </h3>
            <div className="space-y-2">
              {[...toolCalls].reverse().map((tool) => (
                <div
                  key={tool.id}
                  className="overflow-hidden rounded-2xl border border-slate-200/60 bg-white/70 shadow-sm backdrop-blur-sm"
                >
                  <motion.div
                    whileHover={{ backgroundColor: "rgba(241, 245, 249, 1)" }}
                    className="flex cursor-pointer items-center justify-between p-3 px-4 transition-colors"
                    onClick={() => toggleTool(tool.id)}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`rounded-lg p-1.5 ${tool.status === "running" ? "bg-amber-100 text-amber-600" : "bg-emerald-100 text-emerald-600"}`}
                      >
                        <Wrench
                          size={14}
                          className={tool.status === "running" ? "animate-spin" : ""}
                        />
                      </div>
                      <span className="font-[family-name:var(--font-mono)] text-sm font-bold text-slate-700">
                        {tool.name}
                      </span>
                      <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs font-medium text-slate-400">
                        {tool.status === "running" ? "Running..." : "Success"}
                      </span>
                    </div>
                    <motion.div
                      animate={{ rotate: expandedTools[tool.id] ? 90 : 0 }}
                      transition={{ duration: 0.2 }}
                    >
                      <ChevronRight size={18} className="text-slate-400" />
                    </motion.div>
                  </motion.div>

                  <AnimatePresence>
                    {expandedTools[tool.id] && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.3, ease: "easeInOut" }}
                        className="overflow-hidden"
                      >
                        <div className="border-t border-slate-200/50 bg-slate-900 p-4 font-[family-name:var(--font-mono)] text-[13px] text-emerald-400">
                          <div className="mb-3">
                            <span className="text-slate-500 select-none">{"// Arguments"}</span>
                            <pre className="mt-1.5 overflow-x-auto opacity-90">
                              {typeof tool.arguments === "string"
                                ? tool.arguments
                                : JSON.stringify(tool.arguments, null, 2)}
                            </pre>
                          </div>
                          {tool.result && (
                            <div>
                              <span className="text-slate-500 select-none">{"// Result"}</span>
                              <pre className="mt-1.5 max-h-64 overflow-x-auto overflow-y-auto whitespace-pre-wrap text-slate-300 opacity-90">
                                {tool.result}
                              </pre>
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              ))}
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
            <div className="rounded-2xl border border-amber-200 bg-white p-4 shadow-sm">
              <p className="mb-2 text-sm font-medium text-slate-700">
                Tool: <span className="font-mono text-amber-600">{permissionRequest.tool}</span>
              </p>
              <div className="mb-4 overflow-x-auto rounded-xl bg-slate-50 p-3 font-mono text-xs text-slate-600">
                {typeof permissionRequest.params === "string"
                  ? permissionRequest.params
                  : JSON.stringify(permissionRequest.params, null, 2)}
              </div>
              <div className="flex flex-col gap-2">
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => onPermissionResolve("allow")}
                  className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-emerald-600"
                >
                  Allow Once
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => onPermissionResolve("always")}
                  className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700 shadow-sm transition-colors hover:bg-emerald-100"
                >
                  Always Allow for this Session
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => onPermissionResolve("deny")}
                  className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-600 shadow-sm transition-colors hover:bg-red-100"
                >
                  Deny
                </motion.button>
              </div>
            </div>
          </div>
        )}

        {askUser && askUser.options.length > 0 && !isGenerating && (
          <div className="space-y-3">
            <h3 className="flex items-center gap-2 text-xs font-bold tracking-wider text-slate-400 uppercase">
              <AlertTriangle size={14} />
              Action Required
            </h3>
            <div className="rounded-2xl border border-violet-200 bg-white p-4 shadow-sm">
              <p className="mb-3 text-sm font-medium text-slate-700">{askUser.question}</p>
              <div className="flex flex-wrap gap-2">
                {askUser.options.map((option, i) => (
                  <motion.button
                    key={i}
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => onQuickReply(option)}
                    className="rounded-xl border border-violet-200 bg-white px-4 py-2 text-sm font-medium text-violet-700 shadow-sm transition-colors hover:border-violet-300 hover:bg-violet-50"
                  >
                    {option}
                  </motion.button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
