"use client";

import type { FormEvent } from "react";
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
} from "lucide-react";

import { useI18n } from "@/i18n";
import { fetchBrowserPage, type BrowserPageResponse, type ChatBrowserContext } from "@/lib/api";
import { buildBrowserContext, normalizeBrowserUrlInput } from "@/lib/browserContext";
import { isDirectBrowserIframeUrl } from "@/lib/browserDirectIframe";
import {
  createNativeBrowserSurface,
  isNativeBrowserAvailable,
  type NativeBrowserPageLoadEvent,
  type NativeBrowserSurface,
} from "@/lib/nativeBrowser";
import { openExternalUrl } from "@/lib/platform";
import { WORKBENCH_ICON_BUTTON_CLASS } from "./stylePrimitives";

interface BrowserPanelProps {
  initialAddress?: string;
  onBrowserContextChange: (context: ChatBrowserContext | null) => void;
}

type BrowserStatus = "idle" | "loading" | "loaded" | "failed";

interface BrowserHistoryState {
  entries: string[];
  index: number;
}

function isHttpBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isBrowserNavigateMessage(data: unknown): data is { type: string; url: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    "url" in data &&
    (data as { type?: unknown }).type === "ripple-browser-navigate" &&
    typeof (data as { url?: unknown }).url === "string"
  );
}

