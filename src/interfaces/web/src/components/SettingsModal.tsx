"use client";

import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Brain, Wrench, Sparkles, Server, KeyRound } from "lucide-react";
import { SystemInfo } from "@/types";
import { fetchSystemInfo } from "@/lib/api";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  thinkingEnabled: boolean;
  onThinkingToggle: (enabled: boolean) => void;
  apiKey: string | null;
  onApiKeyChange: () => void;
}

export default function SettingsModal({
  isOpen,
  onClose,
  thinkingEnabled,
  onThinkingToggle,
  apiKey,
  onApiKeyChange,
}: SettingsModalProps) {
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen && !systemInfo) {
      const timer = setTimeout(() => setLoading(true), 0);
      fetchSystemInfo()
        .then((info) => {
          clearTimeout(timer);
          setSystemInfo(info);
          setLoading(false);
        })
        .catch(() => {
          clearTimeout(timer);
          setLoading(false);
        });
    }
  }, [isOpen, systemInfo]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4"
          >
            <div className="pointer-events-auto max-h-[80vh] w-full max-w-lg overflow-hidden rounded-3xl bg-white shadow-2xl shadow-slate-300/50">
              {/* Header */}
              <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
                <h2 className="text-lg font-bold text-slate-800">Settings</h2>
                <button
                  onClick={onClose}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 transition-colors hover:bg-slate-200"
                >
                  <X size={16} className="text-slate-500" />
                </button>
              </div>

              <div className="max-h-[calc(80vh-64px)] space-y-6 overflow-y-auto p-6">
                {/* Thinking Mode */}
                <div>
                  <h3 className="mb-3 text-sm font-bold tracking-wider text-slate-500 uppercase">
                    Preferences
                  </h3>
                  <div className="flex items-center justify-between rounded-2xl border border-slate-100 bg-slate-50 p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-100">
                        <Brain size={18} className="text-violet-600" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-slate-700">Thinking Mode</p>
                        <p className="text-xs text-slate-400">Show model reasoning process</p>
                      </div>
                    </div>
                    <button
                      onClick={() => onThinkingToggle(!thinkingEnabled)}
                      className={`relative h-7 w-12 rounded-full transition-colors ${
                        thinkingEnabled ? "bg-violet-500" : "bg-slate-300"
                      }`}
                    >
                      <motion.div
                        animate={{ x: thinkingEnabled ? 20 : 2 }}
                        transition={{ type: "spring", stiffness: 500, damping: 30 }}
                        className="absolute top-[3px] h-[22px] w-[22px] rounded-full bg-white shadow-sm"
                      />
                    </button>
                  </div>
                  <div className="mt-3 flex items-center justify-between rounded-2xl border border-slate-100 bg-slate-50 p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-100">
                        <KeyRound size={18} className="text-amber-600" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-slate-700">API Key</p>
                        <p className="font-mono text-xs text-slate-400">
                          {apiKey ? `${apiKey.slice(0, 6)}${"•".repeat(12)}` : "Not set"}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={onApiKeyChange}
                      className="rounded-lg px-3 py-1.5 text-xs font-semibold text-violet-600 transition-colors hover:bg-violet-50 hover:text-violet-800"
                    >
                      更换
                    </button>
                  </div>
                </div>

                {/* System Info */}
                {loading ? (
                  <div className="py-8 text-center text-sm text-slate-400">
                    Loading system info...
                  </div>
                ) : systemInfo ? (
                  <>
                    {/* Tools */}
                    <div>
                      <h3 className="mb-3 flex items-center gap-2 text-sm font-bold tracking-wider text-slate-500 uppercase">
                        <Wrench size={14} />
                        Available Tools
                      </h3>
                      <div className="flex flex-wrap gap-2">
                        {systemInfo.tools.map((tool) => (
                          <span
                            key={tool}
                            className="rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700"
                          >
                            {tool}
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* Skills */}
                    <div>
                      <h3 className="mb-3 flex items-center gap-2 text-sm font-bold tracking-wider text-slate-500 uppercase">
                        <Sparkles size={14} />
                        Loaded Skills
                      </h3>
                      {systemInfo.skills.length > 0 ? (
                        <div className="space-y-2">
                          {systemInfo.skills.map((skill) => (
                            <div
                              key={skill.name}
                              className="rounded-xl border border-slate-100 bg-slate-50 p-3"
                            >
                              <p className="text-sm font-semibold text-slate-700">{skill.name}</p>
                              <p className="mt-0.5 line-clamp-2 text-xs text-slate-400">
                                {skill.description}
                              </p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-slate-400">No skills loaded</p>
                      )}
                    </div>

                    {/* Model Presets */}
                    <div>
                      <h3 className="mb-3 flex items-center gap-2 text-sm font-bold tracking-wider text-slate-500 uppercase">
                        <Server size={14} />
                        Model Presets
                      </h3>
                      <div className="space-y-1.5">
                        {Object.entries(systemInfo.model_presets).map(([alias, model]) => (
                          <div
                            key={alias}
                            className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50 px-3 py-2"
                          >
                            <span className="font-mono text-sm font-semibold text-violet-600">
                              {alias}
                            </span>
                            <span className="ml-4 max-w-[250px] truncate font-mono text-xs text-slate-400">
                              {model}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="py-8 text-center text-sm text-slate-400">
                    Could not load system info. Is the server running?
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
