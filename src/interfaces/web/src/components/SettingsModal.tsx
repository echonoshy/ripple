"use client";

import React, { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Brain,
  Wrench,
  Sparkles,
  Server,
  KeyRound,
  UserRound,
  Box,
  AlertTriangle,
  Trash2,
  Check,
  Loader2,
} from "lucide-react";
import { SandboxInfo, SystemInfo } from "@/types";
import {
  createCurrentSandbox,
  deleteCurrentSandbox,
  fetchCurrentSandbox,
  fetchSystemInfo,
  isValidUserId,
} from "@/lib/api";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  thinkingEnabled: boolean;
  onThinkingToggle: (enabled: boolean) => void;
  apiKey: string | null;
  onApiKeyChange: () => void;
  userId: string;
  onUserIdChange: (uid: string) => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function ReadyBadge({ label, ready }: { label: string; ready: boolean }) {
  return (
    <div
      className={`flex items-center justify-between rounded-md border px-2.5 py-1.5 text-xs ${
        ready
          ? "border-white/10 bg-black/5 text-[#ededed]"
          : "border-white/10 bg-[#0a0a0a] text-[#666666]"
      }`}
    >
      <span className="font-[family-name:var(--font-mono)]">{label}</span>
      {ready ? <Check size={12} /> : <span className="text-[10px]">—</span>}
    </div>
  );
}

