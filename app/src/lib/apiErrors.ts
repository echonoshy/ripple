export const RIPPLE_API_CONNECTION_ERROR =
  "无法连接到 Ripple 服务。请确认后端服务正在运行，或检查 /v1 代理配置。";

const FETCH_NETWORK_ERROR_MESSAGES = new Set([
  "Failed to fetch",
  "Load failed",
  "NetworkError when attempting to fetch resource.",
]);

export function readableApiErrorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message.trim() : typeof error === "string" ? error.trim() : "";

  if (!message || FETCH_NETWORK_ERROR_MESSAGES.has(message)) {
    return RIPPLE_API_CONNECTION_ERROR;
  }

  return message;
}
