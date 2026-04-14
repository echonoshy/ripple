import assert from "node:assert/strict";

import { applyTaskUpdate, shouldRenderAssistantMessage, upsertTask } from "./chatState";
import type { Message, TaskInfo } from "@/types";

function testShouldHideEmptyAssistantWithOnlyToolCalls() {
  const message: Message = {
    id: "assistant-1",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "tool-1",
        name: "Bash",
        arguments: { command: "echo hello" },
        status: "success",
      },
    ],
  };

  assert.equal(shouldRenderAssistantMessage(message, false, false), false);
  assert.equal(shouldRenderAssistantMessage(message, true, true), true);
}

function testUpsertTaskReplacesPlaceholderWithRealTask() {
  const placeholder: TaskInfo = {
    id: "编写节点拉",
    subject: "编写节点拉取 RSS 指南脚本",
    status: "pending",
  };
  const realTask: TaskInfo = {
    id: "task-123",
    subject: "编写节点拉取 RSS 指南脚本",
    status: "pending",
  };

  const merged = upsertTask([placeholder], realTask);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "task-123");
  assert.equal(merged[0].subject, realTask.subject);
}

function testApplyTaskUpdateFallsBackToSameSubjectPlaceholder() {
  const tasks: TaskInfo[] = [
    {
      id: "编写节点拉",
      subject: "编写节点拉取 RSS 指南脚本",
      status: "pending",
    },
  ];

  const updated = applyTaskUpdate(tasks, {
    id: "task-123",
    subject: "编写节点拉取 RSS 指南脚本",
    status: "completed",
  });

  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, "task-123");
  assert.equal(updated[0].status, "completed");
}

function testShouldShowAssistantWithAskUser() {
  const message: Message = {
    id: "assistant-2",
    role: "assistant",
    content: "",
    askUser: { question: "Which option?", options: ["A", "B"] },
  };

  assert.equal(shouldRenderAssistantMessage(message, false, true), true);
  assert.equal(shouldRenderAssistantMessage(message, false, false), true);
}

function testShouldShowAssistantWithPermissionRequest() {
  const message: Message = {
    id: "assistant-3",
    role: "assistant",
    content: "",
    permissionRequest: { tool: "Bash", params: { command: "rm -rf" }, riskLevel: "high" },
  };

  assert.equal(shouldRenderAssistantMessage(message, false, true), true);
  assert.equal(shouldRenderAssistantMessage(message, false, false), true);
}

testShouldHideEmptyAssistantWithOnlyToolCalls();
testShouldShowAssistantWithAskUser();
testShouldShowAssistantWithPermissionRequest();
testUpsertTaskReplacesPlaceholderWithRealTask();
testApplyTaskUpdateFallsBackToSameSubjectPlaceholder();

console.log("chatState tests passed");
