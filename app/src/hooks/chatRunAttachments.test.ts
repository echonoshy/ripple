import assert from "node:assert/strict";

import { uploadPendingLocalImagesForSend } from "./chatRunAttachments";
import type { PendingLocalImage } from "@/lib/pendingImages";

function pendingImage(name: string): PendingLocalImage {
  return {
    id: `local-${name}`,
    file: new File(["image"], name, { type: "image/png" }),
    name,
    mimeType: "image/png",
    previewUrl: `blob:${name}`,
    size: 5,
    source: "paste",
  };
}

async function testLocalImageUploadsKeepSuccessfulFilesAndReportFailures() {
  const result = await uploadPendingLocalImagesForSend(
    [pendingImage("ok.png"), pendingImage("broken.png")],
    async (file) => {
      if (file.name === "broken.png") throw new Error("upload exploded");
      return {
        path: `/workspace/uploads/${file.name}`,
        name: file.name,
        mime_type: file.type,
        kind: "image",
        size: file.size,
      };
    }
  );

  assert.deepEqual(result.files, [
    {
      path: "/workspace/uploads/ok.png",
      name: "ok.png",
      mime_type: "image/png",
      kind: "image",
    },
  ]);
  assert.deepEqual(result.failures, ["broken.png: upload exploded"]);
}

await testLocalImageUploadsKeepSuccessfulFilesAndReportFailures();

console.log("chat run attachment tests passed");
