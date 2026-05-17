"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  Plug,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import {
  completeConnectorAuth,
  disconnectConnector,
  fetchConnectorStatuses,
  fetchConnectors,
  fetchGogcliAccounts,
  resolveBackendUrl,
  startConnectorAuth,
} from "@/lib/api";
import {
  actionUrl,
  actionDataString,
  connectorAuthMode,
  connectorStatusTone,
  feishuAuthFollowup,
  navigateExternalAuthWindow,
  needsCallbackInput,
  needsDeviceFlowComplete,
} from "@/lib/connectors";
import type {
  ConnectorActionResponse,
  ConnectorInfo,
  ConnectorStatus,
  GogcliAccountInfo,
} from "@/types";

type ConnectorInputs = Record<string, Record<string, string>>;
type ConnectorActions = Record<string, ConnectorActionResponse | null>;

const FEISHU_SETUP_POLL_INTERVAL_MS = 2000;
const FEISHU_SETUP_MAX_POLLS = 90;
const FEISHU_AUTH_COMPLETE_DELAY_MS = 1000;
const FEISHU_AUTH_MAX_POLLS = 5;

function inputValue(inputs: ConnectorInputs, name: string, key: string): string {
  return inputs[name]?.[key] || "";
}

function statusLabel(status: ConnectorStatus | null | undefined): string {
  if (!status) return "Unknown";
  return status.connected ? "Connected" : "Needs setup";
}

function mobileStatusLabel(status: ConnectorStatus | null | undefined): string {
  if (!status) return "Unknown";
  return status.connected ? "Ready" : "Setup";
}

function fieldLabel(connector: ConnectorInfo, key: string): string {
  if (connector.name === "google_workspace" && key === "email") return "Google account";
  if (key === "token") return "Token";
  if (key === "callback_url") return "Callback URL";
  return key;
}

function openExternalUrl(url: string): Window | null {
  if (typeof window === "undefined" || !url) return null;
  return window.open(url, "_blank", "noopener,noreferrer");
}

function openReusableAuthWindow(): Window | null {
  if (typeof window === "undefined") return null;
  const authWindow = window.open("about:blank", "_blank");
  if (!authWindow) return null;
  try {
    authWindow.opener = null;
    authWindow.document.title = "Feishu authorization";
    authWindow.document.body.innerHTML =
      '<div style="font: 14px system-ui, sans-serif; padding: 24px;">Preparing Feishu authorization...</div>';
  } catch {
    /* The blank window may be unavailable in strict browser modes. */
  }
  return authWindow;
}

