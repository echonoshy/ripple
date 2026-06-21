import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { WorkspaceView } from "@/lib/workspaceViews";
import {
  getClientStorageItem,
  setAndroidChatBackGestureEnabled,
  setClientStorageItem,
} from "@/lib/platform";

export const WORKSPACE_ROOT_PATH = "/workspace";

export const ANDROID_CHAT_BACK_GESTURE_DESKTOP_MIN_WIDTH_PX = 1024;
export const SESSION_RAIL_WIDTH_STORAGE_KEY = "ripple.workbench.sessionRailWidth";
export const SESSION_RAIL_COLLAPSED_STORAGE_KEY = "ripple.workbench.sessionRailCollapsed";
export const SESSION_RAIL_DEFAULT_WIDTH = 300;
export const SESSION_RAIL_MIN_WIDTH = 220;
export const SESSION_RAIL_MAX_WIDTH = 420;

type AuthState = "checking" | "needs_auth" | "authenticated";
type MobileSessionMode = "list" | "chat";
type StorageReader = (key: string) => string | null;

export function normalizeWorkspaceFolderPath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === WORKSPACE_ROOT_PATH) return WORKSPACE_ROOT_PATH;
  if (trimmed.startsWith(`${WORKSPACE_ROOT_PATH}/`)) return trimmed;
  return WORKSPACE_ROOT_PATH;
}

export function clampSessionRailWidth(value: number): number {
  return Math.min(SESSION_RAIL_MAX_WIDTH, Math.max(SESSION_RAIL_MIN_WIDTH, Math.round(value)));
}

export function readInitialSessionRailWidth(
  readStorage: StorageReader = getClientStorageItem
): number {
  const rawValue = readStorage(SESSION_RAIL_WIDTH_STORAGE_KEY);
  if (rawValue === null) return SESSION_RAIL_DEFAULT_WIDTH;
  const stored = Number(rawValue);
  return Number.isFinite(stored) ? clampSessionRailWidth(stored) : SESSION_RAIL_DEFAULT_WIDTH;
}

export function readInitialSessionRailCollapsed(
  readStorage: StorageReader = getClientStorageItem
): boolean {
  return readStorage(SESSION_RAIL_COLLAPSED_STORAGE_KEY) === "true";
}

export function isMobileLayoutWidth(width: number): boolean {
  return width < ANDROID_CHAT_BACK_GESTURE_DESKTOP_MIN_WIDTH_PX;
}

function isMobileLayoutViewport(): boolean {
  return typeof window !== "undefined" && isMobileLayoutWidth(window.innerWidth);
}

export function shouldEnableAndroidChatBackGesture({
  authState,
  activeView,
  mobileSessionMode,
  isSkillsMobileBackGestureActive,
  viewportWidth,
}: {
  authState: AuthState;
  activeView: WorkspaceView;
  mobileSessionMode: MobileSessionMode;
  isSkillsMobileBackGestureActive: boolean;
  viewportWidth: number;
}): boolean {
  const isMobileChatBackGestureActive = activeView === "sessions" && mobileSessionMode === "chat";
  const isMobileSkillsBackGestureActive =
    activeView === "skills" && isSkillsMobileBackGestureActive;
  return (
    authState === "authenticated" &&
    (isMobileChatBackGestureActive || isMobileSkillsBackGestureActive) &&
    isMobileLayoutWidth(viewportWidth)
  );
}

export function useMobileLayout(): boolean {
  const [isMobileLayout, setIsMobileLayout] = useState(isMobileLayoutViewport);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const updateMobileLayout = () => {
      setIsMobileLayout(isMobileLayoutViewport());
    };

    updateMobileLayout();
    window.addEventListener("resize", updateMobileLayout);

    return () => {
      window.removeEventListener("resize", updateMobileLayout);
    };
  }, []);

  return isMobileLayout;
}

export function useAndroidChatBackGesture({
  authState,
  activeView,
  mobileSessionMode,
  isSkillsMobileBackGestureActive,
}: {
  authState: AuthState;
  activeView: WorkspaceView;
  mobileSessionMode: MobileSessionMode;
  isSkillsMobileBackGestureActive: boolean;
}) {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const updateAndroidChatBackGesture = () => {
      setAndroidChatBackGestureEnabled(
        shouldEnableAndroidChatBackGesture({
          authState,
          activeView,
          mobileSessionMode,
          isSkillsMobileBackGestureActive,
          viewportWidth: window.innerWidth,
        })
      );
    };

    updateAndroidChatBackGesture();
    window.addEventListener("resize", updateAndroidChatBackGesture);

    return () => {
      window.removeEventListener("resize", updateAndroidChatBackGesture);
      setAndroidChatBackGestureEnabled(false);
    };
  }, [activeView, authState, isSkillsMobileBackGestureActive, mobileSessionMode]);
}

export function useSessionRail() {
  const [sessionRailWidth, setSessionRailWidth] = useState(readInitialSessionRailWidth);
  const sessionRailWidthRef = useRef(sessionRailWidth);
  const [isSessionRailCollapsed, setIsSessionRailCollapsed] = useState(
    readInitialSessionRailCollapsed
  );

  useEffect(() => {
    sessionRailWidthRef.current = sessionRailWidth;
    setClientStorageItem(SESSION_RAIL_WIDTH_STORAGE_KEY, String(sessionRailWidth));
  }, [sessionRailWidth]);

  useEffect(() => {
    setClientStorageItem(SESSION_RAIL_COLLAPSED_STORAGE_KEY, String(isSessionRailCollapsed));
  }, [isSessionRailCollapsed]);

  const updateSessionRailWidth = useCallback((value: number) => {
    setSessionRailWidth(clampSessionRailWidth(value));
  }, []);

  const handleSessionRailResizeStart = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = sessionRailWidthRef.current;

      const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
        updateSessionRailWidth(startWidth + moveEvent.clientX - startX);
      };
      const handlePointerUp = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
    },
    [updateSessionRailWidth]
  );

  const handleSessionRailResizeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        updateSessionRailWidth(sessionRailWidthRef.current - (event.shiftKey ? 40 : 16));
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        updateSessionRailWidth(sessionRailWidthRef.current + (event.shiftKey ? 40 : 16));
      }
    },
    [updateSessionRailWidth]
  );

  return {
    sessionRailWidth,
    isSessionRailCollapsed,
    setIsSessionRailCollapsed,
    handleSessionRailResizeStart,
    handleSessionRailResizeKeyDown,
  };
}
