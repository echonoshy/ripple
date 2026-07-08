"use client";

import type { FormEvent, KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Globe2,
  Loader2,
  Paperclip,
  RefreshCw,
  Search,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { useI18n } from "@/i18n";
import type { ChatBrowserContext } from "@/lib/api";
import {
  buildBrowserContext,
  normalizeBrowserUrlInput,
  type BrowserCapturedPage,
} from "@/lib/browserContext";
import {
  createNativeBrowserSurface,
  isNativeBrowserAvailable,
  type BrowserCommandExecutor,
  type NativeBrowserStateEvent,
  type NativeBrowserSurface,
} from "@/lib/nativeBrowser";
import { openExternalUrl } from "@/lib/platform";
import { WORKBENCH_ICON_BUTTON_CLASS } from "./stylePrimitives";

interface BrowserPanelProps {
  initialAddress?: string;
  onBrowserContextChange: (context: ChatBrowserContext | null) => void;
  onBrowserCommandExecutorChange?: (executor: BrowserCommandExecutor | null) => void;
}

type BrowserStatus = "idle" | "loading" | "loaded" | "failed";
type DownloadStatus = "downloading" | "finished" | "failed";

interface BrowserDownloadState {
  status: DownloadStatus;
  url: string;
  path: string | null;
}

function isHttpBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function basename(value: string): string {
  const cleaned = value.split(/[?#]/, 1)[0] || value;
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || value;
}

export default function BrowserPanel({
  initialAddress = "",
  onBrowserContextChange,
  onBrowserCommandExecutorChange,
}: BrowserPanelProps) {
  const { t } = useI18n();
  const nativeBrowserViewportRef = useRef<HTMLDivElement | null>(null);
  const nativeBrowserRef = useRef<NativeBrowserSurface | null>(null);
  const nativeBrowserLabelRef = useRef("ripple-browser-main");
  const latestCaptureIdRef = useRef(0);
  const nativeLoadTimeoutRef = useRef<number | null>(null);
  const initialNavigationStartedRef = useRef(false);

  const initialUrl = normalizeBrowserUrlInput(initialAddress);
  const [address, setAddress] = useState(initialUrl);
  const [frameUrl, setFrameUrl] = useState(initialUrl);
  const [status, setStatus] = useState<BrowserStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [pendingNavigationUrl, setPendingNavigationUrl] = useState<string | null>(null);
  const [isAttachingPage, setIsAttachingPage] = useState(false);
  const [attachedPageUrl, setAttachedPageUrl] = useState<string | null>(null);
  const [attachedPageCapturedAt, setAttachedPageCapturedAt] = useState<string | null>(null);
  const [nativePageTitle, setNativePageTitle] = useState<string | null>(null);
  const [nativeCanGoBack, setNativeCanGoBack] = useState(false);
  const [nativeCanGoForward, setNativeCanGoForward] = useState(false);
  const [nativeSurfaceReady, setNativeSurfaceReady] = useState(false);
  const [nativeZoomLevel, setNativeZoomLevel] = useState(1);
  const [lastDownload, setLastDownload] = useState<BrowserDownloadState | null>(null);

  const nativeBrowserAvailable = isNativeBrowserAvailable();
  const activeUrl = pendingNavigationUrl || frameUrl;
  const canGoBack = nativeBrowserAvailable && nativeCanGoBack;
  const canGoForward = nativeBrowserAvailable && nativeCanGoForward;
  const attachedToActivePage = Boolean(
    attachedPageUrl && activeUrl && attachedPageUrl === activeUrl
  );

  const statusLabel = useMemo(() => {
    if (status === "loading") return t("browser.loading");
    if (status === "loaded") return t("browser.loaded");
    if (status === "failed") return t("browser.failed");
    return t("browser.ready");
  }, [status, t]);

  const downloadLabel = useMemo(() => {
    if (!lastDownload) return null;
    const name = basename(lastDownload.path || lastDownload.url);
    if (lastDownload.status === "downloading") return t("browser.downloadStarted", { name });
    if (lastDownload.status === "failed") return t("browser.downloadFailed", { name });
    return t("browser.downloadFinished", { name });
  }, [lastDownload, t]);

  const publishContext = useCallback(
    (nextAddress: string, nextPage: BrowserCapturedPage | null) => {
      const context = buildBrowserContext({ address: nextAddress, page: nextPage });
      onBrowserContextChange(context.active ? context : null);
    },
    [onBrowserContextChange]
  );

  const clearAttachedContext = useCallback(() => {
    setAttachedPageUrl(null);
    setAttachedPageCapturedAt(null);
    onBrowserContextChange(null);
  }, [onBrowserContextChange]);

  const clearNativeLoadFallback = useCallback(() => {
    if (nativeLoadTimeoutRef.current === null) return;
    window.clearTimeout(nativeLoadTimeoutRef.current);
    nativeLoadTimeoutRef.current = null;
  }, []);

  const scheduleNativeLoadFallback = useCallback(() => {
    clearNativeLoadFallback();
    nativeLoadTimeoutRef.current = window.setTimeout(() => {
      nativeLoadTimeoutRef.current = null;
      setPendingNavigationUrl(null);
      setStatus((current) => (current === "loading" ? "loaded" : current));
    }, 8000);
  }, [clearNativeLoadFallback]);

  const releaseNativeBrowser = useCallback(() => {
    const nativeBrowser = nativeBrowserRef.current;
    nativeBrowserRef.current = null;
    setNativeSurfaceReady(false);
    if (!nativeBrowser) return;
    void nativeBrowser.close().catch((closeError: unknown) => {
      console.warn("Failed to close native browser surface:", closeError);
    });
  }, []);

  const publishNativeBrowserState = useCallback(
    (event: NativeBrowserStateEvent) => {
      setNativeCanGoBack(event.canGoBack);
      setNativeCanGoForward(event.canGoForward);

      if (event.title !== null) {
        setNativePageTitle(event.title);
      }

      if (event.phase === "download-finished") {
        setLastDownload({
          status: event.downloadSuccess === false ? "failed" : "finished",
          url: event.url,
          path: event.downloadPath || null,
        });
        if (event.downloadSuccess === false) {
          setStatus("failed");
          setError(t("browser.failed"));
        }
        return;
      }

      if (event.phase === "download-requested") {
        setLastDownload({
          status: "downloading",
          url: event.url,
          path: event.downloadPath || null,
        });
        return;
      }

      if (event.phase === "new-window") {
        if (!isHttpBrowserUrl(event.url)) return;
        clearAttachedContext();
        setAddress(event.url);
        setFrameUrl(event.url);
        setPendingNavigationUrl(event.url);
        setStatus("loading");
        setError(null);
        scheduleNativeLoadFallback();
        void nativeBrowserRef.current?.navigate(event.url).catch((nativeError: unknown) => {
          console.warn("Failed to open native browser new-window target:", nativeError);
          clearNativeLoadFallback();
          setPendingNavigationUrl(null);
          setStatus("failed");
          setError(t("browser.failed"));
        });
        return;
      }

      if (!isHttpBrowserUrl(event.url)) return;

      if (event.phase === "started") {
        clearAttachedContext();
        setAddress(event.url);
        setFrameUrl(event.url);
        setPendingNavigationUrl(event.url);
        setStatus("loading");
        setError(null);
        scheduleNativeLoadFallback();
        return;
      }

      if (event.phase === "title-changed") {
        setAddress(event.url);
        setFrameUrl(event.url);
        return;
      }

      clearNativeLoadFallback();
      setAddress(event.url);
      setFrameUrl(event.url);
      setPendingNavigationUrl(null);
      setStatus("loaded");
    },
    [clearAttachedContext, clearNativeLoadFallback, scheduleNativeLoadFallback, t]
  );

  const capturePage = useCallback(
    async (value: string) => {
      latestCaptureIdRef.current += 1;
      const normalizedAddress = normalizeBrowserUrlInput(value);

      clearNativeLoadFallback();
      setAddress(normalizedAddress);
      setPendingNavigationUrl(normalizedAddress || null);
      setError(null);

      if (!normalizedAddress) {
        releaseNativeBrowser();
        setPendingNavigationUrl(null);
        setFrameUrl("");
        setNativePageTitle(null);
        setNativeCanGoBack(false);
        setNativeCanGoForward(false);
        setNativeZoomLevel(1);
        setLastDownload(null);
        setStatus("idle");
        clearAttachedContext();
        return;
      }

      if (!nativeBrowserAvailable) {
        releaseNativeBrowser();
        setFrameUrl(normalizedAddress);
        setPendingNavigationUrl(null);
        setStatus("idle");
        clearAttachedContext();
        return;
      }

      clearAttachedContext();
      setNativePageTitle(null);
      setNativeCanGoBack(false);
      setNativeCanGoForward(false);
      setNativeZoomLevel(1);
      setLastDownload(null);
      setFrameUrl(normalizedAddress);
      setStatus("loading");

      try {
        const viewport = nativeBrowserViewportRef.current;
        if (!viewport) {
          throw new Error("Native browser viewport is not mounted");
        }

        if (!nativeBrowserRef.current) {
          nativeBrowserRef.current = await createNativeBrowserSurface({
            label: nativeBrowserLabelRef.current,
            element: viewport,
            initialUrl: normalizedAddress,
            onStateChange: publishNativeBrowserState,
          });
        } else {
          await nativeBrowserRef.current.syncBounds();
          await nativeBrowserRef.current.navigate(normalizedAddress);
        }

        setNativeSurfaceReady(true);
        setPendingNavigationUrl(null);
        scheduleNativeLoadFallback();
      } catch (nativeError) {
        console.warn("Failed to open native browser surface:", nativeError);
        setNativeSurfaceReady(false);
        setPendingNavigationUrl(null);
        setStatus("failed");
        setError(t("browser.failed"));
        return;
      }
    },
    [
      clearAttachedContext,
      clearNativeLoadFallback,
      nativeBrowserAvailable,
      publishNativeBrowserState,
      releaseNativeBrowser,
      scheduleNativeLoadFallback,
      t,
    ]
  );

  const handleAttachCurrentPage = useCallback(() => {
    if (
      !activeUrl ||
      isAttachingPage ||
      status === "loading" ||
      !nativeBrowserAvailable ||
      !nativeBrowserRef.current
    ) {
      return;
    }

    setIsAttachingPage(true);
    setError(null);

    void (async () => {
      try {
        const nextPage = await nativeBrowserRef.current?.captureCurrentPage();
        if (!nextPage) {
          throw new Error("Native browser surface is not ready");
        }
        const capturedPage: BrowserCapturedPage = {
          url: nextPage.url || activeUrl,
          title: nextPage.title ?? null,
          text: nextPage.text || "",
          selected_text: nextPage.selected_text ?? null,
          headings: nextPage.headings || [],
          links: nextPage.links || [],
          images: nextPage.images || [],
          form_fields: nextPage.form_fields || [],
          truncated: Boolean(nextPage.truncated),
          captured_at: nextPage.captured_at || new Date().toISOString(),
        };

        const resolvedUrl = capturedPage.url || activeUrl;
        setAddress(resolvedUrl);
        setFrameUrl(resolvedUrl);
        setAttachedPageUrl(resolvedUrl);
        setAttachedPageCapturedAt(capturedPage.captured_at);
        setStatus("loaded");
        publishContext(resolvedUrl, capturedPage);
      } catch (attachError) {
        console.warn("Failed to attach browser page context:", attachError);
        setError(t("browser.attachFailed"));
      } finally {
        setIsAttachingPage(false);
      }
    })();
  }, [activeUrl, isAttachingPage, nativeBrowserAvailable, publishContext, status, t]);

  const handleGoBack = useCallback(() => {
    if (nativeBrowserAvailable && nativeBrowserRef.current) {
      setStatus("loading");
      setError(null);
      clearAttachedContext();
      scheduleNativeLoadFallback();
      void nativeBrowserRef.current.goBack().catch((nativeError: unknown) => {
        console.warn("Failed to go back in native browser surface:", nativeError);
        clearNativeLoadFallback();
        setPendingNavigationUrl(null);
        setStatus("failed");
        setError(t("browser.failed"));
      });
    }
  }, [
    clearAttachedContext,
    clearNativeLoadFallback,
    nativeBrowserAvailable,
    scheduleNativeLoadFallback,
    t,
  ]);

  const handleGoForward = useCallback(() => {
    if (nativeBrowserAvailable && nativeBrowserRef.current) {
      setStatus("loading");
      setError(null);
      clearAttachedContext();
      scheduleNativeLoadFallback();
      void nativeBrowserRef.current.goForward().catch((nativeError: unknown) => {
        console.warn("Failed to go forward in native browser surface:", nativeError);
        clearNativeLoadFallback();
        setPendingNavigationUrl(null);
        setStatus("failed");
        setError(t("browser.failed"));
      });
    }
  }, [
    clearAttachedContext,
    clearNativeLoadFallback,
    nativeBrowserAvailable,
    scheduleNativeLoadFallback,
    t,
  ]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void capturePage(address);
  };

  const handleAddressKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void capturePage(event.currentTarget.value);
  };

  const handleRefresh = () => {
    if (!nativeBrowserAvailable || !nativeBrowserRef.current) return;
    setStatus("loading");
    setError(null);
    clearAttachedContext();
    scheduleNativeLoadFallback();
    void nativeBrowserRef.current.reload().catch((refreshError: unknown) => {
      console.warn("Failed to refresh native browser surface:", refreshError);
      clearNativeLoadFallback();
      setPendingNavigationUrl(null);
      setStatus("failed");
      setError(t("browser.failed"));
    });
  };

  const handleZoomOut = () => {
    if (!nativeBrowserAvailable || !nativeBrowserRef.current) return;
    const nextZoom = Math.max(0.5, Math.round((nativeZoomLevel - 0.1) * 10) / 10);
    void nativeBrowserRef.current
      .setZoom(nextZoom)
      .then(() => setNativeZoomLevel(nextZoom))
      .catch((zoomError: unknown) => {
        console.warn("Failed to zoom out native browser surface:", zoomError);
        setError(t("browser.failed"));
      });
  };

  const handleZoomIn = () => {
    if (!nativeBrowserAvailable || !nativeBrowserRef.current) return;
    const nextZoom = Math.min(2, Math.round((nativeZoomLevel + 0.1) * 10) / 10);
    void nativeBrowserRef.current
      .setZoom(nextZoom)
      .then(() => setNativeZoomLevel(nextZoom))
      .catch((zoomError: unknown) => {
        console.warn("Failed to zoom in native browser surface:", zoomError);
        setError(t("browser.failed"));
      });
  };

  const handleClearBrowserData = () => {
    if (!nativeBrowserAvailable || !nativeBrowserRef.current) return;
    if (!window.confirm(t("browser.clearDataConfirm"))) return;
    void nativeBrowserRef.current
      .clearData()
      .then(() => {
        clearAttachedContext();
        setLastDownload(null);
        setNativeZoomLevel(1);
        return nativeBrowserRef.current?.reload();
      })
      .catch((clearError: unknown) => {
        console.warn("Failed to clear native browser data:", clearError);
        setError(t("browser.failed"));
      });
  };

  const handleOpenExternal = () => {
    if (!activeUrl) return;
    void openExternalUrl(activeUrl, "ripple-browser");
  };

  useEffect(() => {
    if (initialNavigationStartedRef.current || !initialUrl) return;
    initialNavigationStartedRef.current = true;
    void capturePage(initialUrl);
  }, [capturePage, initialUrl]);

  useEffect(() => {
    if (!onBrowserCommandExecutorChange) return;
    if (!nativeBrowserAvailable || !nativeSurfaceReady) {
      onBrowserCommandExecutorChange(null);
      return;
    }

    const executeBrowserCommand: BrowserCommandExecutor = async (request) => {
      const nativeBrowser = nativeBrowserRef.current;
      if (!nativeBrowser) {
        return { ok: false, error: "Ripple browser surface is not ready." };
      }
      return nativeBrowser.executeBrowserCommand(request);
    };
    onBrowserCommandExecutorChange(executeBrowserCommand);
    return () => onBrowserCommandExecutorChange(null);
  }, [nativeBrowserAvailable, nativeSurfaceReady, onBrowserCommandExecutorChange]);

  useEffect(() => {
    return () => {
      onBrowserCommandExecutorChange?.(null);
      if (nativeLoadTimeoutRef.current !== null) {
        window.clearTimeout(nativeLoadTimeoutRef.current);
        nativeLoadTimeoutRef.current = null;
      }
      releaseNativeBrowser();
    };
  }, [onBrowserCommandExecutorChange, releaseNativeBrowser]);

  return (
    <section
      data-ripple-browser-panel="true"
      className="flex h-full min-h-0 flex-col bg-white"
      aria-busy={status === "loading"}
    >
      <form className="shrink-0 p-3" onSubmit={handleSubmit}>
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            aria-label={t("browser.goBack")}
            title={t("browser.goBack")}
            disabled={!canGoBack}
            onClick={handleGoBack}
            className={WORKBENCH_ICON_BUTTON_CLASS}
          >
            <ArrowLeft aria-hidden="true" size={16} />
          </button>
          <button
            type="button"
            aria-label={t("browser.goForward")}
            title={t("browser.goForward")}
            disabled={!canGoForward}
            onClick={handleGoForward}
            className={WORKBENCH_ICON_BUTTON_CLASS}
          >
            <ArrowRight aria-hidden="true" size={16} />
          </button>

          <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-[#DEE0E3] bg-white px-3 text-[#646A73] transition-colors focus-within:border-[#1456F0]">
            <Search aria-hidden="true" size={16} className="shrink-0" />
            <input
              aria-label={t("browser.address")}
              className="min-w-0 flex-1 bg-transparent text-sm leading-5 text-[#1F2329] outline-none placeholder:text-[#8F959E]"
              inputMode="url"
              placeholder={t("browser.placeholder")}
              value={address}
              onChange={(event) => setAddress(event.currentTarget.value)}
              onKeyDown={handleAddressKeyDown}
            />
          </div>

          <button
            type="button"
            aria-label={t("browser.openPage")}
            title={t("browser.openPage")}
            disabled={status === "loading" || !address.trim()}
            onClick={() => void capturePage(address)}
            className={`${WORKBENCH_ICON_BUTTON_CLASS} text-[#1456F0]`}
          >
            {status === "loading" ? (
              <Loader2 aria-hidden="true" size={16} className="animate-spin" />
            ) : (
              <Search aria-hidden="true" size={16} />
            )}
          </button>
          <button
            type="button"
            aria-label={t("browser.refreshPage")}
            title={t("browser.refreshPage")}
            disabled={
              !nativeBrowserAvailable || !nativeSurfaceReady || status === "loading" || !activeUrl
            }
            onClick={handleRefresh}
            className={WORKBENCH_ICON_BUTTON_CLASS}
          >
            <RefreshCw aria-hidden="true" size={16} />
          </button>
          <button
            type="button"
            aria-label={t("browser.attachCurrentPage")}
            title={t("browser.attachCurrentPage")}
            disabled={
              !nativeBrowserAvailable ||
              !nativeSurfaceReady ||
              !activeUrl ||
              status === "loading" ||
              isAttachingPage
            }
            onClick={handleAttachCurrentPage}
            className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[#DEE0E3] bg-white px-2.5 text-sm font-medium text-[#2B2F36] transition-colors hover:bg-[#F8F9FA] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isAttachingPage ? (
              <Loader2 aria-hidden="true" size={16} className="animate-spin" />
            ) : attachedToActivePage ? (
              <CheckCircle2 aria-hidden="true" size={16} className="text-[#16845B]" />
            ) : (
              <Paperclip aria-hidden="true" size={16} />
            )}
            <span className="whitespace-nowrap">
              {attachedToActivePage
                ? t("browser.attachedCurrentPage")
                : t("browser.attachCurrentPage")}
            </span>
          </button>
          <button
            type="button"
            aria-label={t("browser.zoomOut")}
            title={t("browser.zoomOut")}
            disabled={!nativeBrowserAvailable || !nativeSurfaceReady || nativeZoomLevel <= 0.5}
            onClick={handleZoomOut}
            className={WORKBENCH_ICON_BUTTON_CLASS}
          >
            <ZoomOut aria-hidden="true" size={16} />
          </button>
          <button
            type="button"
            aria-label={t("browser.zoomIn")}
            title={t("browser.zoomIn")}
            disabled={!nativeBrowserAvailable || !nativeSurfaceReady || nativeZoomLevel >= 2}
            onClick={handleZoomIn}
            className={WORKBENCH_ICON_BUTTON_CLASS}
          >
            <ZoomIn aria-hidden="true" size={16} />
          </button>
          <button
            type="button"
            aria-label={t("browser.clearData")}
            title={t("browser.clearData")}
            disabled={!nativeBrowserAvailable || !nativeSurfaceReady}
            onClick={handleClearBrowserData}
            className={WORKBENCH_ICON_BUTTON_CLASS}
          >
            <Trash2 aria-hidden="true" size={16} />
          </button>
          <button
            type="button"
            aria-label={t("browser.openExternally")}
            title={t("browser.openExternally")}
            disabled={!activeUrl}
            onClick={handleOpenExternal}
            className={WORKBENCH_ICON_BUTTON_CLASS}
          >
            <ExternalLink aria-hidden="true" size={16} />
          </button>
        </div>
      </form>

      <div
        data-ripple-browser-loading-bar="true"
        className="h-0.5 shrink-0 overflow-hidden border-b border-[#EFF0F1] bg-transparent"
        aria-hidden="true"
      >
        <div
          className={`h-full rounded-r-full bg-[#1456F0] transition-all duration-500 ${
            status === "loading" ? "w-2/3 animate-pulse opacity-100" : "w-0 opacity-0"
          }`}
        />
      </div>

      <div className="flex min-h-8 shrink-0 items-center justify-between gap-3 border-b border-[#EFF0F1] px-3 py-1.5 text-xs leading-5 text-[#646A73]">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate">
            {nativeBrowserAvailable && frameUrl
              ? `${t("browser.nativeMode")} · ${nativePageTitle || activeUrl}`
              : activeUrl || t("browser.empty")}
          </span>
          {downloadLabel ? (
            <span
              className={`hidden max-w-56 shrink-0 truncate md:inline ${
                lastDownload?.status === "failed"
                  ? "text-[#B42318]"
                  : lastDownload?.status === "finished"
                    ? "text-[#16845B]"
                    : "text-[#646A73]"
              }`}
            >
              {downloadLabel}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {attachedPageCapturedAt && attachedToActivePage ? (
            <span className="hidden max-w-40 truncate text-[#16845B] md:inline">
              {t("browser.attachedCurrentPage")}
            </span>
          ) : null}
          <span
            className={`shrink-0 ${
              status === "failed"
                ? "text-[#B42318]"
                : status === "loaded"
                  ? "text-[#16845B]"
                  : "text-[#646A73]"
            }`}
            role="status"
          >
            {statusLabel}
          </span>
        </div>
      </div>

      {error ? (
        <div
          className="shrink-0 border-b border-[#FAD4D4] bg-[#FFF1F0] px-3 py-2 text-sm leading-5 text-[#B42318]"
          role="status"
        >
          {error}
        </div>
      ) : null}

      <div
        data-ripple-browser-frame="true"
        className="relative min-h-0 flex-1 overflow-hidden bg-[#F8F9FA]"
      >
        {nativeBrowserAvailable ? (
          <div
            ref={nativeBrowserViewportRef}
            data-ripple-native-browser-viewport="true"
            className="h-full w-full bg-white"
          >
            {!frameUrl ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm leading-6 text-[#8F959E]">
                <div>
                  <Globe2
                    aria-hidden="true"
                    className="mx-auto mb-5 text-[#8F959E]"
                    size={56}
                    strokeWidth={1.8}
                  />
                  <p className="text-base leading-6 font-semibold text-[#1F2329]">
                    {t("browser.emptyTitle")}
                  </p>
                  <p className="mt-2 text-sm leading-5 text-[#8F959E]">
                    {t("browser.emptySubtitle")}
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm leading-6 text-[#646A73]">
            <div className="max-w-sm">
              <ExternalLink aria-hidden="true" className="mx-auto mb-4 text-[#8F959E]" size={40} />
              <p className="font-medium text-[#1F2329]">{t("browser.desktopOnlyTitle")}</p>
              <p className="mt-2">{t("browser.desktopOnlySubtitle")}</p>
              {activeUrl ? (
                <button
                  type="button"
                  className="mt-4 inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-[#DEE0E3] bg-white px-3 text-sm font-medium text-[#2B2F36] transition-colors hover:bg-[#F8F9FA]"
                  onClick={handleOpenExternal}
                >
                  <ExternalLink aria-hidden="true" size={16} />
                  {t("browser.openExternally")}
                </button>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
