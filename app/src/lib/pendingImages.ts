export type PendingImageSource = "paste" | "drop";

export interface PendingLocalImage {
  id: string;
  file: File;
  name: string;
  mimeType: string;
  previewUrl: string;
  size: number;
  source: PendingImageSource;
}

interface TransferItemLike {
  kind?: string;
  type?: string;
  getAsFile?: () => File | null;
}

interface TransferDataLike {
  items?: ArrayLike<TransferItemLike>;
  files?: ArrayLike<File>;
}

interface CreatePendingLocalImagesOptions {
  createId?: (file: File, index: number) => string;
  createObjectUrl?: (file: File) => string;
  now?: () => Date;
}

const IMAGE_FILENAME_RE = /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/i;

function isImageFile(file: File | null | undefined): file is File {
  if (!file) return false;
  const mimeType = file.type.trim().toLowerCase();
  const name = typeof file.name === "string" ? file.name : "";
  return mimeType.startsWith("image/") || IMAGE_FILENAME_RE.test(name);
}

function filesFromArrayLike(files: ArrayLike<File> | undefined): File[] {
  return Array.from(files || []).filter(Boolean);
}

function filesFromTransfer(data: TransferDataLike | null | undefined): File[] {
  if (!data) return [];
  const itemFiles = Array.from(data.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile?.() || null)
    .filter((file): file is File => Boolean(file));

  return itemFiles.length > 0 ? itemFiles : filesFromArrayLike(data.files);
}

function imageFilesFromTransfer(data: TransferDataLike | null | undefined): File[] {
  return partitionTransferFiles(filesFromTransfer(data)).images;
}

export function filesFromClipboardData(data: TransferDataLike | null | undefined): File[] {
  return filesFromTransfer(data);
}

export function imageFilesFromClipboardData(data: TransferDataLike | null | undefined): File[] {
  return imageFilesFromTransfer(data);
}

export function filesFromDropData(data: TransferDataLike | null | undefined): File[] {
  return filesFromTransfer(data);
}

export function imageFilesFromDropData(data: TransferDataLike | null | undefined): File[] {
  return imageFilesFromTransfer(data);
}

export function partitionTransferFiles(files: File[]): { images: File[]; attachments: File[] } {
  const images: File[] = [];
  const attachments: File[] = [];
  for (const file of files) {
    if (isImageFile(file)) {
      images.push(file);
    } else {
      attachments.push(file);
    }
  }
  return { images, attachments };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function timestampForName(date: Date): string {
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "-",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.trim().toLowerCase()) {
    case "image/avif":
      return "avif";
    case "image/bmp":
      return "bmp";
    case "image/gif":
      return "gif";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/svg+xml":
      return "svg";
    case "image/tiff":
      return "tiff";
    case "image/webp":
      return "webp";
    default:
      return "png";
  }
}

function defaultImageName(
  source: PendingImageSource,
  file: File,
  index: number,
  now: Date
): string {
  const prefix = source === "paste" ? "pasted-image" : "dropped-image";
  const suffix = index === 0 ? "" : `-${index + 1}`;
  return `${prefix}-${timestampForName(now)}${suffix}.${extensionForMimeType(file.type)}`;
}

function ensureImageFileName(
  file: File,
  source: PendingImageSource,
  index: number,
  now: Date
): File {
  if (typeof file.name === "string" && file.name.trim()) return file;
  return new File([file], defaultImageName(source, file, index, now), {
    type: file.type || "image/png",
    lastModified: file.lastModified,
  });
}

function defaultCreateId(_file: File, index: number): string {
  const random =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `local-image-${index}-${random}`;
}

function defaultCreateObjectUrl(file: File): string {
  if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    return URL.createObjectURL(file);
  }
  return "";
}

export function createPendingLocalImages(
  files: File[],
  source: PendingImageSource,
  options: CreatePendingLocalImagesOptions = {}
): PendingLocalImage[] {
  const now = options.now?.() || new Date();
  const createId = options.createId || defaultCreateId;
  const createObjectUrl = options.createObjectUrl || defaultCreateObjectUrl;

  return files.filter(isImageFile).map((file, index) => {
    const namedFile = ensureImageFileName(file, source, index, now);
    return {
      id: createId(namedFile, index),
      file: namedFile,
      name: namedFile.name,
      mimeType: namedFile.type || "image/png",
      previewUrl: createObjectUrl(namedFile),
      size: namedFile.size,
      source,
    };
  });
}

export function revokePendingLocalImages(
  images: PendingLocalImage[],
  revokeObjectUrl: (url: string) => void = (url) => URL.revokeObjectURL(url)
) {
  for (const image of images) {
    if (image.previewUrl) revokeObjectUrl(image.previewUrl);
  }
}
