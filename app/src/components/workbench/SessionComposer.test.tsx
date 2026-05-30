import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import SessionComposer, {
  composerToolbarClassName,
  shouldExpandComposer,
} from "./SessionComposer";
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
  assert.match(html, />Plus</);
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

function testComposerToolbarUsesRequestedLucideIconSet() {
  const source = readFileSync(new URL("./SessionComposer.tsx", import.meta.url), "utf8");

  assert.match(source, /<FolderGit2 size=\{16\} strokeWidth=\{2\} \/>/);
  assert.match(source, /<Paperclip size=\{16\} strokeWidth=\{2\} \/>/);
  assert.match(source, /<BrainCircuit size=\{16\} strokeWidth=\{2\} \/>/);
  assert.doesNotMatch(source, /<Folder size=\{16\}/);
  assert.doesNotMatch(source, /<Cpu size=\{16\}/);
}

function testComposerShowsWorkspaceFolderPickerButton() {
  const html = renderComposer({
    workspaceScopeLabel: "Demo",
    workspaceScopePath: "/workspace/demo",
    contextFolderPath: "/workspace/demo",
    onSelectWorkspaceFolder: noop,
  });

  assert.match(html, /data-ripple-composer-folder-button/);
  assert.match(html, /aria-label="Choose context folder"/);
  assert.match(html, /title="Context folder: Demo"/);
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
  assert.match(html, /session-composer-input[^"]*text-\[14px\][^"]*sm:text-\[14px\]/);
  assert.doesNotMatch(html, /session-composer-input[^"]*text-\[15px\]/);
}

function testComposerExpandsActionsBelowTextAfterInput() {
  const emptyHtml = renderComposer();
  const draftHtml = renderComposer({ value: "hello" });

  assert.match(emptyHtml, /data-composer-expanded="false"/);
  assert.match(emptyHtml, /data-composer-layout="inline"/);
  assert.match(draftHtml, /data-composer-expanded="true"/);
  assert.match(draftHtml, /data-composer-layout="stacked"/);
}

function testExpandedComposerKeepsToolbarHorizontalOrigin() {
  const expandedToolbarClass = composerToolbarClassName(true);

  assert.match(expandedToolbarClass, /col-start-1 row-start-2/);
  assert.doesNotMatch(expandedToolbarClass, /-ml-1/);
}

function testComposerOnlyTextInputFocusExpandsEmptyComposer() {
  const source = readFileSync(new URL("./SessionComposer.tsx", import.meta.url), "utf8");
  const textareaBlock = source.match(/<textarea[\s\S]*?\/>/)?.[0] || "";
  const layoutContainer =
    source.match(
      /<div\s+data-composer-expanded=\{isExpandedComposer \? "true" : "false"\}[\s\S]*?\{toolbarControls\}/
    )?.[0] || "";

  assert.match(textareaBlock, /onFocus=\{\(\) => setIsComposerFocused\(true\)\}/);
  assert.doesNotMatch(layoutContainer, /onFocus=/);
}

function testComposerExpandsWhenFocusedWithoutInput() {
  assert.equal(shouldExpandComposer("", true), true);
  assert.equal(shouldExpandComposer("   ", true), true);
  assert.equal(shouldExpandComposer("hello", false), true);
  assert.equal(shouldExpandComposer("", false), false);
}

function testComposerRecalculatesTextareaHeightAfterExpansion() {
  const source = readFileSync(new URL("./SessionComposer.tsx", import.meta.url), "utf8");

  assert.match(source, /\[value,\s*isExpandedComposer,\s*adjustHeight\]/);
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
testComposerToolbarUsesRequestedLucideIconSet();
testComposerShowsWorkspaceFolderPickerButton();
testComposerInputSuppressesGlobalBlueFocusOutline();
testBlockedComposerStillAllowsDraftingAndShowsStop();
testComposerClearsIosHomeIndicatorAndUsesTouchSizedActions();
testComposerExpandsActionsBelowTextAfterInput();
testExpandedComposerKeepsToolbarHorizontalOrigin();
testComposerOnlyTextInputFocusExpandsEmptyComposer();
testComposerExpandsWhenFocusedWithoutInput();
testComposerRecalculatesTextareaHeightAfterExpansion();
testComposerShowsAttachmentUploadStateAndErrors();
testComposerShowsPendingLocalImagePreview();
testLocalImageOnlyMessageCanSend();
testComposerHasPasteAndDropImageHandlers();

console.log("session composer tests passed");
