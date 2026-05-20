import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import MarkdownRenderer from "./MarkdownRenderer";

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

testPreservesSingleNewlineAsLineBreak();
testFeishuAuthCardDoesNotCompleteAuthDirectly();
testFeishuAuthCardShowsWaitingState();
testGoogleAuthCardDoesNotAskForManualCallback();

console.log("markdown renderer tests passed");
