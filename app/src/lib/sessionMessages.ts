import type { ChangedFile, Message, MessageArtifact, SessionDetail } from "@/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getInternalMessageContent(message: Record<string, unknown>): Record<string, unknown>[] {
  if (!isRecord(message.message)) return [];
  const content = message.message.content;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

export function extractSessionMessageText(content: unknown): string {
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((c: { type: string }) => c.type === "text")
          .map((c: { text?: string }) => c.text || "")
          .join("\n");
      }
    } catch {
      /* not JSON, use as-is */
    }
    return content;
  }
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    const fileParts: string[] = [];
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item.type === "text" && typeof item.text === "string") {
        textParts.push(item.text);
        continue;
      }
      if (
        (item.type === "file" || item.type === "attachment" || item.type === "localImage") &&
        isRecord(item.file)
      ) {
        const name = typeof item.file.name === "string" ? item.file.name : "file";
        const path = typeof item.file.path === "string" ? item.file.path : "";
        fileParts.push(path ? `- ${name} (${path})` : `- ${name}`);
        continue;
      }
      if (item.type === "attachment" || item.type === "localImage") {
        const name = typeof item.name === "string" ? item.name : "file";
        const path = typeof item.path === "string" ? item.path : "";
        fileParts.push(path ? `- ${name} (${path})` : `- ${name}`);
      }
    }
    return [
      textParts.join("\n"),
      fileParts.length ? `Attached files:\n${fileParts.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  return content ? JSON.stringify(content) : "";
}

function imageArtifactFromBlock(block: Record<string, unknown>): MessageArtifact | null {
  if (block.type !== "image" && block.type !== "image_generation") return null;
  const workspacePath =
    typeof block.workspace_path === "string"
      ? block.workspace_path
      : typeof block.workspacePath === "string"
        ? block.workspacePath
        : "";
  if (!workspacePath) return null;

  const artifact: MessageArtifact = {
    type: "image",
    workspacePath,
  };
  if (typeof block.mime_type === "string") artifact.mimeType = block.mime_type;
  if (typeof block.mimeType === "string") artifact.mimeType = block.mimeType;
  if (typeof block.size === "number") artifact.size = block.size;
  if (typeof block.revised_prompt === "string") artifact.revisedPrompt = block.revised_prompt;
  if (typeof block.revisedPrompt === "string") artifact.revisedPrompt = block.revisedPrompt;
  return artifact;
}

function extractSessionMessageArtifacts(content: unknown): MessageArtifact[] {
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord).flatMap((block) => {
    const artifact = imageArtifactFromBlock(block);
    return artifact ? [artifact] : [];
  });
}

function changedFileFromBlockFile(file: unknown): ChangedFile | null {
  if (!isRecord(file) || typeof file.path !== "string" || !file.path.trim()) return null;
  const changedFile: ChangedFile = { path: file.path.trim() };
  if (typeof file.status === "string" && file.status.trim()) {
    changedFile.status = file.status.trim();
  }
  if (typeof file.additions === "number" && Number.isFinite(file.additions) && file.additions >= 0) {
    changedFile.additions = Math.trunc(file.additions);
  }
  if (typeof file.deletions === "number" && Number.isFinite(file.deletions) && file.deletions >= 0) {
    changedFile.deletions = Math.trunc(file.deletions);
  }
  if (typeof file.previous_path === "string" && file.previous_path.trim()) {
    changedFile.previousPath = file.previous_path.trim();
  } else if (typeof file.previousPath === "string" && file.previousPath.trim()) {
    changedFile.previousPath = file.previousPath.trim();
  }
  if (typeof file.patch === "string" && file.patch.trim()) {
    changedFile.patch = file.patch;
  }
  return changedFile;
}

function extractSessionMessageChangedFiles(content: unknown): ChangedFile[] {
  if (!Array.isArray(content)) return [];
  const changedFiles: ChangedFile[] = [];
  const seen = new Set<string>();
  for (const block of content.filter(isRecord)) {
    if (block.type !== "changed_files" || !Array.isArray(block.files)) continue;
    for (const item of block.files) {
      const file = changedFileFromBlockFile(item);
      if (!file || seen.has(file.path)) continue;
      seen.add(file.path);
      changedFiles.push(file);
    }
  }
  return changedFiles;
}

export function mapSessionMessages(
  details: SessionDetail | { messages: Record<string, unknown>[] }
): Message[] {
  const result: Message[] = [];
  let id = Date.now();
  const raw = details.messages;
  const pendingQuestion = "pendingQuestion" in details ? details.pendingQuestion : null;
  const pendingOptions = "pendingOptions" in details ? details.pendingOptions : null;
  const pendingPermissionRequest =
    "pendingPermissionRequest" in details ? details.pendingPermissionRequest : null;

  for (const msg of raw) {
    const internalType = typeof msg.type === "string" ? msg.type : null;
    const role = typeof msg.role === "string" ? msg.role : null;

    if (internalType === "user") {
      const createdAt = typeof msg.created_at === "string" ? msg.created_at : undefined;
      const content = getInternalMessageContent(msg);
      const textContent = extractSessionMessageText(content);
      if (textContent) {
        result.push({ id: id++, role: "user", content: textContent, created_at: createdAt });
      }

      for (const block of content) {
        if (!isRecord(block) || block.type !== "tool_result") continue;

        for (let i = result.length - 1; i >= 0; i--) {
          const message = result[i];
          if (message.role !== "assistant" || !message.toolCalls) continue;

          const toolCall = message.toolCalls.find((tool) => tool.id === block.tool_use_id);
          if (toolCall) {
            toolCall.result =
              typeof block.content === "string" ? block.content : JSON.stringify(block.content);
            toolCall.status = block.is_error ? "error" : "success";
            break;
          }
        }
      }
      continue;
    }

    if (internalType === "assistant") {
      const createdAt = typeof msg.created_at === "string" ? msg.created_at : undefined;
      const content = getInternalMessageContent(msg);
      const toolCalls = content
        .filter(
          (block): block is Record<string, unknown> => isRecord(block) && block.type === "tool_use"
        )
        .map((block) => ({
          id: typeof block.id === "string" ? block.id : `tool-${id}`,
          name: typeof block.name === "string" ? block.name : "unknown",
          arguments: isRecord(block.input) ? block.input : {},
          status: "success" as const,
          result: "",
        }));
      const assistantMessage: Message = {
        id: id++,
        role: "assistant",
        content: extractSessionMessageText(content),
        created_at: createdAt,
        toolCalls,
      };
      const artifacts = extractSessionMessageArtifacts(content);
      if (artifacts.length > 0) assistantMessage.artifacts = artifacts;
      const changedFiles = extractSessionMessageChangedFiles(content);
      if (changedFiles.length > 0) assistantMessage.changedFiles = changedFiles;

      const askUserTool = content.find(
        (block) => isRecord(block) && block.type === "tool_use" && block.name === "AskUser"
      );
      if (
        isRecord(askUserTool) &&
        isRecord(askUserTool.input) &&
        typeof askUserTool.input.question === "string"
      ) {
        assistantMessage.askUser = {
          question: askUserTool.input.question,
          options: Array.isArray(askUserTool.input.options)
            ? askUserTool.input.options.filter(
                (option): option is string => typeof option === "string"
              )
            : [],
        };
      }

      result.push(assistantMessage);
      continue;
    }

    if (role === "user") {
      const createdAt = typeof msg.created_at === "string" ? msg.created_at : undefined;
      result.push({
        id: id++,
        role: "user",
        content: extractSessionMessageText(msg.content),
        created_at: createdAt,
      });
    } else if (role === "assistant") {
      const createdAt = typeof msg.created_at === "string" ? msg.created_at : undefined;
      const toolCalls =
        (
          msg.tool_calls as
            | Array<{
                id: string;
                function?: { name: string; arguments: string | Record<string, unknown> };
              }>
            | undefined
        )?.map((tc) => ({
          id: tc.id,
          name: tc.function?.name || "unknown",
          arguments: tc.function?.arguments || {},
          status: "success" as const,
          result: "",
        })) || [];
      const assistantMessage: Message = {
        id: id++,
        role: "assistant",
        content: extractSessionMessageText(msg.content),
        created_at: createdAt,
        toolCalls,
      };
      const artifacts = extractSessionMessageArtifacts(msg.content);
      if (artifacts.length > 0) assistantMessage.artifacts = artifacts;
      const changedFiles = extractSessionMessageChangedFiles(msg.content);
      if (changedFiles.length > 0) assistantMessage.changedFiles = changedFiles;
      result.push(assistantMessage);
    } else if (role === "tool") {
      for (let i = result.length - 1; i >= 0; i--) {
        const message = result[i];
        if (message.role === "assistant" && message.toolCalls) {
          const toolCall = message.toolCalls.find((tool) => tool.id === msg.tool_call_id);
          if (toolCall) {
            toolCall.result =
              typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
            break;
          }
        }
      }
    }
  }

  if (pendingQuestion) {
    const lastAssistant = [...result].reverse().find((message) => message.role === "assistant");
    if (lastAssistant) {
      lastAssistant.askUser = {
        question: pendingQuestion,
        options: Array.isArray(pendingOptions) ? pendingOptions : [],
      };
    }
  }

  if (pendingPermissionRequest) {
    const lastAssistant = [...result].reverse().find((message) => message.role === "assistant");
    if (lastAssistant) {
      lastAssistant.permissionRequest = pendingPermissionRequest;
    }
  }

  return result;
}
