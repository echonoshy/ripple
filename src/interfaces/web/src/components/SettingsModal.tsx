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
            className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4"
          >
            <div className="pointer-events-auto w-full max-w-lg overflow-hidden rounded-lg border border-[#d0d7de] bg-white shadow-xl">
              <div className="flex items-center justify-between border-b border-[#d0d7de] bg-[#f6f8fa] px-4 py-3">
                <h2 className="text-sm font-semibold text-[#24292f]">Preferences</h2>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close settings"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#d0d7de] bg-white text-[#57606a] hover:bg-[#f6f8fa] hover:text-[#24292f]"
                >
                  <X size={15} />
                </button>
              </div>

              <div className="space-y-4 p-4">
                <section className="rounded-md border border-[#d0d7de] bg-white p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[#d0d7de] bg-[#f6f8fa] text-[#57606a]">
                        <KeyRound size={17} />
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-[#24292f]">API key</div>
                        <div className="truncate font-[family-name:var(--font-mono)] text-xs text-[#6e7781]">
                          {apiKey ? `${apiKey.slice(0, 6)}${"*".repeat(8)}` : "Not set"}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={onApiKeyChange}
                      className="inline-flex h-8 items-center rounded-md border border-[#d0d7de] bg-white px-3 text-sm font-medium text-[#24292f] hover:bg-[#f6f8fa]"
                    >
                      Change
                    </button>
                  </div>
                </section>

                <section className="rounded-md border border-[#d0d7de] bg-white p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[#d0d7de] bg-[#f6f8fa] text-[#57606a]">
                        <UserRound size={17} />
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-[#24292f]">User</div>
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
                            className="mt-1 w-48 rounded-md border border-[#d0d7de] px-2 py-1 font-[family-name:var(--font-mono)] text-xs text-[#24292f] outline-none focus:border-[#0969da]"
                          />
                        ) : (
                          <div className="truncate font-[family-name:var(--font-mono)] text-xs text-[#6e7781]">
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
                          className="inline-flex h-8 items-center rounded-md border border-[#d0d7de] bg-white px-3 text-sm font-medium text-[#24292f] hover:bg-[#f6f8fa]"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleSaveUserId()}
                          className="inline-flex h-8 items-center rounded-md border border-[#0969da] bg-[#0969da] px-3 text-sm font-semibold text-white hover:bg-[#075dbd]"
                        >
                          Save
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={handleStartEditUserId}
                        className="inline-flex h-8 items-center rounded-md border border-[#d0d7de] bg-white px-3 text-sm font-medium text-[#24292f] hover:bg-[#f6f8fa]"
                      >
                        Change
                      </button>
                    )}
                  </div>
                  {userIdError && (
                    <div className="mt-2 pl-12 text-xs text-[#cf222e]">{userIdError}</div>
                  )}
                </section>

                <section className="rounded-md border border-[#d0d7de] bg-[#f6f8fa] p-4">
                  <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#24292f]">
                    <HardDrive size={16} />
                    Workspace
                  </div>
                  {sandboxLoading ? (
                    <div className="flex items-center gap-2 text-sm text-[#6e7781]">
                      <Loader2 size={14} className="animate-spin" />
                      Loading
                    </div>
                  ) : sandbox ? (
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-md border border-[#d0d7de] bg-white p-3">
                        <div className="text-xs text-[#6e7781]">Files</div>
                        <div className="mt-1 font-[family-name:var(--font-mono)] text-sm font-semibold text-[#24292f]">
                          {formatBytes(sandbox.workspace_size_bytes)}
                        </div>
                      </div>
                      <div className="rounded-md border border-[#d0d7de] bg-white p-3">
                        <div className="text-xs text-[#6e7781]">Chats</div>
                        <div className="mt-1 font-[family-name:var(--font-mono)] text-sm font-semibold text-[#24292f]">
                          {sandbox.session_count}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-[#6e7781]">No workspace yet</div>
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