export default function BrowserPanel({
  initialAddress = "",
  onBrowserContextChange,
}: BrowserPanelProps) {
  const { t } = useI18n();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const nativeBrowserViewportRef = useRef<HTMLDivElement | null>(null);
  const nativeBrowserRef = useRef<NativeBrowserSurface | null>(null);
  const nativeBrowserLabelRef = useRef("ripple-browser-main");
  const latestCaptureIdRef = useRef(0);
  const frameLoadedRef = useRef(false);
  const initialUrl = normalizeBrowserUrlInput(initialAddress);
  const [address, setAddress] = useState(initialUrl);
  const [frameUrl, setFrameUrl] = useState(initialUrl);
  const [page, setPage] = useState<BrowserPageResponse | null>(null);
  const [status, setStatus] = useState<BrowserStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [frameVersion, setFrameVersion] = useState(0);
  const [pendingNavigationUrl, setPendingNavigationUrl] = useState<string | null>(null);
  const [isAttachingPage, setIsAttachingPage] = useState(false);
  const [attachedPageUrl, setAttachedPageUrl] = useState<string | null>(null);
  const [attachedPageCapturedAt, setAttachedPageCapturedAt] = useState<string | null>(null);
  const [history, setHistory] = useState<BrowserHistoryState>(() => ({
    entries: initialUrl ? [initialUrl] : [],
    index: initialUrl ? 0 : -1,
  }));

  const canGoBack = history.index > 0;
  const canGoForward = history.index >= 0 && history.index < history.entries.length - 1;
  const nativeBrowserAvailable = isNativeBrowserAvailable();
  const activeUrl = pendingNavigationUrl || frameUrl || address;
  const isPreviewBlocked = page?.embeddable === false;
  const shouldUsePreviewHtml = Boolean(page?.preview_html);
  const shouldUseDirectIframe = !shouldUsePreviewHtml && isDirectBrowserIframeUrl(frameUrl);
  const showPreviewBlocked = isPreviewBlocked && !shouldUsePreviewHtml;
  const previewBlockedReason = page?.preview_blocked_reason?.trim();
  const attachedToActivePage = Boolean(attachedPageUrl && activeUrl && attachedPageUrl === activeUrl);

  const statusLabel = useMemo(() => {
    if (status === "loading") return t("browser.loading");
    if (status === "loaded") return t("browser.loaded");
    if (status === "failed") return t("browser.failed");
    return t("browser.ready");
  }, [status, t]);

  const publishContext = useCallback(
    (nextAddress: string, nextPage: BrowserPageResponse | null) => {
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

  const pushHistory = useCallback((nextUrl: string) => {
    setHistory((current) => {
      if (!nextUrl) return { entries: [], index: -1 };

      const currentUrl = current.index >= 0 ? current.entries[current.index] : "";
      if (currentUrl === nextUrl) return current;

      const entries = current.entries.slice(0, current.index + 1);
      entries.push(nextUrl);
      return { entries, index: entries.length - 1 };
    });
  }, []);

  const handleNativePageLoad = useCallback(
    (event: NativeBrowserPageLoadEvent) => {
      if (!isHttpBrowserUrl(event.url)) return;
      setAddress(event.url);
      setFrameUrl(event.url);
      setPendingNavigationUrl(null);
      if (event.phase === "started") {
        setStatus("loading");
        clearAttachedContext();
        return;
      }
      setStatus("loaded");
      pushHistory(event.url);
    },
    [clearAttachedContext, pushHistory]
  );

  const capturePage = useCallback(
    async (value: string, options: { recordHistory?: boolean } = {}) => {
      const captureId = latestCaptureIdRef.current + 1;
      latestCaptureIdRef.current = captureId;
      const shouldRecordHistory = options.recordHistory ?? true;
      const normalizedAddress = normalizeBrowserUrlInput(value);

      setAddress(normalizedAddress);
      setPendingNavigationUrl(normalizedAddress || null);
      setError(null);

      if (!normalizedAddress) {
        frameLoadedRef.current = false;
        setPendingNavigationUrl(null);
        setFrameUrl("");
        setPage(null);
        setStatus("idle");
        clearAttachedContext();
        return;
      }

      setStatus("loading");
      if (nativeBrowserAvailable) {
        clearAttachedContext();
      } else {
        publishContext(normalizedAddress, null);
      }

      let nativePreviewActive = false;

      if (nativeBrowserAvailable) {
        const nativeUrl = normalizedAddress;
        setPage(null);
        setFrameUrl(nativeUrl);
        if (shouldRecordHistory) {
          pushHistory(nativeUrl);
        }
        try {
          const viewport = nativeBrowserViewportRef.current;
          if (!viewport) {
            throw new Error("Native browser viewport is not mounted");
          }
          if (!nativeBrowserRef.current) {
            nativeBrowserRef.current = await createNativeBrowserSurface({
              label: nativeBrowserLabelRef.current,
              element: viewport,
              initialUrl: nativeUrl,
              onPageLoad: handleNativePageLoad,
            });
          } else {
            await nativeBrowserRef.current.syncBounds();
            await nativeBrowserRef.current.navigate(nativeUrl);
          }
          setPendingNavigationUrl(null);
          nativePreviewActive = true;
        } catch (nativeError) {
          console.warn("Failed to open native browser surface:", nativeError);
        }
      }

      if (nativePreviewActive) return;

      if (!nativePreviewActive && isDirectBrowserIframeUrl(normalizedAddress)) {
        const directUrl = normalizedAddress;
        setPage(null);
        setFrameUrl(directUrl);
        setPendingNavigationUrl(null);
        setFrameVersion((current) => current + 1);
        frameLoadedRef.current = false;
        if (shouldRecordHistory) {
          pushHistory(directUrl);
        }
        publishContext(directUrl, null);
        return;
      }

      try {
        const nextPage = await fetchBrowserPage(normalizedAddress);
        if (captureId !== latestCaptureIdRef.current) return;
        const resolvedUrl = nextPage.url || normalizedAddress;

        setPage(nextPage);
        setAddress(resolvedUrl);
        setFrameUrl(resolvedUrl);
        setPendingNavigationUrl(null);
        if (!nativePreviewActive) {
          setFrameVersion((current) => current + 1);
          frameLoadedRef.current = false;
          setStatus("loading");
        }
        if (shouldRecordHistory && !nativePreviewActive) {
          pushHistory(resolvedUrl);
        }
        publishContext(resolvedUrl, nextPage);
      } catch {
        if (captureId !== latestCaptureIdRef.current) return;
        setPendingNavigationUrl(null);
        publishContext(normalizedAddress, null);
        if (!nativePreviewActive) {
          setStatus("failed");
          setError(t("browser.failed"));
        }
      }
    },
    [clearAttachedContext, handleNativePageLoad, nativeBrowserAvailable, publishContext, pushHistory, t]
  );

  const handleAttachCurrentPage = useCallback(() => {
    if (!activeUrl || isAttachingPage) return;

    setIsAttachingPage(true);
    setError(null);

    void (async () => {
      try {
        let capturedPage: BrowserPageResponse;

        if (nativeBrowserAvailable && nativeBrowserRef.current) {
          const nextPage = await nativeBrowserRef.current.captureCurrentPage();
          capturedPage = {
            url: nextPage.url || activeUrl,
            title: nextPage.title ?? null,
            text: nextPage.text || "",
            selected_text: nextPage.selected_text ?? null,
            truncated: Boolean(nextPage.truncated),
            captured_at: nextPage.captured_at || new Date().toISOString(),
          };
        } else {
          const nextPage = page?.url === activeUrl ? page : await fetchBrowserPage(activeUrl);
          capturedPage = {
            url: nextPage.url || activeUrl,
            title: nextPage.title ?? null,
            text: nextPage.text || "",
            selected_text: nextPage.selected_text ?? null,
            truncated: Boolean(nextPage.truncated),
            embeddable: nextPage.embeddable,
            preview_blocked_reason: nextPage.preview_blocked_reason,
            preview_html: nextPage.preview_html,
            captured_at: nextPage.captured_at || new Date().toISOString(),
          };
        }

        const resolvedUrl = capturedPage.url || activeUrl;
        setPage(capturedPage);
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
  }, [activeUrl, isAttachingPage, nativeBrowserAvailable, page, publishContext, t]);

  const handleFrameLoad = useCallback(() => {
    frameLoadedRef.current = true;
    setStatus((current) => (current === "loading" ? "loaded" : current));
  }, []);

  const navigateHistory = useCallback(
    (nextIndex: number) => {
      const nextUrl = history.entries[nextIndex];
      if (!nextUrl) return;

      setHistory((current) => ({ ...current, index: nextIndex }));
      void capturePage(nextUrl, { recordHistory: false });
    },
    [capturePage, history.entries]
  );

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (!isBrowserNavigateMessage(event.data)) return;
      if (!isHttpBrowserUrl(event.data.url)) return;
      void capturePage(event.data.url);
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [capturePage]);

  useEffect(() => {
    return () => {
      const nativeBrowser = nativeBrowserRef.current;
      nativeBrowserRef.current = null;
      void nativeBrowser?.close();
    };
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void capturePage(address);
  };

  const handleRefresh = () => {
    if (nativeBrowserAvailable && nativeBrowserRef.current) {
      setStatus("loading");
      void nativeBrowserRef.current.reload().catch((refreshError: unknown) => {
        console.warn("Failed to refresh native browser surface:", refreshError);
        setStatus("failed");
        setError(t("browser.failed"));
      });
      return;
    }
    void capturePage(activeUrl, { recordHistory: false });
  };

  const handleOpenExternal = () => {
    if (!activeUrl) return;
    void openExternalUrl(activeUrl, "ripple-browser");
  };

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
            onClick={() => navigateHistory(history.index - 1)}
            className={WORKBENCH_ICON_BUTTON_CLASS}
          >
            <ArrowLeft aria-hidden="true" size={16} />
          </button>
          <button
            type="button"
            aria-label={t("browser.goForward")}
            title={t("browser.goForward")}
            disabled={!canGoForward}
            onClick={() => navigateHistory(history.index + 1)}
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
            />
          </div>

          <button
            type="submit"
            aria-label={t("browser.openPage")}
            title={t("browser.openPage")}
            disabled={status === "loading" || !address.trim()}
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
            disabled={status === "loading" || !activeUrl}
            onClick={handleRefresh}
            className={WORKBENCH_ICON_BUTTON_CLASS}
          >
            <RefreshCw aria-hidden="true" size={16} />
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
            status === "loading" ? "w-2/3 opacity-100 animate-pulse" : "w-0 opacity-0"
          }`}
        />
      </div>

      <div className="flex min-h-8 shrink-0 items-center justify-between gap-3 border-b border-[#EFF0F1] px-3 py-1.5 text-xs leading-5 text-[#646A73]">
        <span className="min-w-0 truncate">
          {nativeBrowserAvailable && frameUrl
            ? `${t("browser.nativeMode")} · ${activeUrl}`
            : page?.title || activeUrl || t("browser.empty")}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {attachedPageCapturedAt && attachedToActivePage ? (
            <span className="hidden max-w-40 truncate text-[#16845B] md:inline">
              {t("browser.attachedCurrentPage")}
            </span>
          ) : null}
          <button
            type="button"
            aria-label={t("browser.attachCurrentPage")}
            title={t("browser.attachCurrentPage")}
            disabled={!activeUrl || status === "loading" || isAttachingPage}
            onClick={handleAttachCurrentPage}
            className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-[#DEE0E3] bg-white px-2 text-xs font-medium text-[#2B2F36] transition-colors hover:bg-[#F8F9FA] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isAttachingPage ? (
              <Loader2 aria-hidden="true" size={14} className="animate-spin" />
            ) : attachedToActivePage ? (
              <CheckCircle2 aria-hidden="true" size={14} className="text-[#16845B]" />
            ) : (
              <Paperclip aria-hidden="true" size={14} />
            )}
            <span className="hidden lg:inline">
              {attachedToActivePage ? t("browser.attachedCurrentPage") : t("browser.attachCurrentPage")}
            </span>
          </button>
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
                  <p className="text-base font-semibold leading-6 text-[#1F2329]">
                    {t("browser.emptyTitle")}
                  </p>
                  <p className="mt-2 text-sm leading-5 text-[#8F959E]">
                    {t("browser.emptySubtitle")}
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        ) : showPreviewBlocked ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm leading-6 text-[#646A73]">
            <div className="max-w-sm">
              <ExternalLink aria-hidden="true" className="mx-auto mb-4 text-[#8F959E]" size={40} />
              <p className="font-medium text-[#1F2329]">{t("browser.previewBlocked")}</p>
              <p className="mt-2">
                {previewBlockedReason ? `${previewBlockedReason}. ` : ""}
                {t("browser.previewBlockedDetail")}
              </p>
              <button
                type="button"
                className="mt-4 inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-[#DEE0E3] bg-white px-3 text-sm font-medium text-[#2B2F36] transition-colors hover:bg-[#F8F9FA]"
                onClick={handleOpenExternal}
              >
                <ExternalLink aria-hidden="true" size={16} />
                {t("browser.openExternally")}
              </button>
            </div>
          </div>
        ) : frameUrl ? (
          <>
            <iframe
              ref={iframeRef}
              key={`${frameUrl}:${frameVersion}`}
              title={page?.title || t("browser.title")}
              src={shouldUsePreviewHtml ? undefined : frameUrl}
              srcDoc={shouldUsePreviewHtml ? (page?.preview_html ?? undefined) : undefined}
              className="h-full w-full border-0 bg-white"
              sandbox={
                shouldUseDirectIframe
                  ? undefined
                  : shouldUsePreviewHtml
                  ? "allow-forms allow-scripts"
                  : "allow-forms allow-same-origin allow-scripts"
              }
              referrerPolicy="no-referrer-when-downgrade"
              onLoad={handleFrameLoad}
            />
            {status === "loading" ? (
              <div className="absolute inset-0 cursor-progress bg-white/10" aria-hidden="true" />
            ) : null}
          </>
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm leading-6 text-[#8F959E]">
            <div>
              <Globe2
                aria-hidden="true"
                className="mx-auto mb-5 text-[#8F959E]"
                size={56}
                strokeWidth={1.8}
              />
              <p className="text-base font-semibold leading-6 text-[#1F2329]">
                {t("browser.emptyTitle")}
              </p>
              <p className="mt-2 text-sm leading-5 text-[#8F959E]">{t("browser.emptySubtitle")}</p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