export default function SettingsModal({
  isOpen,
  onClose,
  thinkingEnabled,
  onThinkingToggle,
  apiKey,
  onApiKeyChange,
  userId,
  onUserIdChange,
}: SettingsModalProps) {
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(false);

  // ── User ID editing state ──
  const [isEditingUserId, setIsEditingUserId] = useState(false);
  const [userIdInput, setUserIdInput] = useState("");
  const [userIdError, setUserIdError] = useState<string | null>(null);

  // ── Sandbox state ──
  const [sandbox, setSandbox] = useState<SandboxInfo | null>(null);
  const [sandboxLoading, setSandboxLoading] = useState(false);
  const [sandboxError, setSandboxError] = useState<string | null>(null);
  const [sandboxBusy, setSandboxBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refreshSandbox = useCallback(async () => {
    setSandboxLoading(true);
    setSandboxError(null);
    try {
      const info = await fetchCurrentSandbox();
      setSandbox(info);
    } catch (err) {
      setSandboxError(err instanceof Error ? err.message : String(err));
      setSandbox(null);
    } finally {
      setSandboxLoading(false);
    }
  }, []);

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

  useEffect(() => {
    if (isOpen) {
      refreshSandbox();
      setConfirmDelete(false);
      setIsEditingUserId(false);
      setUserIdError(null);
    }
  }, [isOpen, userId, refreshSandbox]);

  const handleStartEditUserId = () => {
    setUserIdInput(userId);
    setUserIdError(null);
    setIsEditingUserId(true);
  };

  const handleCancelEditUserId = () => {
    setIsEditingUserId(false);
    setUserIdError(null);
  };

  const handleSaveUserId = () => {
    const trimmed = userIdInput.trim();
    if (!isValidUserId(trimmed)) {
      setUserIdError("Must match ^[a-zA-Z0-9_-]{1,64}$");
      return;
    }
    setIsEditingUserId(false);
    setUserIdError(null);
    if (trimmed !== userId) {
      onUserIdChange(trimmed);
    }
  };

  const handleCreateSandbox = async () => {
    setSandboxBusy(true);
    setSandboxError(null);
    try {
      const info = await createCurrentSandbox();
      setSandbox(info);
    } catch (err) {
      setSandboxError(err instanceof Error ? err.message : String(err));
    } finally {
      setSandboxBusy(false);
    }
  };

  const handleDeleteSandbox = async () => {
    setSandboxBusy(true);
    setSandboxError(null);
    const result = await deleteCurrentSandbox();
    setSandboxBusy(false);
    setConfirmDelete(false);
    if (!result.ok) {
      setSandboxError(result.error || "Delete failed");
      return;
    }
    setSandbox(null);
    onUserIdChange(userId);
  };

  const isDefaultUser = userId === "default";

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
            <div className="pointer-events-auto max-h-[80vh] w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl">
              {/* Header */}
              <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
                <h2 className="text-base font-semibold text-[#ededed]">Settings</h2>
                <button
                  onClick={onClose}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-[#888888] transition-colors hover:bg-[#0a0a0a] hover:text-[#ededed]"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="max-h-[calc(80vh-64px)] space-y-6 overflow-y-auto p-6">
                {/* Config */}
                <div>
                  <h3 className="mb-3 text-xs font-medium tracking-wider text-[#666666] uppercase">
                    Config
                  </h3>
                  <div className="flex items-center justify-between rounded-xl border border-white/10 bg-[#0a0a0a] p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-black/5">
                        <Brain size={18} className="text-[#ededed]" />
                      </div>
                      <div>
                        <p className="text-sm text-[#ededed]">Thinking Mode</p>
                        <p className="text-xs text-[#666666]">Show reasoning process</p>
                      </div>
                    </div>
                    <button
                      onClick={() => onThinkingToggle(!thinkingEnabled)}
                      className={`relative h-7 w-14 rounded-full transition-colors ${
                        thinkingEnabled
                          ? "border border-white/20 bg-[#ededed]/20"
                          : "border border-white/10 bg-[#27272a]"
                      }`}
                    >
                      <motion.div
                        animate={{ x: thinkingEnabled ? 26 : 2 }}
                        transition={{ type: "tween", duration: 0.1 }}
                        className={`absolute top-[3px] h-[22px] w-[22px] rounded-full ${
                          thinkingEnabled ? "bg-[#ededed]" : "bg-[#71717a]"
                        }`}
                      />
                    </button>
                  </div>
                  <div className="mt-3 flex items-center justify-between rounded-xl border border-white/10 bg-[#0a0a0a] p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-black/5">
                        <KeyRound size={18} className="text-[#ededed]" />
                      </div>
                      <div>
                        <p className="text-sm text-[#ededed]">API Key</p>
                        <p className="font-[family-name:var(--font-mono)] text-xs text-[#666666]">
                          {apiKey ? `${apiKey.slice(0, 6)}${"*".repeat(8)}` : "Not set"}
                        </p>
                      </div>
                    </div>
                    <button onClick={onApiKeyChange} className="btn-ghost px-3 py-1.5 text-xs">
                      Change
                    </button>
                  </div>
                </div>

                {/* User */}
                <div>
                  <h3 className="mb-3 text-xs font-medium tracking-wider text-[#666666] uppercase">
                    User
                  </h3>
                  <div className="rounded-xl border border-white/10 bg-[#0a0a0a] p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/5">
                          <UserRound size={18} className="text-[#ededed]" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm text-[#ededed]">User ID</p>
                          {isEditingUserId ? (
                            <div className="mt-1 flex items-center gap-2">
                              <input
                                type="text"
                                value={userIdInput}
                                autoFocus
                                onChange={(e) => setUserIdInput(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") handleSaveUserId();
                                  if (e.key === "Escape") handleCancelEditUserId();
                                }}
                                placeholder="e.g. alice"
                                className="w-48 rounded-md border border-white/10 bg-black px-2 py-1 font-[family-name:var(--font-mono)] text-xs text-[#ededed] placeholder:text-[#666666] focus:border-[#ededed]/50 focus:outline-none"
                              />
                            </div>
                          ) : (
                            <p className="truncate font-[family-name:var(--font-mono)] text-xs text-[#666666]">
                              {userId}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {isEditingUserId ? (
                          <>
                            <button
                              onClick={handleCancelEditUserId}
                              className="btn-ghost px-3 py-1.5 text-xs"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={handleSaveUserId}
                              className="btn-primary px-3 py-1.5 text-xs"
                            >
                              Save
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={handleStartEditUserId}
                            className="btn-ghost px-3 py-1.5 text-xs"
                          >
                            Change
                          </button>
                        )}
                      </div>
                    </div>
                    {userIdError && (
                      <p className="mt-2 pl-12 text-xs text-[#ff4444]">{userIdError}</p>
                    )}
                    <p className="mt-2 pl-12 text-[11px] text-[#52525b]">
                      Switching user will reset current session state and reload sessions.
                    </p>
                  </div>
                </div>

                {/* Sandbox */}
                <div>
                  <h3 className="mb-3 flex items-center gap-2 text-xs font-medium tracking-wider text-[#666666] uppercase">
                    <Box size={14} />
                    Sandbox
                  </h3>
                  <div className="rounded-xl border border-white/10 bg-[#0a0a0a] p-4">
                    {sandboxLoading ? (
                      <div className="flex items-center gap-2 text-sm text-[#666666]">
                        <Loader2 size={14} className="animate-spin" />
                        <span>Loading sandbox...</span>
                      </div>
                    ) : sandbox ? (
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div className="rounded-md border border-white/10 bg-black p-2">
                            <p className="text-[10px] tracking-wider text-[#666666] uppercase">
                              Workspace
                            </p>
                            <p className="mt-1 font-[family-name:var(--font-mono)] text-sm text-[#ededed]">
                              {formatBytes(sandbox.workspace_size_bytes)}
                            </p>
                          </div>
                          <div className="rounded-md border border-white/10 bg-black p-2">
                            <p className="text-[10px] tracking-wider text-[#666666] uppercase">
                              Sessions
                            </p>
                            <p className="mt-1 font-[family-name:var(--font-mono)] text-sm text-[#ededed]">
                              {sandbox.session_count}
                            </p>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <ReadyBadge label="python venv" ready={sandbox.has_python_venv} />
                          <ReadyBadge label="pnpm" ready={sandbox.has_pnpm_setup} />
                          <ReadyBadge label="lark-cli" ready={sandbox.has_lark_cli_config} />
                          <ReadyBadge label="notion token" ready={sandbox.has_notion_token} />
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm text-[#888888]">
                          No sandbox yet for{" "}
                          <span className="font-[family-name:var(--font-mono)] text-[#ededed]">
                            {userId}
                          </span>
                          .
                        </p>
                        <button
                          onClick={handleCreateSandbox}
                          disabled={sandboxBusy}
                          className="btn-primary shrink-0 px-3 py-1.5 text-xs disabled:opacity-50"
                        >
                          {sandboxBusy ? "Creating..." : "Create"}
                        </button>
                      </div>
                    )}

                    {sandboxError && (
                      <div className="mt-3 flex items-start gap-2 rounded-md border border-[#ff4444]/20 bg-[#ff4444]/10 p-2 text-xs text-[#ff4444]">
                        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                        <span className="break-all">{sandboxError}</span>
                      </div>
                    )}
                  </div>

                  {/* Danger zone */}
                  {sandbox && (
                    <div className="mt-3 rounded-xl border border-[#ff4444]/20 bg-[#ff4444]/[0.03] p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-[#ff4444]">Delete Sandbox</p>
                          <p className="mt-0.5 text-xs text-[#888888]">
                            Permanently destroys workspace, credentials and all sessions for this
                            user.
                          </p>
                        </div>
                        {confirmDelete ? (
                          <div className="flex shrink-0 items-center gap-2">
                            <button
                              onClick={() => setConfirmDelete(false)}
                              disabled={sandboxBusy}
                              className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-50"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={handleDeleteSandbox}
                              disabled={sandboxBusy}
                              className="flex items-center gap-1.5 rounded-md border border-[#ff4444] bg-[#ff4444]/10 px-3 py-1.5 text-xs font-medium text-[#ff4444] transition-colors hover:bg-[#ff4444]/20 disabled:opacity-50"
                            >
                              {sandboxBusy ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : (
                                <Trash2 size={12} />
                              )}
                              Confirm
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmDelete(true)}
                            disabled={isDefaultUser || sandboxBusy}
                            title={
                              isDefaultUser ? "default user cannot be deleted" : "Delete sandbox"
                            }
                            className="flex shrink-0 items-center gap-1.5 rounded-md border border-[#ff4444]/40 px-3 py-1.5 text-xs font-medium text-[#ff4444] transition-colors hover:bg-[#ff4444]/10 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <Trash2 size={12} />
                            Delete
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* System Info */}
                {loading ? (
                  <div className="py-8 text-center text-sm text-[#666666]">
                    Loading system info...
                  </div>
                ) : systemInfo ? (
                  <>
                    {/* Tools */}
                    <div>
                      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium tracking-wider text-[#666666] uppercase">
                        <Wrench size={14} />
                        Tools
                      </h3>
                      <div className="flex flex-wrap gap-2">
                        {systemInfo.tools.map((tool) => (
                          <span
                            key={tool}
                            className="rounded-md border border-[#ededed]/20 bg-[#ededed]/[0.06] px-3 py-1.5 font-[family-name:var(--font-mono)] text-xs text-[#ededed]"
                          >
                            {tool}
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* Skills */}
                    <div>
                      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium tracking-wider text-[#666666] uppercase">
                        <Sparkles size={14} />
                        Skills
                      </h3>
                      {systemInfo.skills.length > 0 ? (
                        <div className="space-y-2">
                          {systemInfo.skills.map((skill) => (
                            <div
                              key={skill.name}
                              className="rounded-lg border border-white/10 bg-[#0a0a0a] p-3"
                            >
                              <p className="text-sm font-medium text-[#ededed]">{skill.name}</p>
                              <p className="mt-0.5 line-clamp-2 text-xs text-[#666666]">
                                {skill.description}
                              </p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-[#666666]">No skills available</p>
                      )}
                    </div>

                    {/* Model Presets */}
                    <div>
                      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium tracking-wider text-[#666666] uppercase">
                        <Server size={14} />
                        Models
                      </h3>
                      <div className="space-y-1.5">
                        {Object.entries(systemInfo.model_presets).map(([alias, model]) => (
                          <div
                            key={alias}
                            className="flex items-center justify-between rounded-lg border border-white/10 bg-[#0a0a0a] px-3 py-2"
                          >
                            <span className="font-[family-name:var(--font-mono)] text-sm font-medium text-[#ededed]">
                              {alias}
                            </span>
                            <span className="ml-4 max-w-[250px] truncate font-[family-name:var(--font-mono)] text-xs text-[#666666]">
                              {model}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="py-8 text-center text-sm text-[#666666]">
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
