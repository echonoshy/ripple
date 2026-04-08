import { useState } from 'react';
import type { SubAgentData } from '../types/events';

interface SubAgentLogProps {
  data: SubAgentData;
}

export function SubAgentLog({ data }: SubAgentLogProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="border border-purple-300 rounded-lg p-4 bg-purple-50">
      <div
        className="flex items-center justify-between cursor-pointer"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2">
          <span className="text-purple-600">📦</span>
          <span className="font-semibold text-purple-800">SubAgent 执行</span>
          <span className="text-sm text-gray-600">({data.turns_used} 轮)</span>
        </div>
        <button className="text-purple-600 hover:text-purple-800 transition-colors">
          {isExpanded ? '▼' : '▶'}
        </button>
      </div>

      {isExpanded && (
        <div className="mt-4 space-y-2">
          {data.execution_log.map((entry, index) => (
            <div key={index} className="pl-4 border-l-2 border-purple-200">
              {entry.type === 'tool_call' && (
                <div className="text-sm">
                  <span className="text-cyan-600 font-medium">🔧 {entry.tool_name}</span>
                  {entry.tool_input && (
                    <pre className="text-xs text-gray-600 mt-1 bg-white/50 rounded p-2 overflow-x-auto">
                      {JSON.stringify(entry.tool_input, null, 2).slice(0, 150)}
                      {JSON.stringify(entry.tool_input).length > 150 && '...'}
                    </pre>
                  )}
                </div>
              )}

              {entry.type === 'tool_result' && (
                <div className="text-sm">
                  {entry.is_error ? (
                    <span className="text-red-600">❌ 错误: {entry.content}</span>
                  ) : (
                    <span className="text-green-600">✓ 成功</span>
                  )}
                </div>
              )}

              {entry.type === 'assistant_text' && entry.content && (
                <div className="text-sm text-blue-600">
                  💬 {entry.content.slice(0, 100)}
                  {entry.content.length > 100 && '...'}
                </div>
              )}
            </div>
          ))}

          <div className="mt-4 pt-4 border-t border-purple-200">
            <div className="font-semibold text-green-600 mb-2">✓ 最终结果:</div>
            <div className="text-sm text-gray-700 bg-white/50 rounded p-3">
              {data.result.slice(0, 300)}
              {data.result.length > 300 && '...'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
