"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  Cpu,
  Edit3,
  HardDrive,
  KeyRound,
  Layers,
  Languages,
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
import { type LocalePreference, useI18n } from "@/i18n";
import {
  changePassword,
  deleteUserAvatar,
  fetchCurrentSandbox,
  fetchUserAvatarImage,
  fetchUserProfile,
  getConfiguredApiUrl,
  updateUserProfile,
  uploadUserAvatar,
} from "@/lib/api";
import {
  getMeasuredViewportMenuPosition,
  getResponsiveMenuBottomInsetPx,
  VIEWPORT_MENU_MARGIN_PX,
  type ViewportMenuAnchorRect,
} from "@/lib/menuPosition";
import { formatModelName } from "@/lib/models";
import {
  dispatchUserAvatarChanged,
  dispatchUserProfileChanged,
  getUserProfileAvatarUri,
  getUserProfileDisplayName,
} from "@/lib/userAvatar";
import type { SandboxInfo, UserProfile } from "@/types";
import { IconTile, type IconTileTone } from "@/components/icons/IconTile";
import RippleIcon from "@/components/icons/RippleIcon";
import MobileActionSheet from "./MobileActionSheet";
import {
  COMPACT_IOS_PAGE_BACKGROUND,
  MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS,
  MOBILE_PAGE_TOP_SAFE_AREA_CLASS,
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_META_MEDIUM_CLASS,
  TYPOGRAPHY_MICRO_MEDIUM_CLASS,
  TYPOGRAPHY_MOBILE_BODY_CLASS,
  TYPOGRAPHY_PAGE_TITLE_CLASS,
} from "./stylePrimitives";

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
const SETTINGS_AVATAR_MENU_WIDTH = 160;
const SETTINGS_AVATAR_MENU_ITEM_HEIGHT = 32;
const SETTINGS_AVATAR_MENU_VERTICAL_PADDING = 8;

const settingsAccountActionButtonClass = `flex h-9 w-full min-w-0 items-center justify-center gap-1.5 rounded-lg border border-[#DEE0E3] bg-white px-2 text-[#2B2F36] transition-all hover:bg-[#F8F9FA] active:scale-[0.98] sm:inline-flex sm:w-auto sm:min-w-[60px] sm:gap-1 lg:h-8 ${TYPOGRAPHY_MICRO_MEDIUM_CLASS} [&>span]:min-w-0 [&>span]:truncate [&>svg]:shrink-0`;

const settingsSectionClass =
  "overflow-hidden rounded-xl border border-[#DEE0E3]/80 bg-white/82 shadow-[0_10px_26px_rgba(31,35,41,0.06)] backdrop-blur-xl";

const settingsGroupedRowClass =
  "flex min-h-10 flex-wrap items-center justify-between gap-2 px-2.5 py-1.5";

const settingsFieldLabelClass = `min-w-0 text-[#646A73] ${TYPOGRAPHY_META_MEDIUM_CLASS}`;

const settingsFieldInputClass = `mt-1 h-11 w-full rounded-lg border border-[#DEE0E3] bg-white px-2.5 text-[#1F2329] outline-none focus:border-[#8FB1FF] ${TYPOGRAPHY_MOBILE_BODY_CLASS} lg:h-10 lg:text-[14px] lg:leading-[22px]`;

const settingsFormButtonClass = `inline-flex h-11 items-center gap-1.5 rounded-full px-3 lg:h-10 ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`;

interface ModelMenuPosition {
  top: number;
  left: number;
  anchorRect: ViewportMenuAnchorRect;
  measuredHeight: number | null;
}

function getSettingsModelMenuHeight(optionCount: number): number {
  return optionCount * SETTINGS_MODEL_MENU_ITEM_HEIGHT + SETTINGS_MODEL_MENU_VERTICAL_PADDING;
}

