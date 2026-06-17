import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, type LocalePreference } from "@/i18n";
import type { TaskActionInfo, TaskEventInfo, TaskInfo } from "@/types";
import TasksPage from "./TasksPage";

const noop = () => {};

const task: TaskInfo = {
  taskId: "task-client-plan",
  userId: "default",
  title: "整理客户方案",
  objective: "把会议纪要整理成可执行方案",
  status: "in_progress",
  priority: "normal",
  requiresConfirmation: false,
  sourceSessionId: "srv-client",
  progress: {
    completed: 1,
    total: 3,
    percent: 33,
    currentActionId: "act-quote",
    currentActionTitle: "生成报价",
  },
  createdAt: "2026-06-17T08:00:00.000Z",
  updatedAt: "2026-06-17T09:00:00.000Z",
};

const actions: TaskActionInfo[] = [
  {
    actionId: "act-notes",
    taskId: "task-client-plan",
    userId: "default",
    kind: "next_step",
    title: "整理会议纪要",
    objective: "提炼客户需求",
    status: "completed",
    assignee: "codex",
    requiresConfirmation: false,
    resultSummary: "已提炼预算和时间线。",
    createdAt: "2026-06-17T08:00:00.000Z",
    updatedAt: "2026-06-17T08:30:00.000Z",
  },
  {
    actionId: "act-quote",
    taskId: "task-client-plan",
    userId: "default",
    kind: "next_step",
    title: "生成报价",
    objective: "形成报价草案",
    status: "in_progress",
    assignee: "codex",
    requiresConfirmation: false,
    createdAt: "2026-06-17T08:30:00.000Z",
    updatedAt: "2026-06-17T09:00:00.000Z",
  },
];

const events: TaskEventInfo[] = [
  {
    eventId: "evt-1",
    taskId: "task-client-plan",
    userId: "default",
    eventType: "task_action_started",
    payload: { action_id: "act-quote" },
    createdAt: "2026-06-17T09:00:00.000Z",
  },
];

function renderTasksPage(locale: LocalePreference = "zh-CN") {
  return renderToStaticMarkup(
    <I18nProvider initialPreference={locale}>
      <TasksPage
        userId="default"
        selectedTaskId="task-client-plan"
        tasks={[task]}
        actions={actions}
        events={events}
        isLoading={false}
        error={null}
        onRefresh={noop}
        onSelectTask={noop}
        onOpenSession={noop}
        onConfirmTask={noop}
        onRunTaskNow={noop}
        onCancelTask={noop}
      />
    </I18nProvider>
  );
}

function testTasksPageRendersTaskListAndDetail() {
  const html = renderTasksPage();

  assert.match(html, />任务</);
  assert.match(html, /整理客户方案/);
  assert.match(html, /1\/3/);
  assert.match(html, /33%/);
  assert.match(html, /生成报价/);
  assert.match(html, /整理会议纪要/);
  assert.match(html, /来自会话/);
}

function testTasksPageKeepsAutomationOutOfPrimaryNavigation() {
  const source = readFileSync(new URL("./TasksPage.tsx", import.meta.url), "utf8");

  assert.match(source, /data-ripple-task-page/);
  assert.match(source, /data-ripple-task-list/);
  assert.match(source, /data-ripple-task-detail/);
  assert.doesNotMatch(source, /fetchSchedules/);
  assert.doesNotMatch(source, /disconnectConnector/);
}

testTasksPageRendersTaskListAndDetail();
testTasksPageKeepsAutomationOutOfPrimaryNavigation();

console.log("tasks page tests passed");
