import assert from "node:assert/strict";

import * as chatState from "./chatState";
import type { Message, PlanStep, PlanUpdate } from "@/types";

const { applyPlanStepUpdate, shouldRenderAssistantMessage, upsertPlanStep } = chatState;

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

function testUpsertPlanStepReplacesPlaceholderWithRealStep() {
  const placeholder: PlanStep = {
    id: "编写节点拉",
    subject: "编写节点拉取 RSS 指南脚本",
    status: "pending",
  };
  const realStep: PlanStep = {
    id: "plan-step-123",
    subject: "编写节点拉取 RSS 指南脚本",
    status: "pending",
  };

  const merged = upsertPlanStep([placeholder], realStep);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "plan-step-123");
  assert.equal(merged[0].subject, realStep.subject);
}

function testApplyPlanStepUpdateFallsBackToSameSubjectPlaceholder() {
  const steps: PlanStep[] = [
    {
      id: "编写节点拉",
      subject: "编写节点拉取 RSS 指南脚本",
      status: "pending",
    },
  ];

  const updated = applyPlanStepUpdate(steps, {
    id: "plan-step-123",
    subject: "编写节点拉取 RSS 指南脚本",
    status: "completed",
  });

  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, "plan-step-123");
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

function testApplyPlanUpdateReplacesCurrentPlanSnapshot() {
  const update: PlanUpdate = {
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

  const next = chatState.applyPlanUpdate?.(
    [{ id: "old", subject: "Old plan item", status: "pending" }],
    update
  ) ?? { planSteps: [], planProgress: null };

  assert.deepEqual(next.planSteps, update.steps);
  assert.deepEqual(next.planProgress, update.progress);
}

function testApplyPlanUpdateClearsPlanWhenAllStepsComplete() {
  const update: PlanUpdate = {
    steps: [{ id: "codex-plan:turn-1:0", subject: "Verify behavior", status: "completed" }],
    progress: {
      completed: 1,
      total: 1,
      currentTask: undefined,
    },
    allCompleted: true,
  };

  const next = chatState.applyPlanUpdate?.(
    [{ id: "codex-plan:turn-1:0", subject: "Verify behavior", status: "in_progress" }],
    update
  ) ?? {
    planSteps: [{ id: "fallback", subject: "missing implementation", status: "pending" }],
    planProgress: update.progress,
  };

  assert.deepEqual(next.planSteps, []);
  assert.equal(next.planProgress, null);
}

function testClearPlanStateReturnsEmptySnapshot() {
  const next = chatState.clearPlanState?.() ?? {
    planSteps: [{ id: "fallback", subject: "missing implementation", status: "pending" }],
    planProgress: { completed: 0, total: 1 },
  };

  assert.deepEqual(next.planSteps, []);
  assert.equal(next.planProgress, null);
}

testShouldHideEmptyAssistantWithOnlyToolCalls();
testShouldShowAssistantWithAskUser();
testShouldShowAssistantWithPermissionRequest();
testUpsertPlanStepReplacesPlaceholderWithRealStep();
testApplyPlanStepUpdateFallsBackToSameSubjectPlaceholder();
testApplyPlanUpdateReplacesCurrentPlanSnapshot();
testApplyPlanUpdateClearsPlanWhenAllStepsComplete();
testClearPlanStateReturnsEmptySnapshot();

console.log("chatState tests passed");
