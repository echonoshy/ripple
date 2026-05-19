import type { ConnectorActionResponse, ConnectorInfo, ConnectorStatus } from "@/types";

export type ConnectorAuthMode = "token" | "oauth" | "qr" | "status_only";
export type ConnectorStatusTone = "connected" | "needs_setup" | "unknown";
export type FeishuAuthFollowup = "none" | "poll_setup" | "poll_user_auth";
export type ConnectorKind = ConnectorInfo["kind"];
export interface ConnectorGroupSection {
  kind: ConnectorKind;
  title: string;
  connectors: ConnectorInfo[];
}
export interface ExternalAuthWindow {
  closed?: boolean;
  location: { href: string };
  focus?: () => void;
}

export function connectorAuthMode(connector: ConnectorInfo): ConnectorAuthMode {
  if (connector.kind === "runtime_capability") return "status_only";
  if (connector.auth_type === "token") return "token";
  if (connector.auth_type === "oauth") return "oauth";
  if (connector.auth_type === "qr") return "qr";
  return "status_only";
}

export function connectorKindLabel(kind: ConnectorKind): string {
  return kind === "runtime_capability" ? "Runtime Capability" : "User Connector";
}

export function connectorGroupSections(connectors: ConnectorInfo[]): ConnectorGroupSection[] {
  const runtime = connectors.filter((connector) => connector.kind === "runtime_capability");
  const user = connectors.filter((connector) => connector.kind !== "runtime_capability");
  const sections: ConnectorGroupSection[] = [
    { kind: "runtime_capability", title: "Runtime Capabilities", connectors: runtime },
    { kind: "user_connector", title: "User Connectors", connectors: user },
  ];
  return sections.filter((section) => section.connectors.length > 0);
}

export function connectorStatusTone(
  status: ConnectorStatus | null | undefined
): ConnectorStatusTone {
  if (!status) return "unknown";
  return status.connected ? "connected" : "needs_setup";
}

export function needsCallbackInput(action: ConnectorActionResponse | null | undefined): boolean {
  return action?.stage === "awaiting_user_callback_url";
}

export function needsDeviceFlowComplete(
  action: ConnectorActionResponse | null | undefined
): boolean {
  const deviceCode = actionDataString(action, "device_code");
  return action?.stage === "awaiting_user_auth" && deviceCode.length > 0;
}

export function actionUrl(action: ConnectorActionResponse | null | undefined): string {
  return actionDataString(action, "oauth_url") || actionDataString(action, "setup_url");
}

export function actionDataString(
  action: ConnectorActionResponse | null | undefined,
  key: string
): string {
  const value = action?.data?.[key];
  return typeof value === "string" ? value : "";
}

export function feishuAuthFollowup(
  action: ConnectorActionResponse | null | undefined
): FeishuAuthFollowup {
  if (action?.name !== "feishu" || action.ok !== true) return "none";
  if (action.stage === "awaiting_setup" && actionUrl(action)) return "poll_setup";
  if (needsDeviceFlowComplete(action)) return "poll_user_auth";
  return "none";
}

export function navigateExternalAuthWindow(
  authWindow: ExternalAuthWindow | null | undefined,
  url: string,
  fallbackOpen: (url: string) => ExternalAuthWindow | null | undefined
): ExternalAuthWindow | null {
  if (!url) return authWindow || null;
  if (authWindow && authWindow.closed !== true) {
    authWindow.location.href = url;
    authWindow.focus?.();
    return authWindow;
  }
  return fallbackOpen(url) || null;
}

export function extractFeishuDeviceCode(text: string): string {
  const match = text.match(/(?:device[_\s-]*code|设备码|授权码)\s*[:：]\s*([A-Za-z0-9._-]+)/i);
  return match?.[1] || "";
}
