import { SubAgentLog } from './SubAgentLog';
import type { SubAgentData } from '../types/events';

interface ToolResultMessageProps {
  content: string;
  isError: boolean;
  subagentData?: SubAgentData;
}

export function ToolResultMessage({ content, isError, subagentData }: ToolResultMessageProps) {
  // 如果有 SubAgent 数据，显示 SubAgent 日志
  if (subagentData) {
    return <SubAgentLog data={subagentData} />;
  }

  // 普通工具结果
  const preview = content.length > 300 ? content.slice(0, 300) + '...' : content;

  return (
    <div className={`border rounded-lg p-4 ${isError ? 'bg-red-50 border-red-200' : 'bg-blue-50 border-blue-200'}`}>
      <div className="flex items-start gap-2">
        <span className="text-xl">{isError ? '❌' : '✓'}</span>
        <div className="flex-1">
          <div className={`font-semibold mb-1 ${isError ? 'text-red-800' : 'text-blue-800'}`}>
            {isError ? '工具执行错误' : '工具执行成功'}
          </div>
          {content && (
            <pre className="text-xs text-gray-700 bg-white/50 rounded p-2 overflow-x-auto whitespace-pre-wrap">
              {preview}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
