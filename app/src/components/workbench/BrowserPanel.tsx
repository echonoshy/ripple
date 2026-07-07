"use client";

import type { FormEvent } from "react";
import { useCallback, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";

import { useI18n } from "@/i18n";
import { fetchBrowserPage, type BrowserPageResponse, type ChatBrowserContext } from "@/lib/api";
import { buildBrowserContext, normalizeBrowserUrlInput } from "@/lib/browserContext";
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

export default function BrowserPanel({
  initialAddress = "",
  onBrowserContextChange,
}: BrowserPanelProps) {
  const { t } = useI18n();
  const initialUrl = normalizeBrowserUrlInput(initialAddress);
  const [address, setAddress] = useState(initialUrl);
  const [frameUrl, setFrameUrl] = useState(initialUrl);
  const [page, setPage] = useState<BrowserPageResponse | null>(null);
  const [status, setStatus] = useState<BrowserStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [frameVersion, setFrameVersion] = useState(0);
  const [history, setHistory] = useState<BrowserHistoryState>(() => ({
    entries: initialUrl ? [initialUrl] : [],
    index: initialUrl ? 0 : -1,
  }));

  const canGoBack = history.index > 0;
  const canGoForward = history.index >= 0 && history.index < history.entries.length - 1;
  const activeUrl = frameUrl || address;

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

  const capturePage = useCallback(
    async (value: string, options: { recordHistory?: boolean } = {}) => {
      const shouldRecordHistory = options.recordHistory ?? true;
      const normalizedAddress = normalizeBrowserUrlInput(value);

      setAddress(normalizedAddress);
      setFrameUrl(normalizedAddress);
      setError(null);
      setFrameVersion((current) => current + 1);

      if (shouldRecordHistory) {
        pushHistory(normalizedAddress);
      }

      if (!normalizedAddress) {
        setPage(null);
        setStatus("idle");
        publishContext("", null);
        return;
      }

      setStatus("loading");
      publishContext(normalizedAddress, null);

      try {
        const nextPage = await fetchBrowserPage(normalizedAddress);
        const resolvedUrl = nextPage.url || normalizedAddress;

        setPage(nextPage);
        setStatus("loaded");
        setAddress(resolvedUrl);
        setFrameUrl(resolvedUrl);
        publishContext(resolvedUrl, nextPage);
      } catch {
        setPage(null);
        setStatus("failed");
        setError(t("browser.failed"));
        publishContext(normalizedAddress, null);
      }
    },
    [publishContext, pushHistory, t]
  );

  const navigateHistory = useCallback(
    (nextIndex: number) => {
      const nextUrl = history.entries[nextIndex];
      if (!nextUrl) return;

      setHistory((current) => ({ ...current, index: nextIndex }));
      void capturePage(nextUrl, { recordHistory: false });
    },
    [capturePage, history.entries]
  );

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void capturePage(address);
  };

  const handleRefresh = () => {
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
      <form className="shrink-0 border-b border-[#EFF0F1] p-3" onSubmit={handleSubmit}>
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

      <div className="flex min-h-8 shrink-0 items-center justify-between border-b border-[#EFF0F1] px-3 py-1.5 text-xs leading-5 text-[#646A73]">
        <span className="min-w-0 truncate">{page?.title || activeUrl || t("browser.empty")}</span>
        <span
          className={`ml-3 shrink-0 ${
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
        className="min-h-0 flex-1 overflow-hidden bg-[#F8F9FA]"
      >
        {frameUrl ? (
          <iframe
            key={`${frameUrl}:${frameVersion}`}
            title={page?.title || t("browser.title")}
            src={frameUrl}
            className="h-full w-full border-0 bg-white"
            sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
            referrerPolicy="no-referrer-when-downgrade"
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm leading-6 text-[#8F959E]">
            {t("browser.empty")}
          </div>
        )}
      </div>
    </section>
  );
}
