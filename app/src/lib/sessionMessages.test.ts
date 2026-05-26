import assert from "node:assert/strict";

import type { SessionDetail } from "@/types";
import { extractSessionMessageText, mapSessionMessages } from "./sessionMessages";

function makeSessionDetail(overrides: Partial<SessionDetail>): SessionDetail {
  return {
    sessionId: "srv-messages",
    title: "Message mapping",
    pinned: false,
    model: "codex-medium",
    createdAt: "2026-05-19T00:00:00.000Z",
    lastActiveAt: "2026-05-19T00:00:00.000Z",
    messageCount: 0,
    status: "idle",
    changedFileCount: 0,
    pendingApprovalCount: 0,
    messages: [],
    ...overrides,
  };
}

function testExtractsTextAndAttachedFiles() {
  assert.equal(
    extractSessionMessageText([
      { type: "text", text: "Please inspect this" },
      {
        type: "attachment",
        file: { name: "设计稿.png", path: "/workspace/uploads/2026/05/设计稿.png" },
      },
    ]),
    "Please inspect this\n\nAttached files:\n- 设计稿.png (/workspace/uploads/2026/05/设计稿.png)"
  );
}

function testMapsInternalMessagesAndPendingInteractions() {
  const messages = mapSessionMessages(
    makeSessionDetail({
      pendingQuestion: "Which path should I take?",
      pendingOptions: ["A", "B"],
      pendingPermissionRequest: {
        tool: "exec_command",
        params: { command: "bun test src" },
        riskLevel: "medium",
      },
      messages: [
        {
          type: "user",
          created_at: "2026-05-19T00:00:01.000Z",
          message: { content: [{ type: "text", text: "Run the checks" }] },
        },
        {
          type: "assistant",
          created_at: "2026-05-19T00:00:02.000Z",
          message: {
            content: [
              {
                type: "tool_use",
                id: "ask-1",
                name: "AskUser",
                input: { question: "Proceed?", options: ["Yes"] },
              },
              { type: "text", text: "I can do that." },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "ask-1", content: "Yes", is_error: false },
            ],
          },
        },
      ],
    })
  );

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content, "Run the checks");
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].content, "I can do that.");
  assert.equal(messages[1].toolCalls?.[0]?.result, "Yes");
  assert.equal(messages[1].toolCalls?.[0]?.status, "success");
  assert.deepEqual(messages[1].askUser, {
    question: "Which path should I take?",
    options: ["A", "B"],
  });
  assert.deepEqual(messages[1].permissionRequest, {
    tool: "exec_command",
    params: { command: "bun test src" },
    riskLevel: "medium",
  });
}

testExtractsTextAndAttachedFiles();
testMapsInternalMessagesAndPendingInteractions();

console.log("session messages tests passed");
