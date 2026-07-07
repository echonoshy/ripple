import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, type LocalePreference } from "@/i18n";
import type { TaskActionInfo, TaskEventInfo, TaskInfo, TaskTriggerInfo } from "@/types";
import TasksPage, { taskEmptyStateMessageKey } from "./TasksPage";

const noop = () => {};

const task: TaskInfo = {
  taskId: "task-client-plan",
  userId: "default",
  title: "整理客户方案",
  objective: "把会议纪要整理成可执行方案",
  status: "in_progress",
  priority: "normal",
  pinned: false,
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
        onCreateScheduledTaskChat={noop}
        onEditScheduledTaskChat={noop}
        {...props}
      />
    </I18nProvider>
  );
}

function testTasksPageRendersTaskListAndDetail() {
  const html = renderTasksPage();

  assert.match(html, />定时任务</);
  assert.match(html, /整理客户方案/);
  assert.doesNotMatch(html, /1\/3/);
  assert.doesNotMatch(html, /33%/);
  assert.doesNotMatch(html, /整理会议纪要/);
  assert.match(html, /查看来源会话/);
  assert.doesNotMatch(html, /缺少客户预算信息/);
  assert.doesNotMatch(html, /job-quote-1/);
  assert.match(html, /删除/);
  assert.match(html, /时间触发/);
  assert.doesNotMatch(html, /步骤计划/);
  assert.match(html, /明早提醒/);
  assert.match(html, /运行 1\/1/);
  assert.match(html, /job-sch-trip/);
  assert.match(html, /执行受阻/);
  assert.doesNotMatch(html, /到期执行步骤/);
  assert.match(html, /开始执行/);
  assert.ok(html.indexOf("执行受阻") < html.indexOf("开始执行"));
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

function testTasksPageKeepsChatCreationOutOfEmptyState() {
  const source = readFileSync(new URL("./TasksPage.tsx", import.meta.url), "utf8");
  const html = renderTasksPage("en-US", { tasks: [], actions: [], events: [], triggers: [] });
  const emptyStateStart = source.indexOf("orderedTasks.length === 0 && !loading");
  const taskMapStart = source.indexOf("{orderedTasks.map", emptyStateStart);
  const emptyStateSource = source.slice(emptyStateStart, taskMapStart);

  assert.match(source, /onCreateScheduledTaskChat\?: \(\) => void/);
  assert.match(source, /data-ripple-create-scheduled-task-chat="true"/);
  assert.match(html, />Create in chat</);
  assert.match(html, /No scheduled tasks/);
  assert.doesNotMatch(emptyStateSource, /data-ripple-create-scheduled-task-chat="true"/);
}

function testTasksPageOffersChatEditingForSelectedTask() {
  const source = readFileSync(new URL("./TasksPage.tsx", import.meta.url), "utf8");
  const html = renderTasksPage("en-US");

  assert.match(
    source,
    /onEditScheduledTaskChat\?: \(task: TaskInfo, triggers: TaskTriggerInfo\[\]\) => void/
  );
  assert.match(source, /data-ripple-edit-scheduled-task-chat="true"/);
  assert.match(html, />Edit in chat</);
}

function testTasksPageUsesFocusSplitLayout() {
  const html = renderTasksPage();

  assert.match(html, /data-ripple-task-focus-split="true"/);
  assert.match(html, /data-ripple-task-inbox="true"/);
  assert.match(html, /data-ripple-task-summary="true"/);
  assert.match(html, /data-ripple-task-schedule-panel="true"/);
  assert.match(html, /data-ripple-task-activity-panel="true"/);
  assert.match(html, /下次执行/);
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

function testTasksPageShowsPendingConfirmationTaskStatus() {
  const pendingTask: TaskInfo = {
    ...task,
    status: "needs_confirmation",
    requiresConfirmation: true,
  };
  const html = renderTasksPage("en-US", {
    tasks: [pendingTask],
  });

  assert.match(html, />Needs confirmation</);
  assert.doesNotMatch(html, /needs_confirmation/);
}

function testTasksPageStacksMobileSummaryActionsBelowTitle() {
  const source = readFileSync(new URL("./TasksPage.tsx", import.meta.url), "utf8");
  const summaryStart = source.indexOf('data-ripple-task-summary="true"');
  const summaryStatsStart = source.indexOf('{t("tasks.nextRun")}', summaryStart);
  assert.notEqual(summaryStart, -1);
  assert.notEqual(summaryStatsStart, -1);
  const summaryHeaderSource = source.slice(summaryStart, summaryStatsStart);

  assert.match(summaryHeaderSource, /flex-col/);
  assert.match(summaryHeaderSource, /sm:flex-row/);
  assert.match(summaryHeaderSource, /sm:justify-between/);
  assert.match(summaryHeaderSource, /w-full/);
  assert.match(summaryHeaderSource, /sm:w-auto/);
}

function testTasksPageShowsFailedTriggersAsErrors() {
  const failedTrigger: TaskTriggerInfo = {
    ...triggers[0],
    trigger_id: "trg-failed",
    enabled: false,
    status: "error",
    last_run_status: "failed",
    last_error: "fake codex failed",
  };
  const html = renderTasksPage("en-US", { triggers: [failedTrigger] });

  assert.match(html, />Failed</);
  assert.match(html, /fake codex failed/);
  assert.doesNotMatch(html, />Paused</);
}

function testTasksPageShowsCompletedTriggersAsCompleted() {
  const completedTrigger: TaskTriggerInfo = {
    ...triggers[0],
    trigger_id: "trg-completed",
    enabled: false,
    status: "completed",
    last_run_status: "completed",
    run_count: 1,
    max_runs: 1,
  };
  const html = renderTasksPage("en-US", { triggers: [completedTrigger] });

  assert.match(html, />Completed</);
  assert.match(html, /No next run/);
  assert.doesNotMatch(html, /Next: Unknown/);
  assert.doesNotMatch(html, />Paused</);
  const completedTriggerStart = html.indexOf(">明早提醒<");
  const completedTriggerEnd = html.indexOf("Last run: job-sch-trip", completedTriggerStart);
  const completedTriggerHtml = html.slice(completedTriggerStart, completedTriggerEnd);
  assert.doesNotMatch(completedTriggerHtml, />Run again</);
  assert.doesNotMatch(completedTriggerHtml, />Run now</);
}

function testTasksPageExposesTriggerEditingControls() {
  const html = renderTasksPage("en-US", {
    triggers: [
      {
        ...triggers[0],
        kind: "interval",
        run_at: null,
        interval_seconds: 1800,
        max_runs: 5,
        run_count: 2,
      },
    ],
  });
  const source = readFileSync(new URL("./TasksPage.tsx", import.meta.url), "utf8");

  assert.match(source, /updateTaskTrigger/);
  assert.match(source, /deleteTaskTrigger/);
  assert.match(html, />Edit</);
  assert.match(html, />Pause</);
  assert.match(html, />Delete</);
  assert.match(html, /Every 30 min/);
  assert.match(html, /Runs 2\/5/);
}

function testCompletedTaskSummaryDoesNotShowStepProgress() {
  const completedTask: TaskInfo = {
    ...task,
    status: "completed",
    progress: {
      completed: 2,
      total: 2,
      percent: 100,
      currentActionId: null,
      currentActionTitle: null,
    },
  };
  const html = renderTasksPage("en-US", {
    tasks: [completedTask],
    actions: actions.map((action) => ({ ...action, status: "completed" })),
  });

  assert.doesNotMatch(html, /All steps completed/);
  assert.doesNotMatch(html, /Current execution/);
  assert.doesNotMatch(html, /Progress/);
}

function testTasksPageKeepsTaskActionsInternal() {
  const source = readFileSync(new URL("./TasksPage.tsx", import.meta.url), "utf8");
  const html = renderTasksPage("en-US");

  assert.doesNotMatch(html, /data-ripple-task-actions-panel="true"/);
  assert.doesNotMatch(html, />Execution steps</);
  assert.doesNotMatch(html, />Add step</);
  assert.doesNotMatch(html, />Sort</);
  assert.doesNotMatch(source, /editingActionId/);
  assert.doesNotMatch(source, /submitActionEdit/);
  assert.doesNotMatch(source, /updateTaskAction\(/);
}

function testTaskPageDoesNotExposeStepCreation() {
  const source = readFileSync(new URL("./TasksPage.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /createTaskAction/);
  assert.doesNotMatch(source, /tasks\.addAction/);
  assert.doesNotMatch(source, /tasks\.actionTitlePlaceholder/);
  assert.doesNotMatch(source, /newActionWakeupAt/);
  assert.doesNotMatch(source, /tasks\.optionalWakeupAt/);
  assert.doesNotMatch(source, /nextWakeupAt: newActionWakeupAt/);
}

function testTasksPageDoesNotExposeStepSortingMode() {
  const html = renderTasksPage("en-US");
  const source = readFileSync(new URL("./TasksPage.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(html, />Sort</);
  assert.doesNotMatch(html, /Move step up/);
  assert.doesNotMatch(html, /Move step down/);
  assert.doesNotMatch(source, /isActionSortMode/);
  assert.doesNotMatch(source, /draggable=\{isActionSortMode\}/);
  assert.doesNotMatch(source, /tasks\.finishSortingActions/);
  assert.doesNotMatch(source, /tasks\.cancelSortingActions/);
  assert.doesNotMatch(source, /tasks\.actionSortPosition/);
}

function testTimeTriggerFormBelongsToTheTask() {
  const source = readFileSync(new URL("./TasksPage.tsx", import.meta.url), "utf8");
  const html = renderTasksPage("en-US");

  assert.match(source, /createTaskTrigger\(selectedTask\.taskId/);
  assert.doesNotMatch(source, /createTaskActionTrigger/);
  assert.doesNotMatch(html, />Schedules</);
  assert.doesNotMatch(html, />Add schedule</);
  assert.match(html, />Time trigger</);
  assert.doesNotMatch(source, /newTriggerTitle/);
  assert.doesNotMatch(source, /newTriggerPrompt/);
  assert.doesNotMatch(source, /tasks\.triggerTitlePlaceholder/);
  assert.doesNotMatch(source, /tasks\.triggerPromptPlaceholder/);
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

  assert.match(html, /Loading scheduled tasks/);
  assert.doesNotMatch(html, /Failed to load scheduled tasks/);
}

function testTasksPageDistinguishesFilteredEmptyState() {
  assert.equal(taskEmptyStateMessageKey(0, 0), "tasks.noTasks");
  assert.equal(taskEmptyStateMessageKey(1, 0), "tasks.noTasks");
}

function testTasksPageDoesNotRenderStatusFilterTabs() {
  const source = readFileSync(new URL("./TasksPage.tsx", import.meta.url), "utf8");
  const html = renderTasksPage("en-US");

  assert.doesNotMatch(source, /data-ripple-task-desktop-filter-row/);
  assert.doesNotMatch(source, /type TaskFilter/);
  assert.doesNotMatch(source, /taskFilters/);
  assert.doesNotMatch(source, /activeFilter/);
  assert.doesNotMatch(html, />All</);
  assert.doesNotMatch(html, />Open</);
  assert.doesNotMatch(html, />Waiting</);
  assert.doesNotMatch(html, />Blocked</);
  assert.doesNotMatch(html, />Done</);
}

function testTasksPageUsesMobileIndexAndDetailSubpages() {
  const source = readFileSync(new URL("./TasksPage.tsx", import.meta.url), "utf8");

  assert.match(source, /data-ripple-task-mobile-index-page="true"/);
  assert.match(source, /data-ripple-task-mobile-detail-page="true"/);
  assert.match(source, /selectedMobileTaskId/);
  assert.match(source, /closeMobileTaskDetail/);
  assert.match(
    source,
    /<MobilePageHeader[\s\S]*?title=\{mobileDetailTask\.title\}[\s\S]*?onBack=\{closeMobileTaskDetail\}/
  );
}

function testTasksPageExposesQuickPinAndDeleteActions() {
  const source = readFileSync(new URL("./TasksPage.tsx", import.meta.url), "utf8");
  const html = renderTasksPage("en-US", {
    tasks: [{ ...task, pinned: true }],
  });

  assert.match(source, /updateTask/);
  assert.match(source, /toggleTaskPinned/);
  assert.match(source, /quickDeleteTask/);
  assert.match(source, /orderedTasks/);
  assert.match(html, /data-ripple-task-card-action="pin"/);
  assert.match(html, /data-ripple-task-card-action="delete"/);
  assert.match(html, /lucide-pin/);
  assert.match(html, />Unpin</);
}

function testTasksPageUsesMobileSwipeActionsForTasks() {
  const source = readFileSync(new URL("./TasksPage.tsx", import.meta.url), "utf8");
  const html = renderTasksPage("en-US");

  assert.match(source, /SwipeActionRow/);
  assert.match(source, /data-ripple-mobile-task-swipe/);
  assert.match(source, /leadingActions=\{\[/);
  assert.match(source, /trailingActions=\{\[/);
  assert.match(source, /key: "pin"/);
  assert.match(source, /key: "delete"/);
  assert.match(html, /data-ripple-swipe-row="true"/);
  assert.match(html, /data-ripple-mobile-task-swipe/);
  assert.match(html, /data-ripple-swipe-actions="leading"[^>]*opacity-0/);
  assert.match(html, /data-ripple-swipe-actions="trailing"[^>]*opacity-0/);
}

function testTasksMobileCardsAreSeparatedWithoutActiveSelection() {
  const source = readFileSync(new URL("./TasksPage.tsx", import.meta.url), "utf8");
  const html = renderTasksPage("en-US");

  assert.match(source, /data-ripple-task-card="true"/);
  assert.match(
    source,
    /const selected = isDesktopTaskLayout && selectedTask\?\.taskId === task\.taskId/
  );
  assert.match(source, /border-\[#DEE0E3\]/);
  assert.match(source, /shadow-\[0_1px_2px_rgba\(31,35,41,0\.04\)\]/);
  assert.doesNotMatch(html, /shadow-\[inset_3px_0_0_#1456F0\]/);
}

function testTasksMobileDetailSupportsSwipeBackGesture() {
  const source = readFileSync(new URL("./TasksPage.tsx", import.meta.url), "utf8");

  assert.match(source, /framer-motion/);
  assert.match(source, /shouldClaimMobileSwipeBack/);
  assert.match(source, /resolveTaskDetailBackSwipeRelease/);
  assert.match(source, /closeMobileTaskDetailWithSwipeCommit/);
  assert.match(source, /data-ripple-task-detail-swipe-sheet="true"/);
  assert.match(source, /onPointerDownCapture=\{handleTaskDetailSwipePointerDown\}/);
  assert.match(source, /onPointerMoveCapture=\{handleTaskDetailSwipePointerMove\}/);
  assert.match(source, /onPointerUpCapture=\{handleTaskDetailSwipePointerUp\}/);
  assert.match(source, /onTouchMoveCapture=\{handleTaskDetailSwipeTouchMoveCapture\}/);
}

function testTasksPageReloadIsNotKeyedToSelectionChanges() {
  const source = readFileSync(new URL("./TasksPage.tsx", import.meta.url), "utf8");
  const loadTasksStart = source.indexOf("const loadTasks = useCallback");
  const loadTasksEnd = source.indexOf("useEffect(() => {\n    if (!isControlled)", loadTasksStart);
  const loadTasksSource = source.slice(loadTasksStart, loadTasksEnd);
  const dependencyStart = loadTasksSource.lastIndexOf("[");
  const dependencyEnd = loadTasksSource.lastIndexOf("]");
  const dependencySource = loadTasksSource.slice(dependencyStart, dependencyEnd + 1);

  assert.match(loadTasksSource, /selectedIdRef\.current/);
  assert.doesNotMatch(dependencySource, /\bselectedId\b/);
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
testTasksPageKeepsChatCreationOutOfEmptyState();
testTasksPageOffersChatEditingForSelectedTask();
testTasksPageUsesFocusSplitLayout();
testTasksPageShowsPendingConfirmationTriggers();
testTasksPageShowsPendingConfirmationTaskStatus();
testTasksPageStacksMobileSummaryActionsBelowTitle();
testTasksPageShowsFailedTriggersAsErrors();
testTasksPageShowsCompletedTriggersAsCompleted();
testTasksPageExposesTriggerEditingControls();
testCompletedTaskSummaryDoesNotShowStepProgress();
testTasksPageKeepsTaskActionsInternal();
testTaskPageDoesNotExposeStepCreation();
testTasksPageDoesNotExposeStepSortingMode();
testTimeTriggerFormBelongsToTheTask();
testTasksPageLoadingStateDoesNotClaimFailure();
testTasksPageDistinguishesFilteredEmptyState();
testTasksPageDoesNotRenderStatusFilterTabs();
testTasksPageUsesMobileIndexAndDetailSubpages();
testTasksPageExposesQuickPinAndDeleteActions();
testTasksPageUsesMobileSwipeActionsForTasks();
testTasksMobileCardsAreSeparatedWithoutActiveSelection();
testTasksMobileDetailSupportsSwipeBackGesture();
testTasksPageReloadIsNotKeyedToSelectionChanges();
testTasksPageRequiresConfirmationForDestructiveActions();

console.log("tasks page tests passed");
