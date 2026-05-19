const GENERIC_CHAT_ERROR = "无法连接到 Ripple 服务。请确认服务端正在运行。";

export function chatErrorContent(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message || GENERIC_CHAT_ERROR;
}
