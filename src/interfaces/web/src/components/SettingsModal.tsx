"use client";

import React, { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
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
import {
  ConnectorInfo,
  ConnectorStatus,
  GogcliAccountsResponse,
  SandboxInfo,
  SystemInfo,
} from "@/types";
import {
  createCurrentSandbox,
  deleteCurrentSandbox,
  fetchConnectors,
  fetchConnectorStatuses,
  fetchCurrentSandbox,
  fetchGogcliAccounts,
  fetchSystemInfo,
  isValidUserId,
} from "@/lib/api";

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

function ReadyBadge({ label, ready }: { label: string; ready: boolean }) {
  return (
    <div
      className={`border-ripple-ink flex min-w-0 items-center justify-between gap-2 border-2 px-2.5 py-1.5 text-xs font-bold shadow-[2px_2px_0_#111111] ${
        ready ? "bg-ripple-lime/60 text-ripple-ink" : "text-ripple-ink/45 bg-white"
      }`}
    >
      <span className="truncate font-[family-name:var(--font-mono)]">{label}</span>
      {ready ? <Check size={12} /> : <span className="text-[10px]">—</span>}
    </div>
  );
}

export default function SettingsModal({
  isOpen,
  onClose,
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
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [connectorStatuses, setConnectorStatuses] = useState<Record<string, ConnectorStatus>>({});
  const [gogAccounts, setGogAccounts] = useState<GogcliAccountsResponse | null>(null);
  const googleStatus = connectorStatuses.google_workspace;
  const hasGoogleClientConfig = Boolean(googleStatus?.metadata?.has_client_config);

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

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchConnectors();
        if (!cancelled) setConnectors(data);
      } catch {
        if (!cancelled) setConnectors([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !sandbox || connectors.length === 0) {
      setConnectorStatuses({});
      setGogAccounts(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const statuses = await fetchConnectorStatuses(connectors);
        if (!cancelled) setConnectorStatuses(statuses);
      } catch {
        if (!cancelled) setConnectorStatuses({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, sandbox, connectors]);

  useEffect(() => {
    if (!hasGoogleClientConfig) {
      setGogAccounts(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchGogcliAccounts();
        if (!cancelled) setGogAccounts(data);
      } catch {
        // 静默失败 —— 拿不到账号列表不影响其他 sandbox 信息
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasGoogleClientConfig]);

  const handleStartEditUserId = () => {
    setUserIdInput(userId);
    setUserIdError(null);
    setIsEditingUserId(true);
  };

  const handleCancelEditUserId = () => {
    setIsEditingUserId(false);
    setUserIdError(null);
  };

  const handleSaveUserId = async () => {
    const trimmed = userIdInput.trim();
    if (!isValidUserId(trimmed)) {
      setUserIdError("Must match ^[a-zA-Z0-9_-]{1,64}$");
      return;
    }
    setIsEditingUserId(false);
    setUserIdError(null);
    if (trimmed !== userId) {
      await onUserIdChange(trimmed);
      onClose();
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
    setConnectorStatuses({});
    setGogAccounts(null);
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
            className="bg-ripple-ink/35 fixed inset-0 z-40 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4"
          >
            <div className="border-ripple-ink bg-ripple-paper pointer-events-auto max-h-[84vh] w-full max-w-4xl overflow-hidden border-2 shadow-[6px_6px_0_#111111]">
              {/* Header */}
              <div className="border-ripple-ink bg-ripple-lavender flex items-center justify-between border-b-2 px-6 py-4">
                <h2 className="text-ripple-ink text-base font-bold">Settings</h2>
                <button onClick={onClose} className="btn-icon h-8 w-8">
                  <X size={16} />
                </button>
              </div>

              <div className="max-h-[calc(84vh-64px)] space-y-6 overflow-y-auto p-6">
                {/* Config */}
                <div>
                  <h3 className="text-ripple-ink/60 mb-3 text-xs font-bold tracking-wider uppercase">
                    Config
                  </h3>
                  <div className="border-ripple-ink flex items-center justify-between border-2 bg-white p-4 shadow-[3px_3px_0_#111111]">
                    <div className="flex items-center gap-3">
                      <div className="border-ripple-ink bg-ripple-cyan/45 flex h-9 w-9 items-center justify-center border-2">
                        <KeyRound size={18} className="text-ripple-ink" />
                      </div>
                      <div>
                        <p className="text-ripple-ink text-sm font-bold">API Key</p>
                        <p className="text-ripple-ink/55 font-[family-name:var(--font-mono)] text-xs font-bold">
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
                  <h3 className="text-ripple-ink/60 mb-3 text-xs font-bold tracking-wider uppercase">
                    User
                  </h3>
                  <div className="border-ripple-ink border-2 bg-white p-4 shadow-[3px_3px_0_#111111]">
                    <div className="flex items-center justify-between">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="border-ripple-ink bg-ripple-pink flex h-9 w-9 shrink-0 items-center justify-center border-2">
                          <UserRound size={18} className="text-ripple-ink" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-ripple-ink text-sm font-bold">User ID</p>
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
                                className="brutal-input w-48 px-2 py-1 font-[family-name:var(--font-mono)] text-xs"
                              />
                            </div>
                          ) : (
                            <p className="text-ripple-ink/55 truncate font-[family-name:var(--font-mono)] text-xs font-bold">
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
                      <p className="text-ripple-red mt-2 pl-12 text-xs font-bold">{userIdError}</p>
                    )}
                    <p className="text-ripple-ink/50 mt-2 pl-12 text-[11px] font-medium">
                      Switching user will reset current session state and reload sessions.
                    </p>
                  </div>
                </div>

                {/* Sandbox */}
                <div>
                  <h3 className="text-ripple-ink/60 mb-3 flex items-center gap-2 text-xs font-bold tracking-wider uppercase">
                    <Box size={14} />
                    Sandbox
                  </h3>
                  <div className="border-ripple-ink border-2 bg-white p-4 shadow-[3px_3px_0_#111111]">
                    {sandboxLoading ? (
                      <div className="text-ripple-ink/60 flex items-center gap-2 text-sm font-bold">
                        <Loader2 size={14} className="animate-spin" />
                        <span>Loading sandbox...</span>
                      </div>
                    ) : sandbox ? (
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div className="border-ripple-ink bg-ripple-yellow/40 border-2 p-2">
                            <p className="text-ripple-ink/60 text-[10px] font-bold tracking-wider uppercase">
                              Workspace
                            </p>
                            <p className="text-ripple-ink mt-1 font-[family-name:var(--font-mono)] text-sm font-bold">
                              {formatBytes(sandbox.workspace_size_bytes)}
                            </p>
                          </div>
                          <div className="border-ripple-ink bg-ripple-lavender/50 border-2 p-2">
                            <p className="text-ripple-ink/60 text-[10px] font-bold tracking-wider uppercase">
                              Sessions
                            </p>
                            <p className="text-ripple-ink mt-1 font-[family-name:var(--font-mono)] text-sm font-bold">
                              {sandbox.session_count}
                            </p>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <ReadyBadge label="python venv" ready={sandbox.has_python_venv} />
                          <ReadyBadge label="pnpm" ready={sandbox.has_pnpm_setup} />
                        </div>
                        {connectors.length > 0 && (
                          <div className="grid grid-cols-2 gap-2">
                            {connectors.map((connector) => (
                              <ReadyBadge
                                key={connector.name}
                                label={connector.display_name}
                                ready={Boolean(connectorStatuses[connector.name]?.connected)}
                              />
                            ))}
                          </div>
                        )}
                        {googleStatus && !googleStatus.connected && hasGoogleClientConfig && (
                          <p className="text-ripple-ink/55 text-xs font-bold">
                            Google client configured; account login is still pending.
                          </p>
                        )}
                        {gogAccounts && gogAccounts.accounts.length > 0 && (
                          <div>
                            <p className="text-ripple-ink/60 mb-1 text-[10px] font-bold tracking-wider uppercase">
                              Google 已绑账号
                            </p>
                            <ul className="space-y-1">
                              {gogAccounts.accounts.map((a) => (
                                <li
                                  key={a.email}
                                  className="border-ripple-ink bg-ripple-paper text-ripple-ink flex items-center gap-2 border-2 px-2.5 py-1.5 font-[family-name:var(--font-mono)] text-xs font-bold"
                                >
                                  <span className="truncate">{a.email}</span>
                                  {a.alias && (
                                    <span className="text-ripple-ink/55">({a.alias})</span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-ripple-ink/65 text-sm font-medium">
                          No sandbox yet for{" "}
                          <span className="text-ripple-ink font-[family-name:var(--font-mono)] font-bold">
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
                      <div className="border-ripple-ink bg-ripple-red/25 text-ripple-ink mt-3 flex items-start gap-2 border-2 p-2 text-xs font-bold">
                        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                        <span className="break-all">{sandboxError}</span>
                      </div>
                    )}
                  </div>

                  {/* Danger zone */}
                  {sandbox && (
                    <div className="border-ripple-ink bg-ripple-red/20 mt-3 border-2 p-4 shadow-[3px_3px_0_#111111]">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-ripple-ink text-sm font-bold">Delete Sandbox</p>
                          <p className="text-ripple-ink/65 mt-0.5 text-xs">
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
                              className="border-ripple-ink bg-ripple-red/45 text-ripple-ink hover:bg-ripple-red/60 flex items-center gap-1.5 border-2 px-3 py-1.5 text-xs font-bold shadow-[2px_2px_0_#111111] transition-colors disabled:opacity-50"
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
                            className="border-ripple-ink text-ripple-ink hover:bg-ripple-red/35 flex shrink-0 items-center gap-1.5 border-2 bg-white px-3 py-1.5 text-xs font-bold shadow-[2px_2px_0_#111111] transition-colors disabled:cursor-not-allowed disabled:opacity-40"
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
                  <div className="text-ripple-ink/60 py-8 text-center text-sm font-bold">
                    Loading system info...
                  </div>
                ) : systemInfo ? (
                  <>
                    {/* Tools */}
                    <div>
                      <h3 className="text-ripple-ink/60 mb-3 flex items-center gap-2 text-xs font-bold tracking-wider uppercase">
                        <Wrench size={14} />
                        Tools
                      </h3>
                      <div className="flex flex-wrap gap-2">
                        {systemInfo.tools.map((tool) => (
                          <span key={tool} className="brutal-tag bg-ripple-cyan/35 px-3 py-1.5">
                            {tool}
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* Skills */}
                    <div>
                      <h3 className="text-ripple-ink/60 mb-3 flex items-center gap-2 text-xs font-bold tracking-wider uppercase">
                        <Sparkles size={14} />
                        Skills
                      </h3>
                      {systemInfo.skills.length > 0 ? (
                        <div className="space-y-2">
                          {systemInfo.skills.map((skill) => (
                            <div
                              key={skill.name}
                              className="border-ripple-ink border-2 bg-white p-3 shadow-[2px_2px_0_#111111]"
                            >
                              <p className="text-ripple-ink text-sm font-bold">{skill.name}</p>
                              <p className="text-ripple-ink/55 mt-0.5 line-clamp-2 text-xs">
                                {skill.description}
                              </p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-ripple-ink/55 text-sm font-bold">No skills available</p>
                      )}
                    </div>

                    {/* Model Presets */}
                    <div>
                      <h3 className="text-ripple-ink/60 mb-3 flex items-center gap-2 text-xs font-bold tracking-wider uppercase">
                        <Server size={14} />
                        Models
                      </h3>
                      <div className="space-y-1.5">
                        {Object.entries(systemInfo.model_presets).map(([alias, model]) => (
                          <div
                            key={alias}
                            className="border-ripple-ink flex items-center justify-between border-2 bg-white px-3 py-2 shadow-[2px_2px_0_#111111]"
                          >
                            <span className="text-ripple-ink font-[family-name:var(--font-mono)] text-sm font-bold">
                              {alias}
                            </span>
                            <span className="text-ripple-ink/55 ml-4 max-w-[250px] truncate font-[family-name:var(--font-mono)] text-xs font-bold">
                              {model}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="text-ripple-ink/60 py-8 text-center text-sm font-bold">
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
