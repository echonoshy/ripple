import type { UserProfile } from "@/types";

export const USER_AVATAR_CHANGED_EVENT = "ripple:user-avatar-changed";

export function getUserProfileAvatarUri(profile: UserProfile | null | undefined): string | null {
  return profile?.profile?.avatar_uri ?? profile?.avatar_uri ?? null;
}

export function dispatchUserAvatarChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(USER_AVATAR_CHANGED_EVENT));
}
