import assert from "node:assert/strict";

import {
  applyCurrentSessionRuntimeStatus,
  applySessionAttentionMarkers,
  codexRuntimeEventToTimelineEvent,
  extractChangedFilePaths,
  formatSessionActivityTime,
  mergeTimelineEvents,
  mergeInferredWorkbenchSessions,
  mapSessionSummariesToWorkbenchSessions,
  messagesToTimelineEvents,
  sortWorkbenchSessions,
  upsertRuntimeTimelineEvent,
} from "./workbench";
import type { CodexRuntimeEvent, Message, SessionSummary } from "@/types";

function makeSession(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    sessionId: "session-default",
    title: "",
    pinned: false,
    model: "codex-medium",
    createdAt: "2026-05-15T01:00:00.000Z",
    lastActiveAt: "2026-05-15T01:00:00.000Z",
    messageCount: 0,
    status: "idle",
    changedFileCount: 0,
    pendingApprovalCount: 0,
    ...overrides,
  };
}

function testMapsSessionSummariesToWorkbenchSummaries() {
  const sessions = mapSessionSummariesToWorkbenchSessions([
    makeSession({
      sessionId: "srv-auth",
      title: "Refactor auth flow",
      projectId: null,
      projectName: null,
      projectRoot: null,
      contextFolderPath: "/workspace/demo",
      status: "waiting_for_approval",
      messageCount: 3,
      changedFileCount: 2,
      pendingApprovalCount: 1,
    }),
    makeSession({
      sessionId: "srv-empty",
      title: "",
      status: "idle",
    }),
  ]);

  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].sessionId, "srv-auth");
  assert.equal(sessions[0].title, "Refactor auth flow");
  assert.equal(sessions[0].status, "waiting_for_approval");
  assert.equal(sessions[0].messageCount, 3);
  assert.equal(sessions[0].changedFileCount, 2);
  assert.equal(sessions[0].pendingApprovalCount, 1);
  assert.equal(sessions[0].attention, "needs_input");
  assert.equal(sessions[0].projectId, null);
  assert.equal(sessions[0].projectName, null);
  assert.equal(sessions[0].projectRoot, null);
  assert.equal(sessions[0].contextFolderPath, "/workspace/demo");
  assert.equal(sessions[1].title, "New Session");
  assert.equal(sessions[1].attention, undefined);
}

function testSortsSessionsByRecentActivity() {
  const sessions = mapSessionSummariesToWorkbenchSessions([
    makeSession({
      sessionId: "running",
      title: "Running session",
      status: "running",
      lastActiveAt: "2026-05-15T02:00:00.000Z",
    }),
    makeSession({
      sessionId: "approval",
      title: "Approval session",
      status: "awaiting_permission",
      lastActiveAt: "2026-05-15T01:00:00.000Z",
      pendingApprovalCount: 1,
    }),
  ]);

  const sorted = sortWorkbenchSessions(sessions);

  assert.equal(sorted[0].sessionId, "running");
  assert.equal(sorted[1].sessionId, "approval");
  assert.equal(sorted[1].status, "waiting_for_approval");
  assert.equal(sorted[1].attention, "needs_input");
  assert.equal(sorted[1].pendingApprovalCount, 1);
}

function testFormatsSessionActivityTimeLikeCodexSidebar() {
  const now = new Date(2026, 4, 25, 15, 30);

  assert.match(formatSessionActivityTime(new Date(2026, 4, 25, 9, 5).toISOString(), now), /9:05/);
  assert.equal(
    formatSessionActivityTime(new Date(2026, 4, 24, 23, 0).toISOString(), now),
    "Yesterday"
  );
  assert.equal(
    formatSessionActivityTime(new Date(2026, 4, 17, 12, 0).toISOString(), now),
    "May 17"
  );
  assert.equal(
    formatSessionActivityTime(new Date(2025, 11, 31, 12, 0).toISOString(), now),
    "Dec 31, 2025"
  );
  assert.equal(formatSessionActivityTime("not-a-date", now), "");
}