export default function ConnectorsPage() {
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ConnectorStatus>>({});
  const [accounts, setAccounts] = useState<GogcliAccountInfo[]>([]);
  const [inputs, setInputs] = useState<ConnectorInputs>({});
  const [actions, setActions] = useState<ConnectorActions>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [pageError, setPageError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const feishuTimersRef = useRef<number[]>([]);
  const feishuAuthWindowRef = useRef<Window | null>(null);

  const loadConnectors = useCallback(async () => {
    setIsLoading(true);
    setPageError(null);
    try {
      const connectorList = await fetchConnectors();
      setConnectors(connectorList);
      setStatuses(await fetchConnectorStatuses(connectorList));
      const google = connectorList.find((connector) => connector.name === "google_workspace");
      if (google?.accounts_path) {
        const data = await fetchGogcliAccounts(false);
        setAccounts(data?.accounts || []);
      }
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void loadConnectors();
    });
  }, [loadConnectors]);

  const clearFeishuFollowups = useCallback(() => {
    if (typeof window === "undefined") return;
    for (const timer of feishuTimersRef.current) {
      window.clearTimeout(timer);
    }
    feishuTimersRef.current = [];
  }, []);

  const scheduleFeishuFollowup = useCallback((callback: () => void, delayMs: number) => {
    if (typeof window === "undefined") return;
    const timer = window.setTimeout(() => {
      feishuTimersRef.current = feishuTimersRef.current.filter((item) => item !== timer);
      callback();
    }, delayMs);
    feishuTimersRef.current.push(timer);
  }, []);

  useEffect(() => clearFeishuFollowups, [clearFeishuFollowups]);

  const setInput = (connectorName: string, key: string, value: string) => {
    setInputs((prev) => ({
      ...prev,
      [connectorName]: {
        ...(prev[connectorName] || {}),
        [key]: value,
      },
    }));
  };

  const setConnectorBusy = (connectorName: string, value: boolean) => {
    setBusy((prev) => ({ ...prev, [connectorName]: value }));
  };

  const runConnectorAction = async (
    connector: ConnectorInfo,
    action: () => Promise<ConnectorActionResponse>
  ): Promise<ConnectorActionResponse | null> => {
    setConnectorBusy(connector.name, true);
    setPageError(null);
    try {
      const result = await action();
      setActions((prev) => ({ ...prev, [connector.name]: result }));
      await loadConnectors();
      return result;
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setConnectorBusy(connector.name, false);
    }
  };

  const pollFeishuUserAuth = (connector: ConnectorInfo, deviceCode: string, attempt = 0): void => {
    if (!deviceCode || attempt >= FEISHU_AUTH_MAX_POLLS) return;
    scheduleFeishuFollowup(() => {
      void (async () => {
        const result = await runConnectorAction(connector, () =>
          completeConnectorAuth(connector.name, { device_code: deviceCode })
        );
        if (result?.stage === "pending") {
          pollFeishuUserAuth(connector, deviceCode, attempt + 1);
        }
      })();
    }, FEISHU_AUTH_COMPLETE_DELAY_MS);
  };

  const pollFeishuSetup = (connector: ConnectorInfo, attempt = 0): void => {
    if (attempt >= FEISHU_SETUP_MAX_POLLS) return;
    scheduleFeishuFollowup(() => {
      void (async () => {
        const result = await runConnectorAction(connector, () =>
          startConnectorAuth(connector.name, { force_new: false })
        );
        if (!result?.ok) return;
        handleFeishuAuthResult(connector, result, {
          openUrl: result.stage !== "awaiting_setup",
          setupAttempt: attempt + 1,
        });
      })();
    }, FEISHU_SETUP_POLL_INTERVAL_MS);
  };

  const handleFeishuAuthResult = (
    connector: ConnectorInfo,
    result: ConnectorActionResponse,
    options: { openUrl?: boolean; setupAttempt?: number } = {}
  ): void => {
    const followup = feishuAuthFollowup(result);
    if (options.openUrl !== false) {
      feishuAuthWindowRef.current = navigateExternalAuthWindow(
        feishuAuthWindowRef.current,
        actionUrl(result),
        openExternalUrl
      ) as Window | null;
    }
    if (followup === "poll_setup") {
      pollFeishuSetup(connector, options.setupAttempt || 0);
      return;
    }
    if (followup === "poll_user_auth") {
      pollFeishuUserAuth(connector, actionDataString(result, "device_code"));
    }
  };

  const startAuth = async (connector: ConnectorInfo) => {
    const mode = connectorAuthMode(connector);
    const payload: Record<string, string> = {};
    if (mode === "token") {
      payload.api_token = inputValue(inputs, connector.name, "token");
    }
    if (connector.name === "google_workspace") {
      payload.email = inputValue(inputs, connector.name, "email");
    }
    if (connector.name === "feishu") {
      clearFeishuFollowups();
      feishuAuthWindowRef.current = openReusableAuthWindow();
    }
    const result = await runConnectorAction(connector, () =>
      startConnectorAuth(connector.name, payload)
    );
    if (connector.name === "feishu" && result?.ok) {
      handleFeishuAuthResult(connector, result);
    }
  };

  const completeAuth = async (connector: ConnectorInfo) => {
    const previous = actions[connector.name];
    const payload: Record<string, string | number> = {};
    if (connector.name === "google_workspace") {
      payload.email =
        inputValue(inputs, connector.name, "email") || actionDataString(previous, "email");
      payload.callback_url = inputValue(inputs, connector.name, "callback_url");
    }
    if (connector.name === "bilibili") {
      payload.qrcode_key = actionDataString(previous, "qrcode_key");
      payload.max_wait_seconds = 30;
    }
    if (connector.name === "feishu") {
      payload.device_code = actionDataString(previous, "device_code");
    }
    await runConnectorAction(connector, () => completeConnectorAuth(connector.name, payload));
  };

  const disconnect = async (connector: ConnectorInfo) => {
    if (connector.name === "feishu") {
      clearFeishuFollowups();
      feishuAuthWindowRef.current = null;
    }
    const payload: Record<string, string> = {};
    if (connector.name === "google_workspace") {
      payload.email = inputValue(inputs, connector.name, "email") || accounts[0]?.email || "";
    }
    await runConnectorAction(connector, () => disconnectConnector(connector.name, payload));
  };

  const connected = useMemo(
    () => connectors.filter((connector) => statuses[connector.name]?.connected).length,
    [connectors, statuses]
  );

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-white px-5 py-5 text-[#0d0d0d] md:px-8">
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
            onClick={() => void loadConnectors()}
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

        <div className="grid gap-4 lg:grid-cols-2">
          {connectors.map((connector) => {
            const mode = connectorAuthMode(connector);
            const status = statuses[connector.name] || null;
            const tone = connectorStatusTone(status);
            const action = actions[connector.name] || null;
            const isBusy = busy[connector.name] || false;
            const oauthUrl = actionUrl(action);
            const qrImageUrl = resolveBackendUrl(actionDataString(action, "qrcode_image_url"));

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
                      <h2 className="truncate text-sm font-semibold">{connector.display_name}</h2>
                      <span className="rounded-md border border-[#e5e7eb] bg-[#f7f8fa] px-2 py-0.5 text-[11px] font-medium text-[#6b7280]">
                        <span className="sm:hidden">{mobileStatusLabel(status)}</span>
                        <span className="hidden sm:inline">{statusLabel(status)}</span>
                      </span>
                    </div>
                    <p className="mt-1 text-sm leading-5 text-[#6b7280]">{connector.description}</p>
                    {status?.detail && (
                      <div className="mt-2 text-xs leading-5 text-[#6b7280]">{status.detail}</div>
                    )}
                  </div>
                </div>

                <div className="space-y-3 p-4">
                  {mode === "token" && (
                    <ConnectorField
                      connector={connector}
                      fieldKey="token"
                      type="password"
                      value={inputValue(inputs, connector.name, "token")}
                      onChange={setInput}
                    />
                  )}

                  {connector.name === "google_workspace" && (
                    <ConnectorField
                      connector={connector}
                      fieldKey="email"
                      value={inputValue(inputs, connector.name, "email")}
                      onChange={setInput}
                    />
                  )}

                  {needsCallbackInput(action) && (
                    <ConnectorField
                      connector={connector}
                      fieldKey="callback_url"
                      value={inputValue(inputs, connector.name, "callback_url")}
                      onChange={setInput}
                    />
                  )}

                  {oauthUrl && (
                    <a
                      href={oauthUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-8 items-center gap-2 rounded-md border border-[#0969da]/25 bg-[#ddf4ff] px-3 text-sm font-medium text-[#0969da] hover:bg-[#cbeeff]"
                    >
                      <ExternalLink size={14} />
                      <span className="sm:hidden">Authorize</span>
                      <span className="hidden sm:inline">Open authorization</span>
                    </a>
                  )}

                  {qrImageUrl && (
                    <div className="flex flex-wrap items-center gap-4">
                      <img
                        src={qrImageUrl}
                        alt={`${connector.display_name} QR code`}
                        className="h-36 w-36 rounded-md border border-[#e5e7eb] bg-white object-contain"
                      />
                      <button
                        type="button"
                        onClick={() => void completeAuth(connector)}
                        disabled={isBusy}
                        className="inline-flex h-9 items-center gap-2 rounded-md border border-[#1a7f37]/30 bg-[#dafbe1] px-3 text-sm font-semibold text-[#1a7f37] hover:bg-[#c7f7d1] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isBusy ? (
                          <Loader2 size={15} className="animate-spin" />
                        ) : (
                          <CheckCircle2 size={15} />
                        )}
                        Complete
                      </button>
                    </div>
                  )}

                  {action?.detail && (
                    <div className="rounded-md border border-[#e5e7eb] bg-[#f7f8fa] p-3 text-xs leading-5 text-[#374151]">
                      {action.detail}
                    </div>
                  )}

                  {connector.name === "google_workspace" && accounts.length > 0 && (
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
                  )}

                  <div className="flex flex-wrap gap-2">
                    {connector.auth_start_path && mode !== "status_only" && (
                      <button
                        type="button"
                        onClick={() => void startAuth(connector)}
                        disabled={isBusy}
                        className="inline-flex h-9 items-center gap-2 rounded-md bg-[#2463eb] px-3 text-sm font-semibold text-white hover:bg-[#1d56d8] disabled:cursor-not-allowed disabled:bg-[#e5e7eb] disabled:text-[#8b8f94]"
                      >
                        {isBusy ? (
                          <Loader2 size={15} className="animate-spin" />
                        ) : (
                          <KeyRound size={15} />
                        )}
                        {status?.connected ? "Update" : "Connect"}
                      </button>
                    )}
                    {connector.auth_complete_path && needsCallbackInput(action) && (
                      <button
                        type="button"
                        onClick={() => void completeAuth(connector)}
                        disabled={isBusy}
                        className="inline-flex h-9 items-center gap-2 rounded-md border border-[#1a7f37]/30 bg-[#dafbe1] px-3 text-sm font-semibold text-[#1a7f37] hover:bg-[#c7f7d1] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isBusy ? (
                          <Loader2 size={15} className="animate-spin" />
                        ) : (
                          <CheckCircle2 size={15} />
                        )}
                        Complete
                      </button>
                    )}
                    {connector.auth_complete_path && needsDeviceFlowComplete(action) && (
                      <button
                        type="button"
                        onClick={() => void completeAuth(connector)}
                        disabled={isBusy}
                        className="inline-flex h-9 items-center gap-2 rounded-md border border-[#1a7f37]/30 bg-[#dafbe1] px-3 text-sm font-semibold text-[#1a7f37] hover:bg-[#c7f7d1] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isBusy ? (
                          <Loader2 size={15} className="animate-spin" />
                        ) : (
                          <CheckCircle2 size={15} />
                        )}
                        Complete
                      </button>
                    )}
                    {connector.disconnect_path && status?.connected && (
                      <button
                        type="button"
                        onClick={() => void disconnect(connector)}
                        disabled={isBusy}
                        className="inline-flex h-9 items-center gap-2 rounded-md border border-[#cf222e]/25 bg-white px-3 text-sm font-medium text-[#cf222e] hover:bg-[#ffebe9] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <Unplug size={15} />
                        Disconnect
                      </button>
                    )}
                  </div>
                </div>
              </section>
            );
          })}
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

interface ConnectorFieldProps {
  connector: ConnectorInfo;
  fieldKey: string;
  type?: string;
  value: string;
  onChange: (connectorName: string, key: string, value: string) => void;
}

function ConnectorField({
  connector,
  fieldKey,
  type = "text",
  value,
  onChange,
}: ConnectorFieldProps) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[#6b7280]">
        {fieldLabel(connector, fieldKey)}
      </span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(connector.name, fieldKey, event.target.value)}
        className="h-9 w-full rounded-md border border-[#e5e7eb] bg-white px-3 text-sm text-[#0d0d0d] outline-none focus:border-[#2463eb]"
      />
    </label>
  );
}
