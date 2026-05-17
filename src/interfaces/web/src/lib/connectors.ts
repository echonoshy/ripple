import type { ConnectorActionResponse, ConnectorInfo, ConnectorStatus } from "@/types";

export type ConnectorAuthMode = "token" | "oauth" | "qr" | "status_only";
export type ConnectorStatusTone = "connected" | "needs_setup" | "unknown";

export function connectorAuthMode(connector: ConnectorInfo): ConnectorAuthMode {
  if (connector.auth_type === "token") return "token";
  if (connector.auth_type === "oauth") return "oauth";
  if (connector.auth_type === "qr") return "qr";
  return "status_only";
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

export function extractFeishuDeviceCode(text: string): string {
  const match = text.match(/(?:device[_\s-]*code|设备码|授权码)\s*[:：]\s*([A-Za-z0-9._-]+)/i);
  return match?.[1] || "";
}
