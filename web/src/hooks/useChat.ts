import { useState, useCallback, useMemo } from 'react';
import type { Message, TokenStats } from '../types/events';

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [tokenStats, setTokenStats] = useState<TokenStats>({
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });

  const addMessage = useCallback((message: Message) => {
    setMessages(prev => [...prev, message]);
  }, []);

  const addUserMessage = useCallback((content: string) => {
    addMessage({
      id: crypto.randomUUID(),
      type: 'user',
      content,
      timestamp: Date.now(),
    });
  }, [addMessage]);

  const handleThinkingStart = useCallback(() => {
    setIsThinking(true);
  }, []);

  const handleText = useCallback((event: any) => {
    setIsThinking(false);
    addMessage({
      id: crypto.randomUUID(),
      type: 'text',
      content: event.content,
      timestamp: event.timestamp,
    });
  }, [addMessage]);

  const handleToolCall = useCallback((event: any) => {
    addMessage({
      id: event.tool_id,
      type: 'tool_call',
      toolName: event.tool_name,
      toolInput: event.tool_input,
      toolId: event.tool_id,
      timestamp: event.timestamp,
    });
  }, [addMessage]);

  const handleToolResult = useCallback((event: any) => {
    addMessage({
      id: crypto.randomUUID(),
      type: 'tool_result',
      toolId: event.tool_id,
      content: event.content,
      isError: event.is_error,
      subagentData: event.subagent_data,
      timestamp: event.timestamp,
    });
  }, [addMessage]);

  const handleTokenUsage = useCallback((event: any) => {
    setTokenStats(prev => ({
      inputTokens: prev.inputTokens + event.input_tokens,
      outputTokens: prev.outputTokens + event.output_tokens,
      totalTokens: prev.totalTokens + event.input_tokens + event.output_tokens,
    }));
  }, []);

  const handleCompleted = useCallback(() => {
    setIsThinking(false);
  }, []);

  const handleError = useCallback((event: any) => {
    setIsThinking(false);
    addMessage({
      id: crypto.randomUUID(),
      type: 'error',
      content: event.error || '发生未知错误',
      timestamp: event.timestamp || Date.now(),
    });
  }, [addMessage]);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setTokenStats({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  }, []);

  const handlers = useMemo(() => ({
    handleThinkingStart,
    handleText,
    handleToolCall,
    handleToolResult,
    handleTokenUsage,
    handleCompleted,
    handleError,
    addUserMessage,
    clearMessages,
  }), [
    handleThinkingStart, handleText, handleToolCall, handleToolResult,
    handleTokenUsage, handleCompleted, handleError, addUserMessage, clearMessages,
  ]);

  return {
    messages,
    isThinking,
    tokenStats,
    ...handlers,
  };
}
