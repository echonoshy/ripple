import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, type LocalePreference } from "@/i18n";
import SessionComposer, { composerToolbarClassName, shouldExpandComposer } from "./SessionComposer";
import { CLIENT_CONTEXT_FIXTURES } from "@/lib/clientContextFixtures";
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

function renderComposer(
  overrides: Partial<React.ComponentProps<typeof SessionComposer>> = {},
  locale: LocalePreference = "en-US"
) {
  return renderToStaticMarkup(
    <I18nProvider initialPreference={locale}>
      <SessionComposer
        value=""
        onChange={noop}
        onSend={noop}
        onStop={noop}
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
        onCloseModelDropdown={noop}
        onSelectModel={noop}
        {...overrides}
      />
    </I18nProvider>
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

function testComposerOmitsSlashCommandPopup() {
  const source = readFileSync(new URL("./SessionComposer.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /composerTriggers/);
  assert.doesNotMatch(source, /quickActionsState/);
  assert.doesNotMatch(source, /quickActionsRef/);
  assert.doesNotMatch(source, /\/\{action\.command\}/);
}

function testComposerRendersChineseStaticCopy() {
  const html = renderComposer({ isUploadingFiles: true }, "zh-CN");

  assert.match(html, /aria-label="附加文件"/);
  assert.match(html, /aria-label="选择模型"/);
  assert.match(html, /aria-label="发送消息"/);
  assert.match(html, /placeholder="问任何问题..."/);
  assert.match(html, />正在上传文件</);
}

function testComposerToolbarUsesRequestedLucideIconSet() {
  const source = readFileSync(new URL("./SessionComposer.tsx", import.meta.url), "utf8");

  assert.match(source, /LUCIDE_STANDARD_STROKE_WIDTH/);
  assert.match(source, /<FolderGit2 size=\{16\} strokeWidth=\{LUCIDE_STANDARD_STROKE_WIDTH\} \/>/);
  assert.match(source, /<Paperclip size=\{16\} strokeWidth=\{LUCIDE_STANDARD_STROKE_WIDTH\} \/>/);
  assert.match(
    source,
    /<BrainCircuit size=\{16\} strokeWidth=\{LUCIDE_STANDARD_STROKE_WIDTH\} \/>/
  );
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
  assert.match(html, /aria-label="Choose work folder"/);
  assert.match(html, /title="Work folder: Demo"/);
  assert.match(html, /aria-pressed="true"/);
  assert.doesNotMatch(html, /focus folder/i);
}

function testComposerInputDoesNotNeedGlobalBlueFocusOverride() {
  const html = renderComposer();
  const globalCss = readFileSync(new URL("../../globals.css", import.meta.url), "utf8");

  assert.match(html, /session-composer-input/);
  assert.doesNotMatch(globalCss, /:focus-visible\s*\{/);
  assert.doesNotMatch(globalCss, /outline:\s*2px solid var\(--ripple-brand\)/);
}

function testComposerInputHidesNativeScrollbar() {
  const html = renderComposer();

  assert.match(html, /\[-ms-overflow-style:none\]/);
  assert.match(html, /\[scrollbar-width:none\]/);
  assert.match(html, /\[(?:&|&amp;)::-webkit-scrollbar\]:hidden/);
  assert.match(html, /\[(?:&|&amp;)::-webkit-scrollbar\]:h-0/);
  assert.match(html, /\[(?:&|&amp;)::-webkit-scrollbar\]:w-0/);
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
  assert.match(html, /h-11 w-11/);
  assert.match(html, /h-10 w-10/);
  assert.match(html, /session-composer-input[^"]*text-\[16px\][^"]*lg:text-\[14px\]/);
  assert.doesNotMatch(html, /session-composer-input[^"]*text-\[14px\][^"]*sm:text-\[14px\]/);
}

function testComposerUsesWorkbenchSurfaceScaleAndIndependentToolButtons() {
  const source = readFileSync(new URL("./SessionComposer.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /rounded-\[20px\]/);
  assert.match(source, /WORKBENCH_MENU_CLASS/);
  assert.match(source, /COMPOSER_ICON_BUTTON_CLASS/);
  assert.doesNotMatch(
    source,
    /gap-0\.5 rounded-xl border border-\[#EFF0F1\] bg-\[#F8F9FA\] p-0\.5/
  );
  assert.doesNotMatch(source, /className=\{composerToolbarClassName\(isExpandedComposer\)\}/);
  assert.match(source, /gap-1\.5/);
  assert.match(source, /bg-transparent text-\[#646A73\]/);
  assert.doesNotMatch(source, /border-transparent bg-transparent text-\[#646A73\]/);
  assert.match(source, /COMPOSER_ICON_BUTTON_ACTIVE_CLASS/);
  assert.doesNotMatch(source, /COMPOSER_ICON_BUTTON_ACTIVE_CLASS =\n {2}"border-\[#BACEFD\]/);
  assert.match(
    source,
    /rounded-xl border border-\[#DEE0E3\] bg-white p-1\.5 shadow-\[0_1px_2px_rgba\(31,35,41,0\.04\)\]/
  );
  assert.doesNotMatch(source, /rounded-\[22px\]/);
  assert.doesNotMatch(source, /bg-white\/92/);
  assert.doesNotMatch(source, /backdrop-blur-2xl/);
  assert.doesNotMatch(source, /shadow-\[0_12px_30px_rgba\(31,35,41,0\.10\)\]/);
  assert.doesNotMatch(source, /shadow-\[0_10px_22px_rgba\(20,86,240,0\.26\)\]/);
}

function testComposerModelMenuUsesViewportPortal() {
  const source = readFileSync(new URL("./SessionComposer.tsx", import.meta.url), "utf8");
  const modelMenuBlock = source.match(/const modelMenu = \([\s\S]*?const modelMenuPortal/)?.[0] || "";

  assert.match(source, /createPortal/);
  assert.match(source, /data-ripple-composer-model-menu/);
  assert.match(source, /role="menu"/);
  assert.match(source, /position: "fixed"/);
  assert.match(source, /modelMenuRef/);
  assert.match(source, /modelButtonRef/);
  assert.doesNotMatch(modelMenuBlock, /absolute bottom-full left-0/);
}

function testComposerModelButtonHasStableExplainerAnchor() {
  const html = renderComposer();

  assert.match(html, /data-ripple-composer-model-button/);
  assert.match(html, /aria-label="Select model"/);
  assert.match(html, /title="Model: Pro"/);
}

function testComposerShowsRequiredSkillPickerChip() {
  const html = renderComposer({
    availableSkills: [
      {
        id: "ripple:ripple-ui-explainer",
        type: "skill",
        name: "ripple-ui-explainer",
        display_name: "Ripple UI Explainer",
        description: "Explain Ripple UI screenshots.",
        source: "ripple",
        display_source: "system",
        path: "skills/ripple-ui-explainer/SKILL.md",
        user_status: "available",
        enabled: true,
        status: "available",
      },
    ],
    selectedRequiredSkillId: "ripple:ripple-ui-explainer",
    onSelectRequiredSkill: noop,
  });

  assert.match(html, /data-ripple-composer-skill-button/);
  assert.match(html, /aria-label="Select skill"/);
  assert.match(html, /Ripple UI Explainer/);
  assert.match(html, /aria-label="Clear selected skill"/);
}

function testComposerShowsClientContextFixturePickerChip() {
  const html = renderComposer({
    clientContextFixtures: CLIENT_CONTEXT_FIXTURES,
    selectedClientContextFixtureId: "meeting-detail-with-headset",
    onSelectClientContextFixture: noop,
  });

  assert.match(html, /data-ripple-composer-context-button/);
  assert.match(html, /aria-label="Select test context"/);
  assert.match(html, /Meeting page \+ AI headset/);
  assert.match(html, /aria-label="Clear test context"/);
}

function testComposerModelMenuSelectsOnTouchPointerDown() {
  const source = readFileSync(new URL("./SessionComposer.tsx", import.meta.url), "utf8");

  assert.match(source, /handleModelOptionPointerDown/);
  assert.match(source, /event\.pointerType !== "touch"/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(
    source,
    /onPointerDown=\{\(event\) => handleModelOptionPointerDown\(event, model\.id\)\}/
  );
  assert.match(source, /onClick=\{\(\) => handleModelOptionClick\(model\.id\)\}/);
}

function testComposerModelMenuClosesWithExplicitCloseCallback() {
  const source = readFileSync(new URL("./SessionComposer.tsx", import.meta.url), "utf8");

  assert.match(source, /onCloseModelDropdown: \(\) => void/);
  assert.match(
    source,
    /const closeModelMenu = useCallback\(\(\) => \{\s*setModelMenuPosition\(null\);\s*onCloseModelDropdown\(\);/
  );
  assert.doesNotMatch(
    source,
    /const closeModelMenu = useCallback\(\(\) => \{\s*setModelMenuPosition\(null\);\s*onToggleModelDropdown\(\);/
  );
}

function testHiddenComposerDoesNotCloseVisibleModelMenu() {
  const source = readFileSync(new URL("./SessionComposer.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /if \(modelDropdownRef\.current &&\s*modelDropdownRef\.current\.getClientRects\(\)\.length === 0\)\s*return;/
  );
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

  assert.match(textareaBlock, /onFocus=\{\(\) => \{/);
  assert.match(textareaBlock, /setIsComposerFocused\(true\)/);
  assert.doesNotMatch(layoutContainer, /onFocus=/);
}

function testComposerReportsFocusStateToOwner() {
  const source = readFileSync(new URL("./SessionComposer.tsx", import.meta.url), "utf8");

  assert.match(source, /onFocusStateChange\?: \(focused: boolean\) => void/);
  assert.match(source, /onFocusStateChange\?\.\(true\)/);
  assert.match(source, /onFocusStateChange\?\.\(false\)/);
  assert.match(source, /setIsComposerFocused\(true\)/);
  assert.match(source, /setIsComposerFocused\(false\)/);
}

function testComposerIgnoresHistoricalFocusTokenOnMount() {
  const source = readFileSync(new URL("./SessionComposer.tsx", import.meta.url), "utf8");

  assert.match(source, /lastAppliedFocusTokenRef = useRef\(focusToken\)/);
  assert.match(source, /focusToken <= lastAppliedFocusTokenRef\.current/);
  assert.match(source, /lastAppliedFocusTokenRef\.current = focusToken/);
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
testComposerOmitsSlashCommandPopup();
testComposerRendersChineseStaticCopy();
testComposerToolbarUsesRequestedLucideIconSet();
testComposerShowsWorkspaceFolderPickerButton();
testComposerInputDoesNotNeedGlobalBlueFocusOverride();
testComposerInputHidesNativeScrollbar();
testBlockedComposerStillAllowsDraftingAndShowsStop();
testComposerClearsIosHomeIndicatorAndUsesTouchSizedActions();
testComposerUsesWorkbenchSurfaceScaleAndIndependentToolButtons();
testComposerModelMenuUsesViewportPortal();
testComposerModelButtonHasStableExplainerAnchor();
testComposerShowsRequiredSkillPickerChip();
testComposerShowsClientContextFixturePickerChip();
testComposerModelMenuSelectsOnTouchPointerDown();
testComposerModelMenuClosesWithExplicitCloseCallback();
testHiddenComposerDoesNotCloseVisibleModelMenu();
testComposerExpandsActionsBelowTextAfterInput();
testExpandedComposerKeepsToolbarHorizontalOrigin();
testComposerOnlyTextInputFocusExpandsEmptyComposer();
testComposerReportsFocusStateToOwner();
testComposerIgnoresHistoricalFocusTokenOnMount();
testComposerExpandsWhenFocusedWithoutInput();
testComposerRecalculatesTextareaHeightAfterExpansion();
testComposerShowsAttachmentUploadStateAndErrors();
testComposerShowsPendingLocalImagePreview();
testLocalImageOnlyMessageCanSend();
testComposerHasPasteAndDropImageHandlers();

console.log("session composer tests passed");
