import { ReactNode } from 'react';

interface ChatContainerProps {
  children: ReactNode;
}

export function ChatContainer({ children }: ChatContainerProps) {
  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-gray-50">
      {children}
    </div>
  );
}