function testAppliesCurrentRunningStatusToExistingSession() {
  const sessions = mapSessionSummariesToWorkbenchSessions([
    makeSession({
      sessionId: "srv-current",
      title: "Current session",
      status: "idle",
      lastActiveAt: "2026-05-15T01:00:00.000Z",
    }),
    makeSession({
      sessionId: "srv-other",
      title: "Other session",
      status: "idle",
      lastActiveAt: "2026-05-15T02:00:00.000Z",
    }),
  ]);

  const updated = applyCurrentSessionRuntimeStatus(
    sessions,
    "srv-current",
    "running",
    "2026-05-15T03:00:00.000Z"
  );

  assert.equal(updated[0].sessionId, "srv-current");
  assert.equal(updated[0].status, "running");
  assert.equal(updated[0].attention, undefined);
  assert.equal(updated[0].lastActivityAt, "2026-05-15T03:00:00.000Z");
  assert.equal(updated[1].status, "idle");
}

function testAppliesCurrentApprovalStatusToExistingSession() {
  const sessions = mapSessionSummariesToWorkbenchSessions([
    makeSession({
      sessionId: "srv-current",
      title: "Current session",
      status: "idle",
    }),
  ]);

  const updated = applyCurrentSessionRuntimeStatus(sessions, "srv-current", "waiting_for_approval");

  assert.equal(updated[0].status, "waiting_for_approval");
  assert.equal(updated[0].attention, "needs_input");
}

function testAppliesUnreadCompletionAttentionOnlyOffCurrentSession() {
  const sessions = mapSessionSummariesToWorkbenchSessions([
    makeSession({
      sessionId: "srv-current",
      title: "Current session",
      status: "idle",
      lastActiveAt: "2026-05-15T02:00:00.000Z",
    }),
    makeSession({
      sessionId: "srv-background",
      title: "Background session",
      status: "idle",
      lastActiveAt: "2026-05-15T01:00:00.000Z",
    }),
  ]);

  const marked = applySessionAttentionMarkers(
    sessions,
    { "srv-current": "completed", "srv-background": "completed" },
    "srv-current"
  );

  assert.equal(marked[0].sessionId, "srv-current");
  assert.equal(marked[0].attention, undefined);
  assert.equal(marked[1].sessionId, "srv-background");
  assert.equal(marked[1].attention, "completed");
}

function testMergesMissingRunningSessionIntoSidebarSessions() {
  const sessions = mapSessionSummariesToWorkbenchSessions([
    makeSession({
      sessionId: "srv-other",
      title: "Other session",
      status: "idle",
      lastActiveAt: "2026-05-15T01:00:00.000Z",
    }),
  ]);

  const merged = mergeInferredWorkbenchSessions(sessions, [
    {
      sessionId: "srv-running",
      title: "Running Codex session",
      pinned: false,
      status: "running",
      model: "codex-medium",
      lastActivityAt: "2026-05-15T02:00:00.000Z",
      messageCount: 1,
      changedFileCount: 0,
      pendingApprovalCount: 0,
    },
  ]);

  assert.equal(merged[0].sessionId, "srv-running");
  assert.equal(merged[0].status, "running");
  assert.equal(merged[1].sessionId, "srv-other");
}

function testMapsToolCallsIntoTimelineEvents() {
  const messages: Message[] = [
    {
      id: "assistant-1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "tool-1",
          name: "command_execution",
          arguments: { command: "bun run lint", cwd: "/workspace/app" },
          status: "success",
          result: "very long command output that should not be shown in the main timeline",
        },
        {
          id: "tool-2",
          name: "file_change",
          arguments: {
            changes: [
              { path: "/workspace/app/src/App.tsx" },
              { path: "app/src/components/workbench/InspectorPanel.tsx" },
            ],
          },
          status: "success",
        },
      ],
    },
  ];

  const events = messagesToTimelineEvents(messages);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "tool_call");
  assert.equal(events[0].title, "Tool activity");
  assert.match(events[0].body, /bun run lint/);
  assert.match(events[0].body, /InspectorPanel/);
  assert.doesNotMatch(events[0].body, /very long command output/);
}

function testLimitsToolActivityToRecentSummaries() {
  const messages: Message[] = [
    {
      id: "assistant-1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "tool-1",
          name: "command_execution",
          arguments: { command: "first command" },
          status: "success",
        },
        {
          id: "tool-2",
          name: "command_execution",
          arguments: { command: "second command" },
          status: "success",
        },
        {
          id: "tool-3",
          name: "command_execution",
          arguments: { command: "third command" },
          status: "running",
        },
      ],
    },
  ];

  const events = messagesToTimelineEvents(messages, { maxToolActivityItems: 2 });

  assert.equal(events.length, 1);
  assert.equal(events[0].title, "Working with tools");
  assert.equal(events[0].status, "running");
  assert.doesNotMatch(events[0].body, /first command/);
  assert.match(events[0].body, /second command/);
  assert.match(events[0].body, /third command/);
  assert.match(events[0].body, /\+1 earlier tool/);
}

