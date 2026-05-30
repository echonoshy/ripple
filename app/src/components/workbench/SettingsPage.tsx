"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  Cpu,
  HardDrive,
  KeyRound,
  Layers,
  LockKeyhole,
  Loader2,
  LogOut,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import {
  changePassword,
  deleteUserAvatar,
  fetchCurrentSandbox,
  fetchUserAvatarImage,
  fetchUserProfile,
  getConfiguredApiUrl,
  uploadUserAvatar,
} from "@/lib/api";
import {
  getMeasuredViewportMenuPosition,
  getResponsiveMenuBottomInsetPx,
  VIEWPORT_MENU_MARGIN_PX,
  type ViewportMenuAnchorRect,
} from "@/lib/menuPosition";
import { formatModelName } from "@/lib/models";
import { dispatchUserAvatarChanged, getUserProfileAvatarUri } from "@/lib/userAvatar";
import type { SandboxInfo, UserProfile } from "@/types";
import { IconTile, type IconTileTone } from "@/components/icons/IconTile";
import RippleIcon from "@/components/icons/RippleIcon";

interface SettingsPageProps {
  userId: string;
  apiKey: string | null;
  authMode: "service" | "user";
  models: { id: string; owned_by: string }[];
  defaultModel: string;
  selectedModel: string;
  onSelectDefaultModel: (model: string) => void;
  onApiKeyChange: () => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatTokens(num: number): string {
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toString();
}

function percent(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, (value / max) * 100));
}

const SETTINGS_MODEL_MENU_WIDTH = 176;
const SETTINGS_MODEL_MENU_ITEM_HEIGHT = 32;
const SETTINGS_MODEL_MENU_VERTICAL_PADDING = 8;

interface ModelMenuPosition {
  top: number;
  left: number;
  anchorRect: ViewportMenuAnchorRect;
  measuredHeight: number | null;
}

function getSettingsModelMenuHeight(optionCount: number): number {
  return optionCount * SETTINGS_MODEL_MENU_ITEM_HEIGHT + SETTINGS_MODEL_MENU_VERTICAL_PADDING;
}

function getSettingsModelMenuPosition(
  anchorRect: ViewportMenuAnchorRect,
  optionCount: number,
  measuredMenuHeight?: number | null
): { top: number; left: number } {
  const position = getMeasuredViewportMenuPosition({
    anchorRect,
    menuWidth: SETTINGS_MODEL_MENU_WIDTH,
    estimatedMenuHeight: getSettingsModelMenuHeight(optionCount),
    measuredMenuHeight,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    bottomInset: getResponsiveMenuBottomInsetPx(),
    margin: VIEWPORT_MENU_MARGIN_PX,
    align: "right",
  });

  return { top: position.top, left: position.left };
}

function deriveAvatarInitials(name: string): string {
  const parts = name.match(/[a-zA-Z0-9]+/g) ?? [];
  const first = parts[0] ?? name;
  const second = parts[1] ?? "";
  const value = parts.length > 1 ? `${first.charAt(0)}${second.charAt(0)}` : first.slice(0, 2);
  return (value || "U").toUpperCase();
}

