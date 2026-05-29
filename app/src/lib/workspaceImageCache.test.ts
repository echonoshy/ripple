import assert from "node:assert/strict";

import {
  clearWorkspaceImagePreviewCache,
  getWorkspaceImagePreviewUrl,
} from "./workspaceImageCache";

function installObjectUrlStub() {
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  const revoked: string[] = [];
  let nextId = 0;

  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (blob: Blob) => `blob:test-${++nextId}-${blob.size}`,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: (url: string) => {
      revoked.push(url);
    },
  });

  return {
    revoked,
    restore() {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: originalCreateObjectUrl,
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: originalRevokeObjectUrl,
      });
    },
  };
}

async function testWorkspaceImageCacheDeduplicatesPreviewDownloads() {
  clearWorkspaceImagePreviewCache();
  let loads = 0;
  const loadBlob = async () => {
    loads += 1;
    await Promise.resolve();
    return new Blob(["preview"]);
  };

  const first = getWorkspaceImagePreviewUrl(
    {
      userId: "user-a",
      path: "/workspace/outputs/image.png",
      size: 7,
      mimeType: "image/png",
      modifiedAt: "2026-05-29T00:00:00Z",
    },
    loadBlob
  );
  const second = getWorkspaceImagePreviewUrl(
    {
      userId: "user-a",
      path: "/workspace/outputs/image.png",
      size: 7,
      mimeType: "image/png",
      modifiedAt: "2026-05-29T00:00:00Z",
    },
    loadBlob
  );

  assert.equal(loads, 1);
  const firstUrl = await first;
  const secondUrl = await second;
  assert.equal(firstUrl, secondUrl);

  const cachedUrl = await getWorkspaceImagePreviewUrl(
    {
      userId: "user-a",
      path: "/workspace/outputs/image.png",
      size: 7,
      mimeType: "image/png",
      modifiedAt: "2026-05-29T00:00:00Z",
    },
    loadBlob
  );

  assert.equal(cachedUrl, firstUrl);
  assert.equal(loads, 1);
}

async function testWorkspaceImageCacheInvalidatesWhenFileMetadataChanges() {
  clearWorkspaceImagePreviewCache();
  let loads = 0;
  const loadBlob = async () => {
    loads += 1;
    return new Blob([`preview-${loads}`]);
  };

  const firstUrl = await getWorkspaceImagePreviewUrl(
    {
      userId: "user-a",
      path: "/workspace/outputs/image.png",
      size: 7,
      mimeType: "image/png",
      modifiedAt: "2026-05-29T00:00:00Z",
    },
    loadBlob
  );
  const changedUrl = await getWorkspaceImagePreviewUrl(
    {
      userId: "user-a",
      path: "/workspace/outputs/image.png",
      size: 8,
      mimeType: "image/png",
      modifiedAt: "2026-05-29T00:01:00Z",
    },
    loadBlob
  );

  assert.notEqual(changedUrl, firstUrl);
  assert.equal(loads, 2);
}

async function testWorkspaceImageCacheClearRevokesObjectUrls() {
  clearWorkspaceImagePreviewCache();
  const stub = installObjectUrlStub();
  try {
    const url = await getWorkspaceImagePreviewUrl(
      {
        userId: "user-a",
        path: "/workspace/outputs/image.png",
        size: 7,
        mimeType: "image/png",
        modifiedAt: "2026-05-29T00:00:00Z",
      },
      async () => new Blob(["preview"])
    );

    clearWorkspaceImagePreviewCache();

    assert.deepEqual(stub.revoked, [url]);
  } finally {
    stub.restore();
    clearWorkspaceImagePreviewCache();
  }
}

await testWorkspaceImageCacheDeduplicatesPreviewDownloads();
await testWorkspaceImageCacheInvalidatesWhenFileMetadataChanges();
await testWorkspaceImageCacheClearRevokesObjectUrls();

console.log("workspace image cache tests passed");
