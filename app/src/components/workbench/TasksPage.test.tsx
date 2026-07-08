import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { TaskSessionDetail, TaskSessionInfo } from "@/types";
import TasksPage, { taskSessionEmptyStateMessageKey } from "./TasksPage";

const session: TaskSessionInfo = {
  sessionId: "ts-client-plan",
  userId: "default",
  title: "整理客户方案",
  status: "pending_confirm",
  sourceSurface: "web_task_tab",
  sourceId: null,
  taskType: "todo",
  goal: "把会议纪要整理成可执行方案",
  executor: "vitana",
  latestMessage: "需要确认 TaskSpec",
  needsUserAction: true,
  currentTaskSpecId: "spec-client-plan",
  currentRunId: null,
  latestRunId: null,
  createdAt: "2026-07-08T08:00:00.000Z",
  updatedAt: "2026-07-08T09:00:00.000Z",
};

const detail: TaskSessionDetail = {
  taskSession: session,
  taskSpecs: [
    {
      taskSpecId: "spec-client-plan",
      sessionId: "ts-client-plan",
      userId: "default",
      taskType: "todo",
      goal: "把会议纪要整理成可执行方案",
      status: "pending_confirm",
      requiredFields: {},
      sourceRefs: [],
      riskLevel: "low",
      impactSummary: "确认后会生成客户方案草稿。",
      createdAt: "2026-07-08T08:10:00.000Z",
      updatedAt: "2026-07-08T08:10:00.000Z",
    },
  ],
  runs: [],
  confirmations: [],
  events: [
    {
      eventId: "evt-1",
      sessionId: "ts-client-plan",
      userId: "default",
      eventType: "task_spec_drafted",
      payload: { task_spec_id: "spec-client-plan" },
      createdAt: "2026-07-08T08:10:00.000Z",
    },
  ],
};

function renderTasksPage() {
  return renderToStaticMarkup(
    <TasksPage userId="default" initialSessions={[session]} initialDetail={detail} />
  );
}

function testTasksPageRendersTaskSessionDetail() {
  const html = renderTasksPage();

  assert.match(html, /Task Sessions/);
  assert.match(html, /整理客户方案/);
  assert.match(html, /待确认/);
  assert.match(html, /TaskSpec/);
  assert.match(html, /TaskRun/);
  assert.match(html, /确认卡/);
  assert.match(html, /task_spec_drafted/);
  assert.match(html, /data-ripple-task-page="true"/);
  assert.match(html, /data-ripple-task-list="true"/);
  assert.match(html, /data-ripple-task-detail="true"/);
}

function testTasksPageUsesTaskSessionsApiOnly() {
  const source = readFileSync(new URL("./TasksPage.tsx", import.meta.url), "utf8");

  assert.match(source, /fetchTaskSessions/);
  assert.match(source, /fetchTaskSession/);
  assert.match(source, /createTaskSession/);
  assert.doesNotMatch(source, /fetchTasks/);
  assert.doesNotMatch(source, /runTaskNow/);
  assert.doesNotMatch(source, /fetchAllTaskTriggers/);
  assert.doesNotMatch(source, /createTaskAction/);
}

function testTasksPageDistinguishesEmptyStates() {
  assert.equal(taskSessionEmptyStateMessageKey(0, 0), "tasks.noTaskSessions");
  assert.equal(taskSessionEmptyStateMessageKey(2, 0), "tasks.noTaskSessionsForFilter");
}

testTasksPageRendersTaskSessionDetail();
testTasksPageUsesTaskSessionsApiOnly();
testTasksPageDistinguishesEmptyStates();
