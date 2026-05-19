import assert from "node:assert/strict";

import { chatErrorContent } from "./chatErrors";

function testUsesBackendErrorMessageWhenAvailable() {
  assert.equal(
    chatErrorContent(new Error("timed out waiting for Codex app-server response to thread/start")),
    "timed out waiting for Codex app-server response to thread/start"
  );
}

function testFallsBackWhenErrorMessageIsEmpty() {
  assert.equal(chatErrorContent(new Error("")), "无法连接到 Ripple 服务。请确认服务端正在运行。");
}

testUsesBackendErrorMessageWhenAvailable();
testFallsBackWhenErrorMessageIsEmpty();

console.log("chat error tests passed");
