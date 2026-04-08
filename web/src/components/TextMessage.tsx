interface TextMessageProps {
  content: string;
}

export function TextMessage({ content }: TextMessageProps) {
  return (
    <div className="bg-green-50 border border-green-200 rounded-lg p-4">
      <div className="flex items-start gap-2">
        <span className="text-green-600 text-xl">🤖</span>
        <div className="flex-1 prose prose-sm max-w-none">
          <div className="whitespace-pre-wrap">{content}</div>
        </div>
      </div>
    </div>
  );
}
