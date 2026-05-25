export interface ModelOption {
  id: string;
  owned_by: string;
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
