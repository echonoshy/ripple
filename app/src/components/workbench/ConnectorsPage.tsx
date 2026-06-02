"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowBigLeft,
  ExternalLink,
  KeyRound,
  Loader2,
  Plug,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import {
  AuthError,
  cancelConnectorAuth,
  completeConnectorAuth,
  disconnectConnector,
  fetchConnectorStatuses,
  fetchConnectors,
  fetchGogcliAccounts,
  resolveBackendUrl,
  startConnectorAuth,
} from "@/lib/api";
import {
  connectorGroupSections,
  connectorReadinessSummary,
  connectorStatusTone,
} from "@/lib/connectors";
import { openExternalUrl } from "@/lib/platform";
import { IconTile } from "@/components/icons/IconTile";
import { useI18n } from "@/i18n";
import type { ConnectorInfo, ConnectorStatus, GogcliAccountInfo } from "@/types";
import {
  COMPACT_IOS_PAGE_BACKGROUND,
  LUCIDE_NAV_STROKE_WIDTH,
  MOBILE_GLASS_ICON_BUTTON_CLASS,
  MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS,
  MOBILE_PAGE_TOP_SAFE_AREA_CLASS,
} from "./stylePrimitives";

const CONNECTOR_CACHE_TTL_MS = 30_000;
const CONNECTOR_FOCUS_REFRESH_THROTTLE_MS = 10_000;
const ACTION_MESSAGE_DISMISS_MS = 4_000;

interface ConnectorSnapshot {
  connectors: ConnectorInfo[];
  statuses: Record<string, ConnectorStatus>;
  accounts: GogcliAccountInfo[];
  loadedAt: number;
}

interface PendingConnectorAuth {
  connector: string;
  stage: string;
  detail: string;
  data: Record<string, unknown>;
  startedAt: number;
}

type Translator = ReturnType<typeof useI18n>["t"];

interface ConnectorLogoMeta {
  shellClass: string;
  cardClass: string;
  connectedDotClass: string;
}

const CONNECTOR_LOGO_META: Record<string, ConnectorLogoMeta> = {
  google_workspace: {
    shellClass: "border-[#dfe6f4] bg-white/82",
    cardClass: "hover:border-[#cfe4ff]",
    connectedDotClass: "bg-[#34a853]",
  },
  notion: {
    shellClass: "border-[#dfe6f4] bg-white/82",
    cardClass: "hover:border-[#d8d8de]",
    connectedDotClass: "bg-[#111827]",
  },
  feishu: {
    shellClass: "border-[#dfe6f4] bg-white/82",
    cardClass: "hover:border-[#c7efff]",
    connectedDotClass: "bg-[#18c6ff]",
  },
  bilibili: {
    shellClass: "border-[#dfe6f4] bg-white/82",
    cardClass: "hover:border-[#ffd5e6]",
    connectedDotClass: "bg-[#23ade5]",
  },
};

const FALLBACK_CONNECTOR_LOGO_META: ConnectorLogoMeta = {
  shellClass: "border-[#dfe6f4] bg-white/82 text-[#667085]",
  cardClass: "hover:border-[#d2dbea]",
  connectedDotClass: "bg-[#1a7f37]",
};

const FEISHU_FAVICON_DATA_URI =
  "data:image/png;base64,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";

const connectorSnapshotCache = new Map<string, ConnectorSnapshot>();
const connectorSnapshotInflight = new Map<string, Promise<ConnectorSnapshot>>();

function cachedConnectorSnapshot(userId: string): ConnectorSnapshot | null {
  return connectorSnapshotCache.get(userId) || null;
}

function freshConnectorSnapshot(userId: string): ConnectorSnapshot | null {
  const snapshot = cachedConnectorSnapshot(userId);
  if (!snapshot) return null;
  return Date.now() - snapshot.loadedAt < CONNECTOR_CACHE_TTL_MS ? snapshot : null;
}

function hasConnectorSnapshot(userId: string): boolean {
  return connectorSnapshotCache.has(userId);
}

