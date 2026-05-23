export type ChatFileKind = "image" | "attachment";

export interface ChatFileRef {
  path: string;
  name: string;
  mime_type: string;
  kind: ChatFileKind;
}

export type ChatMessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | {
          type: "file";
          file: {
            path: string;
            name: string;
            mime_type: string;
          };
        }
    >;

export function buildChatMessageContent(text: string, files: ChatFileRef[]): ChatMessageContent {
  const trimmed = text.trim();
  if (files.length === 0) return trimmed;

  const content: Exclude<ChatMessageContent, string> = [];
  if (trimmed) {
    content.push({ type: "text", text: trimmed });
  }
  for (const file of files) {
    content.push({
      type: "file",
      file: {
        path: file.path,
        name: file.name,
        mime_type: file.mime_type,
      },
    });
  }
  return content;
}

export function describeChatFilesForDisplay(text: string, files: ChatFileRef[]): string {
  const trimmed = text.trim();
  if (files.length === 0) return trimmed;

  const fileLines = files.map((file) => `- ${file.name} (${file.path})`).join("\n");
  return [trimmed, `Attached files:\n${fileLines}`].filter(Boolean).join("\n\n");
}
