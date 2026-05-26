"use client";

import React, { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { HardDrive, KeyRound, Loader2, UserRound, X } from "lucide-react";
import type { SandboxInfo } from "@/types";
import { fetchCurrentSandbox, isValidUserId } from "@/lib/api";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  apiKey: string | null;
  onApiKeyChange: () => void;
  userId: string;
  onUserIdChange: (uid: string) => void | Promise<void>;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function SettingsModal({
  isOpen,
  onClose,
  apiKey,
  onApiKeyChange,
  userId,
  onUserIdChange,
}: SettingsModalProps) {
  const [sandbox, setSandbox] = useState<SandboxInfo | null>(null);
  const [sandboxLoading, setSandboxLoading] = useState(false);
  const [isEditingUserId, setIsEditingUserId] = useState(false);
  const [userIdInput, setUserIdInput] = useState("");
  const [userIdError, setUserIdError] = useState<string | null>(null);

  const refreshSandbox = useCallback(async () => {
    setSandboxLoading(true);
    try {
      setSandbox(await fetchCurrentSandbox());
    } catch {
      setSandbox(null);
    } finally {
      setSandboxLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    queueMicrotask(() => {
      setIsEditingUserId(false);
      setUserIdError(null);
      void refreshSandbox();
    });
  }, [isOpen, refreshSandbox, userId]);

  const handleStartEditUserId = () => {
    setUserIdInput(userId);
    setUserIdError(null);
    setIsEditingUserId(true);
  };

  const handleSaveUserId = async () => {
    const trimmed = userIdInput.trim();
    if (!isValidUserId(trimmed)) {
      setUserIdError("Use letters, numbers, underscores, or hyphens.");
      return;
    }
    setIsEditingUserId(false);
    if (trimmed !== userId) {
      await onUserIdChange(trimmed);
      onClose();
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.button
            type="button"
            aria-label="Close settings"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-[#24292f]/30"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.98, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
            className="pointer-events-none fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center sm:p-4"
          >
            <div className="pointer-events-auto flex max-h-[calc(100dvh-24px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[#dfe6f4] bg-white shadow-2xl">
              <div className="flex items-center justify-between border-b border-[#dfe6f4] bg-white/74 px-4 py-3">
                <h2 className="text-sm font-semibold text-[#111827]">Settings</h2>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close settings"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[#dfe6f4] bg-white text-[#6b7280] hover:bg-[#f7f8fa] hover:text-[#111827]"
                >
                  <X size={15} />
                </button>
              </div>

              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 pb-[max(env(safe-area-inset-bottom),16px)]">
                <section className="rounded-2xl border border-[#dfe6f4] bg-white/74 p-4 shadow-[0_12px_30px_rgba(44,63,123,0.06)]">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#dfe6f4] bg-[#f6f8ff] text-[#2457e6]">
                        <KeyRound size={17} />
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-[#111827]">API key</div>
                        <div className="truncate font-[family-name:var(--font-mono)] text-xs text-[#667085]">
                          {apiKey ? `${apiKey.slice(0, 6)}${"*".repeat(8)}` : "Not set"}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={onApiKeyChange}
                      className="inline-flex h-8 items-center rounded-full border border-[#dfe6f4] bg-white px-4 text-sm font-semibold text-[#384152] transition-all duration-200 hover:bg-[#f7f8fa] active:scale-[0.98]"
                    >
                      Change
                    </button>
                  </div>
                </section>

                <section className="rounded-2xl border border-[#dfe6f4] bg-white/74 p-4 shadow-[0_12px_30px_rgba(44,63,123,0.06)]">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#dfe6f4] bg-[#f6f8ff] text-[#2457e6]">
                        <UserRound size={17} />
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-[#111827]">User ID</div>
                        {isEditingUserId ? (
                          <input
                            type="text"
                            value={userIdInput}
                            autoFocus
                            onChange={(event) => setUserIdInput(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") void handleSaveUserId();
                              if (event.key === "Escape") setIsEditingUserId(false);
                            }}
                            className="mt-1 w-full min-w-[180px] rounded-full border border-[#dfe6f4] px-3 py-1 font-[family-name:var(--font-mono)] text-xs text-[#111827] outline-none focus:border-[#8da0ff] sm:w-48"
                          />
                        ) : (
                          <div className="truncate font-[family-name:var(--font-mono)] text-xs text-[#667085]">
                            {userId}
                          </div>
                        )}
                      </div>
                    </div>
                    {isEditingUserId ? (
                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setIsEditingUserId(false)}
                          className="inline-flex h-8 items-center rounded-full border border-[#dfe6f4] bg-white px-4 text-sm font-semibold text-[#384152] transition-all duration-200 hover:bg-[#f7f8fa]"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleSaveUserId()}
                          className="inline-flex h-8 items-center rounded-full bg-[linear-gradient(135deg,#2f6bff,#7b5cff)] px-4 text-sm font-semibold text-white shadow-[0_8px_20px_rgba(64,92,255,0.2)] transition-all duration-200 hover:brightness-110 active:scale-[0.98]"
                        >
                          Save
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={handleStartEditUserId}
                        className="inline-flex h-8 items-center rounded-full border border-[#dfe6f4] bg-white px-4 text-sm font-semibold text-[#384152] transition-all duration-200 hover:bg-[#f7f8fa] active:scale-[0.98]"
                      >
                        Change
                      </button>
                    )}
                  </div>
                  {userIdError && (
                    <div className="mt-2 pl-12 text-xs text-[#cf222e]">{userIdError}</div>
                  )}
                </section>

                <section className="rounded-2xl border border-[#dfe6f4] bg-white/74 p-4 shadow-[0_12px_30px_rgba(44,63,123,0.06)]">
                  <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#111827]">
                    <HardDrive size={16} />
                    Workspace
                  </div>
                  {sandboxLoading ? (
                    <div className="flex items-center gap-2 text-sm text-[#667085]">
                      <Loader2 size={14} className="animate-spin" />
                      Loading
                    </div>
                  ) : sandbox ? (
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-xl border border-[#dfe6f4] bg-white/80 p-3">
                        <div className="text-xs text-[#667085]">Files</div>
                        <div className="mt-1 font-[family-name:var(--font-mono)] text-sm font-semibold text-[#111827]">
                          {formatBytes(sandbox.workspace_size_bytes)}
                        </div>
                      </div>
                      <div className="rounded-xl border border-[#dfe6f4] bg-white/80 p-3">
                        <div className="text-xs text-[#667085]">Sessions</div>
                        <div className="mt-1 font-[family-name:var(--font-mono)] text-sm font-semibold text-[#111827]">
                          {sandbox.session_count}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-[#667085]">No workspace yet</div>
                  )}
                </section>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
