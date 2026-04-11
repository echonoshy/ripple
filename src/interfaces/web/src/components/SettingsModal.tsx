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
      setLoading(true);
      fetchSystemInfo().then((info) => {
        setSystemInfo(info);
        setLoading(false);
      }).catch(() => {
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
            className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
          >
            <div className="bg-white rounded-3xl shadow-2xl shadow-slate-300/50 w-full max-w-lg max-h-[80vh] overflow-hidden pointer-events-auto">
              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
                <h2 className="text-lg font-bold text-slate-800">Settings</h2>
                <button
                  onClick={onClose}
                  className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-colors"
                >
                  <X size={16} className="text-slate-500" />
                </button>
              </div>

              <div className="overflow-y-auto max-h-[calc(80vh-64px)] p-6 space-y-6">
                {/* Thinking Mode */}
                <div>
                  <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-3">Preferences</h3>
                  <div className="flex items-center justify-between p-4 rounded-2xl bg-slate-50 border border-slate-100">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl bg-violet-100 flex items-center justify-center">
                        <Brain size={18} className="text-violet-600" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-slate-700">Thinking Mode</p>
                        <p className="text-xs text-slate-400">Show model reasoning process</p>
                      </div>
                    </div>
                    <button
                      onClick={() => onThinkingToggle(!thinkingEnabled)}
                      className={`relative w-12 h-7 rounded-full transition-colors ${
                        thinkingEnabled ? "bg-violet-500" : "bg-slate-300"
                      }`}
                    >
                      <motion.div
                        animate={{ x: thinkingEnabled ? 20 : 2 }}
                        transition={{ type: "spring", stiffness: 500, damping: 30 }}
                        className="absolute top-[3px] w-[22px] h-[22px] rounded-full bg-white shadow-sm"
                      />
                    </button>
                  </div>
                  <div className="flex items-center justify-between p-4 rounded-2xl bg-slate-50 border border-slate-100 mt-3">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl bg-amber-100 flex items-center justify-center">
                        <KeyRound size={18} className="text-amber-600" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-slate-700">API Key</p>
                        <p className="text-xs text-slate-400 font-mono">
                          {apiKey ? `${apiKey.slice(0, 6)}${'•'.repeat(12)}` : 'Not set'}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={onApiKeyChange}
                      className="text-xs font-semibold text-violet-600 hover:text-violet-800 px-3 py-1.5 rounded-lg hover:bg-violet-50 transition-colors"
                    >
                      更换
                    </button>
                  </div>
                </div>

                {/* System Info */}
                {loading ? (
                  <div className="text-center py-8 text-slate-400 text-sm">Loading system info...</div>
                ) : systemInfo ? (
                  <>
                    {/* Tools */}
                    <div>
                      <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                        <Wrench size={14} />
                        Available Tools
                      </h3>
                      <div className="flex flex-wrap gap-2">
                        {systemInfo.tools.map((tool) => (
                          <span
                            key={tool}
                            className="px-3 py-1.5 text-xs font-semibold bg-emerald-50 text-emerald-700 rounded-lg border border-emerald-100"
                          >
                            {tool}
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* Skills */}
                    <div>
                      <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                        <Sparkles size={14} />
                        Loaded Skills
                      </h3>
                      {systemInfo.skills.length > 0 ? (
                        <div className="space-y-2">
                          {systemInfo.skills.map((skill) => (
                            <div
                              key={skill.name}
                              className="p-3 rounded-xl bg-slate-50 border border-slate-100"
                            >
                              <p className="text-sm font-semibold text-slate-700">{skill.name}</p>
                              <p className="text-xs text-slate-400 mt-0.5 line-clamp-2">{skill.description}</p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-slate-400">No skills loaded</p>
                      )}
                    </div>

                    {/* Model Presets */}
                    <div>
                      <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                        <Server size={14} />
                        Model Presets
                      </h3>
                      <div className="space-y-1.5">
                        {Object.entries(systemInfo.model_presets).map(([alias, model]) => (
                          <div
                            key={alias}
                            className="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-50 border border-slate-100"
                          >
                            <span className="text-sm font-semibold text-violet-600 font-mono">{alias}</span>
                            <span className="text-xs text-slate-400 font-mono truncate ml-4 max-w-[250px]">{model}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="text-center py-8 text-slate-400 text-sm">
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
