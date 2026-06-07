import { getClientStorageItem, setClientStorageItem } from "@/lib/platform";
import type { ModelOption } from "./models";

const DEFAULT_MODEL_ID = "codex-medium";

function storageKey(userId: string): string {
  return `ripple.defaultModel.${encodeURIComponent(userId || "default")}`;
}

export function getStoredDefaultModel(userId: string): string | null {
  return getClientStorageItem(storageKey(userId));
}

export function setStoredDefaultModel(userId: string, model: string): void {
  setClientStorageItem(storageKey(userId), model);
}

export function selectPreferredModel(models: ModelOption[], storedModel: string | null): string {
  if (storedModel && models.some((model) => model.id === storedModel)) return storedModel;
  return (
    models.find((model) => model.id === DEFAULT_MODEL_ID)?.id || models[0]?.id || DEFAULT_MODEL_ID
  );
}
