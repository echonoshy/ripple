"use client";

import React from "react";
import { User } from "lucide-react";
import { IconTile } from "@/components/icons/IconTile";
import RippleIcon from "@/components/icons/RippleIcon";
import { fetchUserAvatarImage, fetchUserProfile } from "@/lib/api";
import {
  getUserProfileAvatarUri,
  getUserProfileDisplayName,
  USER_AVATAR_CHANGED_EVENT,
  USER_PROFILE_CHANGED_EVENT,
} from "@/lib/userAvatar";
import { mainNavItems, type WorkspaceView } from "@/lib/workspaceViews";
import { LUCIDE_NAV_STROKE_WIDTH } from "./stylePrimitives";

interface ProductTopBarProps {
  activeView: WorkspaceView;
  userId: string;
  onSelectView: (view: WorkspaceView) => void;
  onOpenSettings: () => void;
}

export default function ProductTopBar({
  activeView,
  userId,
  onSelectView,
  onOpenSettings,
}: ProductTopBarProps) {
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
      className="flex h-[52px] w-full items-center border-b border-[#e8edf7] bg-white/72 px-4 shadow-[0_8px_22px_rgba(44,63,123,0.04)] backdrop-blur-2xl"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <RippleIcon size={28} className="h-7 w-7 shrink-0 rounded-lg" />
        <span className="truncate text-[16px] font-semibold text-[#111827]">Ripple</span>
      </div>

      <nav className="flex flex-1 justify-center" aria-label="Primary">
        <div className="inline-flex items-center gap-1 rounded-2xl border border-[#dfe6f4] bg-white/64 p-1 shadow-[0_6px_18px_rgba(44,63,123,0.05)] backdrop-blur-xl">
          {mainNavItems.map((item) => {
            const Icon = item.icon;
            const selected = item.id === activeView;
            return (
              <button
                key={item.id}
                type="button"
                data-ripple-top-tab={item.id}
                onClick={() => onSelectView(item.id)}
                className={`inline-flex h-8 items-center gap-1.5 rounded-xl px-3 text-[13px] font-semibold transition-all ${
                  selected
                    ? "bg-[#eef4ff] text-[#0b57d0] shadow-[0_10px_24px_rgba(47,107,255,0.18)] ring-1 ring-[#2f6bff]/35"
                    : "text-[#475467] hover:bg-white/78 hover:text-[#111827]"
                }`}
              >
                <Icon size={14} strokeWidth={LUCIDE_NAV_STROKE_WIDTH} />
                {item.label}
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
          aria-label={`Open personal settings for ${displayName}`}
          title="Personal settings"
          className="group inline-flex h-9 w-9 items-center justify-center rounded-2xl border border-[#dfe6f4] bg-white/80 text-[#384152] shadow-[0_8px_22px_rgba(44,63,123,0.07)] backdrop-blur-xl transition-all hover:bg-white hover:shadow-[0_10px_26px_rgba(44,63,123,0.10)] active:scale-[0.98]"
        >
          <IconTile tone="neutral" size="sm" className="relative border-transparent bg-transparent">
            {avatarImageUrl ? (
              <span className="absolute inset-0 overflow-hidden rounded-lg">
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
              className="absolute -right-0.5 -bottom-0.5 z-10 flex h-2 w-2"
              aria-hidden="true"
            >
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full border border-white bg-emerald-500" />
            </span>
          </IconTile>
        </button>
      </div>
    </header>
  );
}
