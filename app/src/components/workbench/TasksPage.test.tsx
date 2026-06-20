import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, type LocalePreference } from "@/i18n";
import type { TaskActionInfo, TaskEventInfo, TaskInfo, TaskTriggerInfo } from "@/types";
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
    nextWakeupAt: "2026-06-18T09:00:00.000Z",
    lastRunId: "job-quote-1",
    lastError: "缺少客户预算信息",
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
  {
    eventId: "evt-3",
    taskId: "task-client-plan",
    userId: "default",
    eventType: "task_action_due_triggered",
    payload: { action_id: "act-quote" },
    createdAt: "2026-06-17T09:03:00.000Z",
  },
  {
    eventId: "evt-2",
    taskId: "task-client-plan",
    userId: "default",
    eventType: "task_action_blocked",
    payload: { action_id: "act-quote", status: "blocked" },
    createdAt: "2026-06-17T09:05:00.000Z",
  },
];

const triggers: TaskTriggerInfo[] = [
  {
    trigger_id: "trg-trip",
    trigger_type: "time",
    user_id: "default",
    title: "明早提醒",
    prompt: "提醒准备材料",
    kind: "once",
    timezone: "Asia/Shanghai",
    run_at: "2026-06-18T07:30:00+08:00",
    interval_seconds: null,
    enabled: true,
    status: "active",
    next_run_at: "2026-06-17T23:30:00Z",
    last_run_at: null,
    last_run_id: "job-sch-trip",
    last_error: null,
    cwd: null,
    model: null,
    effort: null,
    summary: null,
    output_schema: null,
    max_runtime_seconds: 1800,
    max_runs: 1,
    task_id: "task-client-plan",
    task_action_id: "act-quote",
    run_count: 1,
    created_at: "2026-06-17T10:00:00Z",
    updated_at: "2026-06-17T10:00:00Z",
  },
];

function renderTasksPage(
  locale: LocalePreference = "zh-CN",
  props: Partial<React.ComponentProps<typeof TasksPage>> = {}
) {
  return renderToStaticMarkup(
    <I18nProvider initialPreference={locale}>
      <TasksPage
        userId="default"
        selectedTaskId="task-client-plan"
        tasks={[task]}
        actions={actions}
        events={events}
        triggers={triggers}
        isLoading={false}
        error={null}
        onRefresh={noop}
        onSelectTask={noop}
        onOpenSession={noop}
        onConfirmTask={noop}
        onRunTaskNow={noop}
        onCancelTask={noop}
        onDeleteTask={noop}
        {...props}
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
  assert.match(html, /查看来源会话/);
  assert.match(html, /缺少客户预算信息/);
  assert.match(html, /job-quote-1/);
  assert.match(html, /删除/);
  assert.match(html, /计划/);
  assert.match(html, /步骤计划/);
  assert.match(html, /触发器/);
  assert.match(html, /明早提醒/);
  assert.match(html, /运行 1\/1/);
  assert.match(html, /job-sch-trip/);
  assert.match(html, /步骤受阻/);
  assert.match(html, /到期执行步骤/);
  assert.match(html, /开始执行步骤/);
  assert.ok(html.indexOf("步骤受阻") < html.indexOf("开始执行步骤"));
}

function testPrimaryNavigationNoLongerIncludesAutos() {
  const source = readFileSync(new URL("../../lib/workspaceViews.ts", import.meta.url), "utf8");
  const mainNavItemsSource = source.slice(
    source.indexOf("export const mainNavItems"),
    source.indexOf("export const mobileNavItems")
  );

  assert.doesNotMatch(mainNavItemsSource, /label: "Autos"/);
  assert.doesNotMatch(mainNavItemsSource, /id: "automations"/);
}

function testTasksPageKeepsAutomationOutOfPrimaryNavigation() {
  const source = readFileSync(new URL("./TasksPage.tsx", import.meta.url), "utf8");

  assert.match(source, /data-ripple-task-page/);
  assert.match(source, /data-ripple-task-list/);
  assert.match(source, /data-ripple-task-detail/);
  assert.match(source, /fetchAllTaskTriggers/);
  assert.doesNotMatch(source, /fetchSchedules/);
  assert.doesNotMatch(source, /disconnectConnector/);
}

function testTasksPageUsesFocusSplitLayout() {
  const html = renderTasksPage();

  assert.match(html, /data-ripple-task-focus-split="true"/);
  assert.match(html, /data-ripple-task-inbox="true"/);
  assert.match(html, /data-ripple-task-summary="true"/);
  assert.match(html, /data-ripple-task-actions-panel="true"/);
  assert.match(html, /data-ripple-task-activity-panel="true"/);
  assert.match(html, /当前步骤/);
  assert.match(html, /活动记录/);
}

function testTasksPageShowsPendingConfirmationTriggers() {
  const pendingTrigger: TaskTriggerInfo = {
    ...triggers[0],
    trigger_id: "trg-pending",
    enabled: false,
    status: "pending_confirmation",
    last_run_id: null,
    run_count: 0,
  };
  const html = renderTasksPage("en-US", { triggers: [pendingTrigger] });

  assert.match(html, /Pending confirmation/);
  assert.doesNotMatch(html, />Paused</);
}

function testTasksPageLoadingStateDoesNotClaimFailure() {
  const html = renderTasksPage("en-US", {
    selectedTaskId: null,
    tasks: [],
    actions: [],
    events: [],
    triggers: [],
    isLoading: true,
  });

  assert.match(html, /Loading tasks/);
  assert.doesNotMatch(html, /Failed to load tasks/);
}

function testTasksPageRequiresConfirmationForDestructiveActions() {
  const source = readFileSync(new URL("./TasksPage.tsx", import.meta.url), "utf8");

  assert.match(source, /confirmingTaskAction/);
  assert.match(source, /tasks\.confirmCancel/);
  assert.match(source, /tasks\.confirmDelete/);
}

testTasksPageRendersTaskListAndDetail();
testPrimaryNavigationNoLongerIncludesAutos();
testTasksPageKeepsAutomationOutOfPrimaryNavigation();
testTasksPageUsesFocusSplitLayout();
testTasksPageShowsPendingConfirmationTriggers();
testTasksPageLoadingStateDoesNotClaimFailure();
testTasksPageRequiresConfirmationForDestructiveActions();

console.log("tasks page tests passed");
