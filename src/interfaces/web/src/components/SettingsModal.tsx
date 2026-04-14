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
            className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4"
          >
            <div className="pointer-events-auto max-h-[80vh] w-full max-w-lg overflow-hidden rounded-2xl border border-[#27272a] bg-[#09090b] shadow-2xl">
              {/* Header */}
              <div className="flex items-center justify-between border-b border-[#27272a] px-6 py-4">
                <h2 className="text-base font-semibold text-[#fafafa]">Settings</h2>
                <button
                  onClick={onClose}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#fafafa]"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="max-h-[calc(80vh-64px)] space-y-6 overflow-y-auto p-6">
                {/* Thinking Mode */}
                <div>
                  <h3 className="mb-3 text-xs font-medium tracking-wider text-[#71717a] uppercase">
                    Config
                  </h3>
                  <div className="flex items-center justify-between rounded-xl border border-[#27272a] bg-[#18181b] p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#10b981]/30 bg-[#10b981]/[0.06]">
                        <Brain size={18} className="text-[#10b981]" />
                      </div>
                      <div>
                        <p className="text-sm text-[#fafafa]">Thinking Mode</p>
                        <p className="text-xs text-[#71717a]">Show reasoning process</p>
                      </div>
                    </div>
                    <button
                      onClick={() => onThinkingToggle(!thinkingEnabled)}
                      className={`relative h-7 w-14 rounded-full transition-colors ${
                        thinkingEnabled
                          ? "border border-[#10b981]/40 bg-[#10b981]/20"
                          : "border border-[#27272a] bg-[#27272a]"
                      }`}
                    >
                      <motion.div
                        animate={{ x: thinkingEnabled ? 26 : 2 }}
                        transition={{ type: "tween", duration: 0.1 }}
                        className={`absolute top-[3px] h-[22px] w-[22px] rounded-full ${
                          thinkingEnabled ? "bg-[#10b981]" : "bg-[#71717a]"
                        }`}
                      />
                    </button>
                  </div>
                  <div className="mt-3 flex items-center justify-between rounded-xl border border-[#27272a] bg-[#18181b] p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#f59e0b]/30 bg-[#f59e0b]/[0.06]">
                        <KeyRound size={18} className="text-[#f59e0b]" />
                      </div>
                      <div>
                        <p className="text-sm text-[#fafafa]">API Key</p>
                        <p className="font-[family-name:var(--font-mono)] text-xs text-[#71717a]">
                          {apiKey ? `${apiKey.slice(0, 6)}${"*".repeat(8)}` : "Not set"}
                        </p>
                      </div>
                    </div>
                    <button onClick={onApiKeyChange} className="btn-ghost px-3 py-1.5 text-xs">
                      Change
                    </button>
                  </div>
                </div>

                {/* System Info */}
                {loading ? (
                  <div className="py-8 text-center text-sm text-[#71717a]">
                    Loading system info...
                  </div>
                ) : systemInfo ? (
                  <>
                    {/* Tools */}
                    <div>
                      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium tracking-wider text-[#71717a] uppercase">
                        <Wrench size={14} />
                        Tools
                      </h3>
                      <div className="flex flex-wrap gap-2">
                        {systemInfo.tools.map((tool) => (
                          <span
                            key={tool}
                            className="rounded-md border border-[#10b981]/20 bg-[#10b981]/[0.06] px-3 py-1.5 font-[family-name:var(--font-mono)] text-xs text-[#10b981]"
                          >
                            {tool}
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* Skills */}
                    <div>
                      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium tracking-wider text-[#71717a] uppercase">
                        <Sparkles size={14} />
                        Skills
                      </h3>
                      {systemInfo.skills.length > 0 ? (
                        <div className="space-y-2">
                          {systemInfo.skills.map((skill) => (
                            <div
                              key={skill.name}
                              className="rounded-lg border border-[#27272a] bg-[#18181b] p-3"
                            >
                              <p className="text-sm font-medium text-[#fafafa]">{skill.name}</p>
                              <p className="mt-0.5 line-clamp-2 text-xs text-[#71717a]">
                                {skill.description}
                              </p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-[#71717a]">No skills available</p>
                      )}
                    </div>

                    {/* Model Presets */}
                    <div>
                      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium tracking-wider text-[#71717a] uppercase">
                        <Server size={14} />
                        Models
                      </h3>
                      <div className="space-y-1.5">
                        {Object.entries(systemInfo.model_presets).map(([alias, model]) => (
                          <div
                            key={alias}
                            className="flex items-center justify-between rounded-lg border border-[#27272a] bg-[#18181b] px-3 py-2"
                          >
                            <span className="font-[family-name:var(--font-mono)] text-sm font-medium text-[#3b82f6]">
                              {alias}
                            </span>
                            <span className="ml-4 max-w-[250px] truncate font-[family-name:var(--font-mono)] text-xs text-[#71717a]">
                              {model}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="py-8 text-center text-sm text-[#71717a]">
                    Connection error. Is the server online?
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
