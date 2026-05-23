"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, Plug, RefreshCw, ShieldCheck } from "lucide-react";
import { fetchConnectorStatuses, fetchConnectors, fetchGogcliAccounts } from "@/lib/api";
import { connectorGroupSections, connectorStatusTone } from "@/lib/connectors";
import type { ConnectorInfo, ConnectorStatus, GogcliAccountInfo } from "@/types";

const CONNECTOR_CACHE_TTL_MS = 30_000;
const CONNECTOR_FOCUS_REFRESH_THROTTLE_MS = 10_000;

interface ConnectorSnapshot {
  connectors: ConnectorInfo[];
  statuses: Record<string, ConnectorStatus>;
  accounts: GogcliAccountInfo[];
  loadedAt: number;
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

export default function ConnectorsPage({
  userId,
  onConnectorStateChange,
}: {
  userId: string;
  onConnectorStateChange?: () => Promise<unknown> | unknown;
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
  const [isLoading, setIsLoading] = useState(false);
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

  const connected = useMemo(
    () => connectors.filter((connector) => statuses[connector.name]?.connected).length,
    [connectors, statuses]
  );
  const connectorSections = useMemo(() => connectorGroupSections(connectors), [connectors]);

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-white px-5 pt-5 pb-[calc(88px+env(safe-area-inset-bottom))] text-[#0d0d0d] md:px-8 lg:pb-5">
      <div className="mx-auto max-w-5xl space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[#e5e7eb] pb-5">
          <div>
            <h1 className="text-[24px] leading-tight font-semibold tracking-normal">
              <span className="sm:hidden">Apps</span>
              <span className="hidden sm:inline">Connectors</span>
            </h1>
            <div className="mt-2 text-sm text-[#6b7280]">
              <span className="sm:hidden">
                {connected}/{connectors.length || 0} ready
              </span>
              <span className="hidden sm:inline">
                {connected}/{connectors.length || 0} connected
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void loadConnectors({ force: true })}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-[#e5e7eb] bg-white px-3 text-sm font-medium text-[#374151] hover:bg-[#f7f8fa] hover:text-[#0d0d0d]"
          >
            {isLoading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            <span className="sm:hidden">Sync</span>
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </header>

        {pageError && (
          <div className="flex items-start gap-2 rounded-md border border-[#cf222e]/25 bg-[#ffebe9] p-3 text-sm font-medium text-[#cf222e]">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>{pageError}</span>
          </div>
        )}

        <div className="space-y-6">
          {connectorSections.map((section) => (
            <section key={section.kind} className="space-y-3">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-[#0d0d0d]">{section.title}</h2>
                  <p className="mt-1 text-xs leading-5 text-[#6b7280]">
                    {section.kind === "runtime_capability"
                      ? "Server-side Codex capabilities shared by the runtime."
                      : "Per-user credentials stored inside the current sandbox boundary."}
                  </p>
                </div>
                <span className="text-xs font-medium text-[#6b7280]">
                  {section.connectors.length}
                </span>
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                {section.connectors.map((connector) => {
                  const status = statuses[connector.name] || null;
                  const tone = connectorStatusTone(status);

                  return (
                    <section
                      key={connector.name}
                      className="min-w-0 rounded-lg border border-[#e5e7eb] bg-white"
                    >
                      <div className="flex items-start gap-3 border-b border-[#e5e7eb] p-4">
                        <span
                          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md border ${
                            tone === "connected"
                              ? "border-[#1a7f37]/25 bg-[#dafbe1] text-[#1a7f37]"
                              : tone === "needs_setup"
                                ? "border-[#bf8700]/25 bg-[#fff8c5] text-[#7d4e00]"
                                : "border-[#e5e7eb] bg-[#f7f8fa] text-[#6b7280]"
                          }`}
                        >
                          {tone === "connected" ? <ShieldCheck size={17} /> : <Plug size={17} />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="truncate text-sm font-semibold">
                              {connector.display_name}
                            </h3>
                            <span className="rounded-md border border-[#e5e7eb] bg-[#f7f8fa] px-2 py-0.5 text-[11px] font-medium text-[#6b7280]">
                              <span className="sm:hidden">{mobileStatusLabel(status)}</span>
                              <span className="hidden sm:inline">{statusLabel(status)}</span>
                            </span>
                          </div>
                          <p className="mt-1 text-sm leading-5 text-[#6b7280]">
                            {connector.description}
                          </p>
                          {status?.detail && (
                            <div className="mt-2 text-xs leading-5 text-[#6b7280]">
                              {status.detail}
                            </div>
                          )}
                        </div>
                      </div>

                      {connector.name === "google_workspace" && accounts.length > 0 && (
                        <div className="p-4">
                          <div className="rounded-md border border-[#e5e7eb] bg-white">
                            {accounts.map((account) => (
                              <div
                                key={account.email}
                                className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
                              >
                                <span className="truncate font-[family-name:var(--font-mono)]">
                                  {account.email}
                                </span>
                                <span className="text-[#6b7280]">
                                  {account.valid === false ? "Invalid" : "Ready"}
                                </span>
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
          <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-[#e5e7eb] text-sm text-[#6b7280]">
            <span className="sm:hidden">No apps yet</span>
            <span className="hidden sm:inline">No connectors</span>
          </div>
        )}
      </div>
    </div>
  );
}
