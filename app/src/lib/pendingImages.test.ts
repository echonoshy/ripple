import assert from "node:assert/strict";

import {
  createPendingLocalImages,
  filesFromClipboardData,
  filesFromDropData,
  imageFilesFromClipboardData,
  imageFilesFromDropData,
  partitionTransferFiles,
  revokePendingLocalImages,
} from "./pendingImages";

function imageFile(name: string, type: string = "image/png") {
  return new File(["image-bytes"], name, { type, lastModified: 1 });
}

function textFile(name: string) {
  return new File(["hello"], name, { type: "text/plain", lastModified: 1 });
}

function testExtractsImagesFromClipboardItems() {
  const image = imageFile("chart.png");
  const text = textFile("notes.txt");
  const files = imageFilesFromClipboardData({
    items: [
      { kind: "file", type: "image/png", getAsFile: () => image },
      { kind: "file", type: "text/plain", getAsFile: () => text },
    ],
    files: [image, text],
  });

  assert.deepEqual(files, [image]);
}

function testDropFiltersNonImages() {
  const image = imageFile("photo.jpg", "image/jpeg");
  const text = textFile("notes.txt");
  const files = imageFilesFromDropData({ items: [], files: [text, image] });

  assert.deepEqual(files, [image]);
}

function testNamelessImagesGetStableDefaultNames() {
  const nameless = imageFile("", "image/png");
  const pending = createPendingLocalImages([nameless], "paste", {
    createId: (_file, index) => `local-${index}`,
    createObjectUrl: () => "blob:ripple-local-0",
    now: () => new Date("2026-05-29T01:02:03.000Z"),
  });

  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, "local-0");
  assert.equal(pending[0].name, "pasted-image-20260529-010203.png");
  assert.equal(pending[0].file.name, "pasted-image-20260529-010203.png");
  assert.equal(pending[0].previewUrl, "blob:ripple-local-0");
}

function testTextOnlyPasteReturnsNoImages() {
  const files = imageFilesFromClipboardData({
    items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
    files: [],
  });

  assert.deepEqual(files, []);
}

function testClipboardFileExtractionKeepsDocuments() {
  const image = imageFile("chart.png");
  const document = new File(["report"], "report.pdf", { type: "application/pdf" });
  const files = filesFromClipboardData({
    items: [
      { kind: "file", type: "image/png", getAsFile: () => image },
      { kind: "file", type: "application/pdf", getAsFile: () => document },
    ],
    files: [],
  });

  assert.deepEqual(files, [image, document]);
}

function testDropFileExtractionKeepsDocuments() {
  const document = new File(["notes"], "notes.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const files = filesFromDropData({ items: [], files: [document] });

  assert.deepEqual(files, [document]);
}

function testPartitionTransferFilesSplitsImagesFromAttachments() {
  const image = imageFile("chart.png");
  const document = new File(["report"], "report.pdf", { type: "application/pdf" });
  const partitioned = partitionTransferFiles([image, document]);

  assert.deepEqual(partitioned.images, [image]);
  assert.deepEqual(partitioned.attachments, [document]);
}

function testRevokesPreviewUrls() {
  const revoked: string[] = [];
  const pending = createPendingLocalImages([imageFile("chart.png")], "drop", {
    createId: (_file, index) => `drop-${index}`,
    createObjectUrl: () => "blob:ripple-drop-0",
    now: () => new Date("2026-05-29T01:02:03.000Z"),
  });

  revokePendingLocalImages(pending, (url) => revoked.push(url));

  assert.deepEqual(revoked, ["blob:ripple-drop-0"]);
}

testExtractsImagesFromClipboardItems();
testDropFiltersNonImages();
testNamelessImagesGetStableDefaultNames();
testTextOnlyPasteReturnsNoImages();
testClipboardFileExtractionKeepsDocuments();
testDropFileExtractionKeepsDocuments();
testPartitionTransferFilesSplitsImagesFromAttachments();
testRevokesPreviewUrls();

console.log("pending image tests passed");
