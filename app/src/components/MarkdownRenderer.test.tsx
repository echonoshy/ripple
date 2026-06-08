import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/i18n";
import MarkdownRenderer from "./MarkdownRenderer";

function renderMarkdown(
  props: React.ComponentProps<typeof MarkdownRenderer>,
  locale: "en-US" | "zh-CN" = "en-US"
) {
  return renderToStaticMarkup(
    <I18nProvider initialPreference={locale}>
      <MarkdownRenderer {...props} />
    </I18nProvider>
  );
}

function cssRule(selector: string): string {
  const css = readFileSync(new URL("../globals.css", import.meta.url), "utf8");
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

function testPreservesSingleNewlineAsLineBreak() {
  const html = renderToStaticMarkup(
    <MarkdownRenderer content={"GitHub, 2026-05-16 13:36\nSubject: Security alert"} />
  );

  assert.match(html, /<br\/?>/);
}

function testFeishuAuthCardDoesNotCompleteAuthDirectly() {
  const html = renderMarkdown({
    content: "[FEISHU_AUTH]\ndevice_code: device-123\nhttps://accounts.feishu.cn/device",
  });

  assert.match(html, /Open authorization page/);
  assert.match(html, /Complete Feishu authorization/);
  assert.doesNotMatch(html, /continue the current task/);
  assert.doesNotMatch(html, /done/);
}

function testFeishuAuthCardShowsWaitingState() {
  const html = renderMarkdown({
    content: "[FEISHU_AUTH]\nhttps://accounts.feishu.cn/device",
    feishuAuthWaiting: {
      connector: "feishu",
      url: "https://accounts.feishu.cn/device",
      elapsedSeconds: 12,
      label: "Feishu operation",
    },
  });

  assert.match(html, /Waiting for Feishu in the browser/);
  assert.match(html, /12 seconds elapsed/);
  assert.doesNotMatch(html, /continue automatically/);
}

function testFeishuAuthCardSeparatesConnectAndSkillText() {
  const connectHtml = renderMarkdown({
    content: "[FEISHU_AUTH_CONNECT]\nhttps://accounts.feishu.cn/device",
  });
  const skillHtml = renderMarkdown({
    content: "[FEISHU_AUTH_SKILL]\nhttps://accounts.feishu.cn/device",
  });

  assert.match(connectHtml, /Authorize Feishu account/);
  assert.doesNotMatch(connectHtml, /for this request/);
  assert.doesNotMatch(connectHtml, /Step 2\/2/);
  assert.match(skillHtml, /Authorize Feishu for this request/);
  assert.match(skillHtml, /This Feishu request needs authorization first/);
  assert.doesNotMatch(skillHtml, /continue automatically/);
}

function testGoogleAuthCardGuidesManualTwoStepFlow() {
  const html = renderMarkdown({
    content: "[GOOGLE_AUTH]\nhttps://accounts.google.com/o/oauth2/auth?state=abc",
  });

  assert.match(html, /Open Google authorization/);
  assert.match(html, /Authorize Google Workspace/);
  assert.match(html, /send your Google Workspace request/);
  assert.doesNotMatch(html, /Step 1\/2/);
  assert.doesNotMatch(html, /continue automatically/);
  assert.doesNotMatch(html, /callback URL/);
  assert.doesNotMatch(html, /好了/);
}

function testGoogleAuthCardSeparatesConnectAndSkillText() {
  const connectHtml = renderMarkdown({
    content: "[GOOGLE_AUTH_CONNECT]\nhttps://accounts.google.com/o/oauth2/auth?state=abc",
  });
  const skillHtml = renderMarkdown({
    content: "[GOOGLE_AUTH_SKILL]\nhttps://accounts.google.com/o/oauth2/auth?state=abc",
  });

  assert.match(connectHtml, /Connect Google Workspace/);
  assert.doesNotMatch(connectHtml, /send your Google Workspace request/);
  assert.match(skillHtml, /Authorize Google Workspace for this request/);
  assert.match(skillHtml, /This Google Workspace request needs authorization first/);
  assert.doesNotMatch(skillHtml, /continue automatically/);
}

function testGoogleAuthCardConsumesLegacyChineseTrailingInstruction() {
  const html = renderMarkdown({
    content:
      "[GOOGLE_AUTH]\nGoogle Workspace 授权\n\n请打开下面的授权链接并点击允许：\n\n" +
      "https://accounts.google.com/o/oauth2/auth?state=abc\n\n" +
      "授权完成后 Ripple 会自动继续。",
  });

  assert.match(html, /Authorize Google Workspace/);
  assert.doesNotMatch(html, /授权完成后 Ripple 会自动继续/);
}

function testGoogleAuthCardUsesChineseI18nText() {
  const html = renderToStaticMarkup(
    <I18nProvider initialPreference="zh-CN">
      <MarkdownRenderer
        content={"[GOOGLE_AUTH]\nhttps://accounts.google.com/o/oauth2/auth?state=abc"}
      />
    </I18nProvider>
  );

  assert.match(html, /授权 Google Workspace/);
  assert.doesNotMatch(html, /第 1\/2 步/);
  assert.match(html, /授权完成后，回到这里发送你要执行的 Google Workspace 请求/);
  assert.doesNotMatch(html, /Ripple 会自动继续刚才的请求/);
}

function testGoogleAuthorizedCardUsesI18nText() {
  const enHtml = renderMarkdown({ content: "[GOOGLE_AUTHORIZED_CONNECT]" });
  const skillHtml = renderMarkdown({ content: "[GOOGLE_AUTHORIZED_SKILL]" });
  const zhHtml = renderToStaticMarkup(
    <I18nProvider initialPreference="zh-CN">
      <MarkdownRenderer content={"[GOOGLE_AUTHORIZED_SKILL]"} />
    </I18nProvider>
  );

  assert.match(enHtml, /Google Workspace connected/);
  assert.doesNotMatch(enHtml, /Step 2\/2/);
  assert.match(enHtml, /Authorization is complete/);
  assert.doesNotMatch(enHtml, /send your Google Workspace request/);
  assert.match(skillHtml, /You can now send your Google Workspace request/);
  assert.match(zhHtml, /Google Workspace 已连接/);
  assert.doesNotMatch(zhHtml, /第 2\/2 步/);
  assert.match(zhHtml, /现在可以发送你要执行的 Google Workspace 请求/);
  assert.doesNotMatch(enHtml, /继续执行刚才的请求/);
  assert.doesNotMatch(zhHtml, /继续执行刚才的请求/);
}

function testFeishuAndNotionAuthorizedCardsUseI18nText() {
  const feishuConnectHtml = renderMarkdown({ content: "[FEISHU_AUTHORIZED_CONNECT]" });
  const feishuSkillHtml = renderMarkdown({ content: "[FEISHU_AUTHORIZED_SKILL]" });
  const notionConnectHtml = renderMarkdown({ content: "[NOTION_AUTHORIZED_CONNECT]" });
  const notionSkillHtml = renderMarkdown({ content: "[NOTION_AUTHORIZED_SKILL]" });

  assert.match(feishuConnectHtml, /Feishu connected/);
  assert.match(feishuConnectHtml, /Authorization is complete/);
  assert.doesNotMatch(feishuConnectHtml, /Feishu request/);
  assert.match(feishuSkillHtml, /You can now send your Feishu request/);
  assert.match(notionConnectHtml, /Notion connected/);
  assert.match(notionConnectHtml, /Token saved/);
  assert.doesNotMatch(notionConnectHtml, /Notion request/);
  assert.match(notionSkillHtml, /You can now send your Notion request/);
}

function testNotionTokenCardSeparatesConnectAndSkillText() {
  const connectHtml = renderMarkdown({ content: "[NOTION_TOKEN_CONNECT]" });
  const skillHtml = renderMarkdown({ content: "[NOTION_TOKEN_SKILL]" });

  assert.match(connectHtml, /Connect Notion/);
  assert.match(connectHtml, /Paste your Notion integration token/);
  assert.doesNotMatch(connectHtml, /This Notion request/);
  assert.match(skillHtml, /Connect Notion for this request/);
  assert.match(skillHtml, /This Notion request needs an integration token first/);
  assert.doesNotMatch(skillHtml, /continue automatically/);
}

function testConnectorAuthLinksUseScopedButtonStyles() {
  const googleHtml = renderMarkdown({
    content: "[GOOGLE_AUTH]\nhttps://accounts.google.com/o/oauth2/auth?state=abc",
  });
  const feishuHtml = renderMarkdown({
    content: "[FEISHU_AUTH]\nhttps://accounts.feishu.cn/device",
  });
  const bilibiliHtml = renderMarkdown({
    content:
      "[BILIBILI_AUTH]\n" +
      "/v1/bilibili/qrcode.png?content=encoded\n" +
      "https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=abc\n" +
      "bilibili://browser?url=https%3A%2F%2Faccount.bilibili.com%2Fh5%2Faccount-h5%2Fauth%2Fscan-web%3Fqrcode_key%3Dabc",
  });

  assert.match(
    googleHtml,
    /class="(?=[^"]*\bconnector-auth-link\b)(?=[^"]*\bconnector-auth-link--primary\b)[^"]*"/
  );
  assert.match(
    feishuHtml,
    /class="(?=[^"]*\bconnector-auth-link\b)(?=[^"]*\bconnector-auth-link--info\b)[^"]*"/
  );
  assert.match(
    bilibiliHtml,
    /class="(?=[^"]*\bconnector-auth-link\b)(?=[^"]*\bconnector-auth-link--warning\b)[^"]*"/
  );
  assert.match(
    bilibiliHtml,
    /class="(?=[^"]*\bconnector-auth-link\b)(?=[^"]*\bconnector-auth-link--neutral\b)[^"]*"/
  );
}

