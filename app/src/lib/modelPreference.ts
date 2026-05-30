import type { ModelOption } from "./models";

const DEFAULT_MODEL_ID = "codex-medium";

function storageKey(userId: string): string {
  return `ripple.defaultModel.${encodeURIComponent(userId || "default")}`;
}

function localStorageOrNull(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getStoredDefaultModel(userId: string): string | null {
  return localStorageOrNull()?.getItem(storageKey(userId)) || null;
}

export function setStoredDefaultModel(userId: string, model: string): void {
  localStorageOrNull()?.setItem(storageKey(userId), model);
}

export function selectPreferredModel(models: ModelOption[], storedModel: string | null): string {
  if (storedModel && models.some((model) => model.id === storedModel)) return storedModel;
  return (
    models.find((model) => model.id === DEFAULT_MODEL_ID)?.id || models[0]?.id || DEFAULT_MODEL_ID
  );
}
