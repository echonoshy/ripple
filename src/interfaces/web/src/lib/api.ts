import { fetchEventSource } from '@microsoft/fetch-event-source';
import { ToolCall, UsageInfo, SystemInfo } from '@/types';

function getApiUrl(): string {
  if (process.env.NEXT_PUBLIC_RIPPLE_API_URL) {
    return process.env.NEXT_PUBLIC_RIPPLE_API_URL;
  }
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:8810/v1`;
  }
  return 'http://localhost:8810/v1';
}

const API_URL = getApiUrl();
const API_KEY_STORAGE_KEY = 'ripple-api-key';

export class AuthError extends Error {
  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'AuthError';
  }
}

export function getApiKey(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(API_KEY_STORAGE_KEY);
}

export function setApiKey(key: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(API_KEY_STORAGE_KEY, key);
}

export function clearApiKey(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(API_KEY_STORAGE_KEY);
}

function authHeaders(): Record<string, string> {
  const key = getApiKey();
  if (!key) return {};
  return { Authorization: `Bearer ${key}` };
}

export async function fetchModels(): Promise<{ id: string; owned_by: string }[]> {
  try {
    const res = await fetch(`${API_URL}/models`, {
      headers: { ...authHeaders() },
    });
    if (res.status === 401) throw new AuthError();
    if (!res.ok) throw new Error('Failed to fetch models');
    const data = await res.json();
    return data.data || [];
  } catch (error) {
    if (error instanceof AuthError) throw error;
    console.error("Error fetching models:", error);
    return [];
  }
}

export async function fetchSystemInfo(): Promise<SystemInfo | null> {
  try {
    const res = await fetch(`${API_URL}/info`, {
      headers: { ...authHeaders() },
    });
    if (res.status === 401) throw new AuthError();
    if (!res.ok) throw new Error('Failed to fetch system info');
    return await res.json();
  } catch (error) {
    if (error instanceof AuthError) throw error;
    console.error("Error fetching system info:", error);
    return null;
  }
}

export async function createSession(): Promise<string> {
  try {
    const res = await fetch(`${API_URL}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({}),
    });
    if (res.status === 401) throw new AuthError();
    if (!res.ok) throw new Error('Failed to create session');
    const data = await res.json();
    return data.session_id;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    console.error("Error creating session:", error);
    return `sess_${Date.now()}`;
  }
}

export async function sendChatMessage(
  sessionId: string,
  content: string,
  model: string,
  thinking: boolean,
  callbacks: {
    onMessageDelta: (delta: string) => void;
    onToolCall: (toolCall: ToolCall) => void;
    onToolResult: (toolId: string, result: string) => void;
    onUsage: (usage: UsageInfo) => void;
    onComplete: () => void;
    onError: (error: Error) => void;
  }
) {
  try {
    await fetchEventSource(`${API_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': sessionId,
        ...authHeaders(),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        stream: true,
        session_id: sessionId,
        thinking,
      }),
      async onopen(response) {
        if (response.status === 401) {
          throw new AuthError();
        }
        if (!response.ok) {
          throw new Error(`Server responded with ${response.status}`);
        }
      },
      onmessage(msg) {
        if (msg.data === '[DONE]') {
          callbacks.onComplete();
          return;
        }

        try {
          const data = JSON.parse(msg.data);

          if (data.type === 'tool_call') {
            callbacks.onToolCall({
              id: data.id,
              name: data.name,
              arguments: data.input || {},
              status: 'running',
            });
            return;
          }

          if (data.type === 'tool_result') {
            const resultContent = typeof data.content === 'string'
              ? data.content
              : JSON.stringify(data.content);
            callbacks.onToolResult(data.tool_use_id, resultContent);
            return;
          }

          if (data.usage) {
            callbacks.onUsage(data.usage);
          }

          if (data.choices?.[0]?.delta) {
            const delta = data.choices[0].delta;
            if (delta.content) {
              callbacks.onMessageDelta(delta.content);
            }
          }
        } catch (e) {
          console.warn("Failed to parse SSE message:", msg.data, e);
        }
      },
      onerror(err) {
        callbacks.onError(err);
        throw err;
      },
      onclose() {
        callbacks.onComplete();
      }
    });
  } catch (error) {
    callbacks.onError(error as Error);
  }
}
