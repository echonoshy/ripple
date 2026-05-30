import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import MarkdownRenderer from "./MarkdownRenderer";

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
  const html = renderToStaticMarkup(
    <MarkdownRenderer
      content={"[FEISHU_AUTH]\ndevice_code: device-123\nhttps://accounts.feishu.cn/device"}
    />
  );

  assert.match(html, /打开授权页面/);
  assert.match(html, /自动继续当前任务/);
  assert.doesNotMatch(html, /好了/);
}

function testFeishuAuthCardShowsWaitingState() {
  const html = renderToStaticMarkup(
    <MarkdownRenderer
      content={"[FEISHU_AUTH]\nhttps://accounts.feishu.cn/device"}
      feishuAuthWaiting={{
        connector: "feishu",
        url: "https://accounts.feishu.cn/device",
        elapsedSeconds: 12,
        label: "飞书操作",
      }}
    />
  );

  assert.match(html, /正在等待你在浏览器完成飞书操作/);
  assert.match(html, /已等待 12 秒/);
}

function testGoogleAuthCardDoesNotAskForManualCallback() {
  const html = renderToStaticMarkup(
    <MarkdownRenderer
      content={"[GOOGLE_AUTH]\nhttps://accounts.google.com/o/oauth2/auth?state=abc"}
    />
  );

  assert.match(html, /打开 Google 授权/);
  assert.match(html, /自动继续刚才的请求/);
  assert.doesNotMatch(html, /callback URL/);
  assert.doesNotMatch(html, /好了/);
}

function testConnectorAuthLinksUseScopedButtonStyles() {
  const googleHtml = renderToStaticMarkup(
    <MarkdownRenderer
      content={"[GOOGLE_AUTH]\nhttps://accounts.google.com/o/oauth2/auth?state=abc"}
    />
  );
  const feishuHtml = renderToStaticMarkup(
    <MarkdownRenderer content={"[FEISHU_AUTH]\nhttps://accounts.feishu.cn/device"} />
  );
  const bilibiliHtml = renderToStaticMarkup(
    <MarkdownRenderer
      content={
        "[BILIBILI_AUTH]\n" +
        "/v1/bilibili/qrcode.png?content=encoded\n" +
        "https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=abc\n" +
        "bilibili://browser?url=https%3A%2F%2Faccount.bilibili.com%2Fh5%2Faccount-h5%2Fauth%2Fscan-web%3Fqrcode_key%3Dabc"
      }
    />
  );

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
  const googleHtml = renderToStaticMarkup(
    <MarkdownRenderer
      content={"[GOOGLE_AUTH]\nhttps://accounts.google.com/o/oauth2/auth?state=abc"}
    />
  );
  const feishuHtml = renderToStaticMarkup(
    <MarkdownRenderer content={"[FEISHU_AUTH]\nhttps://accounts.feishu.cn/device"} />
  );

  assert.match(googleHtml, /data-ripple-icon-tile="true"/);
  assert.match(googleHtml, /data-tone="accent"/);
  assert.match(feishuHtml, /data-ripple-icon-tile="true"/);
}

function testBilibiliAuthCardShowsQrAndManualOpenLink() {
  const html = renderToStaticMarkup(
    <MarkdownRenderer
      content={
        "[BILIBILI_AUTH]\n" +
        "/v1/bilibili/qrcode.png?content=encoded\n" +
        "https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=abc\n" +
        "bilibili://browser?url=https%3A%2F%2Faccount.bilibili.com%2Fh5%2Faccount-h5%2Fauth%2Fscan-web%3Fqrcode_key%3Dabc"
      }
    />
  );

  assert.match(html, /B 站扫码登录/);
  assert.match(html, /src="[^"]*\/v1\/bilibili\/qrcode\.png\?content=encoded"/);
  assert.match(html, /打开 B 站授权链接/);
  assert.match(html, /扫码或点链接确认后/);
  assert.match(html, /好了/);
  assert.doesNotMatch(html, /自动继续/);
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
testGoogleAuthCardDoesNotAskForManualCallback();
testConnectorAuthLinksUseScopedButtonStyles();
testConnectorAuthCardsUseSoftTileHeaders();
testBilibiliAuthCardShowsQrAndManualOpenLink();
testMarkdownTablesUseReadableTableClasses();
testCodeBlocksWrapLongLinesWithoutHorizontalScroll();
testGlobalCodeBlockCssKeepsWrappingEnabled();

console.log("markdown renderer tests passed");
