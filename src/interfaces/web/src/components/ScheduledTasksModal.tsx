"use client";

import React, { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CalendarClock, Loader2, X } from "lucide-react";
import ScheduledTasksPanel from "@/components/ScheduledTasksPanel";
import { SandboxInfo } from "@/types";
import { fetchCurrentSandbox } from "@/lib/api";

interface ScheduledTasksModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
}

export default function ScheduledTasksModal({ isOpen, onClose, userId }: ScheduledTasksModalProps) {
  const [sandbox, setSandbox] = useState<SandboxInfo | null>(null);
  const [loading, setLoading] = useState(false);

  const refreshSandbox = useCallback(async () => {
    setLoading(true);
    try {
      setSandbox(await fetchCurrentSandbox());
    } catch {
      setSandbox(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      refreshSandbox();
    }
  }, [isOpen, refreshSandbox, userId]);

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
            <div className="pointer-events-auto max-h-[84vh] w-full max-w-5xl overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl">
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
                <div className="flex items-center gap-3">
                  <CalendarClock size={18} className="text-[#ededed]" />
                  <div>
                    <h2 className="text-sm font-semibold text-[#ededed]">Scheduled Tasks</h2>
                    <p className="font-[family-name:var(--font-mono)] text-xs text-[#666666]">
                      {userId}
                    </p>
                  </div>
                </div>
                <button
                  onClick={onClose}
                  className="rounded-lg p-2 text-[#666666] transition-colors hover:bg-white/10 hover:text-[#ededed]"
                  aria-label="Close scheduled tasks"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="max-h-[calc(84vh-73px)] overflow-y-auto p-5">
                {loading && !sandbox ? (
                  <div className="flex items-center gap-2 text-sm text-[#666666]">
                    <Loader2 size={14} className="animate-spin" />
                    <span>Loading scheduled tasks...</span>
                  </div>
                ) : (
                  <ScheduledTasksPanel sandboxReady={Boolean(sandbox)} userId={userId} />
                )}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
