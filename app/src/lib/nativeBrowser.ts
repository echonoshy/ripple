import { isTauriRuntime } from "./platform";

export interface NativeBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeBrowserPageLoadEvent {
  label: string;
  url: string;
  phase: "started" | "finished";
}

export interface NativeBrowserCapturedPage {
  url: string;
  title?: string | null;
  text: string;
  selected_text?: string | null;
  truncated: boolean;
  captured_at: string;
}

export interface NativeBrowserSurface {
  navigate: (url: string) => Promise<void>;
  reload: () => Promise<void>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  captureCurrentPage: () => Promise<NativeBrowserCapturedPage>;
  syncBounds: () => Promise<void>;
  close: () => Promise<void>;
}

interface NativeBrowserSurfaceOptions {
  label: string;
  element: HTMLElement;
  initialUrl: string;
  onPageLoad?: (event: NativeBrowserPageLoadEvent) => void;
}

interface NativeBrowserOpenUrlEvent {
  label: string;
  url: string;
}

type UnlistenFn = () => void;

export function isNativeBrowserAvailable(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  return isTauriRuntime();
}

export async function createNativeBrowserSurface(
  options: NativeBrowserSurfaceOptions
): Promise<NativeBrowserSurface> {
  if (!isNativeBrowserAvailable()) {
    throw new Error("Native browser is only available in the Tauri client");
  }

  const { label, element, initialUrl, onPageLoad } = options;
  let currentUrl = initialUrl;
  let closed = false;
  let lastVisible = false;
  let latestIntersectionRatio = 1;
  let syncScheduled = false;
  let unlistenPageLoad: UnlistenFn | null = null;
  let unlistenOpenUrl: UnlistenFn | null = null;

  const syncBounds = async () => {
    if (closed) return;
    const viewport = measureViewport(element, latestIntersectionRatio);
    if (!viewport.visible) {
      if (lastVisible) {
        lastVisible = false;
        await hideNativeBrowser({ label });
      }
      return;
    }

    await resizeNativeBrowser({ label, bounds: viewport.bounds });
    if (!lastVisible) {
      lastVisible = true;
      await showNativeBrowser({ label });
    }
  };

  const scheduleSyncBounds = () => {
    if (syncScheduled || closed) return;
    syncScheduled = true;
    window.requestAnimationFrame(() => {
      syncScheduled = false;
      void syncBounds();
    });
  };

  const resizeObserver = new ResizeObserver(scheduleSyncBounds);
  resizeObserver.observe(element);

  const intersectionObserver = new IntersectionObserver((entries) => {
    latestIntersectionRatio = entries[0]?.intersectionRatio ?? 0;
    scheduleSyncBounds();
  });
  intersectionObserver.observe(element);

  const handleWindowChange = () => scheduleSyncBounds();
  window.addEventListener("resize", handleWindowChange);
  window.addEventListener("scroll", handleWindowChange, true);
  document.addEventListener("visibilitychange", handleWindowChange);

  const { listen } = await import("@tauri-apps/api/event");
  unlistenPageLoad = await listen<NativeBrowserPageLoadEvent>(
    "ripple-browser-page-load",
    (event) => {
      if (event.payload.label !== label) return;
      currentUrl = event.payload.url;
      onPageLoad?.(event.payload);
    }
  );
  unlistenOpenUrl = await listen<NativeBrowserOpenUrlEvent>(
    "ripple-browser-open-url",
    (event) => {
      if (event.payload.label !== label || !isHttpUrl(event.payload.url)) return;
      currentUrl = event.payload.url;
      void navigateNativeBrowser({ label, url: currentUrl }).then(syncBounds);
    }
  );

  await openNativeBrowser({
    label,
    url: currentUrl,
    bounds: measureViewport(element, latestIntersectionRatio).bounds,
  });
  await syncBounds();

  return {
    async navigate(url: string) {
      currentUrl = url;
      await navigateNativeBrowser({ label, url });
      await syncBounds();
    },
    async reload() {
      await reloadNativeBrowser({ label });
      await syncBounds();
    },
    async goBack() {
      await backNativeBrowser({ label });
      await syncBounds();
    },
    async goForward() {
      await forwardNativeBrowser({ label });
      await syncBounds();
    },
    async captureCurrentPage() {
      return captureNativeBrowser({ label });
    },
    syncBounds,
    async close() {
      if (closed) return;
      closed = true;
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      window.removeEventListener("resize", handleWindowChange);
      window.removeEventListener("scroll", handleWindowChange, true);
      document.removeEventListener("visibilitychange", handleWindowChange);
      unlistenPageLoad?.();
      unlistenPageLoad = null;
      unlistenOpenUrl?.();
      unlistenOpenUrl = null;
      await closeNativeBrowser({ label });
    },
  };
}

interface NativeBrowserOpenRequest {
  label: string;
  url: string;
  bounds: NativeBrowserBounds;
}

interface NativeBrowserLabelRequest {
  label: string;
}

interface NativeBrowserNavigateRequest extends NativeBrowserLabelRequest {
  url: string;
}

interface NativeBrowserResizeRequest extends NativeBrowserLabelRequest {
  bounds: NativeBrowserBounds;
}

async function openNativeBrowser(request: NativeBrowserOpenRequest): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("plugin:ripple-browser|open", { request });
}

async function resizeNativeBrowser(request: NativeBrowserResizeRequest): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("plugin:ripple-browser|resize", { request });
}

async function navigateNativeBrowser(request: NativeBrowserNavigateRequest): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("plugin:ripple-browser|navigate", { request });
}

async function reloadNativeBrowser(request: NativeBrowserLabelRequest): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("plugin:ripple-browser|reload", { request });
}

async function backNativeBrowser(request: NativeBrowserLabelRequest): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("plugin:ripple-browser|back", { request });
}

async function forwardNativeBrowser(request: NativeBrowserLabelRequest): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("plugin:ripple-browser|forward", { request });
}

async function captureNativeBrowser(
  request: NativeBrowserLabelRequest
): Promise<NativeBrowserCapturedPage> {
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke("plugin:ripple-browser|capture", { request })) as NativeBrowserCapturedPage;
}

async function closeNativeBrowser(request: NativeBrowserLabelRequest): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("plugin:ripple-browser|close", { request });
}

async function showNativeBrowser(request: NativeBrowserLabelRequest): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("plugin:ripple-browser|show", { request });
}

async function hideNativeBrowser(request: NativeBrowserLabelRequest): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("plugin:ripple-browser|hide", { request });
}

function measureViewport(
  element: HTMLElement,
  intersectionRatio: number
): { bounds: NativeBrowserBounds; visible: boolean } {
  const rect = element.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 1;
  const left = clamp(rect.left, 0, viewportWidth);
  const top = clamp(rect.top, 0, viewportHeight);
  const right = clamp(rect.right, 0, viewportWidth);
  const bottom = clamp(rect.bottom, 0, viewportHeight);
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const visible =
    document.visibilityState !== "hidden" &&
    intersectionRatio > 0 &&
    rect.width > 0 &&
    rect.height > 0 &&
    right > left &&
    bottom > top;

  return {
    bounds: {
      x: left,
      y: top,
      width,
      height,
    },
    visible,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
