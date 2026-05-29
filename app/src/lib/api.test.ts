import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  cancelSessionConnectorAuth,
  compactSessionContext,
  createSchedule,
  createSession,
  deleteSchedule,
  deleteSession,
  fetchSchedules,
  fetchSessions,
  fetchSessionDetails,
  fetchWorkspaceFilePreview,
  getApiOrigin,
  parseWorkspaceLink,
  renameWorkspaceEntry,
  resolveSessionPermissionRequest,
  resolveApiUrl,
  runScheduleNow,
  searchWorkspaceFiles,
  sendChatMessage,
  stopSession,
  updateSchedule,
  updateSession,
} from "./api";

function response(status: number, detail: string): Response {
  return new Response(JSON.stringify({ detail }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function withFetch(mock: typeof fetch, run: () => Promise<void>) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    await run();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function assertRejectsWithMessage(
  mockResponse: Response,
  expectedMessage: string
): Promise<void> {
  await withFetch(
    async () => mockResponse,
    async () => {
      await assert.rejects(
        () => renameWorkspaceEntry("/workspace/missing.txt", "README.md"),
        (error) => error instanceof Error && error.message === expectedMessage
      );
    }
  );
}

async function testRenameEndpointNotFoundAsksForServerRestart() {
  await assertRejectsWithMessage(
    response(404, "Not Found"),
    "Workspace rename API is unavailable. Restart Ripple server."
  );
}

async function testRenamePathNotFoundStaysFileSpecific() {
  await assertRejectsWithMessage(
    response(404, "Path not found"),
    "File or folder no longer exists. Refresh workspace."
  );
}

async function testRenameConflictUsesFriendlyMessage() {
  await assertRejectsWithMessage(
    response(409, "A file or folder with that name already exists"),
    "A file or folder with that name already exists."
  );
}

async function testSessionIdIsEncodedInPath() {
  const urls: string[] = [];
  const sessionId = "session/with space";

  await withFetch(
    async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    async () => {
      await fetchSessionDetails(sessionId);
      await updateSession(sessionId, { title: "Renamed", pinned: true });
      await deleteSession(sessionId);
      await stopSession(sessionId);
      await cancelSessionConnectorAuth(sessionId);
      await compactSessionContext(sessionId);
      await resolveSessionPermissionRequest(sessionId, "allow");
    }
  );

  assert.deepEqual(urls, [
    "http://140.143.229.103:8810/v1/sessions/session%2Fwith%20space",
    "http://140.143.229.103:8810/v1/sessions/session%2Fwith%20space",
    "http://140.143.229.103:8810/v1/sessions/session%2Fwith%20space",
    "http://140.143.229.103:8810/v1/sessions/session%2Fwith%20space/stop",
    "http://140.143.229.103:8810/v1/sessions/session%2Fwith%20space/connector-auth/cancel",
    "http://140.143.229.103:8810/v1/sessions/session%2Fwith%20space/context/compact",
    "http://140.143.229.103:8810/v1/sessions/session%2Fwith%20space/permissions/resolve",
  ]);
}

async function testScheduleIdIsEncodedInPath() {
  const urls: string[] = [];
  const scheduleId = "schedule/with space";

  await withFetch(
    async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ schedule_id: scheduleId }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    async () => {
      await updateSchedule(scheduleId, { enabled: false });
      await deleteSchedule(scheduleId);
      await runScheduleNow(scheduleId);
    }
  );

  assert.deepEqual(urls, [
    "http://140.143.229.103:8810/v1/schedules/schedule%2Fwith%20space",
    "http://140.143.229.103:8810/v1/schedules/schedule%2Fwith%20space",
    "http://140.143.229.103:8810/v1/schedules/schedule%2Fwith%20space/run-now",
  ]);
}

function testParseWorkspaceLinkDecodesEncodedSandboxPath() {
  assert.deepEqual(
    parseWorkspaceLink(
      "/home/lake/workspace/ripple/.ripple/sandboxes/lake/workspace/meeting_record/%E9%80%9A%E7%94%A8%E4%BC%9A%E8%AE%AE82.json:34"
    ),
    {
      isWorkspaceFile: true,
      workspacePath: "/workspace/meeting_record/通用会议82.json",
      lineNumber: 34,
      userId: "lake",
    }
  );
}

async function testWorkspaceFilePreviewPathNotFoundStaysFileSpecific() {
  await withFetch(
    async () => response(404, "Path not found"),
    async () => {
      await assert.rejects(
        () => fetchWorkspaceFilePreview("/workspace/missing.txt"),
        (error) =>
          error instanceof Error &&
          error.message === "File or folder no longer exists. Refresh workspace."
      );
    }
  );
}

async function testScheduleApiUsesExpectedBackendShape() {
  const urls: string[] = [];
  const methods: string[] = [];

  await withFetch(
    async (input, init) => {
      urls.push(String(input));
      methods.push(init?.method || "GET");
      if (String(input).endsWith("/schedules") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            schedule_id: "sch-created",
            user_id: "alice",
            title: "Digest",
            prompt: "Summarize",
            kind: "once",
            timezone: "UTC",
            run_at: "2026-05-19T00:00:00+00:00",
            interval_seconds: null,
            enabled: true,
            status: "active",
            next_run_at: "2026-05-19T00:00:00+00:00",
            last_run_at: null,
            last_run_id: null,
            last_error: null,
            cwd: null,
            model: "codex-medium",
            effort: null,
            summary: null,
            output_schema: null,
            max_runtime_seconds: 1800,
            max_runs: null,
            run_count: 0,
            created_at: "2026-05-18T00:00:00+00:00",
            updated_at: "2026-05-18T00:00:00+00:00",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ schedules: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    async () => {
      assert.deepEqual(await fetchSchedules(), []);
      const created = await createSchedule({
        title: "Digest",
        prompt: "Summarize",
        kind: "once",
        timezone: "UTC",
        run_at: "2026-05-19T00:00",
      });
      assert.equal(created.schedule_id, "sch-created");
    }
  );

  assert.deepEqual(methods, ["GET", "POST"]);
  assert.deepEqual(urls, [
    "http://140.143.229.103:8810/v1/schedules",
    "http://140.143.229.103:8810/v1/schedules",
  ]);
}

async function testFetchSessionsNormalizesBackendShape() {
  await withFetch(
    async () =>
      new Response(
        JSON.stringify({
          sessions: [
            {
              session_id: "srv-normalized",
              title: "Normalized session",
              pinned: true,
              model: "codex-medium",
              created_at: "2026-05-18T00:00:00.000Z",
              last_active: "2026-05-19T00:00:00.000Z",
              message_count: 4,
              status: "running",
              changed_file_count: 2,
              pending_approval_count: 1,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ),
    async () => {
      assert.deepEqual(await fetchSessions(), [
        {
          sessionId: "srv-normalized",
          title: "Normalized session",
          pinned: true,
          model: "codex-medium",
          createdAt: "2026-05-18T00:00:00.000Z",
          lastActiveAt: "2026-05-19T00:00:00.000Z",
          messageCount: 4,
          status: "running",
          changedFileCount: 2,
          pendingApprovalCount: 1,
        },
      ]);
    }
  );
}

async function testCreateSessionNormalizesBackendShape() {
  await withFetch(
    async () =>
      new Response(
        JSON.stringify({
          session_id: "srv-created",
          title: "",
          pinned: false,
          model: "codex-medium",
          created_at: "2026-05-19T00:00:00.000Z",
          last_active: "2026-05-19T00:00:00.000Z",
          message_count: 0,
          status: "idle",
          changed_file_count: 0,
          pending_approval_count: 0,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ),
    async () => {
      assert.equal((await createSession()).sessionId, "srv-created");
    }
  );
}

async function testFetchSessionDetailsNormalizesBackendShape() {
  await withFetch(
    async () =>
      new Response(
        JSON.stringify({
          session_id: "srv-detail",
          title: "Detail session",
          pinned: false,
          model: "codex-high",
          created_at: "2026-05-18T00:00:00.000Z",
          last_active: "2026-05-19T00:00:00.000Z",
          message_count: 2,
          status: "waiting_for_approval",
          changed_file_count: 1,
          pending_approval_count: 1,
          messages: [],
          pending_question: "Continue?",
          pending_options: ["Yes", "No"],
          pending_permission_request: { tool: "exec", params: {}, riskLevel: "medium" },
          plan_steps: [{ id: "step-1", subject: "Inspect", status: "completed" }],
          plan_progress: { completed: 1, total: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ),
    async () => {
      assert.deepEqual(await fetchSessionDetails("srv-detail"), {
        sessionId: "srv-detail",
        title: "Detail session",
        pinned: false,
        model: "codex-high",
        createdAt: "2026-05-18T00:00:00.000Z",
        lastActiveAt: "2026-05-19T00:00:00.000Z",
        messageCount: 2,
        status: "waiting_for_approval",
        changedFileCount: 1,
        pendingApprovalCount: 1,
        messages: [],
        pendingQuestion: "Continue?",
        pendingOptions: ["Yes", "No"],
        pendingPermissionRequest: { tool: "exec", params: {}, riskLevel: "medium" },
        planSteps: [{ id: "step-1", subject: "Inspect", status: "completed" }],
        planProgress: { completed: 1, total: 1 },
      });
    }
  );
}

async function testFetchSessionsRejectsServerFailures() {
  await withFetch(
    async () => response(500, "session store unavailable"),
    async () => {
      await assert.rejects(
        () => fetchSessions(),
        (error) => error instanceof Error && error.message === "session store unavailable"
      );
    }
  );
}

async function testFetchSessionsRejectsNetworkFailures() {
  await withFetch(
    async () => {
      throw new TypeError("Failed to fetch");
    },
    async () => {
      await assert.rejects(
        () => fetchSessions(),
        (error) =>
          error instanceof Error &&
          error.message === "无法连接到 Ripple 服务。请确认后端服务正在运行，或检查 /v1 代理配置。"
      );
    }
  );
}

async function testWorkspaceSearchDefaultsToNameScope() {
  let requestedUrl = "";

  await withFetch(
    async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ query: "json", count: 0, entries: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    async () => {
      await searchWorkspaceFiles("json");
    }
  );

  assert.match(requestedUrl, /[?&]scope=name(?:&|$)/);
}

async function testChatStreamUsesServerConflictDetail() {
  let reportedMessage = "";
  const globals = globalThis as unknown as {
    document?: Pick<Document, "addEventListener" | "removeEventListener"> & { hidden: boolean };
    window?: Pick<Window, "fetch" | "setTimeout" | "clearTimeout">;
  };
  const previousDocument = globals.document;
  const previousWindow = globals.window;
  globals.document = {
    hidden: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  globals.window = {
    fetch: (...args) => globalThis.fetch(...args),
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };

  try {
    await withFetch(
      async () => response(409, "Session already has work in progress"),
      async () => {
        await sendChatMessage("session-1", "hi", "codex-test", {
          onMessageDelta: () => undefined,
          onToolCall: () => undefined,
          onToolResult: () => undefined,
          onUsage: () => undefined,
          onComplete: () => undefined,
          onError: (error) => {
            reportedMessage = error.message;
          },
        });
      }
    );
  } finally {
    globals.document = previousDocument;
    globals.window = previousWindow;
  }

  assert.equal(reportedMessage, "Session already has work in progress");
}

function testDefaultApiOriginUsesPublicBaseUrl() {
  assert.equal(getApiOrigin(), "http://140.143.229.103:8810");
}

function testDevDefaultApiUrlUsesSameOriginProxy() {
  assert.equal(resolveApiUrl({ DEV: true }), "/v1");
  assert.equal(
    resolveApiUrl({ DEV: true, VITE_RIPPLE_API_URL: "http://localhost:8810/v1" }),
    "http://localhost:8810/v1"
  );
  assert.equal(
    resolveApiUrl({ DEV: true, VITE_RIPPLE_API_URL: "http://140.143.229.103:8810" }),
    "http://140.143.229.103:8810/v1"
  );
  assert.equal(resolveApiUrl({ PROD: true }), "http://140.143.229.103:8810/v1");
}

function testViteDevServerProxiesV1ToLocalRippleServer() {
  const config = readFileSync(new URL("../../vite.config.ts", import.meta.url), "utf8");

  assert.match(config, /proxy/);
  assert.match(config, new RegExp(String.raw`["']/v1["']`));
  assert.match(config, new RegExp(String.raw`http://127\.0\.0\.1:8810`));
}

function testChatStreamingStaysOpenWhenPageIsHidden() {
  const source = readFileSync(new URL("./api.ts", import.meta.url), "utf8");

  assert.match(source, /openWhenHidden:\s*true/);
}

function testChatStreamingAcceptsImageRuntimeEvents() {
  const source = readFileSync(new URL("./api.ts", import.meta.url), "utf8");

  assert.match(source, /"image_generation"/);
  assert.match(source, /"image_view"/);
}

testDefaultApiOriginUsesPublicBaseUrl();
testDevDefaultApiUrlUsesSameOriginProxy();
testViteDevServerProxiesV1ToLocalRippleServer();
testChatStreamingStaysOpenWhenPageIsHidden();
testChatStreamingAcceptsImageRuntimeEvents();
await testRenameEndpointNotFoundAsksForServerRestart();
await testRenamePathNotFoundStaysFileSpecific();
await testRenameConflictUsesFriendlyMessage();
await testSessionIdIsEncodedInPath();
await testScheduleIdIsEncodedInPath();
testParseWorkspaceLinkDecodesEncodedSandboxPath();
await testWorkspaceFilePreviewPathNotFoundStaysFileSpecific();
await testScheduleApiUsesExpectedBackendShape();
await testFetchSessionsNormalizesBackendShape();
await testCreateSessionNormalizesBackendShape();
await testFetchSessionDetailsNormalizesBackendShape();
await testFetchSessionsRejectsServerFailures();
await testFetchSessionsRejectsNetworkFailures();
await testWorkspaceSearchDefaultsToNameScope();
await testChatStreamUsesServerConflictDetail();

console.log("api tests passed");
