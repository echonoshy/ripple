export interface ModelOption {
  id: string;
  owned_by: string;
  display_name?: string;
  provider?: string;
  source?: "codex_runtime" | "preset" | string;
  model?: string;
  default_think_level?: string | null;
  supported_think_levels?: string[];
  hidden?: boolean;
}

export const MODEL_DISPLAY_MAPPING: Record<string, string> = {
  "codex-low": "Lite",
  "codex-medium": "Plus",
  "codex-high": "Pro",
  "codex-xhigh": "Ultra",
};

export function formatModelName(id: string): string {
  return MODEL_DISPLAY_MAPPING[id] ?? formatRuntimeModelName(id);
}

function formatRuntimeModelName(id: string): string {
  if (!id.toLowerCase().startsWith("gpt-")) return id;
  return id
    .split("-")
    .map((part) => {
      if (part.toLowerCase() === "gpt") return "GPT";
      if (/^[a-z]/i.test(part)) return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
      return part;
    })
    .join("-");
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
