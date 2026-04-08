import { useEffect, useRef, useState, useCallback } from 'react';
import type { WebSocketEvent } from '../types/events';

export function useWebSocket(url: string) {
  const [isConnected, setIsConnected] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const eventHandlersRef = useRef<Map<string, (event: WebSocketEvent) => void>>(new Map());

  useEffect(() => {
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      console.log('WebSocket connected');
    };

    ws.onmessage = (event) => {
      try {
        const data: WebSocketEvent = JSON.parse(event.data);

        // 处理连接事件
        if (data.type === 'connected') {
          setSessionId(data.session_id);
        }

        // 调用注册的事件处理器
        const handler = eventHandlersRef.current.get(data.type);
        if (handler) {
          handler(data);
        }
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      console.log('WebSocket disconnected');
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    return () => {
      ws.close();
    };
  }, [url]);

  const sendMessage = useCallback((content: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'user_message',
        content,
        timestamp: Date.now(),
      }));
    }
  }, []);

  const clearHistory = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'clear_history',
        timestamp: Date.now(),
      }));
    }
  }, []);

  const on = useCallback((eventType: string, handler: (event: WebSocketEvent) => void) => {
    eventHandlersRef.current.set(eventType, handler);
  }, []);

  return {
    isConnected,
    sessionId,
    sendMessage,
    clearHistory,
    on,
  };
}
