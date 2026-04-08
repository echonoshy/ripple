import type { Message } from '../types/events';
import { TextMessage } from './TextMessage';
import { ToolCallMessage } from './ToolCallMessage';
import { ToolResultMessage } from './ToolResultMessage';

interface MessageItemProps {
  message: Message;
}

export function MessageItem({ message }: MessageItemProps) {
  switch (message.type) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div className="max-w-[80%] bg-cyan-600 text-white rounded-2xl rounded-br-sm px-4 py-2.5 shadow-sm">
            <p className="whitespace-pre-wrap">{message.content}</p>
          </div>
        </div>
      );

    case 'text':
      return <TextMessage content={message.content || ''} />;

    case 'tool_call':
      return (
        <ToolCallMessage
          toolName={message.toolName || ''}
          toolInput={message.toolInput || {}}
        />
      );

    case 'tool_result':
      return (
        <ToolResultMessage
          content={message.content || ''}
          isError={message.isError || false}
          subagentData={message.subagentData}
        />
      );

    case 'error':
      return (
        <div className="flex justify-start">
          <div className="max-w-[80%] bg-red-50 border border-red-200 text-red-700 rounded-2xl rounded-bl-sm px-4 py-2.5 shadow-sm">
            <p className="text-sm font-medium mb-1">出错了</p>
            <p className="text-sm whitespace-pre-wrap">{message.content}</p>
          </div>
        </div>
      );

    default:
      return null;
  }
}
