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

  assert.match(html, /打开授权链接/);
  assert.match(html, /自动继续当前任务/);
  assert.doesNotMatch(html, /好了/);
}

testPreservesSingleNewlineAsLineBreak();
testFeishuAuthCardDoesNotCompleteAuthDirectly();

console.log("markdown renderer tests passed");
