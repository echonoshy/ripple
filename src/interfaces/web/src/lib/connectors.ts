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

export function actionDataString(
  action: ConnectorActionResponse | null | undefined,
  key: string
): string {
  const value = action?.data?.[key];
  return typeof value === "string" ? value : "";
}