function testPlacesAssistantContentAfterItsToolCalls() {
  const messages: Message[] = [
    {
      id: "assistant-1",
      role: "assistant",
      content: "Done.\n\n- One\n- Two",
      toolCalls: [
        {
          id: "tool-1",
          name: "command_execution",
          arguments: { command: "bun run build" },
          status: "success",
          result: "ok",
        },
      ],
    },
  ];

  const events = messagesToTimelineEvents(messages);

  assert.equal(events.length, 2);
  assert.equal(events[0].type, "tool_call");
  assert.equal(events[1].type, "final_summary");
  assert.equal(events[1].title, "Response");
  assert.equal(events[1].body, "Done.\n\n- One\n- Two");
}

function testExtractsChangedFilesFromToolCalls() {
  const messages: Message[] = [
    {
      id: "assistant-1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "tool-1",
          name: "file_change",
          arguments: {
            changes: [
              { path: "/workspace/a.ts" },
              { path: "/workspace/b.ts" },
              { path: "/workspace/a.ts" },
            ],
          },
          status: "success",
        },
      ],
    },
  ];

  assert.deepEqual(extractChangedFilePaths(messages), ["/workspace/a.ts", "/workspace/b.ts"]);
}

function testMapsCodexRuntimeEventsIntoTimelineEvents() {
  const command: CodexRuntimeEvent = {
    type: "tool_output_delta",
    id: "cmd-1",
    kind: "command_execution",
    delta: "pytest -q",
    stream: "stdout",
  };
  const commandEvent = codexRuntimeEventToTimelineEvent(command, {
    id: "runtime-1",
    createdAt: "2026-05-19T00:00:00.000Z",
  });

  assert.equal(commandEvent.id, "runtime-1");
  assert.equal(commandEvent.type, "command");
  assert.equal(commandEvent.title, "Command output");
  assert.equal(commandEvent.body, "pytest -q");
  assert.equal(commandEvent.status, "stdout");
  assert.equal(commandEvent.createdAt, "2026-05-19T00:00:00.000Z");

  const patchEvent = codexRuntimeEventToTimelineEvent(
    {
      type: "file_change_patch_updated",
      id: "file-1",
      patch: "@@ -1 +1 @@",
    },
    { id: "runtime-2" }
  );
  assert.equal(patchEvent.type, "file_change");
  assert.equal(patchEvent.title, "File patch updated");
  assert.match(patchEvent.body, /@@ -1/);

  const warningEvent = codexRuntimeEventToTimelineEvent(
    {
      type: "codex_warning",
      message: "context is getting full",
    },
    { id: "runtime-3" }
  );
  assert.equal(warningEvent.type, "warning");
  assert.equal(warningEvent.title, "System warning");
  assert.equal(warningEvent.body, "context is getting full");

  const compactEvent = codexRuntimeEventToTimelineEvent(
    {
      type: "context_compaction",
      id: "compact-1",
      status: "completed",
    },
    { id: "runtime-4" }
  );
  assert.equal(compactEvent.type, "context_compaction");
  assert.equal(compactEvent.title, "Context compacted");
  assert.equal(compactEvent.status, "completed");

  const imageEvent = codexRuntimeEventToTimelineEvent(
    {
      type: "image_generation",
      id: "img-1",
      status: "completed",
      workspace_path: "/workspace/outputs/images/2026/05/img-1.png",
      mime_type: "image/png",
      size: 128,
      revised_prompt: "studio toy photo",
    } as CodexRuntimeEvent,
    { id: "runtime-5" }
  );
  assert.equal(imageEvent.type, "image_generation");
  assert.equal(imageEvent.title, "Generated image");
  assert.equal(imageEvent.workspacePath, "/workspace/outputs/images/2026/05/img-1.png");
  assert.equal(imageEvent.mimeType, "image/png");
  assert.equal(imageEvent.size, 128);
  assert.match(imageEvent.body, /studio toy photo/);

  const folderSearchEvent = codexRuntimeEventToTimelineEvent(
    {
      type: "folder_context_search",
      id: "folder-search-1",
      status: "completed",
      context_folder_path: "/workspace/genius_club",
      query: "天才俱乐部成员分别是谁？",
      match_count: 2,
      scanned_files: 12,
      matches: [
        { path: "/workspace/genius_club/001.txt", line: 8, snippet: "天才俱乐部成员名单" },
        { path: "/workspace/genius_club/489.txt", line: 20, snippet: "结局相关片段" },
      ],
    } as CodexRuntimeEvent,
    { id: "runtime-6" }
  );
  assert.equal(folderSearchEvent.type, "tool_call");
  assert.equal(folderSearchEvent.title, "Folder context search");
  assert.match(folderSearchEvent.body, /genius_club/);
  assert.match(folderSearchEvent.body, /2 matches/);
  assert.match(folderSearchEvent.body, /001\.txt:8/);
}