export default function SettingsPage({
  userId,
  apiKey,
  authMode,
  models,
  defaultModel,
  selectedModel,
  onSelectDefaultModel,
  onApiKeyChange,
}: SettingsPageProps) {
  const [sandbox, setSandbox] = useState<SandboxInfo | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [avatarImageUrl, setAvatarImageUrl] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [isAvatarUploading, setIsAvatarUploading] = useState(false);
  const [isPasswordOpen, setIsPasswordOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [modelMenuPosition, setModelMenuPosition] = useState<ModelMenuPosition | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const avatarFileInputRef = useRef<HTMLInputElement | null>(null);

  const loadSettingsData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [sandboxData, profileData] = await Promise.all([
        fetchCurrentSandbox(),
        fetchUserProfile().catch(() => null),
      ]);
      setSandbox(sandboxData);
      setProfile(profileData);
    } catch {
      setSandbox(null);
      setProfile(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void loadSettingsData();
    });
  }, [loadSettingsData, userId]);

  const profileAvatarUri = getUserProfileAvatarUri(profile);
  const avatarName = profile?.profile?.user_name || userId;
  const avatarInitials = deriveAvatarInitials(avatarName);
  const limits = profile?.limits;
  const usage = profile?.usage;
  const maxWorkspaceBytes = limits?.max_workspace_bytes || 2 * 1024 * 1024 * 1024;
  const maxSessions = limits?.max_sessions || 200;
  const workspaceBytes = usage?.workspace_size_bytes ?? sandbox?.workspace_size_bytes ?? 0;
  const sessionCount = usage?.session_count ?? sandbox?.session_count ?? 0;
  const availableModels = useMemo(
    () =>
      models.length > 0 ? models : [{ id: defaultModel || selectedModel, owned_by: "ripple" }],
    [defaultModel, models, selectedModel]
  );

  const handlePasswordSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isChangingPassword) return;
    if (!currentPassword || !newPassword) {
      setPasswordError("Enter your current and new password.");
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError("New password must be at least 8 characters.");
      return;
    }
    try {
      setIsChangingPassword(true);
      setPasswordError(null);
      setPasswordMessage(null);
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setIsPasswordOpen(false);
      setPasswordMessage("Password updated.");
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : "Could not change password.");
    } finally {
      setIsChangingPassword(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setAvatarImageUrl(null);
    setAvatarError(null);
    if (!profileAvatarUri || typeof URL === "undefined") return;

    void fetchUserAvatarImage(profileAvatarUri)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setAvatarImageUrl(objectUrl);
      })
      .catch((error) => {
        if (cancelled) return;
        setAvatarError(error instanceof Error ? error.message : "Could not load avatar.");
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [profileAvatarUri]);

  const handleAvatarUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file || !file.type.startsWith("image/")) return;

    try {
      setIsAvatarUploading(true);
      setAvatarError(null);
      const nextProfile = await uploadUserAvatar(file);
      setProfile(nextProfile);
      dispatchUserAvatarChanged();
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : "Could not upload avatar.");
    } finally {
      setIsAvatarUploading(false);
    }
  };

  const handleAvatarRemove = async () => {
    try {
      setIsAvatarUploading(true);
      setAvatarError(null);
      const nextProfile = await deleteUserAvatar();
      setProfile(nextProfile);
      dispatchUserAvatarChanged();
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : "Could not remove avatar.");
    } finally {
      setIsAvatarUploading(false);
    }
  };

  const closeModelMenu = useCallback(() => {
    setIsModelMenuOpen(false);
    setModelMenuPosition(null);
  }, []);

  const handleModelMenuToggle = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (isModelMenuOpen) {
      closeModelMenu();
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const anchorRect = {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
    };
    const position = getSettingsModelMenuPosition(anchorRect, availableModels.length);
    setModelMenuPosition({ ...position, anchorRect, measuredHeight: null });
    setIsModelMenuOpen(true);
  };

  useLayoutEffect(() => {
    if (!isModelMenuOpen || !modelMenuPosition) return;
    const menuNode = modelMenuRef.current;
    if (!menuNode) return;

    const measuredMenuHeight = Math.ceil(menuNode.getBoundingClientRect().height);
    if (!measuredMenuHeight || measuredMenuHeight === modelMenuPosition.measuredHeight) return;

    const position = getSettingsModelMenuPosition(
      modelMenuPosition.anchorRect,
      availableModels.length,
      measuredMenuHeight
    );
    setModelMenuPosition((current) => {
      if (!current) return current;
      if (
        current.measuredHeight === measuredMenuHeight &&
        current.top === position.top &&
        current.left === position.left
      ) {
        return current;
      }
      return {
        ...current,
        ...position,
        measuredHeight: measuredMenuHeight,
      };
    });
  }, [availableModels.length, isModelMenuOpen, modelMenuPosition]);

  useEffect(() => {
    if (!isModelMenuOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeModelMenu();
    };

    window.addEventListener("resize", closeModelMenu);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", closeModelMenu);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeModelMenu, isModelMenuOpen]);

  const modelMenuPortal =
    isModelMenuOpen && modelMenuPosition && typeof document !== "undefined"
      ? createPortal(
          <>
            <div className="fixed inset-0 z-40 bg-transparent" onClick={closeModelMenu} />
            <div
              ref={modelMenuRef}
              role="menu"
              style={{
                top: modelMenuPosition.top,
                left: modelMenuPosition.left,
                position: "fixed",
              }}
              className="z-50 max-h-[calc(100dvh-104px)] w-44 overflow-y-auto rounded-xl border border-[#dfe6f4] bg-white p-1 shadow-[0_14px_34px_rgba(44,63,123,0.14)]"
              onClick={(event) => event.stopPropagation()}
            >
              {availableModels.map((model) => {
                const selected = model.id === defaultModel;
                return (
                  <button
                    key={model.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    onClick={() => {
                      onSelectDefaultModel(model.id);
                      closeModelMenu();
                    }}
                    className={`flex h-8 w-full items-center justify-between rounded-lg px-2.5 text-left text-[12px] font-semibold ${
                      selected ? "bg-[#eef3ff] text-[#2457e6]" : "text-[#374151] hover:bg-[#f7f8fa]"
                    }`}
                  >
                    {formatModelName(model.id)}
                    {selected ? <Check size={13} aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>
          </>,
          document.body
        )
      : null;

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-[radial-gradient(circle_at_16%_0%,rgba(47,107,255,0.10),transparent_34%),radial-gradient(circle_at_88%_8%,rgba(20,184,166,0.08),transparent_32%),#fbfdff] px-2.5 pt-[max(env(safe-area-inset-top),8px)] pb-[calc(68px+env(safe-area-inset-bottom))] text-[#111827] md:px-4 md:pt-[max(env(safe-area-inset-top),12px)] md:pb-4">
      {modelMenuPortal}
      <div className="mx-auto max-w-5xl space-y-2">
        <header className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <RippleIcon
              size={24}
              className="h-6 w-6 shrink-0 rounded-md shadow-[0_6px_14px_rgba(64,92,255,0.14)]"
            />
            <div className="min-w-0">
              <h1 className="text-[16px] leading-tight font-semibold tracking-normal">Ripple</h1>
              <div className="text-[10px] text-[#7a8496]">Settings</div>
            </div>
          </div>
          {isLoading ? <Loader2 size={15} className="mt-1.5 animate-spin text-[#6b7280]" /> : null}
        </header>

        <section className="rounded-xl border border-[#dfe6f4] bg-white/78 shadow-[0_8px_22px_rgba(44,63,123,0.05)] backdrop-blur-xl">
          <SectionHeader icon={<UserRound size={13} />} title="Account" tone="accent" />
          <div className="space-y-2 p-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => avatarFileInputRef.current?.click()}
                  disabled={isAvatarUploading}
                  className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[#b8cdf8] bg-[#eef4ff] text-[15px] font-semibold text-[#2463eb] shadow-[0_6px_14px_rgba(44,63,123,0.07)] transition-all hover:bg-[#e8f0ff] active:scale-[0.98]"
                  aria-label={`Upload avatar for ${avatarName}`}
                  title="Upload avatar"
                >
                  {avatarImageUrl ? (
                    <img
                      src={avatarImageUrl}
                      alt=""
                      aria-hidden="true"
                      className="h-full w-full object-cover"
                    />
                  ) : isAvatarUploading ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : (
                    avatarInitials
                  )}
                </button>
                <input
                  ref={avatarFileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleAvatarUpload}
                />
                <div className="min-w-0">
                  <div className="mb-0.5 inline-flex rounded-full border border-[#dfe6f4] bg-[#f8faff] px-1.5 py-0.5 text-[10px] font-semibold text-[#667085]">
                    {authMode === "user" ? "Invite account" : "Developer mode"}
                  </div>
                  <div className="text-[12px] font-semibold text-[#111827]">
                    {authMode === "user" ? "Signed in" : "API key access"}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-[#667085]">
                    Workspace <span className="font-mono text-[#374151]">{userId}</span>
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                {authMode === "user" ? (
                  <button
                    type="button"
                    onClick={() => {
                      setIsPasswordOpen((open) => !open);
                      setPasswordError(null);
                      setPasswordMessage(null);
                    }}
                    className="inline-flex h-7 items-center gap-1.5 rounded-full border border-[#dfe6f4] bg-white px-2.5 text-[11px] font-semibold text-[#374151] transition-all hover:bg-[#f7f8fa] active:scale-[0.98]"
                  >
                    <LockKeyhole size={13} />
                    Change password
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={onApiKeyChange}
                  className="inline-flex h-7 items-center gap-1.5 rounded-full border border-[#dfe6f4] bg-white px-2.5 text-[11px] font-semibold text-[#374151] transition-all hover:bg-[#f7f8fa] active:scale-[0.98]"
                >
                  <LogOut size={13} />
                  {authMode === "user" ? "Sign out" : "Change access"}
                </button>
                <button
                  type="button"
                  onClick={() => avatarFileInputRef.current?.click()}
                  disabled={isAvatarUploading}
                  className="inline-flex h-7 items-center gap-1.5 rounded-full border border-[#dfe6f4] bg-white px-2.5 text-[11px] font-semibold text-[#374151] transition-all hover:bg-[#f7f8fa] active:scale-[0.98]"
                >
                  {isAvatarUploading ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Upload size={13} />
                  )}
                  {isAvatarUploading ? "Uploading" : "Upload avatar"}
                </button>
                {profileAvatarUri ? (
                  <button
                    type="button"
                    onClick={handleAvatarRemove}
                    disabled={isAvatarUploading}
                    className="inline-flex h-7 items-center gap-1.5 rounded-full border border-[#dfe6f4] bg-white px-2.5 text-[11px] font-semibold text-[#374151] transition-all hover:bg-[#f7f8fa] active:scale-[0.98]"
                  >
                    <X size={13} />
                    Remove avatar
                  </button>
                ) : null}
              </div>
            </div>
            {avatarError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] font-semibold text-red-700">
                {avatarError}
              </div>
            ) : null}

            {authMode === "user" && isPasswordOpen ? (
              <form
                onSubmit={handlePasswordSubmit}
                className="space-y-2 rounded-lg border border-[#e8edf7] bg-[#f8faff] p-2"
              >
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="min-w-0 text-[11px] font-semibold text-[#667085]">
                    Current password
                    <input
                      type="password"
                      value={currentPassword}
                      onChange={(event) => setCurrentPassword(event.target.value)}
                      className="mt-1 h-8 w-full rounded-lg border border-[#dfe6f4] bg-white px-2.5 text-[12px] text-[#111827] outline-none focus:border-[#8da0ff]"
                    />
                  </label>
                  <label className="min-w-0 text-[11px] font-semibold text-[#667085]">
                    New password
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(event) => setNewPassword(event.target.value)}
                      className="mt-1 h-8 w-full rounded-lg border border-[#dfe6f4] bg-white px-2.5 text-[12px] text-[#111827] outline-none focus:border-[#8da0ff]"
                    />
                  </label>
                </div>
                {passwordError ? (
                  <div className="text-xs font-medium text-[#cf222e]">{passwordError}</div>
                ) : null}
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIsPasswordOpen(false);
                      setPasswordError(null);
                    }}
                    className="inline-flex h-7 items-center gap-1.5 rounded-full border border-[#dfe6f4] bg-white px-2 text-[11px] font-semibold text-[#374151]"
                  >
                    <X size={12} />
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isChangingPassword}
                    className="inline-flex h-7 items-center gap-1.5 rounded-full bg-[#2463eb] px-2 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#d0d7e2]"
                  >
                    {isChangingPassword ? <Loader2 size={12} className="animate-spin" /> : null}
                    Save password
                  </button>
                </div>
              </form>
            ) : null}
            {passwordMessage ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-700">
                {passwordMessage}
              </div>
            ) : null}
          </div>
        </section>

        <section className="rounded-xl border border-[#dfe6f4] bg-white/78 shadow-[0_8px_22px_rgba(44,63,123,0.05)] backdrop-blur-xl">
          <SectionHeader icon={<HardDrive size={13} />} title="Usage & Limits" tone="neutral" />
          <div className="grid gap-2 p-2.5 md:grid-cols-2">
            <UsageMeter
              icon={<HardDrive size={13} />}
              iconTone="neutral"
              title="Workspace storage"
              value={workspaceBytes}
              max={maxWorkspaceBytes}
              detail={`${formatBytes(workspaceBytes)} of ${formatBytes(maxWorkspaceBytes)}`}
            />
            <UsageMeter
              icon={<Layers size={13} />}
              iconTone="accent"
              title="Session count"
              value={sessionCount}
              max={maxSessions}
              detail={`${sessionCount} of ${maxSessions}`}
            />
            <RunActivityMetrics
              runsToday={usage?.runs_today ?? 0}
              activeRuns={usage?.active_runs ?? 0}
            />
          </div>
          <div className="border-t border-[#e8edf7] p-2.5">
            <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-[#374151]">
              <IconTile tone="neutral" size="xs">
                <Cpu size={12} />
              </IconTile>
              Token usage
            </div>
            <div className="mb-1.5 text-[11px] leading-4 text-[#667085]">
              Input and output are shown separately for each window.
            </div>
            <div className="overflow-hidden rounded-lg border border-[#e8edf7] bg-[#f8faff] text-center">
              <div className="grid grid-cols-2 divide-x divide-[#e8edf7]">
                <Metric
                  label="24h input"
                  value={formatTokens(usage?.daily_input_tokens ?? 0)}
                  compact
                />
                <Metric
                  label="24h output"
                  value={formatTokens(usage?.daily_output_tokens ?? 0)}
                  compact
                />
              </div>
              <div className="grid grid-cols-2 divide-x divide-[#e8edf7] border-t border-[#e8edf7] bg-white/60">
                <Metric
                  label="7d input"
                  value={formatTokens(usage?.weekly_input_tokens ?? 0)}
                  compact
                />
                <Metric
                  label="7d output"
                  value={formatTokens(usage?.weekly_output_tokens ?? 0)}
                  compact
                />
              </div>
              <div className="grid grid-cols-2 divide-x divide-[#e8edf7] border-t border-[#e8edf7]">
                <Metric
                  label="Total input"
                  value={formatTokens(usage?.total_input_tokens ?? 0)}
                  compact
                />
                <Metric
                  label="Total output"
                  value={formatTokens(usage?.total_output_tokens ?? 0)}
                  compact
                />
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-[#dfe6f4] bg-white/78 shadow-[0_8px_22px_rgba(44,63,123,0.05)] backdrop-blur-xl">
          <SectionHeader icon={<SlidersHorizontal size={13} />} title="Defaults" tone="neutral" />
          <div className="flex flex-wrap items-center justify-between gap-2 p-2.5">
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-[#111827]">Default model</div>
              <div className="mt-0.5 text-[11px] text-[#667085]">
                Used for new prompts and scheduled runs.
              </div>
            </div>
            <div>
              <button
                type="button"
                onClick={handleModelMenuToggle}
                className="inline-flex h-7 min-w-28 items-center justify-between gap-2 rounded-full border border-[#dfe6f4] bg-white px-2.5 text-[11px] font-semibold text-[#374151] transition-all outline-none hover:bg-[#f7f8fa] focus:border-[#8da0ff]"
                aria-label="Default model"
                aria-haspopup="menu"
                aria-expanded={isModelMenuOpen}
              >
                {formatModelName(defaultModel)}
                <ChevronDown size={13} className="text-[#6b7280]" />
              </button>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-[#dfe6f4] bg-white/78 shadow-[0_8px_22px_rgba(44,63,123,0.05)] backdrop-blur-xl">
          <button
            type="button"
            onClick={() => setDiagnosticsOpen((open) => !open)}
            className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left"
          >
            <span className="flex items-center gap-1.5 text-[12px] font-semibold text-[#111827]">
              <IconTile tone="success" size="xs">
                <ShieldCheck size={13} />
              </IconTile>
              About & Diagnostics
            </span>
            <ChevronDown
              size={14}
              className={`shrink-0 text-[#6b7280] transition-transform ${
                diagnosticsOpen ? "rotate-180" : ""
              }`}
            />
          </button>
          {diagnosticsOpen ? (
            <div className="space-y-1.5 border-t border-[#e8edf7] p-2.5">
              <DiagnosticRow
                icon={<Server size={13} />}
                label="API endpoint"
                value={getConfiguredApiUrl()}
              />
              <DiagnosticRow icon={<UserRound size={13} />} label="User ID" value={userId} />
              <DiagnosticRow icon={<KeyRound size={13} />} label="Auth mode" value={authMode} />
              <DiagnosticRow
                icon={<HardDrive size={13} />}
                label="Sandbox status"
                value={sandbox ? "Ready" : "Not created"}
              />
              <DiagnosticRow
                icon={<KeyRound size={13} />}
                label="Credential"
                value={apiKey ? `${apiKey.slice(0, 6)}${"*".repeat(8)}` : "Not set"}
              />
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function SectionHeader({
  icon,
  title,
  tone = "neutral",
}: {
  icon: React.ReactNode;
  title: string;
  tone?: IconTileTone;
}) {
  return (
    <div className="flex h-8 items-center gap-1.5 border-b border-[#e8edf7] px-2.5 text-[11px] font-semibold text-[#111827]">
      <IconTile tone={tone} size="xs">
        {icon}
      </IconTile>
      {title}
    </div>
  );
}

function UsageMeter({
  icon,
  iconTone = "neutral",
  title,
  value,
  max,
  detail,
}: {
  icon: React.ReactNode;
  iconTone?: IconTileTone;
  title: string;
  value: number;
  max: number;
  detail: string;
}) {
  const amount = percent(value, max);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-[#6b7280]">
        <span className="flex items-center gap-1.5">
          <IconTile tone={iconTone} size="xs">
            {icon}
          </IconTile>
          {title}
        </span>
        <span>{amount.toFixed(1)}%</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-[#e5e7eb]">
        <div
          className="h-full bg-[#2463eb] transition-all duration-300"
          style={{ width: `${amount}%` }}
        />
      </div>
      <div className="mt-1 text-[11px] text-[#8b8f94]">{detail}</div>
    </div>
  );
}

function Metric({
  label,
  value,
  compact = false,
}: {
  label: string;
  value: string;
  compact?: boolean;
}) {
  return (
    <div
      className={compact ? "px-2 py-1.5" : "rounded-lg border border-[#e8edf7] bg-[#f8faff] p-2"}
    >
      <div className="text-[11px] font-medium text-[#8b8f94]">{label}</div>
      <div className="mt-0.5 text-[14px] font-semibold text-[#253247]">{value}</div>
    </div>
  );
}

function RunActivityMetrics({
  runsToday,
  activeRuns,
}: {
  runsToday: number;
  activeRuns: number;
}) {
  const items = [
    { label: "Runs today", value: runsToday },
    { label: "Running now", value: activeRuns },
  ];

  return (
    <div
      data-ripple-settings-run-metrics
      className="md:col-span-2 overflow-hidden rounded-lg border border-[#e8edf7] bg-[#f8faff]"
    >
      <div className="grid grid-cols-2 divide-x divide-[#e8edf7]">
        {items.map((item) => (
          <div key={item.label} className="px-2 py-1.5">
            <div className="text-[11px] font-medium text-[#8b8f94]">{item.label}</div>
            <div className="mt-0.5 text-[14px] font-semibold text-[#253247]">{item.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DiagnosticRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex min-h-8 items-center gap-1.5 rounded-lg border border-[#e8edf7] bg-[#f8faff] px-2 py-1">
      <IconTile tone="neutral" size="xs">
        {icon}
      </IconTile>
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] font-semibold text-[#6b7280]">{label}</span>
        <span className="block truncate font-mono text-[11px] text-[#253247]">{value}</span>
      </span>
    </div>
  );
}
