export interface ModelOption {
  id: string;
  owned_by: string;
  display_name?: string;
  description?: string;
  supported_reasoning_efforts?: string[];
  default_reasoning_effort?: string;
}

export const MODEL_DISPLAY_MAPPING: Record<string, string> = {
  "codex-low": "Lite",
  "codex-medium": "Plus",
  "codex-high": "Pro",
  "codex-xhigh": "Ultra",
};

export function formatModelName(model: string | Pick<ModelOption, "id" | "display_name">): string {
  if (typeof model !== "string")
    return model.display_name || MODEL_DISPLAY_MAPPING[model.id] || model.id;
  return MODEL_DISPLAY_MAPPING[model] ?? model;
}

const CODEX_MODEL_ORDER = ["codex-low", "codex-medium", "codex-high", "codex-xhigh"];
const MODEL_ORDER_RANK = new Map(CODEX_MODEL_ORDER.map((id, index) => [id, index]));

export function sortModelOptions<T extends { id: string }>(models: T[]): T[] {
  return models
    .map((model, index) => ({ model, index }))
    .sort((a, b) => {
      const aRank = MODEL_ORDER_RANK.get(a.model.id);
      const bRank = MODEL_ORDER_RANK.get(b.model.id);

      if (aRank !== undefined && bRank !== undefined) {
        return aRank - bRank || a.index - b.index;
      }
      if (aRank !== undefined) return -1;
      if (bRank !== undefined) return 1;
      return a.index - b.index;
    })
    .map(({ model }) => model);
}
