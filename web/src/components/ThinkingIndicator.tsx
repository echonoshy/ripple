export function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 px-4 py-3 text-gray-600">
      <div className="flex gap-1">
        <div className="w-2 h-2 bg-cyan-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
        <div className="w-2 h-2 bg-cyan-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
        <div className="w-2 h-2 bg-cyan-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
      </div>
      <span>正在思考...</span>
    </div>
  );
}
