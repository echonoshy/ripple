import assert from "node:assert/strict";

import * as chatState from "./chatState";
import type { Message, TaskInfo, TaskPlanUpdate } from "@/types";

const { applyTaskUpdate, shouldRenderAssistantMessage, upsertTask } = chatState;

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

function testApplyTaskPlanUpdateReplacesCurrentPlanSnapshot() {
  const update: TaskPlanUpdate = {
    steps: [
      { id: "codex-plan:turn-1:0", subject: "Inspect current bridge", status: "completed" },
      { id: "codex-plan:turn-1:1", subject: "Map event to UI", status: "in_progress" },
    ],
    progress: {
      completed: 1,
      total: 2,
      currentTask: "Map event to UI",
    },
    allCompleted: false,
  };

  const next = chatState.applyTaskPlanUpdate?.(
    [{ id: "old", subject: "Old plan item", status: "pending" }],
    update
  ) ?? { taskSteps: [], taskProgress: null };

  assert.deepEqual(next.taskSteps, update.steps);
  assert.deepEqual(next.taskProgress, update.progress);
}

function testApplyTaskPlanUpdateClearsPlanWhenAllStepsComplete() {
  const update: TaskPlanUpdate = {
    steps: [{ id: "codex-plan:turn-1:0", subject: "Verify behavior", status: "completed" }],
    progress: {
      completed: 1,
      total: 1,
      currentTask: undefined,
    },
    allCompleted: true,
  };

  const next = chatState.applyTaskPlanUpdate?.(
    [{ id: "codex-plan:turn-1:0", subject: "Verify behavior", status: "in_progress" }],
    update
  ) ?? {
    taskSteps: [{ id: "fallback", subject: "missing implementation", status: "pending" }],
    taskProgress: update.progress,
  };

  assert.deepEqual(next.taskSteps, []);
  assert.equal(next.taskProgress, null);
}

function testClearTaskPlanStateReturnsEmptySnapshot() {
  const next = chatState.clearTaskPlanState?.() ?? {
    taskSteps: [{ id: "fallback", subject: "missing implementation", status: "pending" }],
    taskProgress: { completed: 0, total: 1 },
  };

  assert.deepEqual(next.taskSteps, []);
  assert.equal(next.taskProgress, null);
}

testShouldHideEmptyAssistantWithOnlyToolCalls();
testShouldShowAssistantWithAskUser();
testShouldShowAssistantWithPermissionRequest();
testUpsertTaskReplacesPlaceholderWithRealTask();
testApplyTaskUpdateFallsBackToSameSubjectPlaceholder();
testApplyTaskPlanUpdateReplacesCurrentPlanSnapshot();
testApplyTaskPlanUpdateClearsPlanWhenAllStepsComplete();
testClearTaskPlanStateReturnsEmptySnapshot();

console.log("chatState tests passed");
