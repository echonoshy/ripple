interface ToolCallMessageProps {
  toolName: string;
  toolInput: Record<string, any>;
}

export function ToolCallMessage({ toolName, toolInput }: ToolCallMessageProps) {
  const inputStr = JSON.stringify(toolInput, null, 2);
  const preview = inputStr.length > 200 ? inputStr.slice(0, 200) + '...' : inputStr;

  return (
    <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
      <div className="flex items-start gap-2">
        <span className="text-yellow-600 text-xl">🔧</span>
        <div className="flex-1">
          <div className="font-semibold text-yellow-800 mb-1">调用工具: {toolName}</div>
          <pre className="text-xs text-gray-600 bg-white/50 rounded p-2 overflow-x-auto">
            {preview}
          </pre>
        </div>
      </div>
    </div>
  );
}
