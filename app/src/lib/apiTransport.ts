import {
  getClientStorageItem,
  removeClientStorageItem,
  setClientStorageItem,
} from "@/lib/platform";

// TEMP_HTTP_IP_API: use direct HTTP IP until test-oauth.weilai.ai is unblocked.
const DEFAULT_PUBLIC_API_URL = "http://140.143.229.103:8810/v1";

const API_KEY_STORAGE_KEY = "ripple-api-key";
const USER_ID_STORAGE_KEY = "ripple-user-id";
const AUTH_MODE_STORAGE_KEY = "ripple-auth-mode";
const DEFAULT_USER_ID = "default";
const USER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export type ApiUrlEnv = {
  DEV?: boolean;
  PROD?: boolean;
  VITE_RIPPLE_API_URL?: string;
};

export type AuthMode = "service" | "user";

function normalizeApiUrl(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export function resolveApiUrl(env: ApiUrlEnv): string {
  if (env.VITE_RIPPLE_API_URL) {
    return normalizeApiUrl(env.VITE_RIPPLE_API_URL);
  }
  if (env.DEV) {
    return "/v1";
  }
  return DEFAULT_PUBLIC_API_URL;
}

function getApiUrl(): string {
  return resolveApiUrl(import.meta.env);
}

export const API_URL = getApiUrl();

export function getConfiguredApiUrl(): string {
  return API_URL;
}

export function getApiOrigin(): string {
  return API_URL.replace(/\/v1\/?$/, "");
}

export function resolveBackendUrl(href: string | undefined): string | undefined {
  if (!href) return href;
  if (href.startsWith("/v1/")) {
    return `${getApiOrigin()}${href}`;
  }
  return href;
}

export function apiOriginForValidation(): string | null {
  const apiOrigin = getApiOrigin();
  if (apiOrigin) {
    try {
      return new URL(apiOrigin).origin;
    } catch {
      return null;
    }
  }
  if (typeof window === "undefined") return null;
  return window.location.origin;
}

export function resolveRippleApiUrl(href: string, resourceName: string): string {
  const resolved = resolveBackendUrl(href)?.trim();
  const expectedOrigin = apiOriginForValidation();
  if (!resolved || !expectedOrigin) {
    throw new Error(`${resourceName} must be a Ripple API URL.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(resolved, expectedOrigin);
  } catch {
    throw new Error(`${resourceName} must be a Ripple API URL.`);
  }

  if (parsed.origin !== expectedOrigin || !parsed.pathname.startsWith("/v1/")) {
    throw new Error(`${resourceName} must be a Ripple API URL.`);
  }

  return parsed.toString();
}

export class AuthError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "AuthError";
  }
}

export function getApiKey(): string | null {
  return getClientStorageItem(API_KEY_STORAGE_KEY);
}

export function getAuthMode(): AuthMode {
  const mode = getClientStorageItem(AUTH_MODE_STORAGE_KEY);
  if (mode === "user" || mode === "service") return mode;
  return "service";
}

export function setApiKey(key: string): void {
  setClientStorageItem(API_KEY_STORAGE_KEY, key);
  setClientStorageItem(AUTH_MODE_STORAGE_KEY, "service");
}

export function setUserSessionToken(token: string, userId: string): void {
  setClientStorageItem(API_KEY_STORAGE_KEY, token);
  setClientStorageItem(AUTH_MODE_STORAGE_KEY, "user");
  setUserId(userId);
}

export function clearApiKey(): void {
  removeClientStorageItem(API_KEY_STORAGE_KEY);
  removeClientStorageItem(AUTH_MODE_STORAGE_KEY);
}

export function isUserSessionAuth(): boolean {
  return getAuthMode() === "user" && Boolean(getApiKey());
}

export function isValidUserId(uid: string): boolean {
  return USER_ID_PATTERN.test(uid);
}

export function getUserId(): string {
  const stored = getClientStorageItem(USER_ID_STORAGE_KEY);
  if (stored && isValidUserId(stored)) return stored;
  return DEFAULT_USER_ID;
}

export function setUserId(uid: string): void {
  const trimmed = uid.trim();
  if (!isValidUserId(trimmed)) {
    throw new Error("Invalid user_id: must match ^[a-zA-Z0-9_-]{1,64}$");
  }
  setClientStorageItem(USER_ID_STORAGE_KEY, trimmed);
}

export function clearUserId(): void {
  removeClientStorageItem(USER_ID_STORAGE_KEY);
}

export function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (getAuthMode() !== "user") {
    headers["X-Ripple-User-Id"] = getUserId();
  }
  const key = getApiKey();
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function responseDetail(res: Response): Promise<string> {
  try {
    const body = (await res.clone().json()) as unknown;
    if (isRecord(body)) {
      const detail = body.detail;
      if (typeof detail === "string") return detail;
      if (isRecord(detail) && typeof detail.message === "string") return detail.message;
      if (detail !== undefined && detail !== null) return JSON.stringify(detail);
    }
  } catch {
    /* ignore parse error */
  }
  return "";
}