async function fetchConnectorSnapshot(userId: string, force = false): Promise<ConnectorSnapshot> {
  const freshSnapshot = force ? null : freshConnectorSnapshot(userId);
  if (freshSnapshot) return freshSnapshot;
  const inflightSnapshot = connectorSnapshotInflight.get(userId);
  if (!force && inflightSnapshot) return inflightSnapshot;

  const nextInflight = (async () => {
    const connectorList = await fetchConnectors();
    const statuses = await fetchConnectorStatuses(connectorList);
    const google = connectorList.find((connector) => connector.name === "google_workspace");
    let accounts: GogcliAccountInfo[] = [];
    if (google?.accounts_path) {
      const data = await fetchGogcliAccounts(false);
      accounts = data?.accounts || [];
    }
    const snapshot = { connectors: connectorList, statuses, accounts, loadedAt: Date.now() };
    connectorSnapshotCache.set(userId, snapshot);
    return snapshot;
  })();
  connectorSnapshotInflight.set(userId, nextInflight);

  try {
    return await nextInflight;
  } finally {
    if (connectorSnapshotInflight.get(userId) === nextInflight) {
      connectorSnapshotInflight.delete(userId);
    }
  }
}

function statusLabel(status: ConnectorStatus | null | undefined, t: Translator): string {
  if (!status) return t("connectors.unknown");
  return status.connected ? t("connectors.connected") : t("connectors.needsSetup");
}

function mobileStatusLabel(status: ConnectorStatus | null | undefined, t: Translator): string {
  if (!status) return t("connectors.unknown");
  return status.connected ? t("connectors.ready") : t("connectors.setup");
}

function actionDetail(result: Record<string, unknown>, fallback: string): string {
  return typeof result.detail === "string" && result.detail.trim() ? result.detail : fallback;
}

function actionData(result: Record<string, unknown>): Record<string, unknown> {
  return result.data && typeof result.data === "object"
    ? (result.data as Record<string, unknown>)
    : {};
}

function authUrlFromData(data: Record<string, unknown>): string | null {
  for (const key of ["oauth_url", "auth_url", "setup_url", "app_url"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function stringFromData(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function connectorLogoMeta(connector: ConnectorInfo): ConnectorLogoMeta {
  return CONNECTOR_LOGO_META[connector.name] || FALLBACK_CONNECTOR_LOGO_META;
}

function connectorStatusPillClass(status: ConnectorStatus | null | undefined): string {
  const tone = connectorStatusTone(status);
  if (tone === "connected") {
    return "border-[#1a7f37]/20 bg-[#dafbe1]/78 text-[#1a7f37]";
  }
  if (tone === "needs_setup") {
    return "border-[#f2cc79]/45 bg-[#fff8df]/82 text-[#7d4e00]";
  }
  return "border-[#dfe6f4] bg-white/76 text-[#667085]";
}

function connectorStatusDotClass(
  status: ConnectorStatus | null | undefined,
  logo: ConnectorLogoMeta
): string {
  const tone = connectorStatusTone(status);
  if (tone === "connected") return logo.connectedDotClass;
  if (tone === "needs_setup") return "bg-[#bf8700]";
  return "bg-[#94a3b8]";
}

function GoogleWorkspaceLogo() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-6 w-6">
      <path
        fill="#4285f4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34a853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C4 20.53 7.7 23 12 23z"
      />
      <path
        fill="#fbbc05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#ea4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 4 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

function NotionLogo() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-6 w-6">
      <path
        fill="#111827"
        d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z"
      />
    </svg>
  );
}

function FeishuLogo() {
  return (
    <img
      src={FEISHU_FAVICON_DATA_URI}
      alt=""
      aria-hidden="true"
      className="h-6 w-6 object-contain"
      draggable={false}
    />
  );
}

function BilibiliLogo() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-6 w-6">
      <path
        fill="#23ade5"
        d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L9.653 4.44c.071.071.134.142.187.213h4.267a.836.836 0 0 1 .16-.213l2.853-2.747c.267-.249.573-.373.92-.373.347 0 .662.151.929.4.267.249.391.551.391.907 0 .355-.124.657-.373.906zM5.333 7.24c-.746.018-1.373.276-1.88.773-.506.498-.769 1.13-.786 1.894v7.52c.017.764.28 1.395.786 1.893.507.498 1.134.756 1.88.773h13.334c.746-.017 1.373-.275 1.88-.773.506-.498.769-1.129.786-1.893v-7.52c-.017-.765-.28-1.396-.786-1.894-.507-.497-1.134-.755-1.88-.773zM8 11.107c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c0-.373.129-.689.386-.947.258-.257.574-.386.947-.386zm8 0c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c.017-.391.15-.711.4-.96.249-.249.56-.373.933-.373Z"
      />
    </svg>
  );
}

