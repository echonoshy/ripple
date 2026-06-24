import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/i18n";
import ClientContextDemoPage from "./ClientContextDemoPage";

function testDemoPageRendersVisibleContextValues() {
  const html = renderToStaticMarkup(
    <I18nProvider initialPreference="zh-CN">
      <ClientContextDemoPage />
    </I18nProvider>
  );

  assert.match(html, /data-ripple-client-context-demo-page="true"/);
  assert.match(html, /会议详情/);
  assert.match(html, /产品周会/);
  assert.match(html, /Viaim Meeting/);
  assert.match(html, /左耳 80%/);
  assert.match(html, /右耳 78%/);
  assert.match(html, /充电盒 55%/);
  assert.match(html, /已连接/);
  assert.match(html, /主动降噪/);
  assert.match(html, /未录音/);
  assert.match(html, /Mock 数据/);
  assert.match(html, /现在耳机电量是多少？/);
}

function testMainUsesDedicatedDemoRoute() {
  const mainSource = readFileSync(new URL("../../main.tsx", import.meta.url), "utf8");

  assert.match(mainSource, /ClientContextDemoPage/);
  assert.match(mainSource, /client-context-demo/);
  assert.match(mainSource, /window\.location\.pathname/);
}

testDemoPageRendersVisibleContextValues();
testMainUsesDedicatedDemoRoute();

console.log("client context demo page tests passed");