function testMapsMessageImageArtifactsIntoTimelineEvents() {
  const events = messagesToTimelineEvents([
    {
      id: "assistant-image",
      role: "assistant",
      content: "",
      artifacts: [
        {
          type: "image",
          workspacePath: "/workspace/outputs/images/2026/05/img-1.png",
          mimeType: "image/png",
          size: 128,
          revisedPrompt: "studio toy photo",
        },
      ],
      created_at: "2026-05-19T00:00:02.000Z",
    },
  ]);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "image_generation");
  assert.equal(events[0].title, "Generated image");
  assert.equal(events[0].workspacePath, "/workspace/outputs/images/2026/05/img-1.png");
  assert.equal(events[0].createdAt, "2026-05-19T00:00:02.000Z");
}

function testSummarizesCodexRuntimeDiffInsteadOfShowingFullPatch() {
  const event = codexRuntimeEventToTimelineEvent(
    {
      type: "codex_turn_diff_updated",
      diff: ["diff --git a/src/App.tsx b/src/App.tsx", "@@ -1,2 +1,2 @@", "-old", "+new"].join(
        "\n"
      ),
      status: "running",
    },
    { id: "runtime-diff-1", createdAt: "2026-05-19T00:00:03.000Z" }
  );

  assert.equal(event.id, "runtime-diff-1");
  assert.equal(event.type, "file_change");
  assert.equal(event.title, "Workspace diff");
  assert.equal(event.status, "running");
  assert.match(event.body, /1 file/);
  assert.match(event.body, /src\/App\.tsx/);
  assert.doesNotMatch(event.body, /@@ -1/);
}

function testUpsertsCodexRuntimeDiffEvents() {
  const first = upsertRuntimeTimelineEvent(
    [],
    {
      type: "codex_turn_diff_updated",
      diff: "diff --git a/src/App.tsx b/src/App.tsx",
      status: "running",
    },
    { id: "runtime-diff", createdAt: "2026-05-19T00:00:01.000Z" }
  );
  const second = upsertRuntimeTimelineEvent(
    first,
    {
      type: "codex_turn_diff_updated",
      diff: "diff --git a/src/Session.tsx b/src/Session.tsx",
      status: "completed",
    },
    { id: "runtime-diff", createdAt: "2026-05-19T00:00:02.000Z" }
  );

  assert.equal(second.length, 1);
  assert.equal(second[0].id, "runtime-diff");
  assert.equal(second[0].status, "completed");
  assert.match(second[0].body, /src\/Session\.tsx/);
  assert.doesNotMatch(second[0].body, /src\/App\.tsx/);
}

function testUpsertsContextCompactionLifecycleEvents() {
  const first = upsertRuntimeTimelineEvent(
    [],
    {
      type: "context_compaction",
      id: "compact-1",
      status: "running",
    },
    { id: "runtime-1-0", createdAt: "2026-05-19T00:00:01.000Z" }
  );
  const second = upsertRuntimeTimelineEvent(
    first,
    {
      type: "context_compaction",
      id: "compact-1",
      status: "completed",
    },
    { id: "runtime-1-1", createdAt: "2026-05-19T00:00:02.000Z" }
  );

  assert.equal(second.length, 1);
  assert.equal(second[0].type, "context_compaction");
  assert.equal(second[0].status, "completed");
}