function ConnectorOfficialLogo({
  connector,
  status,
}: {
  connector: ConnectorInfo;
  status: ConnectorStatus | null | undefined;
}) {
  const logo = connectorLogoMeta(connector);
  const logoNode =
    connector.name === "google_workspace" ? (
      <GoogleWorkspaceLogo />
    ) : connector.name === "notion" ? (
      <NotionLogo />
    ) : connector.name === "feishu" ? (
      <FeishuLogo />
    ) : connector.name === "bilibili" ? (
      <BilibiliLogo />
    ) : (
      <Plug size={18} />
    );

  return (
    <span
      data-ripple-connector-logo-shell="true"
      title={connector.display_name}
      className={`relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border shadow-[0_8px_18px_rgba(44,63,123,0.06)] backdrop-blur-xl ${logo.shellClass}`}
    >
      <span
        data-ripple-connector-official-logo="true"
        className="inline-flex items-center justify-center"
      >
        {logoNode}
      </span>
      <span
        aria-hidden="true"
        className={`absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-2 border-white ${connectorStatusDotClass(
          status,
          logo
        )}`}
      />
    </span>
  );
}

export default function ConnectorsPage({
  userId,
  onConnectorStateChange,
  onBack,
}: {
  userId: string;
  onConnectorStateChange?: () => Promise<unknown> | unknown;
  onBack?: () => void;
}) {
  const { t } = useI18n();
  const [connectors, setConnectors] = useState<ConnectorInfo[]>(
    () => cachedConnectorSnapshot(userId)?.connectors || []
  );
  const [statuses, setStatuses] = useState<Record<string, ConnectorStatus>>(
    () => cachedConnectorSnapshot(userId)?.statuses || {}
  );
  const [accounts, setAccounts] = useState<GogcliAccountInfo[]>(
    () => cachedConnectorSnapshot(userId)?.accounts || []
  );
  const [pageError, setPageError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<string | null>(null);
  const [notionToken, setNotionToken] = useState("");
  const [pendingAuth, setPendingAuth] = useState<PendingConnectorAuth | null>(null);
  const loadRequestIdRef = useRef(0);
  const lastFocusRefreshAtRef = useRef(0);

  const applySnapshot = useCallback((snapshot: ConnectorSnapshot) => {
    setConnectors(snapshot.connectors);
    setStatuses(snapshot.statuses);
    setAccounts(snapshot.accounts);
  }, []);

  const loadConnectors = useCallback(
    async (options: { force?: boolean; background?: boolean } = {}) => {
      const cached = options.force ? null : cachedConnectorSnapshot(userId);
      if (cached) {
        applySnapshot(cached);
        if (Date.now() - cached.loadedAt < CONNECTOR_CACHE_TTL_MS) return;
      }

      const requestId = loadRequestIdRef.current + 1;
      loadRequestIdRef.current = requestId;
      if (!options.background) setIsLoading(true);
      setPageError(null);
      try {
        const snapshot = await fetchConnectorSnapshot(userId, options.force);
        if (loadRequestIdRef.current !== requestId) return;
        applySnapshot(snapshot);
        await onConnectorStateChange?.();
      } catch (error) {
        if (loadRequestIdRef.current === requestId) {
          setPageError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (loadRequestIdRef.current === requestId) {
          setIsLoading(false);
        }
      }
    },
    [applySnapshot, onConnectorStateChange, userId]
  );

  useEffect(() => {
    const cached = cachedConnectorSnapshot(userId);
    if (cached) {
      applySnapshot(cached);
    } else {
      setConnectors([]);
      setStatuses({});
      setAccounts([]);
    }
    void loadConnectors({ background: hasConnectorSnapshot(userId) });
  }, [applySnapshot, loadConnectors, userId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const refreshOnFocus = () => {
      const now = Date.now();
      if (now - lastFocusRefreshAtRef.current < CONNECTOR_FOCUS_REFRESH_THROTTLE_MS) return;
      lastFocusRefreshAtRef.current = now;
      void loadConnectors({ background: true, force: true });
    };
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [loadConnectors]);

  useEffect(() => {
    if (!actionMessage) return;
    const timer = window.setTimeout(() => {
      setActionMessage(null);
    }, ACTION_MESSAGE_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [actionMessage]);

  const connectorReadiness = useMemo(
    () => connectorReadinessSummary(connectors, statuses),
    [connectors, statuses]
  );
  const connectorSections = useMemo(() => connectorGroupSections(connectors), [connectors]);

  const runConnectorMutation = useCallback(
    async (
      actionKey: string,
      mutation: () => Promise<Record<string, unknown>>,
      options: { refresh?: boolean } = {}
    ) => {
      setPendingAction(actionKey);
      setPageError(null);
      setActionMessage(null);
      try {
        const result = await mutation();
        setActionMessage(actionDetail(result, t("connectors.connectorUpdated")));
        if (options.refresh !== false) await loadConnectors({ force: true });
        return result;
      } catch (error) {
        if (error instanceof AuthError) {
          setPageError(t("connectors.apiKeyExpired"));
        } else {
          setPageError(error instanceof Error ? error.message : String(error));
        }
        return null;
      } finally {
        setPendingAction(null);
      }
    },
    [loadConnectors, t]
  );

  const handleOpenPendingExternalUrl = useCallback((event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const href = event.currentTarget.href.trim();
    if (!href) return;
    void openExternalUrl(href, "ripple-connector-auth");
  }, []);

  const handleStartAuth = useCallback(
    async (connector: ConnectorInfo) => {
      if (connector.name === "notion") {
        setConfirmAction("notion-token");
        return;
      }
      const result = await runConnectorMutation(
        `${connector.name}:connect`,
        () => startConnectorAuth(connector.name),
        { refresh: false }
      );
      if (!result) return;
      const data = actionData(result);
      const maybeUrl = authUrlFromData(data);
      if (maybeUrl && connector.name !== "bilibili") {
        void openExternalUrl(maybeUrl, "ripple-connector-auth");
      }
      const stage = typeof result.stage === "string" ? result.stage : "pending";
      if (stage === "authorized") {
        setPendingAuth(null);
        await loadConnectors({ force: true });
      } else {
        setPendingAuth({
          connector: connector.name,
          stage,
          detail: actionDetail(
            result,
            t("connectors.authorizationStarted", { name: connector.display_name })
          ),
          data,
          startedAt: Date.now(),
        });
      }
    },
    [loadConnectors, runConnectorMutation, t]
  );

  const handleSubmitNotionToken = useCallback(async () => {
    const token = notionToken.trim();
    if (!token) {
      setPageError(t("connectors.notionTokenRequired"));
      return;
    }
    const result = await runConnectorMutation("notion:connect", () =>
      startConnectorAuth("notion", { api_token: token })
    );
    if (!result) return;
    setNotionToken("");
    setConfirmAction(null);
    setPendingAuth(null);
  }, [notionToken, runConnectorMutation, t]);

  const handleCancelPendingAuth = useCallback(
    async (connector: ConnectorInfo) => {
      const result = await runConnectorMutation(`${connector.name}:cancel-auth`, () =>
        cancelConnectorAuth(connector.name)
      );
      if (!result) return;
      setPendingAuth((current) => (current?.connector === connector.name ? null : current));
    },
    [runConnectorMutation]
  );

  const handleCompletePendingAuth = useCallback(
    async (connector: ConnectorInfo) => {
      if (!pendingAuth || pendingAuth.connector !== connector.name) return;
      const qrcodeKey = stringFromData(pendingAuth.data, "qrcode_key");
      const deviceCode = stringFromData(pendingAuth.data, "device_code");
      if (connector.name === "feishu" && !deviceCode) {
        const result = await runConnectorMutation(
          `${connector.name}:continue-auth`,
          () => startConnectorAuth(connector.name),
          { refresh: false }
        );
        if (!result) return;
        const data = actionData(result);
        const nextUrl = authUrlFromData(data);
        const currentUrl = authUrlFromData(pendingAuth.data);
        if (nextUrl && nextUrl !== currentUrl) {
          void openExternalUrl(nextUrl, "ripple-connector-auth");
        }
        const stage = typeof result.stage === "string" ? result.stage : "pending";
        if (stage === "authorized") {
          setPendingAuth(null);
          await loadConnectors({ force: true });
        } else {
          setPendingAuth({
            connector: connector.name,
            stage,
            detail: actionDetail(result, pendingAuth.detail),
            data: { ...pendingAuth.data, ...data },
            startedAt: pendingAuth.startedAt,
          });
        }
        return;
      }
      const payload =
        connector.name === "bilibili" && qrcodeKey
          ? { qrcode_key: qrcodeKey, max_wait_seconds: 5 }
          : connector.name === "feishu" && deviceCode
            ? { device_code: deviceCode }
            : {};
      const result = await runConnectorMutation(
        `${connector.name}:complete-auth`,
        () => completeConnectorAuth(connector.name, payload),
        { refresh: false }
      );
      if (!result) return;
      const data = actionData(result);
      const stage = typeof result.stage === "string" ? result.stage : "pending";
      if (stage === "authorized") {
        setPendingAuth(null);
        await loadConnectors({ force: true });
      } else {
        setPendingAuth({
          connector: connector.name,
          stage,
          detail: actionDetail(result, pendingAuth.detail),
          data: { ...pendingAuth.data, ...data },
          startedAt: pendingAuth.startedAt,
        });
      }
    },
    [loadConnectors, pendingAuth, runConnectorMutation]
  );

  const handleDisconnect = useCallback(
    async (connector: ConnectorInfo, payload: Record<string, unknown> = {}) => {
      const accountSuffix = typeof payload.email === "string" ? `:${payload.email}` : "";
      const actionKey = `${connector.name}:disconnect${accountSuffix}`;
      if (confirmAction !== actionKey) {
        setConfirmAction(actionKey);
        return;
      }
      const result = await runConnectorMutation(actionKey, () =>
        disconnectConnector(connector.name, payload)
      );
      if (!result) return;
      setConfirmAction(null);
      if (connector.name === "google_workspace") {
        const data = await fetchGogcliAccounts(false);
        setAccounts(data?.accounts || []);
      }
    },
    [confirmAction, runConnectorMutation]
  );

  useEffect(() => {
    if (!pendingAuth) return;
    const connectorName = pendingAuth.connector;
    const timer = window.setInterval(() => {
      const connector = connectors.find((item) => item.name === connectorName);
      if (!connector) return;
      if (connectorName === "google_workspace") {
        void loadConnectors({ background: true, force: true });
      } else if (connectorName === "feishu" || connectorName === "bilibili") {
        void handleCompletePendingAuth(connector);
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [connectors, handleCompletePendingAuth, loadConnectors, pendingAuth]);

  useEffect(() => {
    if (!pendingAuth) return;
    if (!statuses[pendingAuth.connector]?.connected) return;
    setPendingAuth(null);
    setActionMessage(t("connectors.authorizationCompleted"));
  }, [pendingAuth, statuses, t]);

  return (
    <div
      className={`h-full min-h-0 overflow-y-auto ${COMPACT_IOS_PAGE_BACKGROUND} px-3 ${MOBILE_PAGE_TOP_SAFE_AREA_CLASS} ${MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS} text-[#111827] md:px-6 lg:pb-5`}
    >
      <div className="mx-auto max-w-5xl space-y-3">
        <header className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2.5">
            {onBack ? (
              <button
                type="button"
                onClick={onBack}
                aria-label={t("connectors.backToSettings")}
                title={t("connectors.backToSettings")}
                className={`${MOBILE_GLASS_ICON_BUTTON_CLASS} mt-0.5 lg:hidden`}
              >
                <ArrowBigLeft size={15} strokeWidth={LUCIDE_NAV_STROKE_WIDTH} />
              </button>
            ) : null}
            <div className="min-w-0">
              <h1 className="text-[18px] leading-tight font-semibold tracking-normal">
                <span className="sm:hidden">{t("connectors.title")}</span>
                <span className="hidden sm:inline">{t("connectors.title")}</span>
              </h1>
              <div className="mt-1 text-[11px] text-[#7a8496]">
                <span className="sm:hidden">
                  {t("connectors.readyCount", {
                    connected: connectorReadiness.connected,
                    total: connectorReadiness.total,
                  })}
                </span>
                <span className="hidden sm:inline">
                  {t("connectors.connectedCount", {
                    connected: connectorReadiness.connected,
                    total: connectorReadiness.total,
                  })}
                </span>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void loadConnectors({ force: true })}
            className="inline-flex h-10 items-center gap-1.5 rounded-full border border-[#dfe6f4] bg-white/78 px-3 text-[12px] font-medium text-[#384152] shadow-[0_8px_18px_rgba(44,63,123,0.05)] hover:bg-white"
          >
            {isLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            <span className="sm:hidden">{t("connectors.refresh")}</span>
            <span className="hidden sm:inline">{t("connectors.refresh")}</span>
          </button>
        </header>

        {pageError && (
          <div className="flex items-start gap-2 rounded-xl border border-[#cf222e]/25 bg-[#ffebe9] p-2.5 text-[12px] font-medium text-[#cf222e]">
            <IconTile tone="danger" size="sm" className="mt-0.5">
              <AlertTriangle size={13} />
            </IconTile>
            <span>{pageError}</span>
          </div>
        )}

        {actionMessage && (
          <div className="flex items-start gap-2 rounded-xl border border-[#1a7f37]/20 bg-[#dafbe1] p-2.5 text-[12px] font-medium text-[#1a7f37]">
            <IconTile tone="success" size="sm" className="mt-0.5">
              <ShieldCheck size={13} />
            </IconTile>
            <span>{actionMessage}</span>
          </div>
        )}

        <div className="space-y-4">
          {connectorSections.map((section) => (
            <section key={section.kind} className="space-y-2.5">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <h2 className="text-[12px] font-semibold text-[#111827]">{section.title}</h2>
                  <p className="mt-0.5 text-[11px] leading-4 text-[#667085]">
                    {t("connectors.sectionDescription")}
                  </p>
                </div>
                <span className="text-[11px] font-medium text-[#667085]">
                  {section.connectors.length}
                </span>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {section.connectors.map((connector) => {
                  const status = statuses[connector.name] || null;
                  const logo = connectorLogoMeta(connector);
                  const pendingForConnector =
                    pendingAuth?.connector === connector.name ? pendingAuth : null;
                  const qrcodeImageUrl = pendingForConnector
                    ? resolveBackendUrl(
                        stringFromData(pendingForConnector.data, "qrcode_image_url") || ""
                      )
                    : null;
                  const qrcodeContent = pendingForConnector
                    ? stringFromData(pendingForConnector.data, "qrcode_content")
                    : null;
                  const pendingExternalUrl =
                    connector.name === "bilibili"
                      ? null
                      : qrcodeContent ||
                        (pendingForConnector ? authUrlFromData(pendingForConnector.data) : null);
                  const pendingExternalLabel = stringFromData(
                    pendingForConnector?.data || {},
                    "setup_url"
                  )
                    ? t("connectors.openSetup")
                    : t("connectors.openAuth");

                  return (
                    <section
                      key={connector.name}
                      data-ripple-connector-card="true"
                      className={`group min-w-0 overflow-hidden rounded-xl border border-[#dfe6f4] bg-white/78 shadow-[0_10px_26px_rgba(44,63,123,0.055)] backdrop-blur-xl transition-all hover:-translate-y-0.5 hover:bg-white/86 hover:shadow-[0_16px_34px_rgba(44,63,123,0.08)] ${logo.cardClass}`}
                    >
                      <div className="flex items-start gap-3 p-3">
                        <ConnectorOfficialLogo connector={connector} status={status} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <h3 className="truncate text-[13px] leading-5 font-semibold">
                                {connector.display_name}
                              </h3>
                              <p className="mt-0.5 text-[11px] leading-4 text-[#667085]">
                                {connector.description}
                              </p>
                            </div>
                            <span
                              data-ripple-connector-status-pill="true"
                              className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-[10px] font-semibold ${connectorStatusPillClass(
                                status
                              )}`}
                            >
                              <span
                                aria-hidden="true"
                                className={`h-1.5 w-1.5 rounded-full ${connectorStatusDotClass(
                                  status,
                                  logo
                                )}`}
                              />
                              <span className="sm:hidden">{mobileStatusLabel(status, t)}</span>
                              <span className="hidden sm:inline">{statusLabel(status, t)}</span>
                            </span>
                          </div>
                          {status?.detail && (
                            <div className="mt-2 rounded-lg border border-[#e8edf7] bg-white/64 px-2 py-1.5 text-[11px] leading-4 text-[#667085]">
                              {status.detail}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="border-t border-[#e8edf7] bg-[#fbfcff]/62 px-3 py-2.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {connector.auth_start_path && !status?.connected ? (
                            <button
                              type="button"
                              onClick={() => void handleStartAuth(connector)}
                              disabled={pendingAction === `${connector.name}:connect`}
                              className="inline-flex h-7 items-center gap-1.5 rounded-full border border-[#dfe6f4] bg-white px-2.5 text-[11px] font-semibold text-[#384152] hover:bg-[#f7f8fa] disabled:opacity-60"
                            >
                              {pendingAction === `${connector.name}:connect` ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : (
                                <Plug size={12} />
                              )}
                              {t("connectors.connect")}
                            </button>
                          ) : null}
                          {pendingForConnector ? (
                            <button
                              type="button"
                              onClick={() => void handleCancelPendingAuth(connector)}
                              disabled={pendingAction === `${connector.name}:cancel-auth`}
                              className="inline-flex h-7 items-center gap-1.5 rounded-full border border-[#cf222e]/25 bg-[#ffebe9] px-2.5 text-[11px] font-semibold text-[#cf222e] disabled:opacity-60"
                            >
                              {pendingAction === `${connector.name}:cancel-auth` ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : (
                                <X size={12} />
                              )}
                              {t("connectors.cancelAuth")}
                            </button>
                          ) : null}
                          {connector.disconnect_path && status?.connected ? (
                            <button
                              type="button"
                              onClick={() =>
                                void handleDisconnect(
                                  connector,
                                  connector.name === "google_workspace" ? { all: true } : {}
                                )
                              }
                              disabled={pendingAction === `${connector.name}:disconnect`}
                              className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-semibold disabled:opacity-60 ${
                                confirmAction === `${connector.name}:disconnect`
                                  ? "border-[#cf222e]/25 bg-[#ffebe9] text-[#cf222e]"
                                  : "border-[#dfe6f4] bg-white text-[#384152] hover:bg-[#f7f8fa]"
                              }`}
                            >
                              {pendingAction === `${connector.name}:disconnect` ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : (
                                <Trash2 size={12} />
                              )}
                              {confirmAction === `${connector.name}:disconnect`
                                ? t("connectors.confirmLocalDisconnect")
                                : t("connectors.localDisconnect")}
                            </button>
                          ) : null}
                        </div>
                      </div>

                      {connector.name === "notion" && confirmAction === "notion-token" ? (
                        <div className="mx-3 mb-3 rounded-xl border border-[#dfe6f4] bg-white/78 p-3 shadow-[0_8px_18px_rgba(44,63,123,0.04)]">
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <input
                              value={notionToken}
                              onChange={(event) => setNotionToken(event.target.value)}
                              type="password"
                              placeholder={t("connectors.notionTokenPlaceholder")}
                              className="min-h-8 min-w-0 flex-1 rounded-lg border border-[#dfe6f4] bg-white px-2.5 text-[11px] text-[#111827] outline-none focus:border-[#007aff]"
                            />
                            <div className="flex shrink-0 gap-2">
                              <button
                                type="button"
                                onClick={() => void handleSubmitNotionToken()}
                                disabled={pendingAction === "notion:connect"}
                                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#007aff]/30 bg-[#007aff] px-2.5 text-[11px] font-semibold text-white disabled:opacity-60"
                              >
                                {pendingAction === "notion:connect" ? (
                                  <Loader2 size={12} className="animate-spin" />
                                ) : (
                                  <KeyRound size={12} />
                                )}
                                {t("connectors.save")}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setConfirmAction(null);
                                  setNotionToken("");
                                }}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#dfe6f4] bg-white text-[#384152] hover:bg-[#f7f8fa]"
                                aria-label={t("connectors.cancelNotionToken")}
                                title={t("connectors.cancelNotionToken")}
                              >
                                <X size={13} />
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : null}

                      {pendingForConnector ? (
                        <div className="mx-3 mb-3 rounded-xl border border-[#dfe6f4] bg-[#f8fbff]/88 p-3 text-[11px] text-[#667085] shadow-[0_8px_18px_rgba(44,63,123,0.04)]">
                          <div className="flex items-start gap-2">
                            <Loader2
                              size={13}
                              className="mt-0.5 shrink-0 animate-spin text-[#007aff]"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="font-semibold text-[#384152]">
                                {pendingForConnector.stage}
                              </div>
                              <div className="mt-1 leading-4">{pendingForConnector.detail}</div>
                              {qrcodeImageUrl || pendingExternalUrl ? (
                                <div className="mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-center">
                                  {qrcodeImageUrl ? (
                                    <img
                                      src={qrcodeImageUrl}
                                      alt={t("connectors.bilibiliQrAlt")}
                                      className="h-28 w-28 rounded-lg border border-[#dfe6f4] bg-white object-contain p-1"
                                    />
                                  ) : null}
                                  {pendingExternalUrl ? (
                                    <a
                                      href={pendingExternalUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      onClick={handleOpenPendingExternalUrl}
                                      className="inline-flex h-7 items-center gap-1.5 rounded-full border border-[#dfe6f4] bg-white px-2.5 text-[11px] font-semibold text-[#384152] hover:bg-[#f7f8fa]"
                                    >
                                      <ExternalLink size={12} />
                                      {qrcodeContent
                                        ? t("connectors.openLink")
                                        : pendingExternalLabel}
                                    </a>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      ) : null}

                      {connector.name === "google_workspace" && accounts.length > 0 && (
                        <div className="px-3 pb-3">
                          <div className="divide-y divide-[#e8edf7] overflow-hidden rounded-xl border border-[#dfe6f4] bg-white/82 shadow-[0_8px_18px_rgba(44,63,123,0.04)]">
                            {accounts.map((account) => (
                              <div
                                key={account.email}
                                className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-2 text-[11px]"
                              >
                                <div className="min-w-0">
                                  <div className="truncate font-[family-name:var(--font-mono)]">
                                    {account.email}
                                  </div>
                                  <div className="mt-0.5 text-[10px] text-[#6b7280]">
                                    {account.valid === false
                                      ? t("connectors.invalid")
                                      : t("connectors.ready")}
                                  </div>
                                </div>
                                <div className="flex shrink-0 flex-wrap gap-2">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void handleDisconnect(connector, { email: account.email })
                                    }
                                    disabled={
                                      pendingAction ===
                                      `${connector.name}:disconnect:${account.email}`
                                    }
                                    className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-semibold disabled:opacity-60 ${
                                      confirmAction ===
                                      `${connector.name}:disconnect:${account.email}`
                                        ? "border-[#cf222e]/25 bg-[#ffebe9] text-[#cf222e]"
                                        : "border-[#dfe6f4] bg-white text-[#384152] hover:bg-[#f7f8fa]"
                                    }`}
                                  >
                                    {pendingAction ===
                                    `${connector.name}:disconnect:${account.email}` ? (
                                      <Loader2 size={12} className="animate-spin" />
                                    ) : (
                                      <Trash2 size={12} />
                                    )}
                                    {confirmAction ===
                                    `${connector.name}:disconnect:${account.email}`
                                      ? t("connectors.confirm")
                                      : t("connectors.removeLocal")}
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        {connectors.length === 0 && !isLoading && (
          <div className="flex h-32 items-center justify-center rounded-xl border border-dashed border-[#dfe6f4] bg-white/52 text-[12px] text-[#667085]">
            <span className="sm:hidden">{t("connectors.empty")}</span>
            <span className="hidden sm:inline">{t("connectors.empty")}</span>
          </div>
        )}
      </div>
    </div>
  );
}
