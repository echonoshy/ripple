import type { FeishuAuthOpenPayload } from "@/components/MarkdownRenderer";
import type { ConnectorAuthChatEvent } from "@/types";

export const CONNECTOR_AUTH_POLL_TIMEOUT_MS = 5 * 60 * 1000;

export function connectorAuthPollPayloadFromEvent(
  event: ConnectorAuthChatEvent
): FeishuAuthOpenPayload | null {
  const data = event.action?.data || {};
  const mode = event.action?.source === "connectors_page" ? "connect" : "skill";
  const nextUrl =
    typeof data.oauth_url === "string"
      ? data.oauth_url
      : typeof data.setup_url === "string"
        ? data.setup_url
        : "";
  if (
    event.type !== "connector_auth_required" ||
    (event.connector !== "google_workspace" && event.connector !== "feishu") ||
    !nextUrl
  ) {
    return null;
  }

  return {
    connector: event.connector === "google_workspace" ? "google_workspace" : "feishu",
    tag: event.connector === "feishu" && data.setup_url === nextUrl ? "setup" : "auth",
    url: nextUrl,
    popup: null,
    mode,
  };
}

export function shouldStartConnectorAuthPoll(payload: FeishuAuthOpenPayload): boolean {
  return payload.mode !== "connect";
}

export function connectorAuthRequiresSessionAttention(event: ConnectorAuthChatEvent): boolean {
  const payload = connectorAuthPollPayloadFromEvent(event);
  return Boolean(payload && shouldStartConnectorAuthPoll(payload));
}

export function shouldContinueConnectorAuthPoll(
  lastEvent: ConnectorAuthChatEvent | null,
  targetConnector: FeishuAuthOpenPayload["connector"],
  elapsedMs: number,
  timeoutMs: number = CONNECTOR_AUTH_POLL_TIMEOUT_MS
): boolean {
  return (
    elapsedMs < timeoutMs &&
    lastEvent !== null &&
    lastEvent.connector === targetConnector &&
    lastEvent.type === "connector_auth_required" &&
    lastEvent.stage !== "auth_failed" &&
    lastEvent.stage !== "invalid_request"
  );
}

export function shouldAutoOpenConnectorAuthWindow(
  connector: FeishuAuthOpenPayload["connector"]
): boolean {
  return connector !== "feishu" && connector !== "google_workspace";
}
