import type { UserProfile } from "@/types";

export const USER_AVATAR_CHANGED_EVENT = "ripple:user-avatar-changed";
export const USER_PROFILE_CHANGED_EVENT = "ripple:user-profile-changed";

export function getUserProfileAvatarUri(profile: UserProfile | null | undefined): string | null {
  return profile?.profile?.avatar_uri ?? profile?.avatar_uri ?? null;
}

export function getUserProfileDisplayName(
  profile: UserProfile | null | undefined,
  fallback: string
): string {
  return (
    profile?.profile?.display_name?.trim() ||
    profile?.profile?.user_name?.trim() ||
    profile?.profile?.login?.trim() ||
    fallback
  );
}

export function dispatchUserAvatarChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(USER_AVATAR_CHANGED_EVENT));
}

export function dispatchUserProfileChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(USER_PROFILE_CHANGED_EVENT));
}
