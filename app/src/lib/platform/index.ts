type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

interface TauriWindow extends Window {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
}

interface AndroidGestureWindow extends Window {
  RippleAndroidGesture?: {
    setChatBackGestureEnabled?: (enabled: boolean) => void;
  };
}

export interface OpenExternalResult {
  opened: boolean;
  popup: Window | null;
  error?: unknown;
}

export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const currentWindow = window as TauriWindow;
  return Boolean(currentWindow.__TAURI__ || currentWindow.__TAURI_INTERNALS__);
}

export function getClientStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getClientStorageItem(key: string): string | null {
  try {
    return getClientStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function setClientStorageItem(key: string, value: string): void {
  try {
    getClientStorage()?.setItem(key, value);
  } catch {
    /* Storage can be disabled or quota-limited in restricted browser contexts. */
  }
}

export function removeClientStorageItem(key: string): void {
  try {
    getClientStorage()?.removeItem(key);
  } catch {
    /* Storage can be disabled in restricted browser contexts. */
  }
}

export async function openExternalUrl(
  href: string,
  target: string = "_blank"
): Promise<OpenExternalResult> {
  const nextHref = href.trim();
  if (!nextHref || typeof window === "undefined") {
    return { opened: false, popup: null };
  }

  if (isTauriRuntime()) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(nextHref);
      return { opened: true, popup: null };
    } catch (error) {
      console.warn("Failed to open external URL with Tauri opener:", error);
      return { opened: false, popup: null, error };
    }
  }

  const popup = window.open(nextHref, target, "noopener,noreferrer");
  return { opened: Boolean(popup), popup };
}

export function setAndroidChatBackGestureEnabled(enabled: boolean): void {
  if (!isTauriRuntime() || typeof window === "undefined") return;

  const bridge = (window as AndroidGestureWindow).RippleAndroidGesture;
  if (typeof bridge?.setChatBackGestureEnabled !== "function") return;

  try {
    bridge.setChatBackGestureEnabled(enabled);
  } catch (error) {
    console.warn("Failed to update Android chat back gesture exclusion:", error);
  }
}

export function saveBlobAsDownload(blob: Blob, filename: string): void {
  if (typeof window === "undefined") return;

  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}
