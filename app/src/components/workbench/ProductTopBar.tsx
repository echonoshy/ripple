"use client";

import React from "react";
import { User } from "lucide-react";
import { IconTile } from "@/components/icons/IconTile";
import RippleIcon from "@/components/icons/RippleIcon";
import { type MessageKey, useI18n } from "@/i18n";
import { fetchUserAvatarImage, fetchUserProfile } from "@/lib/api";
import {
  getUserProfileAvatarUri,
  getUserProfileDisplayName,
  USER_AVATAR_CHANGED_EVENT,
  USER_PROFILE_CHANGED_EVENT,
} from "@/lib/userAvatar";
import { mainNavItems, type WorkspaceView } from "@/lib/workspaceViews";
import {
  LUCIDE_NAV_STROKE_WIDTH,
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_SECTION_TITLE_CLASS,
} from "./stylePrimitives";

interface ProductTopBarProps {
  activeView: WorkspaceView;
  userId: string;
  onSelectView: (view: WorkspaceView) => void;
  onOpenSettings: () => void;
}

const navLabelKeys: Record<WorkspaceView, MessageKey> = {
  sessions: "nav.sessions",
  files: "nav.files",
  skills: "nav.skills",
  automations: "nav.automations",
  connectors: "nav.connectors",
  home: "nav.settings",
};

export default function ProductTopBar({
  activeView,
  userId,
  onSelectView,
  onOpenSettings,
}: ProductTopBarProps) {
  const { t } = useI18n();
  const [profile, setProfile] = React.useState<Awaited<ReturnType<typeof fetchUserProfile>> | null>(
    null
  );
  const [avatarImageUrl, setAvatarImageUrl] = React.useState<string | null>(null);
  const [profileRefreshToken, setProfileRefreshToken] = React.useState(0);

  const avatarUri = getUserProfileAvatarUri(profile);
  const displayName = getUserProfileDisplayName(profile, userId);

  React.useEffect(() => {
    let cancelled = false;

    void fetchUserProfile()
      .then((data) => {
        if (!cancelled) setProfile(data);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [profileRefreshToken, userId]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    const handleProfileChanged = () => setProfileRefreshToken((token) => token + 1);
    window.addEventListener(USER_AVATAR_CHANGED_EVENT, handleProfileChanged);
    window.addEventListener(USER_PROFILE_CHANGED_EVENT, handleProfileChanged);
    return () => {
      window.removeEventListener(USER_AVATAR_CHANGED_EVENT, handleProfileChanged);
      window.removeEventListener(USER_PROFILE_CHANGED_EVENT, handleProfileChanged);
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setAvatarImageUrl(null);
    if (!avatarUri || typeof URL === "undefined") return;

    void fetchUserAvatarImage(avatarUri)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setAvatarImageUrl(objectUrl);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [avatarUri]);

  return (
    <header
      data-ripple-product-top-bar="true"
      className="flex h-[52px] w-full items-center border-b border-[#d7d7dd]/70 bg-white/76 px-4 shadow-[0_8px_22px_rgba(60,60,67,0.05)] backdrop-blur-2xl"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <RippleIcon size={28} className="h-7 w-7 shrink-0 rounded-lg" />
        <span className={`truncate ${TYPOGRAPHY_SECTION_TITLE_CLASS} text-[#111827]`}>Ripple</span>
      </div>

      <nav className="flex flex-1 justify-center" aria-label={t("nav.primary")}>
        <div className="inline-flex items-center gap-0.5 rounded-full border border-[#d7d7dd]/80 bg-white/68 p-0.5 shadow-[0_6px_18px_rgba(60,60,67,0.06)] backdrop-blur-xl">
          {mainNavItems.map((item) => {
            const Icon = item.icon;
            const selected = item.id === activeView;
            return (
              <button
                key={item.id}
                type="button"
                data-ripple-top-tab={item.id}
                onClick={() => onSelectView(item.id)}
                className={`inline-flex h-8 w-[132px] shrink-0 items-center justify-center gap-1.5 rounded-full px-3 ${TYPOGRAPHY_BODY_MEDIUM_CLASS} whitespace-nowrap transition-all ${
                  selected
                    ? "bg-[#007aff] text-white shadow-[0_8px_18px_rgba(0,122,255,0.22)]"
                    : "text-[#3c3c43] hover:bg-white/82 hover:text-[#111827]"
                }`}
              >
                <Icon
                  size={16}
                  className="h-4 w-4 shrink-0"
                  strokeWidth={LUCIDE_NAV_STROKE_WIDTH}
                />
                {t(navLabelKeys[item.id])}
              </button>
            );
          })}
        </div>
      </nav>

      <div className="flex flex-1 justify-end">
        <button
          type="button"
          data-ripple-top-settings-entry="true"
          onClick={onOpenSettings}
          aria-label={t("common.openPersonalSettingsFor", { name: displayName })}
          title={t("common.personalSettings")}
          className="group inline-flex h-10 w-10 items-center justify-center rounded-xl bg-transparent text-[#3c3c43] transition-colors hover:bg-[#f2f2f7]/70 active:bg-[#e5e5ea]/70"
        >
          <IconTile tone="neutral" size="lg" className="relative border-transparent bg-transparent">
            {avatarImageUrl ? (
              <span className="absolute inset-0 overflow-hidden rounded-xl">
                <img
                  src={avatarImageUrl}
                  alt=""
                  aria-hidden="true"
                  className="h-full w-full object-cover"
                />
              </span>
            ) : (
              <User size={14} className="text-[#384152]" />
            )}
            <span
              data-ripple-settings-status-dot="true"
              className="absolute -right-0.5 -bottom-0.5 z-10 flex h-2.5 w-2.5"
              aria-hidden="true"
            >
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full border border-white bg-emerald-500" />
            </span>
          </IconTile>
        </button>
      </div>
    </header>
  );
}
