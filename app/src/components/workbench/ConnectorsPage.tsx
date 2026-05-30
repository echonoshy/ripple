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
import { IconTile, type IconTileTone } from "@/components/icons/IconTile";
import type { ConnectorInfo, ConnectorStatus, GogcliAccountInfo } from "@/types";

const CONNECTOR_CACHE_TTL_MS = 30_000;
const CONNECTOR_FOCUS_REFRESH_THROTTLE_MS = 10_000;

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

function statusLabel(status: ConnectorStatus | null | undefined): string {
  if (!status) return "Unknown";
  return status.connected ? "Connected" : "Needs setup";
}

function mobileStatusLabel(status: ConnectorStatus | null | undefined): string {
  if (!status) return "Unknown";
  return status.connected ? "Ready" : "Setup";
}

function connectorStatusIconTone(status: ConnectorStatus | null | undefined): IconTileTone {
  const tone = connectorStatusTone(status);
  if (tone === "connected") return "success";
  if (tone === "needs_setup") return "warning";
  return "neutral";
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

export default function ConnectorsPage({
  userId,
  onConnectorStateChange,
  onBack,
}: {
  userId: string;
  onConnectorStateChange?: () => Promise<unknown> | unknown;
  onBack?: () => void;
}) {
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
        setActionMessage(actionDetail(result, "Connector updated"));
        if (options.refresh !== false) await loadConnectors({ force: true });
        return result;
      } catch (error) {
        if (error instanceof AuthError) {
          setPageError("API key 已失效");
        } else {
          setPageError(error instanceof Error ? error.message : String(error));
        }
        return null;
      } finally {
        setPendingAction(null);
      }
    },
    [loadConnectors]
  );

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
        window.open(maybeUrl, "_blank", "noopener,noreferrer");
      }
      const stage = typeof result.stage === "string" ? result.stage : "pending";
      if (stage === "authorized") {
        setPendingAuth(null);
        await loadConnectors({ force: true });
      } else {
        setPendingAuth({
          connector: connector.name,
          stage,
          detail: actionDetail(result, `${connector.display_name} authorization started`),
          data,
          startedAt: Date.now(),
        });
      }
    },
    [loadConnectors, runConnectorMutation]
  );

  const handleSubmitNotionToken = useCallback(async () => {
    const token = notionToken.trim();
    if (!token) {
      setPageError("Notion token is required.");
      return;
    }
    const result = await runConnectorMutation("notion:connect", () =>
      startConnectorAuth("notion", { api_token: token })
    );
    if (!result) return;
    setNotionToken("");
    setConfirmAction(null);
    setPendingAuth(null);
  }, [notionToken, runConnectorMutation]);

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
          window.open(nextUrl, "_blank", "noopener,noreferrer");
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
    setActionMessage("Connector authorization completed.");
  }, [pendingAuth, statuses]);

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-[radial-gradient(circle_at_16%_0%,rgba(47,107,255,0.12),transparent_34%),radial-gradient(circle_at_88%_8%,rgba(139,92,246,0.11),transparent_32%),#fbfdff] px-3 pt-[max(env(safe-area-inset-top),12px)] pb-[calc(76px+env(safe-area-inset-bottom))] text-[#111827] md:px-6 lg:pb-5">
      <div className="mx-auto max-w-5xl space-y-3">
        <header className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2.5">
            {onBack ? (
              <button
                type="button"
                onClick={onBack}
                aria-label="Back to settings"
                title="Back to settings"
                className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#dfe6f4] bg-white text-[#384152] hover:bg-[#f7f8fa] lg:hidden"
              >
                <ArrowBigLeft size={15} />
              </button>
            ) : null}
            <div className="min-w-0">
              <h1 className="text-[18px] leading-tight font-semibold tracking-normal">
                <span className="sm:hidden">Connectors</span>
                <span className="hidden sm:inline">Connectors</span>
              </h1>
              <div className="mt-1 text-[11px] text-[#7a8496]">
                <span className="sm:hidden">
                  {connectorReadiness.connected}/{connectorReadiness.total} ready
                </span>
                <span className="hidden sm:inline">
                  {connectorReadiness.connected}/{connectorReadiness.total} connected
                </span>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void loadConnectors({ force: true })}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[#dfe6f4] bg-white/78 px-2.5 text-[12px] font-medium text-[#384152] shadow-[0_8px_18px_rgba(44,63,123,0.05)] hover:bg-white"
          >
            {isLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            <span className="sm:hidden">Refresh</span>
            <span className="hidden sm:inline">Refresh</span>
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
                    Per-user credentials stored inside the current sandbox boundary.
                  </p>
                </div>
                <span className="text-[11px] font-medium text-[#667085]">
                  {section.connectors.length}
                </span>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {section.connectors.map((connector) => {
                  const status = statuses[connector.name] || null;
                  const tone = connectorStatusTone(status);
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
                    ? "Open setup"
                    : "Open auth";

                  return (
                    <section
                      key={connector.name}
                      className="min-w-0 rounded-xl border border-[#dfe6f4] bg-white/74 shadow-[0_8px_22px_rgba(44,63,123,0.05)] backdrop-blur-xl"
                    >
                      <div className="flex items-start gap-2.5 border-b border-[#e8edf7] p-3">
                        <IconTile tone={connectorStatusIconTone(status)} size="md">
                          {tone === "connected" ? <ShieldCheck size={15} /> : <Plug size={15} />}
                        </IconTile>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <h3 className="truncate text-[12px] font-semibold">
                              {connector.display_name}
                            </h3>
                            <span className="rounded-full border border-[#dfe6f4] bg-white/76 px-1.5 py-0.5 text-[10px] font-medium text-[#667085]">
                              <span className="sm:hidden">{mobileStatusLabel(status)}</span>
                              <span className="hidden sm:inline">{statusLabel(status)}</span>
                            </span>
                          </div>
                          <p className="mt-1 text-[11px] leading-4 text-[#667085]">
                            {connector.description}
                          </p>
                          {status?.detail && (
                            <div className="mt-1.5 text-[11px] leading-4 text-[#667085]">
                              {status.detail}
                            </div>
                          )}
                          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
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
                                Connect
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
                                Cancel auth
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
                                  ? "Confirm local disconnect"
                                  : "Local disconnect"}
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </div>

                      {connector.name === "notion" && confirmAction === "notion-token" ? (
                        <div className="border-b border-[#e8edf7] p-3">
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <input
                              value={notionToken}
                              onChange={(event) => setNotionToken(event.target.value)}
                              type="password"
                              placeholder="Notion integration token"
                              className="min-h-8 min-w-0 flex-1 rounded-lg border border-[#dfe6f4] bg-white px-2.5 text-[11px] text-[#111827] outline-none focus:border-[#2f6bff]"
                            />
                            <div className="flex shrink-0 gap-2">
                              <button
                                type="button"
                                onClick={() => void handleSubmitNotionToken()}
                                disabled={pendingAction === "notion:connect"}
                                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#2f6bff]/30 bg-[#2f6bff] px-2.5 text-[11px] font-semibold text-white disabled:opacity-60"
                              >
                                {pendingAction === "notion:connect" ? (
                                  <Loader2 size={12} className="animate-spin" />
                                ) : (
                                  <KeyRound size={12} />
                                )}
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setConfirmAction(null);
                                  setNotionToken("");
                                }}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#dfe6f4] bg-white text-[#384152] hover:bg-[#f7f8fa]"
                                aria-label="Cancel Notion token entry"
                                title="Cancel Notion token entry"
                              >
                                <X size={13} />
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : null}

                      {pendingForConnector ? (
                        <div className="border-b border-[#e8edf7] p-3 text-[11px] text-[#667085]">
                          <div className="flex items-start gap-2">
                            <Loader2
                              size={13}
                              className="mt-0.5 shrink-0 animate-spin text-[#2f6bff]"
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
                                      alt="Bilibili login QR code"
                                      className="h-28 w-28 rounded-lg border border-[#dfe6f4] bg-white object-contain p-1"
                                    />
                                  ) : null}
                                  {pendingExternalUrl ? (
                                    <a
                                      href={pendingExternalUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="inline-flex h-7 items-center gap-1.5 rounded-full border border-[#dfe6f4] bg-white px-2.5 text-[11px] font-semibold text-[#384152] hover:bg-[#f7f8fa]"
                                    >
                                      <ExternalLink size={12} />
                                      {qrcodeContent ? "Open link" : pendingExternalLabel}
                                    </a>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      ) : null}

                      {connector.name === "google_workspace" && accounts.length > 0 && (
                        <div className="p-3">
                          <div className="rounded-xl border border-[#dfe6f4] bg-white/82">
                            {accounts.map((account) => (
                              <div
                                key={account.email}
                                className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 text-[11px]"
                              >
                                <div className="min-w-0">
                                  <div className="truncate font-[family-name:var(--font-mono)]">
                                    {account.email}
                                  </div>
                                  <div className="mt-0.5 text-[10px] text-[#6b7280]">
                                    {account.valid === false ? "Invalid" : "Ready"}
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
                                      ? "Confirm"
                                      : "Remove local"}
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
            <span className="sm:hidden">No connectors</span>
            <span className="hidden sm:inline">No connectors</span>
          </div>
        )}
      </div>
    </div>
  );
}