function testConnectorAuthCardsUseSoftTileHeaders() {
  const googleHtml = renderMarkdown({
    content: "[GOOGLE_AUTH]\nhttps://accounts.google.com/o/oauth2/auth?state=abc",
  });
  const feishuHtml = renderMarkdown({
    content: "[FEISHU_AUTH]\nhttps://accounts.feishu.cn/device",
  });

  assert.match(googleHtml, /data-ripple-icon-tile="true"/);
  assert.match(googleHtml, /data-tone="accent"/);
  assert.match(feishuHtml, /data-ripple-icon-tile="true"/);
}

function testConnectorAuthCardsUseWorkbenchNoticeSurfaces() {
  const googleHtml = renderMarkdown({
    content: "[GOOGLE_AUTH]\nhttps://accounts.google.com/o/oauth2/auth?state=abc",
  });
  const authorizedHtml = renderMarkdown({ content: "[GOOGLE_AUTHORIZED_CONNECT]" });

  for (const html of [googleHtml, authorizedHtml]) {
    assert.match(html, /rounded-xl/);
    assert.match(html, /border-\[#DEE0E3\]/);
    assert.match(html, /bg-white/);
    assert.match(html, /shadow-\[0_1px_2px_rgba\(31,35,41,0\.04\)\]/);
    assert.doesNotMatch(html, /rounded-2xl/);
    assert.doesNotMatch(html, /bg-white\/74/);
    assert.doesNotMatch(html, /backdrop-blur-xl/);
  }
}

testConnectorAuthCardsUseWorkbenchNoticeSurfaces();

function testBilibiliAuthCardShowsQrAndManualOpenLink() {
  const html = renderMarkdown({
    content:
      "[BILIBILI_AUTH]\n" +
      "/v1/bilibili/qrcode.png?content=encoded\n" +
      "https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=abc\n" +
      "bilibili://browser?url=https%3A%2F%2Faccount.bilibili.com%2Fh5%2Faccount-h5%2Fauth%2Fscan-web%3Fqrcode_key%3Dabc",
  });

  assert.match(html, /Connect Bilibili/);
  assert.match(html, /src="[^"]*\/v1\/bilibili\/qrcode\.png\?content=encoded"/);
  assert.match(html, /Open Bilibili authorization/);
  assert.match(html, /After confirming with the QR code or link/);
  assert.match(html, /done/);
  assert.doesNotMatch(html, /Step 1\/2/);
  assert.doesNotMatch(html, /summarize/);
  assert.doesNotMatch(html, /自动继续/);
}

function testBilibiliSkillAuthCardExplainsRequirement() {
  const html = renderMarkdown({
    content:
      "[BILIBILI_AUTH_SKILL]\n" +
      "/v1/bilibili/qrcode.png?content=encoded\n" +
      "https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=abc\n" +
      "bilibili://browser?url=https%3A%2F%2Faccount.bilibili.com%2Fh5%2Faccount-h5%2Fauth%2Fscan-web%3Fqrcode_key%3Dabc",
  });

  assert.match(html, /Connect Bilibili to summarize videos/);
  assert.match(html, /authorization, you can summarize Bilibili videos/);
  assert.doesNotMatch(html, /Step 1\/2/);
  assert.doesNotMatch(html, /continue automatically/);
}

function testBilibiliAuthorizedCardUsesI18nText() {
  const enHtml = renderMarkdown({ content: "[BILIBILI_AUTHORIZED_CONNECT]" });
  const skillHtml = renderMarkdown({ content: "[BILIBILI_AUTHORIZED_SKILL]" });
  const zhHtml = renderToStaticMarkup(
    <I18nProvider initialPreference="zh-CN">
      <MarkdownRenderer content={"[BILIBILI_AUTHORIZED_SKILL]"} />
    </I18nProvider>
  );

  assert.match(enHtml, /Bilibili connected/);
  assert.match(enHtml, /Authorization is complete/);
  assert.doesNotMatch(enHtml, /video link or BV ID/);
  assert.match(skillHtml, /Bilibili connected/);
  assert.match(skillHtml, /Send the Bilibili video link or BV ID/);
  assert.doesNotMatch(skillHtml, /Step 2\/2/);
  assert.match(zhHtml, /Bilibili 已连接/);
  assert.match(zhHtml, /发送你要总结的 B 站视频链接或 BV 号/);
  assert.doesNotMatch(enHtml, /继续执行刚才的请求/);
  assert.doesNotMatch(zhHtml, /继续执行刚才的请求/);
}

function testBilibiliAuthCardConsumesLegacyChineseTrailingInstruction() {
  const html = renderMarkdown({
    content:
      "[BILIBILI_AUTH]\nB 站扫码登录\n\n" +
      "/v1/bilibili/qrcode.png?content=encoded\n\n" +
      "https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=abc\n\n" +
      "bilibili://browser?url=https%3A%2F%2Faccount.bilibili.com%2Fh5%2Faccount-h5%2Fauth%2Fscan-web%3Fqrcode_key%3Dabc\n\n" +
      "扫码或点链接确认后，回到这里发送「好了」。",
  });

  assert.match(html, /After confirming with the QR code or link/);
  assert.match(html, /done/);
  assert.doesNotMatch(html, /扫码或点链接确认后/);
  assert.doesNotMatch(html, /好了/);
}

function testBilibiliAuthCardUsesChineseI18nText() {
  const html = renderToStaticMarkup(
    <I18nProvider initialPreference="zh-CN">
      <MarkdownRenderer
        content={
          "[BILIBILI_AUTH]\n" +
          "/v1/bilibili/qrcode.png?content=encoded\n" +
          "https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=abc\n" +
          "bilibili://browser?url=https%3A%2F%2Faccount.bilibili.com%2Fh5%2Faccount-h5%2Fauth%2Fscan-web%3Fqrcode_key%3Dabc"
        }
      />
    </I18nProvider>
  );

  assert.match(html, /扫码或点链接确认后/);
  assert.match(html, /好了/);
  assert.doesNotMatch(html, /After confirming/);
}

function testRegularMarkdownLinksUseTauriAwareExternalOpener() {
  const html = renderToStaticMarkup(
    <MarkdownRenderer content={"Open [docs](https://example.com/docs)."} />
  );
  const source = readFileSync(new URL("./MarkdownRenderer.tsx", import.meta.url), "utf8");

  assert.match(html, /href="https:\/\/example\.com\/docs"/);
  assert.match(html, /data-ripple-external-link="true"/);
  assert.match(source, /openExternalUrl\(resolvedHref, "ripple-markdown-link"\)/);
}

function testMarkdownTablesUseReadableTableClasses() {
  const html = renderToStaticMarkup(
    <MarkdownRenderer
      content={[
        "| 编号 | 代号 | 已知事实身份 / 信息 | 截至本地章节的结局 |",
        "|---|---|---|---|",
        "| No.1 | 爱因斯坦 | 会长。疑似历史上的爱因斯坦本人。 | 没有明确死亡。 |",
      ].join("\n")}
    />
  );

  assert.match(html, /markdown-table-wrap/);
  assert.match(html, /markdown-table"/);
  assert.match(html, /markdown-table-cell/);
}

function testCodeBlocksWrapLongLinesWithoutHorizontalScroll() {
  const html = renderToStaticMarkup(
    <MarkdownRenderer
      content={"```text\nbwrap: Can't create file at .../workspace/.agents: Is a directory\n```"}
    />
  );

  assert.match(html, /whitespace-pre-wrap/);
  assert.match(html, /\[overflow-wrap:anywhere\]/);
  assert.doesNotMatch(html, /overflow-x-auto/);
  assert.doesNotMatch(html, /break-all/);
}

function testCodeBlocksUseReadableTypeSize() {
  const html = renderToStaticMarkup(<MarkdownRenderer content={"```text\n名称:\n用途:\n```"} />);

  assert.match(html, /text-\[13px\]/);
  assert.match(html, /leading-\[20px\]/);
  assert.doesNotMatch(html, /text-\[11px\]/);
}

function testGlobalCodeBlockCssKeepsWrappingEnabled() {
  const preRule = cssRule(".markdown-body pre");
  const preCodeRule = cssRule(".markdown-body pre code");

  assert.match(preRule, /overflow-x:\s*hidden/);
  assert.match(preRule, /white-space:\s*pre-wrap/);
  assert.match(preRule, /overflow-wrap:\s*anywhere/);
  assert.match(preCodeRule, /display:\s*block/);
  assert.match(preCodeRule, /min-width:\s*0/);
  assert.match(preCodeRule, /white-space:\s*inherit/);
  assert.match(preCodeRule, /overflow-wrap:\s*inherit/);
}

testPreservesSingleNewlineAsLineBreak();
testFeishuAuthCardDoesNotCompleteAuthDirectly();
testFeishuAuthCardShowsWaitingState();
testFeishuAuthCardSeparatesConnectAndSkillText();
testGoogleAuthCardGuidesManualTwoStepFlow();
testGoogleAuthCardSeparatesConnectAndSkillText();
testGoogleAuthCardConsumesLegacyChineseTrailingInstruction();
testGoogleAuthCardUsesChineseI18nText();
testGoogleAuthorizedCardUsesI18nText();
testFeishuAndNotionAuthorizedCardsUseI18nText();
testNotionTokenCardSeparatesConnectAndSkillText();
testConnectorAuthLinksUseScopedButtonStyles();
testConnectorAuthCardsUseSoftTileHeaders();
testBilibiliAuthCardShowsQrAndManualOpenLink();
testBilibiliSkillAuthCardExplainsRequirement();
testBilibiliAuthorizedCardUsesI18nText();
testBilibiliAuthCardConsumesLegacyChineseTrailingInstruction();
testBilibiliAuthCardUsesChineseI18nText();
testRegularMarkdownLinksUseTauriAwareExternalOpener();
testMarkdownTablesUseReadableTableClasses();
testCodeBlocksWrapLongLinesWithoutHorizontalScroll();
testCodeBlocksUseReadableTypeSize();
testGlobalCodeBlockCssKeepsWrappingEnabled();

console.log("markdown renderer tests passed");