function testMergesRuntimeEventsByTimestamp() {
  const messageEvents = messagesToTimelineEvents([
    {
      id: "old-user",
      role: "user",
      content: "write a doc",
      created_at: "2026-05-19T00:00:01.000Z",
    },
    {
      id: "old-assistant",
      role: "assistant",
      content: "done",
      created_at: "2026-05-19T00:00:02.000Z",
    },
    {
      id: "new-user",
      role: "user",
      content: "send a Feishu message",
      created_at: "2026-05-19T00:00:04.000Z",
    },
  ]);
  const runtimeEvents = [
    codexRuntimeEventToTimelineEvent(
      {
        type: "codex_turn_diff_updated",
        diff: "diff --git a/codex-goal-mode.md b/codex-goal-mode.md",
      },
      { id: "runtime-diff", createdAt: "2026-05-19T00:00:03.000Z" }
    ),
  ];

  const merged = mergeTimelineEvents(messageEvents, runtimeEvents);

  assert.deepEqual(
    merged.map((event) => event.id),
    ["old-user", "old-assistant", "runtime-diff", "new-user"]
  );
}

function testMergeSkipsRuntimeImageAlreadyRepresentedByMessageArtifact() {
  const messageEvents = messagesToTimelineEvents([
    {
      id: "assistant-image",
      role: "assistant",
      content: "",
      artifacts: [
        {
          type: "image",
          workspacePath: "/workspace/outputs/images/2026/05/img-1.png",
          mimeType: "image/png",
          size: 128,
          revisedPrompt: "studio toy photo",
        },
      ],
      created_at: "2026-05-19T00:00:03.000Z",
    },
  ]);
  const runtimeEvents = [
    codexRuntimeEventToTimelineEvent(
      {
        type: "image_generation",
        id: "img-1",
        status: "completed",
        workspace_path: "/workspace/outputs/images/2026/05/img-1.png",
        mime_type: "image/png",
        size: 128,
        revised_prompt: "studio toy photo",
      } as CodexRuntimeEvent,
      { id: "runtime-image", createdAt: "2026-05-19T00:00:02.000Z" }
    ),
  ];

  const merged = mergeTimelineEvents(messageEvents, runtimeEvents);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "assistant-image-image-0");
  assert.equal(merged[0].workspacePath, "/workspace/outputs/images/2026/05/img-1.png");
}

function testRuntimeEventsStayBeforeOptimisticAssistantResponse() {
  const messageEvents = messagesToTimelineEvents([
    {
      id: "user-1",
      role: "user",
      content: "summarize these files",
      created_at: "2026-05-19T00:00:00.000Z",
    },
    {
      id: "assistant-1",
      role: "assistant",
      content: "Here is the summary.",
      created_at: "2026-05-19T00:00:00.000Z",
    },
  ]);
  const runtimeEvents = [
    codexRuntimeEventToTimelineEvent(
      {
        type: "context_compaction",
        id: "compact-1",
        status: "completed",
      },
      { id: "runtime-compact", createdAt: "2026-05-19T00:00:01.000Z" }
    ),
  ];

  const merged = mergeTimelineEvents(messageEvents, runtimeEvents);

  assert.deepEqual(
    merged.map((event) => event.id),
    ["user-1", "runtime-context_compaction-compact-1", "assistant-1"]
  );
}

testMapsSessionSummariesToWorkbenchSummaries();
testSortsSessionsByRecentActivity();
testFormatsSessionActivityTimeLikeCodexSidebar();
testAppliesCurrentRunningStatusToExistingSession();
testAppliesCurrentApprovalStatusToExistingSession();
testAppliesUnreadCompletionAttentionOnlyOffCurrentSession();
testMergesMissingRunningSessionIntoSidebarSessions();
testMapsToolCallsIntoTimelineEvents();
testLimitsToolActivityToRecentSummaries();
testPlacesAssistantContentAfterItsToolCalls();
testExtractsChangedFilesFromToolCalls();
testMapsCodexRuntimeEventsIntoTimelineEvents();
testMapsMessageImageArtifactsIntoTimelineEvents();
testSummarizesCodexRuntimeDiffInsteadOfShowingFullPatch();
testUpsertsCodexRuntimeDiffEvents();
testUpsertsContextCompactionLifecycleEvents();
testMergesRuntimeEventsByTimestamp();
testMergeSkipsRuntimeImageAlreadyRepresentedByMessageArtifact();
testRuntimeEventsStayBeforeOptimisticAssistantResponse();

console.log("workbench tests passed");
