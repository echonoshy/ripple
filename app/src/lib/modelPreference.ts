import { getClientStorageItem, setClientStorageItem } from "@/lib/platform";
import type { ModelOption } from "./models";

const DEFAULT_MODEL_ID = "codex-medium";
export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

function storageKey(userId: string): string {
  return `ripple.defaultModel.${encodeURIComponent(userId || "default")}`;
}

function reasoningStorageKey(userId: string): string {
  return `ripple.reasoningEffort.${encodeURIComponent(userId || "default")}`;
}

export function getStoredDefaultModel(userId: string): string | null {
  return getClientStorageItem(storageKey(userId));
}

export function setStoredDefaultModel(userId: string, model: string): void {
  setClientStorageItem(storageKey(userId), model);
}

export function getStoredReasoningEffort(userId: string): ReasoningEffort {
  const stored = getClientStorageItem(reasoningStorageKey(userId));
  return REASONING_EFFORTS.includes(stored as ReasoningEffort)
    ? (stored as ReasoningEffort)
    : DEFAULT_REASONING_EFFORT;
}

export function setStoredReasoningEffort(userId: string, effort: ReasoningEffort): void {
  setClientStorageItem(reasoningStorageKey(userId), effort);
}

export function selectPreferredModel(models: ModelOption[], storedModel: string | null): string {
  if (storedModel && models.some((model) => model.id === storedModel)) return storedModel;
  return (
    models.find((model) => model.id === DEFAULT_MODEL_ID)?.id || models[0]?.id || DEFAULT_MODEL_ID
  );
}
