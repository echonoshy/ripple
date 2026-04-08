import type { TokenStats } from '../types/events';

interface TokenStatsProps {
  stats: TokenStats;
}

export function TokenStats({ stats }: TokenStatsProps) {
  const maxTokens = 200000;
  const percentage = (stats.totalTokens / maxTokens) * 100;

  return (
    <div className="flex items-center gap-3 text-sm">
      <div className="text-white/80">
        {stats.totalTokens.toLocaleString()} / {maxTokens.toLocaleString()} tokens
      </div>
      <div className="w-24 h-2 bg-white/20 rounded-full overflow-hidden">
        <div
          className="h-full bg-white transition-all duration-300"
          style={{ width: `${Math.min(percentage, 100)}%` }}
        />
      </div>
      <div className="text-white/60">{percentage.toFixed(1)}%</div>
    </div>
  );
}
