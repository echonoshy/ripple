export interface MobileSettings {
  serverUrl: string;
  apiKey: string;
  userId: string;
  model: string;
  thinkingEnabled: boolean;
}

export interface SettingsStorageAdapter {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  deleteItem: (key: string) => Promise<void>;
}

export const DEFAULT_SETTINGS: MobileSettings = {
  serverUrl: "",
  apiKey: "",
  userId: "default",
  model: "codex-medium",
  thinkingEnabled: false,
};

const SETTINGS_KEY = "ripple-mobile-settings";
const USER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function isValidUserId(uid: string): boolean {
  return USER_ID_PATTERN.test(uid);
}

export function normalizeSettings(input: Partial<MobileSettings>): MobileSettings {
  const userId = (input.userId ?? DEFAULT_SETTINGS.userId).trim();
  return {
    serverUrl: (input.serverUrl ?? DEFAULT_SETTINGS.serverUrl).trim().replace(/\/+$/, ""),
    apiKey: (input.apiKey ?? DEFAULT_SETTINGS.apiKey).trim(),
    userId: isValidUserId(userId) ? userId : DEFAULT_SETTINGS.userId,
    model: (input.model ?? DEFAULT_SETTINGS.model).trim() || DEFAULT_SETTINGS.model,
    thinkingEnabled: Boolean(input.thinkingEnabled),
  };
}

export function createSettingsStore(adapter: SettingsStorageAdapter) {
  return {
    load: async (): Promise<MobileSettings> => {
      const raw = await adapter.getItem(SETTINGS_KEY);
      if (!raw) return DEFAULT_SETTINGS;
      try {
        return normalizeSettings(JSON.parse(raw) as Partial<MobileSettings>);
      } catch {
        return DEFAULT_SETTINGS;
      }
    },

    save: async (settings: Partial<MobileSettings>): Promise<MobileSettings> => {
      const normalized = normalizeSettings(settings);
      await adapter.setItem(SETTINGS_KEY, JSON.stringify(normalized));
      return normalized;
    },

    clear: async (): Promise<void> => {
      await adapter.deleteItem(SETTINGS_KEY);
    },
  };
}

interface SecureStoreModule {
  getItemAsync: (key: string) => Promise<string | null>;
  setItemAsync: (key: string, value: string) => Promise<void>;
  deleteItemAsync: (key: string) => Promise<void>;
}

export function createSecureSettingsStore() {
  // Keep native SecureStore out of Node tests; Expo resolves it at app runtime.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const SecureStore = require("expo-secure-store") as SecureStoreModule;
  return createSettingsStore({
    getItem: (key) => SecureStore.getItemAsync(key),
    setItem: (key, value) => SecureStore.setItemAsync(key, value),
    deleteItem: (key) => SecureStore.deleteItemAsync(key),
  });
}
