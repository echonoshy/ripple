import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import SessionComposer from "./SessionComposer";
import type { PendingLocalImage } from "@/lib/pendingImages";

function noop() {}

const pastedImage: PendingLocalImage = {
  id: "local-image-1",
  file: new File(["png"], "pasted-image.png", { type: "image/png" }),
  name: "pasted-image.png",
  mimeType: "image/png",
  previewUrl: "blob:ripple-local-image-1",
  size: 3,
  source: "paste",
};

function renderComposer(overrides: Partial<React.ComponentProps<typeof SessionComposer>> = {}) {
  return renderToStaticMarkup(
    <SessionComposer
      value=""
      onChange={noop}
      onSend={noop}
      onStop={noop}
      onClearContext={noop}
      onCompactContext={noop}
      onAttachFiles={noop}
      onRemovePendingFile={noop}
      onAddPendingImages={noop}
      onRemovePendingLocalImage={noop}
      pendingFiles={[]}
      pendingLocalImages={[]}
      isGenerating={false}
      hasSession={false}
      focusToken={0}
      selectedModel="codex-high"
      models={[
        { id: "codex-medium", owned_by: "ripple" },
        { id: "codex-high", owned_by: "ripple" },
      ]}
      isModelDropdownOpen={true}
      onToggleModelDropdown={noop}
      onSelectModel={noop}
      {...overrides}
    />
  );
}

function testShowsSelectedModelAndMenuOptions() {
  const html = renderComposer();

  assert.match(html, />Pro</);
  assert.match(html, />Balanced</);
  assert.doesNotMatch(html, />Codex</);
}

function testComposerToolbarNamesRealActions() {
  const html = renderComposer();

  assert.match(html, /aria-label="Attach files"/);
  assert.doesNotMatch(html, /aria-label="Quick actions"/);
  assert.doesNotMatch(html, /aria-label="Mention workspace file"/);
  assert.doesNotMatch(html, /title="Quick actions"/);
  assert.doesNotMatch(html, /title="Mention workspace file"/);
}

function testComposerInputSuppressesGlobalBlueFocusOutline() {
  const html = renderComposer();
  const globalCss = readFileSync(new URL("../../globals.css", import.meta.url), "utf8");

  assert.match(html, /session-composer-input/);
  assert.match(globalCss, /\.session-composer-input:focus-visible/);
  assert.match(globalCss, /outline:\s*none/);
}

function testBlockedComposerStillAllowsDraftingAndShowsStop() {
  const html = renderComposer({ value: "draft", isBlocked: true });

  assert.match(html, />draft</);
  assert.doesNotMatch(html, /<textarea[^>]*\sdisabled="/);
  assert.match(html, /aria-label="Stop generation"/);
  assert.doesNotMatch(html, /aria-label="Send message"/);
}

function testComposerClearsIosHomeIndicatorAndUsesTouchSizedActions() {
  const html = renderComposer();

  assert.match(html, /pb-\[max\(env\(safe-area-inset-bottom\),8px\)\]/);
  assert.match(html, /h-10 w-10/);
  assert.match(html, /text-\[16px\][^"]*sm:text-\[14px\]/);
}

function testComposerShowsAttachmentUploadStateAndErrors() {
  const uploadingHtml = renderComposer({ isUploadingFiles: true });
  const errorHtml = renderComposer({ uploadError: "phone-photo.jpg: upload is too large" });

  assert.match(uploadingHtml, /Uploading files/);
  assert.match(errorHtml, /phone-photo\.jpg: upload is too large/);
}

function testComposerShowsPendingLocalImagePreview() {
  const html = renderComposer({ pendingLocalImages: [pastedImage] });

  assert.match(html, /src="blob:ripple-local-image-1"/);
  assert.match(html, /aria-label="Remove pasted-image\.png"/);
}

function testLocalImageOnlyMessageCanSend() {
  const html = renderComposer({ pendingLocalImages: [pastedImage] });
  const sendButton = html.match(/<button[^>]*aria-label="Send message"[^>]*>/)?.[0] || "";

  assert.match(sendButton, /aria-label="Send message"/);
  assert.doesNotMatch(sendButton, /\sdisabled(=""|\s|>)/);
}

function testComposerHasPasteAndDropImageHandlers() {
  const source = readFileSync(new URL("./SessionComposer.tsx", import.meta.url), "utf8");

  assert.match(source, /onPaste=\{handlePaste\}/);
  assert.match(source, /filesFromClipboardData/);
  assert.match(source, /partitionTransferFiles/);
  assert.match(source, /void onAttachFiles\(attachmentFiles\)/);
  assert.doesNotMatch(source, /onDrop=\{handleDrop\}/);
}

testShowsSelectedModelAndMenuOptions();
testComposerToolbarNamesRealActions();
testComposerInputSuppressesGlobalBlueFocusOutline();
testBlockedComposerStillAllowsDraftingAndShowsStop();
testComposerClearsIosHomeIndicatorAndUsesTouchSizedActions();
testComposerShowsAttachmentUploadStateAndErrors();
testComposerShowsPendingLocalImagePreview();
testLocalImageOnlyMessageCanSend();
testComposerHasPasteAndDropImageHandlers();

console.log("session composer tests passed");
