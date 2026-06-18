import { AuthError, uploadWorkspaceAttachment } from "@/lib/api";
import { readableApiErrorMessage } from "@/lib/apiErrors";
import type { ChatFileRef } from "@/lib/chatInput";
import type { PendingLocalImage } from "@/lib/pendingImages";

const MAX_ATTACHMENT_UPLOAD_ERRORS_SHOWN = 3;

export function attachmentUploadErrorMessage(error: unknown): string {
  const message = readableApiErrorMessage(error);
  if (/length limit/i.test(message)) {
    return "File exceeds the server upload limit.";
  }
  if (/\((413|400)\)/.test(message) && /upload|attachment/i.test(message)) {
    return `${message}. The file may exceed the server upload limit.`;
  }
  return message;
}

export function summarizeAttachmentUploadErrors(errors: string[]): string {
  const shown = errors.slice(0, MAX_ATTACHMENT_UPLOAD_ERRORS_SHOWN);
  const suffix =
    errors.length > shown.length ? `; ${errors.length - shown.length} more failed` : "";
  return `${shown.join("; ")}${suffix}`;
}

type AttachmentUploadResult = Awaited<ReturnType<typeof uploadWorkspaceAttachment>>;

export async function uploadPendingLocalImagesForSend(
  images: PendingLocalImage[],
  uploadAttachment: (file: File) => Promise<AttachmentUploadResult>
): Promise<{ files: ChatFileRef[]; failures: string[] }> {
  const files: ChatFileRef[] = [];
  const failures: string[] = [];

  for (const image of images) {
    try {
      const uploaded = await uploadAttachment(image.file);
      files.push({
        path: uploaded.path,
        name: uploaded.name,
        mime_type: uploaded.mime_type,
        kind: uploaded.kind,
      });
    } catch (err) {
      if (err instanceof AuthError) {
        throw err;
      }
      failures.push(`${image.name}: ${attachmentUploadErrorMessage(err)}`);
    }
  }

  return { files, failures };
}