function getSettingsAvatarMenuHeight(optionCount: number): number {
  return optionCount * SETTINGS_AVATAR_MENU_ITEM_HEIGHT + SETTINGS_AVATAR_MENU_VERTICAL_PADDING;
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

function getSettingsAvatarMenuPosition(
  anchorRect: ViewportMenuAnchorRect,
  optionCount: number
): { top: number; left: number } {
  const position = getMeasuredViewportMenuPosition({
    anchorRect,
    menuWidth: SETTINGS_AVATAR_MENU_WIDTH,
    estimatedMenuHeight: getSettingsAvatarMenuHeight(optionCount),
    measuredMenuHeight: null,
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
  const { preference: localePreference, setPreference: setLocalePreference, t } = useI18n();
  const [sandbox, setSandbox] = useState<SandboxInfo | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [avatarImageUrl, setAvatarImageUrl] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [isAvatarUploading, setIsAvatarUploading] = useState(false);
  const [isAvatarMenuOpen, setIsAvatarMenuOpen] = useState(false);
  const [isDisplayNameEditing, setIsDisplayNameEditing] = useState(false);
  const [displayNameInput, setDisplayNameInput] = useState("");
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);
  const [displayNameMessage, setDisplayNameMessage] = useState<string | null>(null);
  const [isSavingDisplayName, setIsSavingDisplayName] = useState(false);
  const [isPasswordOpen, setIsPasswordOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [modelMenuPosition, setModelMenuPosition] = useState<ModelMenuPosition | null>(null);
  const [avatarMenuPosition, setAvatarMenuPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const avatarFileInputRef = useRef<HTMLInputElement | null>(null);
  const diagnosticsSectionRef = useRef<HTMLElement | null>(null);

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
  const profileDisplayName = getUserProfileDisplayName(profile, userId);
  const profileEmail = profile?.profile?.login?.trim() || "";
  const avatarName = profileDisplayName;
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
  const tokenUsageMetrics = [
    { label: t("settings.dailyInput"), value: formatTokens(usage?.daily_input_tokens ?? 0) },
    { label: t("settings.weeklyInput"), value: formatTokens(usage?.weekly_input_tokens ?? 0) },
    { label: t("settings.totalInput"), value: formatTokens(usage?.total_input_tokens ?? 0) },
    { label: t("settings.dailyOutput"), value: formatTokens(usage?.daily_output_tokens ?? 0) },
    { label: t("settings.weeklyOutput"), value: formatTokens(usage?.weekly_output_tokens ?? 0) },
    { label: t("settings.totalOutput"), value: formatTokens(usage?.total_output_tokens ?? 0) },
  ];
  const languageOptions: Array<{ value: LocalePreference; label: string }> = [
    { value: "system", label: t("settings.language.system") },
    { value: "zh-CN", label: t("settings.language.zhCN") },
    { value: "en-US", label: t("settings.language.enUS") },
  ];

  useEffect(() => {
    if (isDisplayNameEditing) return;
    setDisplayNameInput(profile?.profile?.display_name ?? "");
  }, [isDisplayNameEditing, profile?.profile?.display_name]);

  useEffect(() => {
    if (!diagnosticsOpen || typeof window === "undefined") return;
    const frame = window.requestAnimationFrame(() => {
      diagnosticsSectionRef.current?.scrollIntoView({
        block: "end",
        behavior: "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [diagnosticsOpen]);

  const handlePasswordSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isChangingPassword) return;
    if (!currentPassword || !newPassword) {
      setPasswordError(t("settings.passwordMissing"));
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError(t("settings.passwordTooShort"));
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
      setPasswordMessage(t("settings.passwordUpdated"));
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : t("settings.passwordUpdateFailed"));
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleDisplayNameSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSavingDisplayName) return;
    const displayName = displayNameInput.trim();
    try {
      setIsSavingDisplayName(true);
      setDisplayNameError(null);
      setDisplayNameMessage(null);
      const nextProfile = await updateUserProfile({ display_name: displayName || null });
      setProfile(nextProfile);
      setDisplayNameInput(nextProfile.profile?.display_name ?? "");
      setIsDisplayNameEditing(false);
      setDisplayNameMessage(t("settings.displayNameUpdated"));
      dispatchUserProfileChanged();
    } catch (error) {
      setDisplayNameError(
        error instanceof Error ? error.message : t("settings.displayNameUpdateFailed")
      );
    } finally {
      setIsSavingDisplayName(false);
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
        setAvatarError(error instanceof Error ? error.message : t("settings.avatarLoadFailed"));
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [profileAvatarUri, t]);

  const handleAvatarUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    setIsAvatarMenuOpen(false);
    setAvatarMenuPosition(null);
    if (!file || !file.type.startsWith("image/")) return;

    try {
      setIsAvatarUploading(true);
      setAvatarError(null);
      const nextProfile = await uploadUserAvatar(file);
      setProfile(nextProfile);
      dispatchUserAvatarChanged();
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : t("settings.avatarUploadFailed"));
    } finally {
      setIsAvatarUploading(false);
    }
  };

  const handleAvatarRemove = async () => {
    setIsAvatarMenuOpen(false);
    setAvatarMenuPosition(null);
    try {
      setIsAvatarUploading(true);
      setAvatarError(null);
      const nextProfile = await deleteUserAvatar();
      setProfile(nextProfile);
      dispatchUserAvatarChanged();
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : t("settings.avatarRemoveFailed"));
    } finally {
      setIsAvatarUploading(false);
    }
  };

  const closeAvatarMenu = useCallback(() => {
    setIsAvatarMenuOpen(false);
    setAvatarMenuPosition(null);
  }, []);

  const handleAvatarMenuToggle = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (isAvatarMenuOpen) {
      closeAvatarMenu();
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const anchorRect = {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
    };
    setAvatarMenuPosition(getSettingsAvatarMenuPosition(anchorRect, profileAvatarUri ? 2 : 1));
    setIsAvatarMenuOpen(true);
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

  useEffect(() => {
    if (!isAvatarMenuOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAvatarMenu();
    };

    window.addEventListener("resize", closeAvatarMenu);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", closeAvatarMenu);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeAvatarMenu, isAvatarMenuOpen]);

  const modelMenuPortal =
    isModelMenuOpen && modelMenuPosition && typeof document !== "undefined"
      ? createPortal(
          <>
            <div
              className="fixed inset-0 z-40 hidden bg-transparent lg:block"
              onClick={closeModelMenu}
            />
            <div
              ref={modelMenuRef}
              role="menu"
              style={{
                top: modelMenuPosition.top,
                left: modelMenuPosition.left,
                position: "fixed",
              }}
              className="z-50 hidden max-h-[calc(100dvh-104px)] w-44 overflow-y-auto rounded-xl border border-[#DEE0E3] bg-white p-1 shadow-[0_14px_34px_rgba(31,35,41,0.14)] lg:block"
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
                    className={`flex h-8 w-full items-center justify-between rounded-lg px-2.5 text-left ${TYPOGRAPHY_META_MEDIUM_CLASS} ${
                      selected ? "bg-[#F0F5FF] text-[#0F4BD8]" : "text-[#2B2F36] hover:bg-[#F8F9FA]"
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
  const avatarMenuPortal =
    isAvatarMenuOpen && avatarMenuPosition && typeof document !== "undefined"
      ? createPortal(
          <>
            <div
              className="fixed inset-0 z-40 hidden bg-transparent lg:block"
              onClick={closeAvatarMenu}
            />
            <div
              role="menu"
              style={{
                top: avatarMenuPosition.top,
                left: avatarMenuPosition.left,
                position: "fixed",
              }}
              className="z-50 hidden w-40 rounded-xl border border-[#DEE0E3] bg-white p-1 shadow-[0_14px_34px_rgba(31,35,41,0.14)] lg:block"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeAvatarMenu();
                  avatarFileInputRef.current?.click();
                }}
                className={`flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[#2B2F36] hover:bg-[#F8F9FA] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
              >
                <Upload size={13} />
                {t("settings.uploadAvatar")}
              </button>
              {profileAvatarUri ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleAvatarRemove}
                  className={`flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[#B42318] hover:bg-[#FFF1F0] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                >
                  <X size={13} />
                  {t("settings.removeAvatar")}
                </button>
              ) : null}
            </div>
          </>,
          document.body
        )
      : null;

  return (
    <div
      className={`h-full min-h-0 overflow-y-auto ${COMPACT_IOS_PAGE_BACKGROUND} px-3 ${MOBILE_PAGE_TOP_SAFE_AREA_CLASS} ${MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS} text-[#1F2329] md:px-6 lg:pb-5`}
    >
      {modelMenuPortal}
      {avatarMenuPortal}
      <MobileActionSheet
        open={isModelMenuOpen}
        data-ripple-settings-model-sheet
        title={t("settings.defaultModel")}
        closeLabel={t("settings.cancel")}
        onClose={closeModelMenu}
        actions={availableModels.map((model) => ({
          key: model.id,
          label: formatModelName(model.id),
          selected: model.id === defaultModel,
          tone: model.id === defaultModel ? "accent" : "neutral",
          onClick: () => {
            onSelectDefaultModel(model.id);
            closeModelMenu();
          },
        }))}
      />
      <MobileActionSheet
        open={isAvatarMenuOpen}
        data-ripple-settings-avatar-sheet
        title={t("settings.avatarActions")}
        closeLabel={t("settings.cancel")}
        onClose={closeAvatarMenu}
        actions={[
          {
            key: "upload-avatar",
            label: t("settings.uploadAvatar"),
            icon: <Upload size={16} />,
            loading: isAvatarUploading,
            disabled: isAvatarUploading,
            onClick: () => {
              closeAvatarMenu();
              avatarFileInputRef.current?.click();
            },
          },
          ...(profileAvatarUri
            ? [
                {
                  key: "remove-avatar",
                  label: t("settings.removeAvatar"),
                  icon: <X size={16} />,
                  tone: "danger" as const,
                  onClick: () => {
                    handleAvatarRemove();
                  },
                },
              ]
            : []),
        ]}
      />
      <div className="mx-auto max-w-5xl space-y-2.5">
        <header className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <RippleIcon
              size={28}
              className="h-7 w-7 shrink-0 rounded-md shadow-[0_6px_14px_rgba(64,92,255,0.14)]"
            />
            <div className="min-w-0">
              <h1 className={TYPOGRAPHY_PAGE_TITLE_CLASS}>Ripple</h1>
              <div className={`text-[#646A73] ${TYPOGRAPHY_META_CLASS}`}>{t("settings.title")}</div>
            </div>
          </div>
          {isLoading ? <Loader2 size={15} className="mt-1.5 animate-spin text-[#646A73]" /> : null}
        </header>

        <SettingsSection sectionKind="account">
          <SectionHeader
            icon={<UserRound size={13} />}
            title={t("settings.account")}
            tone="neutral"
          />
          <div className="space-y-1.5 p-2">
            <div
              data-ripple-settings-account-summary
              className="flex flex-wrap items-center justify-between gap-2 pb-0.5"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => avatarFileInputRef.current?.click()}
                  disabled={isAvatarUploading}
                  className={`flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[#DEE0E3] bg-white/86 text-[#2B2F36] shadow-[0_8px_18px_rgba(31,35,41,0.08)] transition-all hover:bg-white active:scale-[0.98] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
                  aria-label={t("settings.uploadAvatarFor", { name: avatarName })}
                  title={t("settings.uploadAvatar")}
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
                  <div
                    aria-label={t("settings.displayName")}
                    className={`truncate text-[#1F2329] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
                  >
                    {authMode === "user" ? profileDisplayName : t("settings.apiKeyAccess")}
                  </div>
                  <div className={`mt-0.5 truncate text-[#646A73] ${TYPOGRAPHY_META_CLASS}`}>
                    {authMode === "user"
                      ? profileEmail || t("settings.signedIn")
                      : t("settings.developerMode")}
                  </div>
                </div>
              </div>
              <div
                data-ripple-settings-account-actions
                className="grid w-full grid-cols-2 gap-1 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:justify-end"
              >
                {authMode === "user" ? (
                  <button
                    type="button"
                    data-ripple-settings-row-action
                    onClick={() => {
                      setIsDisplayNameEditing((editing) => !editing);
                      setDisplayNameError(null);
                      setDisplayNameMessage(null);
                    }}
                    className={settingsAccountActionButtonClass}
                  >
                    <Edit3 size={13} />
                    <span>{t("settings.edit")}</span>
                  </button>
                ) : null}
                {authMode === "user" ? (
                  <button
                    type="button"
                    data-ripple-settings-row-action
                    onClick={() => {
                      setIsPasswordOpen((open) => !open);
                      setPasswordError(null);
                      setPasswordMessage(null);
                    }}
                    className={settingsAccountActionButtonClass}
                  >
                    <LockKeyhole size={13} />
                    <span>{t("settings.changePassword")}</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  data-ripple-settings-row-action
                  onClick={onApiKeyChange}
                  className={settingsAccountActionButtonClass}
                >
                  <LogOut size={13} />
                  <span>{t("settings.logOut")}</span>
                </button>
                <div className="relative">
                  <button
                    type="button"
                    data-ripple-settings-row-action
                    onClick={handleAvatarMenuToggle}
                    disabled={isAvatarUploading}
                    aria-label={t("settings.avatarActions")}
                    aria-haspopup="menu"
                    aria-expanded={isAvatarMenuOpen}
                    className={settingsAccountActionButtonClass}
                  >
                    {isAvatarUploading ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <UserRound size={13} />
                    )}
                    <span>
                      {isAvatarUploading ? t("settings.uploading") : t("settings.avatar")}
                    </span>
                    <ChevronDown size={12} className="text-[#646A73]" />
                  </button>
                </div>
              </div>
            </div>
            {avatarError ? (
              <div
                className={`rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-red-700 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
              >
                {avatarError}
              </div>
            ) : null}

            {authMode === "user" && isDisplayNameEditing ? (
              <form
                onSubmit={handleDisplayNameSubmit}
                className="space-y-2 rounded-lg border border-[#EFF0F1] bg-[#F8F9FA] p-2"
              >
                <label className={settingsFieldLabelClass}>
                  {t("settings.displayName")}
                  <input
                    aria-label={t("settings.displayName")}
                    type="text"
                    value={displayNameInput}
                    onChange={(event) => setDisplayNameInput(event.target.value)}
                    className={settingsFieldInputClass}
                    maxLength={80}
                  />
                </label>
                {displayNameError ? (
                  <div className={`text-[#B42318] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}>
                    {displayNameError}
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIsDisplayNameEditing(false);
                      setDisplayNameInput(profile?.profile?.display_name ?? "");
                      setDisplayNameError(null);
                    }}
                    className={`${settingsFormButtonClass} border border-[#DEE0E3] bg-white text-[#2B2F36]`}
                  >
                    <X size={12} />
                    {t("settings.cancel")}
                  </button>
                  <button
                    type="submit"
                    disabled={isSavingDisplayName}
                    className={`${settingsFormButtonClass} bg-[#1456F0] text-white disabled:cursor-not-allowed disabled:bg-[#BBBFC4]`}
                  >
                    {isSavingDisplayName ? <Loader2 size={12} className="animate-spin" /> : null}
                    {t("settings.saveName")}
                  </button>
                </div>
              </form>
            ) : null}
            {displayNameMessage ? (
              <div
                className={`rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-emerald-700 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
              >
                {displayNameMessage}
              </div>
            ) : null}

            {authMode === "user" && isPasswordOpen ? (
              <form
                onSubmit={handlePasswordSubmit}
                className="space-y-2 rounded-lg border border-[#EFF0F1] bg-[#F8F9FA] p-2"
              >
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className={settingsFieldLabelClass}>
                    {t("settings.currentPassword")}
                    <input
                      type="password"
                      value={currentPassword}
                      onChange={(event) => setCurrentPassword(event.target.value)}
                      className={settingsFieldInputClass}
                    />
                  </label>
                  <label className={settingsFieldLabelClass}>
                    {t("settings.newPassword")}
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(event) => setNewPassword(event.target.value)}
                      className={settingsFieldInputClass}
                    />
                  </label>
                </div>
                {passwordError ? (
                  <div className={`text-[#B42318] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}>
                    {passwordError}
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIsPasswordOpen(false);
                      setPasswordError(null);
                    }}
                    className={`${settingsFormButtonClass} border border-[#DEE0E3] bg-white text-[#2B2F36]`}
                  >
                    <X size={12} />
                    {t("settings.cancel")}
                  </button>
                  <button
                    type="submit"
                    disabled={isChangingPassword}
                    className={`${settingsFormButtonClass} bg-[#1456F0] text-white disabled:cursor-not-allowed disabled:bg-[#BBBFC4]`}
                  >
                    {isChangingPassword ? <Loader2 size={12} className="animate-spin" /> : null}
                    {t("settings.savePassword")}
                  </button>
                </div>
              </form>
            ) : null}
            {passwordMessage ? (
              <div
                className={`rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-emerald-700 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
              >
                {passwordMessage}
              </div>
            ) : null}
          </div>
        </SettingsSection>

        <SettingsSection sectionKind="usage">
          <SectionHeader
            icon={<HardDrive size={13} />}
            title={t("settings.usageLimits")}
            tone="neutral"
          />
          <div className="grid gap-1.5 p-2.5 md:grid-cols-2">
            <UsageMeter
              icon={<HardDrive size={13} />}
              iconTone="neutral"
              title={t("settings.workspaceStorage")}
              value={workspaceBytes}
              max={maxWorkspaceBytes}
              detail={t("settings.usageOfLimit", {
                value: formatBytes(workspaceBytes),
                max: formatBytes(maxWorkspaceBytes),
              })}
            />
            <UsageMeter
              icon={<Layers size={13} />}
              iconTone="neutral"
              title={t("settings.sessionCount")}
              value={sessionCount}
              max={maxSessions}
              detail={t("settings.usageOfLimit", { value: sessionCount, max: maxSessions })}
            />
            <RunActivityMetrics
              runsToday={usage?.runs_today ?? 0}
              activeRuns={usage?.active_runs ?? 0}
            />
          </div>
          <div className="border-t border-[#EFF0F1] p-2">
            <div
              className={`mb-1 flex items-center gap-1.5 text-[#2B2F36] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
            >
              <IconTile tone="neutral" size="xs">
                <Cpu size={12} />
              </IconTile>
              {t("settings.tokenUsage")}
            </div>
            <div
              data-ripple-settings-token-grid
              className="grid grid-cols-3 overflow-hidden rounded-lg border border-[#EFF0F1] bg-[#F8F9FA] text-center"
            >
              {tokenUsageMetrics.map((metric, index) => {
                const borderClassName = [
                  index % 3 === 0 ? "" : "border-l border-[#EFF0F1]",
                  index >= 3 ? "border-t border-[#EFF0F1]" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <Metric
                    key={metric.label}
                    label={metric.label}
                    value={metric.value}
                    compact
                    className={borderClassName}
                  />
                );
              })}
            </div>
          </div>
        </SettingsSection>

        <SettingsSection sectionKind="defaults">
          <SectionHeader
            icon={<SlidersHorizontal size={13} />}
            title={t("settings.defaults")}
            tone="neutral"
          />
          <div data-ripple-settings-defaults-list className="divide-y divide-[#EFF0F1]">
            <div className={settingsGroupedRowClass}>
              <div className="min-w-0">
                <div className={`text-[#1F2329] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>
                  {t("settings.defaultModel")}
                </div>
              </div>
              <div>
                <button
                  type="button"
                  onClick={handleModelMenuToggle}
                  className={`inline-flex h-11 min-w-28 items-center justify-between gap-2 rounded-full border border-[#DEE0E3] bg-white px-3 text-[#2B2F36] transition-all outline-none hover:bg-[#F8F9FA] focus:border-[#8FB1FF] lg:h-10 ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
                  aria-label={t("settings.defaultModel")}
                  aria-haspopup="menu"
                  aria-expanded={isModelMenuOpen}
                >
                  {formatModelName(defaultModel)}
                  <ChevronDown size={13} className="text-[#646A73]" />
                </button>
              </div>
            </div>
            <div
              data-ripple-settings-language-row
              className="flex min-h-10 flex-col items-stretch justify-between gap-2 px-2.5 py-2 sm:flex-row sm:items-center sm:py-1.5"
            >
              <div className="flex min-w-0 items-center gap-2">
                <IconTile tone="neutral" size="xs">
                  <Languages size={13} />
                </IconTile>
                <div className="min-w-0">
                  <div className={`text-[#1F2329] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>
                    {t("settings.language.title")}
                  </div>
                  <div className={`mt-0.5 hidden text-[#646A73] sm:block ${TYPOGRAPHY_META_CLASS}`}>
                    {t("settings.language.description")}
                  </div>
                </div>
              </div>
              <div
                data-ripple-settings-language-control
                className="grid w-full grid-cols-3 rounded-full border border-[#DEE0E3] bg-white p-0.5 sm:inline-flex sm:w-auto sm:shrink-0"
              >
                {languageOptions.map((option) => {
                  const selected = localePreference === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setLocalePreference(option.value)}
                      className={`h-9 min-w-0 rounded-full px-1 transition-all sm:min-w-[76px] sm:px-2 lg:h-8 ${TYPOGRAPHY_MICRO_MEDIUM_CLASS} sm:text-[12px] sm:leading-5 ${
                        selected
                          ? "bg-[#F0F5FF] text-[#0F4BD8] shadow-[0_6px_14px_rgba(20,86,240,0.14)]"
                          : "text-[#646A73] hover:bg-[#F8F9FA] hover:text-[#2B2F36]"
                      }`}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          ref={diagnosticsSectionRef}
          sectionKind="diagnostics"
          data-ripple-settings-diagnostics-section
          className="scroll-mb-[calc(84px+env(safe-area-inset-bottom))] lg:scroll-mb-4"
        >
          <button
            type="button"
            onClick={() => setDiagnosticsOpen((open) => !open)}
            className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left"
          >
            <span
              className={`flex items-center gap-1.5 text-[#1F2329] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
            >
              <IconTile tone="neutral" size="xs">
                <ShieldCheck size={13} />
              </IconTile>
              {t("settings.aboutDiagnostics")}
            </span>
            <ChevronDown
              size={14}
              className={`shrink-0 text-[#646A73] transition-transform ${
                diagnosticsOpen ? "rotate-180" : ""
              }`}
            />
          </button>
          {diagnosticsOpen ? (
            <div className="space-y-1.5 border-t border-[#EFF0F1] p-2.5">
              <DiagnosticRow
                icon={<Server size={13} />}
                label={t("settings.apiEndpoint")}
                value={getConfiguredApiUrl()}
              />
              <DiagnosticRow
                icon={<UserRound size={13} />}
                label={t("settings.userId")}
                value={userId}
              />
              <DiagnosticRow
                icon={<KeyRound size={13} />}
                label={t("settings.authMode")}
                value={authMode}
              />
              <DiagnosticRow
                icon={<HardDrive size={13} />}
                label={t("settings.sandboxStatus")}
                value={sandbox ? t("settings.ready") : t("settings.notCreated")}
              />
              <DiagnosticRow
                icon={<KeyRound size={13} />}
                label={t("settings.credential")}
                value={apiKey ? `${apiKey.slice(0, 6)}${"*".repeat(8)}` : t("settings.notSet")}
              />
            </div>
          ) : null}
        </SettingsSection>
      </div>
    </div>
  );
}

type SettingsSectionKind = "account" | "usage" | "defaults" | "diagnostics";

interface SettingsSectionProps extends React.HTMLAttributes<HTMLElement> {
  sectionKind: SettingsSectionKind;
}

const SettingsSection = React.forwardRef<HTMLElement, SettingsSectionProps>(
  ({ sectionKind, className = "", children, ...sectionProps }, ref) => (
    <section
      {...sectionProps}
      ref={ref}
      data-ripple-settings-section={sectionKind}
      className={className ? `${settingsSectionClass} ${className}` : settingsSectionClass}
    >
      {children}
    </section>
  )
);
SettingsSection.displayName = "SettingsSection";

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
    <div
      className={`flex min-h-10 items-center gap-1.5 border-b border-[#EFF0F1]/80 bg-white/54 px-2.5 text-[#1F2329] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
    >
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
    <div data-ripple-settings-usage-meter className="rounded-lg bg-[#F8F9FA]/70 px-2 py-1.5">
      <div
        className={`mb-1 flex items-center justify-between text-[#646A73] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
      >
        <span className="flex items-center gap-1.5">
          <IconTile tone={iconTone} size="xs">
            {icon}
          </IconTile>
          {title}
        </span>
        <span>{amount.toFixed(1)}%</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-[#EFF0F1]">
        <div
          className="h-full bg-[#1456F0] transition-all duration-300"
          style={{ width: `${amount}%` }}
        />
      </div>
      <div className={`mt-1 text-[#8F959E] ${TYPOGRAPHY_META_CLASS}`}>{detail}</div>
    </div>
  );
}

function Metric({
  label,
  value,
  compact = false,
  className = "",
}: {
  label: string;
  value: string;
  compact?: boolean;
  className?: string;
}) {
  const baseClassName = compact
    ? "px-1.5 py-1"
    : "rounded-lg border border-[#EFF0F1] bg-[#F8F9FA] p-2";

  return (
    <div className={className ? `${baseClassName} ${className}` : baseClassName}>
      <div
        className={
          compact
            ? `text-[#8F959E] ${TYPOGRAPHY_META_MEDIUM_CLASS}`
            : `text-[#8F959E] ${TYPOGRAPHY_META_MEDIUM_CLASS}`
        }
      >
        {label}
      </div>
      <div
        className={
          compact
            ? `mt-0.5 text-[#1F2329] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`
            : `mt-0.5 text-[#1F2329] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`
        }
      >
        {value}
      </div>
    </div>
  );
}

function RunActivityMetrics({ runsToday, activeRuns }: { runsToday: number; activeRuns: number }) {
  const { t } = useI18n();
  const items = [
    { label: t("settings.runsToday"), value: runsToday },
    { label: t("settings.runningNow"), value: activeRuns },
  ];

  return (
    <div
      data-ripple-settings-run-metrics
      className="overflow-hidden rounded-lg border border-[#EFF0F1] bg-[#F8F9FA] md:col-span-2"
    >
      <div className="grid grid-cols-2 divide-x divide-[#EFF0F1]">
        {items.map((item) => (
          <div key={item.label} className="px-2 py-1.5">
            <div className={`text-[#8F959E] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}>{item.label}</div>
            <div className={`mt-0.5 text-[#1F2329] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>
              {item.value}
            </div>
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
    <div className="flex min-h-8 items-center gap-1.5 rounded-lg border border-[#EFF0F1] bg-[#F8F9FA] px-2 py-1">
      <IconTile tone="neutral" size="xs">
        {icon}
      </IconTile>
      <span className="min-w-0 flex-1">
        <span className={`block text-[#646A73] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}>{label}</span>
        <span className={`block truncate font-mono text-[#1F2329] ${TYPOGRAPHY_META_CLASS}`}>
          {value}
        </span>
      </span>
    </div>
  );
}
