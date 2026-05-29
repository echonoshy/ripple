export interface WorkspaceImagePreviewKey {
  path: string;
  userId?: string | null;
  size?: number | null;
  mimeType?: string | null;
  modifiedAt?: string | null;
}

type CacheEntry = {
  bytes: number;
  lastUsed: number;
  promise?: Promise<string>;
  url?: string;
};

const MAX_CACHE_ENTRIES = 64;
const MAX_CACHE_BYTES = 96 * 1024 * 1024;

const previewCache = new Map<string, CacheEntry>();
let cachedBytes = 0;

function previewCacheKey(key: WorkspaceImagePreviewKey): string {
  return [
    key.userId || "",
    key.path,
    key.size ?? "",
    key.mimeType || "",
    key.modifiedAt || "",
  ].join("\n");
}

function revokePreviewUrl(url: string) {
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Some test and server-side environments do not provide a live object URL registry.
  }
}

function removeCacheEntry(key: string, entry: CacheEntry) {
  previewCache.delete(key);
  if (entry.url) {
    cachedBytes -= entry.bytes;
    revokePreviewUrl(entry.url);
  }
}

function trimPreviewCache() {
  if (previewCache.size <= MAX_CACHE_ENTRIES && cachedBytes <= MAX_CACHE_BYTES) return;

  const readyEntries = Array.from(previewCache.entries())
    .filter(([, entry]) => entry.url)
    .sort(([, a], [, b]) => a.lastUsed - b.lastUsed);

  for (const [key, entry] of readyEntries) {
    if (previewCache.size <= MAX_CACHE_ENTRIES && cachedBytes <= MAX_CACHE_BYTES) break;
    removeCacheEntry(key, entry);
  }
}

export function clearWorkspaceImagePreviewCache() {
  for (const [key, entry] of previewCache.entries()) {
    removeCacheEntry(key, entry);
  }
  cachedBytes = 0;
}

export async function getWorkspaceImagePreviewUrl(
  key: WorkspaceImagePreviewKey,
  loadBlob: () => Promise<Blob>
): Promise<string> {
  const cacheKey = previewCacheKey(key);
  const existing = previewCache.get(cacheKey);
  const now = Date.now();

  if (existing?.url) {
    existing.lastUsed = now;
    return existing.url;
  }

  if (existing?.promise) {
    existing.lastUsed = now;
    return existing.promise;
  }

  const entry: CacheEntry = {
    bytes: 0,
    lastUsed: now,
  };

  const promise = loadBlob()
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      const currentEntry = previewCache.get(cacheKey);
      if (currentEntry !== entry) {
        revokePreviewUrl(url);
        throw new Error("Workspace image preview request was cancelled");
      }

      entry.url = url;
      entry.promise = undefined;
      entry.bytes = blob.size || 0;
      entry.lastUsed = Date.now();
      cachedBytes += entry.bytes;
      trimPreviewCache();
      return url;
    })
    .catch((error) => {
      if (previewCache.get(cacheKey) === entry) {
        previewCache.delete(cacheKey);
      }
      throw error;
    });

  entry.promise = promise;
  previewCache.set(cacheKey, entry);
  return promise;
}
