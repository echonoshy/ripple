import { useEffect, useCallback } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useChat } from './hooks/useChat';
import { ChatContainer } from './components/ChatContainer';
import { MessageList } from './components/MessageList';
import { InputBox } from './components/InputBox';
import { TokenStats } from './components/TokenStats';
import { ThinkingIndicator } from './components/ThinkingIndicator';

export function App() {
  const ws = useWebSocket('ws://localhost:8000/ws');
  const chat = useChat();

  const {
    handleThinkingStart, handleText, handleToolCall, handleToolResult,
    handleTokenUsage, handleCompleted, handleError,
  } = chat;
  const { on } = ws;

  useEffect(() => {
    on('thinking_start', handleThinkingStart);
    on('text', handleText);
    on('tool_call', handleToolCall);
    on('tool_result', handleToolResult);
    on('token_usage', handleTokenUsage);
    on('completed', handleCompleted);
    on('error', handleError);
  }, [on, handleThinkingStart, handleText, handleToolCall, handleToolResult, handleTokenUsage, handleCompleted, handleError]);

  const handleSend = useCallback((content: string) => {
    chat.addUserMessage(content);
    ws.sendMessage(content);
  }, [chat.addUserMessage, ws.sendMessage]);

  const handleClearHistory = () => {
    if (confirm('确定要清空对话历史吗？')) {
      ws.clearHistory();
      chat.clearMessages();
    }
  };

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      <header className="bg-cyan-600 text-white p-4 shadow-lg">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">Ripple Agent</h1>
            {ws.sessionId && (
              <span className="text-xs text-white/60 font-mono">
                {ws.sessionId.slice(0, 8)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-4">
            <TokenStats stats={chat.tokenStats} />
            <button
              onClick={handleClearHistory}
              disabled={!ws.isConnected || chat.messages.length === 0}
              className="px-3 py-1 text-sm bg-white/20 hover:bg-white/30 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              清空历史
            </button>
            <div
              className={`w-3 h-3 rounded-full ${ws.isConnected ? 'bg-green-400' : 'bg-red-400'}`}
              title={ws.isConnected ? '已连接' : '未连接'}
            />
          </div>
        </div>
      </header>

      <ChatContainer>
        <MessageList messages={chat.messages} />
        {chat.isThinking && <ThinkingIndicator />}
      </ChatContainer>

      <InputBox onSend={handleSend} disabled={!ws.isConnected || chat.isThinking} />
    </div>
  );
}
