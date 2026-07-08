import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  acceptAgentDelegation,
  approveAgentInvocation,
  answerAgentDelegation,
  cancelConnectorAuth,
  cancelTask,
  cancelSessionConnectorAuth,
  changePassword,
  compactSessionContext,
  confirmTask,
  createAgentDelegation,
  addAgentContact,
  createAgentInvocation,
  createConversationMessage,
  createDirectConversation,
  createSession,
  createTaskAction,
  deleteTask,
  deleteUserAvatar,
  deleteSession,
  downloadWorkspaceFile,
  fetchTask,
  fetchTaskEvents,
  fetchAllTaskTriggers,
  fetchTaskTriggers,
  fetchTasks,
  fetchSessionTasks,
  fetchSessions,
  fetchSessionDetails,
  fetchAgentDelegations,
  fetchAgentContacts,
  fetchConversationMessages,
  fetchConversations,
  fetchMemoryStatus,
  fetchMemorySummary,
  forkSession,
  fetchUserAvatarImage,
  fetchModels,
  fetchWorkspaceDocumentPreview,
  fetchWorkspaceFilePreview,
  getApiOrigin,
  markConversationRead,
  parseWorkspaceLink,
  renameWorkspaceEntry,
  resolveSessionPermissionRequest,
  resolveApiUrl,
  resetMemory,
  rejectAgentDelegation,
  removeAgentContact,
  runTaskTriggerNow,
  runTaskNow,
  searchWorkspaceFiles,
  sendChatMessage,
  sendSessionControlAction,
  stopSession,
  updateTask,
  updateAgentContact,
  updateTaskTrigger,
  updateSession,
  updateTaskAction,
  createTaskTrigger,
  createTaskActionTrigger,
  deleteTaskTrigger,
  disableSessionMemory,
  updateUserProfile,
  uploadUserAvatar,
  disconnectConnector,
  clearApiKey,
  getAuthMode,
  setApiKey,
  setUserSessionToken,
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

async function withBrowserStorage(run: () => Promise<void>) {
  const globals = globalThis as unknown as { window?: { localStorage: Storage } };
  const previousWindow = globals.window;
  const values = new Map<string, string>();
  globals.window = {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
      clear: () => {
        values.clear();
      },
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() {
        return values.size;
      },
    },
  };
  try {
    await run();
  } finally {
    globals.window = previousWindow;
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
      await forkSession(sessionId);
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
    "http://140.143.229.103:8810/v1/sessions/session%2Fwith%20space/fork",
  ]);
}

async function testTaskTriggerApisUseTaskScopedRoutes() {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];

  await withFetch(
    async (input, init) => {
      const url = new URL(String(input));
      requests.push({
        method: init?.method || "GET",
        path: url.pathname,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url.pathname.endsWith("/run-now")) {
        return new Response(JSON.stringify({ job_id: "job-trigger", status: "completed" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (init?.method === "PATCH") {
        return new Response(
          JSON.stringify({
            trigger_id: "trg-linked",
            trigger_type: "time",
            user_id: "default",
            title: "每半小时提醒",
            prompt: "提醒准备材料",
            kind: "interval",
            timezone: "UTC",
            run_at: null,
            interval_seconds: 1800,
            enabled: true,
            status: "active",
            next_run_at: "2026-06-17T10:30:00Z",
            last_run_at: null,
            last_run_id: null,
            last_error: null,
            cwd: null,
            model: null,
            effort: null,
            summary: null,
            output_schema: null,
            max_runtime_seconds: 1800,
            max_runs: 5,
            task_id: "task-trip",
            task_action_id: "act-remind",
            run_count: 0,
            created_at: "2026-06-17T10:00:00Z",
            updated_at: "2026-06-17T10:05:00Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (init?.method === "DELETE") {
        return new Response(JSON.stringify({ deleted: true, trigger_id: "trg-linked" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({
            trigger_id: "trg-linked",
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
            last_run_id: null,
            last_error: null,
            cwd: null,
            model: null,
            effort: null,
            summary: null,
            output_schema: null,
            max_runtime_seconds: 1800,
            max_runs: 1,
            task_id: "task-trip",
            task_action_id: "act-remind",
            run_count: 0,
            created_at: "2026-06-17T10:00:00Z",
            updated_at: "2026-06-17T10:00:00Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          triggers: [
            {
              trigger_id: "trg-linked",
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
              last_run_id: null,
              last_error: null,
              cwd: null,
              model: null,
              effort: null,
              summary: null,
              output_schema: null,
              max_runtime_seconds: 1800,
              max_runs: 1,
              task_id: "task-trip",
              task_action_id: "act-remind",
              run_count: 0,
              created_at: "2026-06-17T10:00:00Z",
              updated_at: "2026-06-17T10:00:00Z",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
    async () => {
      const allTriggers = await fetchAllTaskTriggers();
      assert.equal(allTriggers[0]?.trigger_id, "trg-linked");
      const triggers = await fetchTaskTriggers("task/trip");
      assert.equal(triggers[0]?.trigger_id, "trg-linked");
      const created = await createTaskActionTrigger("task/trip", "act/remind", {
        title: "明早提醒",
        prompt: "提醒准备材料",
        kind: "once",
        timezone: "Asia/Shanghai",
        run_at: "2026-06-18T07:30",
      });
      assert.equal(created.task_action_id, "act-remind");
      const taskCreated = await createTaskTrigger("task/trip", {
        title: "明早提醒",
        prompt: "提醒准备材料",
        kind: "once",
        timezone: "Asia/Shanghai",
        run_at: "2026-06-18T07:30",
      });
      assert.equal(taskCreated.task_id, "task-trip");
      const updated = await updateTaskTrigger("task/trip", "trg/linked", {
        title: "每半小时提醒",
        kind: "interval",
        timezone: "UTC",
        interval_seconds: 1800,
        max_runs: 5,
        enabled: true,
      });
      assert.equal(updated.interval_seconds, 1800);
      assert.equal((await runTaskTriggerNow("task/trip", "trg/linked")).job_id, "job-trigger");
      assert.equal((await deleteTaskTrigger("task/trip", "trg/linked")).deleted, true);
    }
  );

  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.path}`),
    [
      "GET /v1/task-triggers",
      "GET /v1/tasks/task%2Ftrip/triggers",
      "POST /v1/tasks/task%2Ftrip/actions/act%2Fremind/triggers",
      "POST /v1/tasks/task%2Ftrip/triggers",
      "PATCH /v1/tasks/task%2Ftrip/triggers/trg%2Flinked",
      "POST /v1/tasks/task%2Ftrip/triggers/trg%2Flinked/run-now",
      "DELETE /v1/tasks/task%2Ftrip/triggers/trg%2Flinked",
    ]
  );
  assert.deepEqual(requests[2]?.body, {
    title: "明早提醒",
    prompt: "提醒准备材料",
    kind: "once",
    timezone: "Asia/Shanghai",
    run_at: "2026-06-18T07:30:00+08:00",
  });
  assert.deepEqual(requests[3]?.body, {
    title: "明早提醒",
    prompt: "提醒准备材料",
    kind: "once",
    timezone: "Asia/Shanghai",
    run_at: "2026-06-18T07:30:00+08:00",
  });
  assert.deepEqual(requests[4]?.body, {
    title: "每半小时提醒",
    kind: "interval",
    timezone: "UTC",
    interval_seconds: 1800,
    max_runs: 5,
    enabled: true,
  });
}

function testApiClientExposesMemoryEndpoints() {
  const source = readFileSync(new URL("./api.ts", import.meta.url), "utf8");

  assert.match(source, /fetchMemoryStatus/);
  assert.match(source, /fetchMemorySummary/);
  assert.doesNotMatch(source, /updateMemorySettings/);
  assert.match(source, /resetMemory/);
  assert.match(source, /disableSessionMemory/);
  assert.match(source, /\/memory\/status/);
  assert.match(source, /\/memory\/summary/);
  assert.match(source, /\/memory\/reset/);
  assert.match(source, /\/memory\/disable/);
}

async function testMemoryApisUseExpectedRoutesAndPayloads() {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];

  await withFetch(
    async (input, init) => {
      const url = new URL(String(input));
      requests.push({
        method: init?.method || "GET",
        path: url.pathname,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url.pathname.endsWith("/memory/status")) {
        return new Response(
          JSON.stringify({
            ok: true,
            memory: {
              enabled: true,
              use_memories: true,
              generate_memories: true,
              dedicated_tools: false,
              disable_on_external_context: false,
            },
            summary: {
              available: true,
              registry_available: true,
              raw_available: false,
              last_updated_at: "2026-06-30T00:00:00Z",
            },
            runtime: {
              memories_db_available: true,
              stage1_output_count: 3,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.pathname.endsWith("/memory/summary")) {
        return new Response(
          JSON.stringify({
            ok: true,
            summary: { text: "remembered preference", truncated: false },
            registry: null,
            raw: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    async () => {
      const status = await fetchMemoryStatus();
      const summary = await fetchMemorySummary();
      await resetMemory();
      await disableSessionMemory("session/with space");

      assert.equal(status.memory.enabled, true);
      assert.equal(status.runtime.stage1_output_count, 3);
      assert.equal(summary.summary?.text, "remembered preference");
    }
  );

  assert.deepEqual(requests, [
    { method: "GET", path: "/v1/memory/status", body: null },
    { method: "GET", path: "/v1/memory/summary", body: null },
    { method: "POST", path: "/v1/memory/reset", body: { confirm: true } },
    { method: "POST", path: "/v1/sessions/session%2Fwith%20space/memory/disable", body: null },
  ]);
}

async function testConnectorManagementApisEncodeNamesAndPayloads() {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];

  await withFetch(
    async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method || "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ ok: true, stage: "ok", data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    async () => {
      await disconnectConnector("google/workspace", { email: "worker@example.com" });
      await cancelConnectorAuth("google/workspace");
    }
  );

  assert.deepEqual(requests, [
    {
      url: "http://140.143.229.103:8810/v1/connectors/google%2Fworkspace/disconnect",
      method: "POST",
      body: { confirm: true, email: "worker@example.com" },
    },
    {
      url: "http://140.143.229.103:8810/v1/connectors/google%2Fworkspace/auth/cancel",
      method: "POST",
      body: null,
    },
  ]);
}

async function testCapabilityApisUseUnifiedCatalogAndSkillPatch() {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];

  await withFetch(
    async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method || "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(
        JSON.stringify(
          String(input).includes("/capabilities")
            ? { capabilities: [] }
            : { id: "user:demo", type: "skill", enabled: true }
        ),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    },
    async () => {
      const { fetchCapabilities, updateSkillCapability } = await import("./api");
      await fetchCapabilities();
      await updateSkillCapability("user:demo/with space", true);
    }
  );

  assert.deepEqual(requests, [
    {
      url: "http://140.143.229.103:8810/v1/capabilities",
      method: "GET",
      body: null,
    },
    {
      url: "http://140.143.229.103:8810/v1/skills/user%3Ademo%2Fwith%20space",
      method: "PATCH",
      body: { enabled: true },
    },
  ]);
}

async function testSkillApisUseUserFacingSkillEndpoints() {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];

  await withFetch(
    async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method || "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      const url = String(input);
      const responseBody = url.endsWith("/skills")
        ? { skills: [] }
        : url.endsWith("/validate")
          ? { passed: true, checks: [] }
          : { id: "user:demo", user_status: "not_enabled", desired_state: "draft" };
      return new Response(JSON.stringify(responseBody), {
        status: init?.method === "POST" && url.endsWith("/skills") ? 201 : 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    async () => {
      const { createSkill, deleteSkill, fetchSkill, fetchSkills, updateSkill, validateSkill } =
        await import("./api");
      await fetchSkills();
      await fetchSkill("user:demo/with space");
      await createSkill({
        display_name: "Weekly Review",
        description: "Summarize weekly updates.",
        when_to_use: "When I ask for a weekly review.",
        steps: ["Collect updates"],
        output_format: "Progress, risks, next actions.",
        requires_connectors: [],
        requires_user_confirmation: false,
        test_example: "Use two sample updates.",
      });
      await updateSkill("user:demo/with space", { enabled: true });
      await validateSkill("user:demo/with space");
      await deleteSkill("user:demo/with space");
    }
  );

  assert.deepEqual(requests, [
    {
      url: "http://140.143.229.103:8810/v1/skills",
      method: "GET",
      body: null,
    },
    {
      url: "http://140.143.229.103:8810/v1/skills/user%3Ademo%2Fwith%20space",
      method: "GET",
      body: null,
    },
    {
      url: "http://140.143.229.103:8810/v1/skills",
      method: "POST",
      body: {
        display_name: "Weekly Review",
        description: "Summarize weekly updates.",
        when_to_use: "When I ask for a weekly review.",
        steps: ["Collect updates"],
        output_format: "Progress, risks, next actions.",
        requires_connectors: [],
        requires_user_confirmation: false,
        test_example: "Use two sample updates.",
      },
    },
    {
      url: "http://140.143.229.103:8810/v1/skills/user%3Ademo%2Fwith%20space",
      method: "PATCH",
      body: { enabled: true },
    },
    {
      url: "http://140.143.229.103:8810/v1/skills/user%3Ademo%2Fwith%20space/validate",
      method: "POST",
      body: null,
    },
    {
      url: "http://140.143.229.103:8810/v1/skills/user%3Ademo%2Fwith%20space",
      method: "DELETE",
      body: { confirm: true },
    },
  ]);
}

async function testChangePasswordPostsCurrentAndNewPassword() {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];

  await withBrowserStorage(async () => {
    setUserSessionToken("rip_usr_token", "usr_abc");
    await withFetch(
      async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method || "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      async () => {
        await changePassword("old-password", "new-password");
      }
    );
  });

  assert.deepEqual(requests, [
    {
      url: "http://140.143.229.103:8810/v1/auth/password",
      method: "POST",
      body: { current_password: "old-password", new_password: "new-password" },
    },
  ]);
}

async function testAvatarApisUseServerProfileStorage() {
  await withBrowserStorage(async () => {
    setApiKey("service-key");
    const seen: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
    await withFetch(
      async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const headers = new Headers(init?.headers);
        seen.push({ url, method, headers, body: init?.body ?? null });
        if (url.endsWith("/users/me/avatar") && method === "POST") {
          assert.ok(init?.body instanceof FormData);
          assert.equal(headers.get("content-type"), null);
          return new Response(
            JSON.stringify({
              user_id: "default",
              profile: {
                user_id: "default",
                user_name: "default",
                avatar_uri: "/v1/users/me/avatar/avatar.png",
              },
              avatar_uri: "/v1/users/me/avatar/avatar.png",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.endsWith("/users/me/avatar/avatar.png") && method === "GET") {
          return new Response("avatar-bytes", {
            status: 200,
            headers: { "Content-Type": "image/png" },
          });
        }
        if (url.endsWith("/users/me/avatar") && method === "DELETE") {
          return new Response(
            JSON.stringify({
              user_id: "default",
              profile: { user_id: "default", user_name: "default", avatar_uri: null },
              avatar_uri: null,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return response(404, "not found");
      },
      async () => {
        const uploaded = await uploadUserAvatar(
          new File([new Uint8Array([1, 2, 3])], "avatar.png", { type: "image/png" })
        );
        assert.equal(uploaded.profile?.avatar_uri, "/v1/users/me/avatar/avatar.png");

        const blob = await fetchUserAvatarImage("/v1/users/me/avatar/avatar.png");
        assert.equal(blob.type, "image/png");

        const removed = await deleteUserAvatar();
        assert.equal(removed.profile?.avatar_uri, null);
      }
    );

    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].headers.get("x-ripple-user-id"), "default");
    assert.equal(seen[1].method, "GET");
    assert.equal(seen[1].headers.get("authorization"), "Bearer service-key");
    assert.equal(seen[2].method, "DELETE");
  });
}

async function testAvatarImageRejectsExternalUrlsBeforeAuthFetch() {
  await withBrowserStorage(async () => {
    setApiKey("service-key");
    let fetchCalled = false;

    await withFetch(
      async () => {
        fetchCalled = true;
        return new Response("unexpected", { status: 200 });
      },
      async () => {
        await assert.rejects(
          () => fetchUserAvatarImage("https://evil.example/avatar.png"),
          (error) => error instanceof Error && /Ripple API URL/.test(error.message)
        );
      }
    );

    assert.equal(fetchCalled, false);
  });
}

async function testUpdateUserProfilePatchesDisplayName() {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];

  await withBrowserStorage(async () => {
    setUserSessionToken("rip_usr_token", "usr_abc");
    await withFetch(
      async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method || "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(
          JSON.stringify({
            user_id: "usr_abc",
            profile: {
              user_id: "usr_abc",
              user_name: "Alice",
              display_name: "Alice",
              login: "alice@example.com",
              avatar_uri: null,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      },
      async () => {
        const profile = await updateUserProfile({ display_name: "Alice" });
        assert.equal(profile.profile?.display_name, "Alice");
      }
    );
  });

  assert.deepEqual(requests, [
    {
      url: "http://140.143.229.103:8810/v1/users/me/profile",
      method: "PATCH",
      body: { display_name: "Alice" },
    },
  ]);
}

async function testAuthHeadersUseUserSessionWithoutSpoofableUserId() {
  await withBrowserStorage(async () => {
    setUserSessionToken("rip_usr_token", "usr_abc");
    assert.equal(getAuthMode(), "user");
    let headers: HeadersInit | undefined;

    await withFetch(
      async (_input, init) => {
        headers = init?.headers;
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      async () => {
        await fetchModels();
      }
    );

    assert.deepEqual(headers, { Authorization: "Bearer rip_usr_token" });
  });
}

async function testAuthHeadersKeepServiceKeyUserIdCompatibility() {
  await withBrowserStorage(async () => {
    setApiKey("service-key");
    assert.equal(getAuthMode(), "service");
    let headers: HeadersInit | undefined;

    await withFetch(
      async (_input, init) => {
        headers = init?.headers;
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      async () => {
        await fetchModels();
      }
    );

    assert.deepEqual(headers, {
      Authorization: "Bearer service-key",
      "X-Ripple-User-Id": "default",
    });
    clearApiKey();
  });
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

async function testWorkspaceDocumentPreviewUsesPreviewEndpoint() {
  const urls: string[] = [];
  await withFetch(
    async (input) => {
      urls.push(String(input));
      return new Response("pdf-bytes", {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'inline; filename="report.pdf"',
        },
      });
    },
    async () => {
      const preview = await fetchWorkspaceDocumentPreview("/workspace/report.docx");

      assert.equal(preview.filename, "report.pdf");
      assert.equal(preview.blob.type, "application/pdf");
      assert.match(urls[0] || "", /\/workspace\/preview\?path=%2Fworkspace%2Freport\.docx/);
    }
  );
}

async function testWorkspaceDownloadDecodesUtf8ContentDispositionFilename() {
  const urls: string[] = [];
  await withFetch(
    async (input) => {
      urls.push(String(input));
      return new Response("deck", {
        status: 200,
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          "Content-Disposition":
            "attachment; filename=\"download.pptx\"; filename*=UTF-8''%E4%B8%8A%E5%B8%82%E5%85%AC%E5%8F%B8%E8%81%94%E7%B3%BB%E4%BA%BA%E4%B8%80%E9%A1%B5%E5%B1%95%E7%A4%BA.pptx",
        },
      });
    },
    async () => {
      const downloaded = await downloadWorkspaceFile("/workspace/财报/上市公司联系人一页展示.pptx");

      assert.equal(downloaded.filename, "上市公司联系人一页展示.pptx");
      assert.equal(await downloaded.blob.text(), "deck");
      assert.match(
        urls[0] || "",
        /\/workspace\/download\?path=%2Fworkspace%2F%E8%B4%A2%E6%8A%A5%2F%E4%B8%8A%E5%B8%82%E5%85%AC%E5%8F%B8%E8%81%94%E7%B3%BB%E4%BA%BA%E4%B8%80%E9%A1%B5%E5%B1%95%E7%A4%BA\.pptx/
      );
    }
  );
}

async function testCreateTaskTriggerAddsOffsetForNonUtcRunAt() {
  let body: unknown = null;

  await withFetch(
    async (_input, init) => {
      body = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({
          trigger_id: "trg-created",
          trigger_type: "time",
          user_id: "alice",
          title: "Ping",
          prompt: "Say hi",
          kind: "once",
          timezone: "Asia/Shanghai",
          run_at: "2026-05-29T18:01:00Z",
          interval_seconds: null,
          enabled: true,
          status: "active",
          next_run_at: "2026-05-29T18:01:00Z",
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
          created_at: "2026-05-29T17:00:00Z",
          updated_at: "2026-05-29T17:00:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
    async () => {
      await createTaskTrigger("task-time", {
        title: "Ping",
        prompt: "Say hi",
        kind: "once",
        timezone: "Asia/Shanghai",
        run_at: "2026-05-30T02:01",
      });
    }
  );

  assert.deepEqual(body, {
    title: "Ping",
    prompt: "Say hi",
    kind: "once",
    timezone: "Asia/Shanghai",
    run_at: "2026-05-30T02:01:00+08:00",
  });
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
          contextFolderPath: null,
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

async function testForkSessionPostsToForkEndpointAndNormalizesSession() {
  const requests: Array<{ method: string; path: string }> = [];

  await withFetch(
    async (input, init) => {
      const url = new URL(String(input));
      requests.push({ method: init?.method || "GET", path: url.pathname });
      return new Response(
        JSON.stringify({
          ok: true,
          source_session_id: "srv-parent",
          codex_thread_id: "thr-child",
          session: {
            session_id: "srv-child",
            title: "Forked session",
            pinned: false,
            forked_from_session_id: "srv-parent",
            model: "gpt-5",
            created_at: "2026-06-30T00:00:00Z",
            last_active: "2026-06-30T00:01:00Z",
            message_count: 2,
            status: "idle",
            changed_file_count: 0,
            pending_approval_count: 0,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
    async () => {
      assert.deepEqual(await forkSession("srv-parent"), {
        sessionId: "srv-child",
        title: "Forked session",
        pinned: false,
        contextFolderPath: null,
        forkedFromSessionId: "srv-parent",
        model: "gpt-5",
        createdAt: "2026-06-30T00:00:00Z",
        lastActiveAt: "2026-06-30T00:01:00Z",
        messageCount: 2,
        status: "idle",
        changedFileCount: 0,
        pendingApprovalCount: 0,
      });
    }
  );

  assert.deepEqual(requests, [{ method: "POST", path: "/v1/sessions/srv-parent/fork" }]);
}

async function testListApisFollowBackendPaginationCursors() {
  const requests: string[] = [];

  await withFetch(
    async (input) => {
      const url = new URL(String(input));
      requests.push(`${url.pathname}${url.search}`);
      const cursor = url.searchParams.get("cursor");

      if (url.pathname.endsWith("/sessions")) {
        return new Response(
          JSON.stringify({
            sessions:
              cursor === "sessions-page-2"
                ? [
                    {
                      session_id: "srv-page-2",
                      title: "Second page",
                      model: "gpt-5",
                      created_at: "2026-06-20T00:00:00Z",
                      last_active: "2026-06-20T00:01:00Z",
                      message_count: 1,
                      status: "idle",
                      changed_file_count: 0,
                      pending_approval_count: 0,
                    },
                  ]
                : [
                    {
                      session_id: "srv-page-1",
                      title: "First page",
                      model: "gpt-5",
                      created_at: "2026-06-19T00:00:00Z",
                      last_active: "2026-06-19T00:01:00Z",
                      message_count: 1,
                      status: "idle",
                      changed_file_count: 0,
                      pending_approval_count: 0,
                    },
                  ],
            next_cursor: cursor === "sessions-page-2" ? null : "sessions-page-2",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.pathname.endsWith("/tasks")) {
        return new Response(
          JSON.stringify({
            tasks:
              cursor === "tasks-page-2"
                ? [{ task_id: "task-page-2", title: "Second task" }]
                : [{ task_id: "task-page-1", title: "First task" }],
            next_cursor: cursor === "tasks-page-2" ? null : "tasks-page-2",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.pathname.endsWith("/task-triggers")) {
        const base = {
          trigger_type: "time",
          user_id: "default",
          title: "Reminder",
          prompt: "提醒",
          kind: "once",
          timezone: "Asia/Shanghai",
          run_at: null,
          interval_seconds: null,
          enabled: true,
          status: "active",
          next_run_at: null,
          last_run_at: null,
          last_run_id: null,
          last_error: null,
          cwd: null,
          model: null,
          effort: null,
          summary: null,
          output_schema: null,
          max_runtime_seconds: 1800,
          max_runs: 1,
          run_count: 0,
          created_at: "2026-06-20T00:00:00Z",
          updated_at: "2026-06-20T00:00:00Z",
        };
        return new Response(
          JSON.stringify({
            triggers:
              cursor === "triggers-page-2"
                ? [{ ...base, trigger_id: "trg-page-2" }]
                : [{ ...base, trigger_id: "trg-page-1" }],
            next_cursor: cursor === "triggers-page-2" ? null : "triggers-page-2",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      throw new Error(`Unexpected request: ${url.pathname}`);
    },
    async () => {
      assert.deepEqual(
        (await fetchSessions()).map((session) => session.sessionId),
        ["srv-page-1", "srv-page-2"]
      );
      assert.deepEqual(
        (await fetchTasks()).map((task) => task.taskId),
        ["task-page-1", "task-page-2"]
      );
      assert.deepEqual(
        (await fetchAllTaskTriggers()).map((trigger) => trigger.trigger_id),
        ["trg-page-1", "trg-page-2"]
      );
    }
  );

  assert.ok(requests.includes("/v1/sessions?cursor=sessions-page-2"));
  assert.ok(requests.includes("/v1/tasks?cursor=tasks-page-2"));
  assert.ok(requests.includes("/v1/task-triggers?cursor=triggers-page-2"));
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

async function testCreateSessionPostsSelectedModel() {
  let requestBody: unknown = null;

  await withFetch(
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body || "{}"));
      return new Response(
        JSON.stringify({
          session_id: "srv-created",
          title: "",
          pinned: false,
          model: "codex-high",
          created_at: "2026-05-19T00:00:00.000Z",
          last_active: "2026-05-19T00:00:00.000Z",
          message_count: 0,
          status: "idle",
          changed_file_count: 0,
          pending_approval_count: 0,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
    async () => {
      await createSession({ model: "codex-high" });
    }
  );

  assert.deepEqual(requestBody, { model: "codex-high" });
}

async function testUpdateSessionPatchesSelectedModel() {
  let requestBody: unknown = null;

  await withFetch(
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body || "{}"));
      return new Response(
        JSON.stringify({
          session_id: "srv-updated",
          title: "Updated session",
          pinned: false,
          model: "codex-high",
          created_at: "2026-05-19T00:00:00.000Z",
          last_active: "2026-05-19T00:00:00.000Z",
          message_count: 0,
          status: "idle",
          changed_file_count: 0,
          pending_approval_count: 0,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
    async () => {
      await updateSession("srv-updated", { model: "codex-high" });
    }
  );

  assert.deepEqual(requestBody, { model: "codex-high" });
}

async function testCreateSessionPostsContextFolderPath() {
  let requestBody: unknown = null;

  await withFetch(
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body || "{}"));
      return new Response(
        JSON.stringify({
          session_id: "srv-created",
          title: "",
          pinned: false,
          model: "codex-test",
          created_at: "2026-05-30T00:00:00Z",
          last_active: "2026-05-30T00:00:00Z",
          message_count: 0,
          status: "idle",
          changed_file_count: 0,
          pending_approval_count: 0,
          context_folder_path: "/workspace/demo",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
    async () => {
      const session = await createSession({
        model: "codex-test",
        contextFolderPath: "/workspace/demo",
      });
      assert.equal(session.contextFolderPath, "/workspace/demo");
    }
  );

  assert.deepEqual(requestBody, {
    model: "codex-test",
    context_folder_path: "/workspace/demo",
  });
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
          pending_control_request: {
            type: "agent_delegation_clarification",
            delegation_id: "dlg-1",
            target_user_id: "bob",
            question: "Which branch should I inspect?",
            reason: "The task did not name a branch.",
          },
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
        contextFolderPath: null,
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
        pendingControlRequest: {
          type: "agent_delegation_clarification",
          delegation_id: "dlg-1",
          target_user_id: "bob",
          question: "Which branch should I inspect?",
          reason: "The task did not name a branch.",
        },
        pendingPermissionRequest: { tool: "exec", params: {}, riskLevel: "medium" },
        planSteps: [{ id: "step-1", subject: "Inspect", status: "completed" }],
        planProgress: { completed: 1, total: 1 },
      });
    }
  );
}

async function testAgentDelegationApisUseExpectedRoutesAndPayloads() {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const rawDelegation = {
    delegation_id: "dlg-1",
    requester_user_id: "alice",
    requester_session_id: "sess-a",
    target_user_id: "bob",
    target_session_id: "sess-b",
    target_job_id: "job-b",
    status: "awaiting_requester_info",
    task_title: "Check release",
    task_prompt: "Review the release notes.",
    created_at: "2026-07-04T01:00:00Z",
    updated_at: "2026-07-04T01:01:00Z",
    accepted_at: "2026-07-04T01:02:00Z",
    completed_at: null,
    result_text: "最终产物：已整理三条要点。",
    result_status: "completed",
    result_job_id: "job-b",
    result_updated_at: "2026-07-04T01:03:00Z",
    result_output_available: true,
    pending_clarification: { question: "Need version?" },
    last_answer_event: null,
    reason: null,
    error: null,
  };

  await withFetch(
    async (input, init) => {
      const url = new URL(String(input));
      requests.push({
        method: init?.method || "GET",
        path: `${url.pathname}${url.search}`,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(
        JSON.stringify(
          url.pathname === "/v1/agent-delegations" && !init?.method
            ? { delegations: [rawDelegation], count: 1 }
            : rawDelegation
        ),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
    async () => {
      const listed = await fetchAgentDelegations("received");
      assert.equal(listed[0]?.delegationId, "dlg-1");
      assert.equal(listed[0]?.pendingClarification?.question, "Need version?");
      assert.equal(listed[0]?.resultText, "最终产物：已整理三条要点。");
      assert.equal(listed[0]?.resultStatus, "completed");
      assert.equal(listed[0]?.resultJobId, "job-b");
      assert.equal(listed[0]?.resultOutputAvailable, true);

      await createAgentDelegation({
        targetUserId: "bob",
        sourceSessionId: "sess/a",
        taskTitle: "Check release",
        taskPrompt: "Review the release notes.",
      });
      await acceptAgentDelegation("dlg/1");
      await rejectAgentDelegation("dlg/1", "Not available");
      await answerAgentDelegation("dlg/1", "Use v1.2.3.");
    }
  );

  assert.deepEqual(requests, [
    { method: "GET", path: "/v1/agent-delegations?role=received", body: null },
    {
      method: "POST",
      path: "/v1/agent-delegations",
      body: {
        target_user_id: "bob",
        source_session_id: "sess/a",
        task_title: "Check release",
        task_prompt: "Review the release notes.",
      },
    },
    { method: "POST", path: "/v1/agent-delegations/dlg%2F1/accept", body: {} },
    {
      method: "POST",
      path: "/v1/agent-delegations/dlg%2F1/reject",
      body: { reason: "Not available" },
    },
    {
      method: "POST",
      path: "/v1/agent-delegations/dlg%2F1/answer",
      body: { answer: "Use v1.2.3." },
    },
  ]);
}

async function testAgentContactApisUseExpectedRoutesAndPayloads() {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const rawContact = {
    owner_user_id: "alice",
    contact_user_id: "bob",
    remark: "发布负责人",
    created_at: "2026-07-06T01:00:00Z",
    updated_at: "2026-07-06T01:01:00Z",
    profile: {
      user_id: "bob",
      user_name: "Bob",
      display_name: "Bob",
      login: "bob@example.com",
      avatar_uri: "/v1/users/me/avatar/avatar.png",
    },
  };

  await withFetch(
    async (input, init) => {
      const url = new URL(String(input));
      requests.push({
        method: init?.method || "GET",
        path: `${url.pathname}${url.search}`,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(
        JSON.stringify(
          url.pathname === "/v1/contacts" && !init?.method
            ? { contacts: [rawContact], count: 1 }
            : url.pathname === "/v1/contacts/bob" && init?.method === "PATCH"
              ? { ...rawContact, remark: JSON.parse(String(init.body)).remark }
              : url.pathname === "/v1/contacts/bob" && init?.method === "DELETE"
                ? { deleted: true, contact_user_id: "bob" }
                : rawContact
        ),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
    async () => {
      const listed = await fetchAgentContacts();
      assert.equal(listed[0]?.contactUserId, "bob");
      assert.equal(listed[0]?.remark, "发布负责人");
      assert.equal(listed[0]?.profile?.userName, "Bob");

      const added = await addAgentContact("bob");
      assert.equal(added.contactUserId, "bob");

      const updated = await updateAgentContact("bob", { remark: "值班联系人" });
      assert.equal(updated.remark, "值班联系人");

      const removed = await removeAgentContact("bob");
      assert.equal(removed.deleted, true);
      assert.equal(removed.contactUserId, "bob");
    }
  );

  assert.deepEqual(requests, [
    { method: "GET", path: "/v1/contacts", body: null },
    {
      method: "POST",
      path: "/v1/contacts",
      body: { contact_user_id: "bob" },
    },
    {
      method: "PATCH",
      path: "/v1/contacts/bob",
      body: { remark: "值班联系人" },
    },
    { method: "DELETE", path: "/v1/contacts/bob", body: null },
  ]);
}

async function testConversationAndAgentInvocationApisUseExpectedRoutesAndPayloads() {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const rawConversation = {
    conversation_id: "conv-1",
    kind: "direct",
    direct_key: "alice:bob",
    title: null,
    created_by_user_id: "alice",
    created_at: "2026-07-07T01:00:00Z",
    updated_at: "2026-07-07T01:01:00Z",
    last_message_at: "2026-07-07T01:01:00Z",
    participants: [
      {
        conversation_id: "conv-1",
        actor_type: "user",
        actor_id: "alice",
        user_id: "alice",
        role: "member",
        status: "active",
      },
      {
        conversation_id: "conv-1",
        actor_type: "user",
        actor_id: "bob",
        user_id: "bob",
        role: "member",
        status: "active",
      },
    ],
  };
  const rawMessage = {
    conversation_id: "conv-1",
    seq: 1,
    message_id: "cmsg-1",
    sender_user_id: "alice",
    sender_actor_type: "user",
    sender_actor_id: "alice",
    kind: "text",
    body: { text: "先一起看这个方案" },
    created_at: "2026-07-07T01:01:00Z",
  };
  const rawInvocation = {
    invocation_id: "ainv-1",
    conversation_id: "conv-1",
    request_message_id: "cmsg-2",
    requester_user_id: "alice",
    target_user_id: "bob",
    target_agent_id: "bob-agent",
    status: "pending_approval",
    prompt: "@bob-agent 帮我们整理上面的方案",
    requires_target_approval: true,
    context_snapshot: { conversation_id: "conv-1", messages: [rawMessage] },
    created_at: "2026-07-07T01:02:00Z",
    updated_at: "2026-07-07T01:02:00Z",
  };
  const rawStartedInvocation = {
    ...rawInvocation,
    status: "running",
    target_session_id: "session-agent-1",
    target_job_id: "agent-1",
    updated_at: "2026-07-07T01:03:00Z",
  };

  await withFetch(
    async (input, init) => {
      const url = new URL(String(input));
      requests.push({
        method: init?.method || "GET",
        path: `${url.pathname}${url.search}`,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      let payload: unknown = rawConversation;
      if (url.pathname === "/v1/conversations" && !init?.method) {
        payload = { conversations: [rawConversation], count: 1 };
      } else if (url.pathname === "/v1/conversations/conv%2F1/messages" && !init?.method) {
        payload = { messages: [rawMessage], count: 1 };
      } else if (url.pathname === "/v1/conversations/conv%2F1/read") {
        payload = {
          participant: {
            conversation_id: "conv-1",
            actor_type: "user",
            actor_id: "alice",
            user_id: "alice",
            role: "member",
            status: "active",
            last_read_message_seq: 1,
          },
        };
      } else if (
        url.pathname === "/v1/conversations/conv%2F1/agent-invocations"
      ) {
        payload = rawInvocation;
      } else if (url.pathname === "/v1/agent-invocations/ainv%2F1/approve") {
        payload = rawStartedInvocation;
      } else if (url.pathname === "/v1/conversations/conv%2F1/messages") {
        payload = rawMessage;
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    async () => {
      const conversations = await fetchConversations();
      assert.equal(conversations[0]?.conversationId, "conv-1");
      assert.equal(conversations[0]?.participants[1]?.userId, "bob");

      const direct = await createDirectConversation("bob");
      assert.equal(direct.conversationId, "conv-1");

      const messages = await fetchConversationMessages("conv/1");
      assert.equal(messages[0]?.body.text, "先一起看这个方案");

      const newerMessages = await fetchConversationMessages("conv/1", { afterSeq: 1 });
      assert.equal(newerMessages[0]?.body.text, "先一起看这个方案");

      await markConversationRead("conv/1", 1);

      const message = await createConversationMessage("conv/1", "继续讨论");
      assert.equal(message.messageId, "cmsg-1");

      const invocation = await createAgentInvocation("conv/1", {
        targetUserId: "bob",
        prompt: "@bob-agent 帮我们整理上面的方案",
        contextMessageCount: 10,
      });
      assert.equal(invocation.invocationId, "ainv-1");
      assert.equal(invocation.requiresTargetApproval, true);
      assert.equal(invocation.contextSnapshot.messages[0]?.messageId, "cmsg-1");

      const approved = await approveAgentInvocation("ainv/1", "可以执行");
      assert.equal(approved.status, "running");
      assert.equal(approved.targetJobId, "agent-1");
    }
  );

  assert.deepEqual(requests, [
    { method: "GET", path: "/v1/conversations", body: null },
    {
      method: "POST",
      path: "/v1/conversations/direct",
      body: { contact_user_id: "bob" },
    },
    { method: "GET", path: "/v1/conversations/conv%2F1/messages", body: null },
    { method: "GET", path: "/v1/conversations/conv%2F1/messages?after_seq=1", body: null },
    {
      method: "POST",
      path: "/v1/conversations/conv%2F1/read",
      body: { last_read_message_seq: 1 },
    },
    {
      method: "POST",
      path: "/v1/conversations/conv%2F1/messages",
      body: { text: "继续讨论" },
    },
    {
      method: "POST",
      path: "/v1/conversations/conv%2F1/agent-invocations",
      body: {
        target_user_id: "bob",
        prompt: "@bob-agent 帮我们整理上面的方案",
        context_message_count: 10,
      },
    },
    {
      method: "POST",
      path: "/v1/agent-invocations/ainv%2F1/approve",
      body: { note: "可以执行" },
    },
  ]);
}

function testSessionFollowUpClientApisAreRemoved() {
  const source = readFileSync(new URL("./api.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /sessionFollowUpPath/);
  assert.doesNotMatch(source, /fetchSessionFollowUps/);
  assert.doesNotMatch(source, /confirmSessionFollowUp/);
  assert.doesNotMatch(source, /updateSessionFollowUp/);
  assert.doesNotMatch(source, /runSessionFollowUpNow/);
  assert.doesNotMatch(source, /cancelSessionFollowUp/);
}

async function testTaskApisUseExpectedBackendShape() {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const taskResponse = {
    task: {
      task_id: "task/with space",
      user_id: "default",
      title: "整理客户方案",
      objective: "形成报价草案",
      status: "in_progress",
      priority: "normal",
      requires_confirmation: false,
      source_session_id: "srv-detail",
      progress: {
        completed: 1,
        total: 2,
        percent: 50,
        current_action_id: "act/1",
        current_action_title: "生成报价",
      },
      created_at: "2026-06-17T08:00:00.000Z",
      updated_at: "2026-06-17T09:00:00.000Z",
      pinned: true,
    },
    actions: [
      {
        action_id: "act/1",
        task_id: "task/with space",
        user_id: "default",
        kind: "next_step",
        title: "生成报价",
        objective: "形成报价草案",
        status: "in_progress",
        assignee: "codex",
        requires_confirmation: false,
        due_at: "2026-06-18T09:00:00.000Z",
        result_summary: "已完成报价草案。",
        created_at: "2026-06-17T08:30:00.000Z",
        updated_at: "2026-06-17T09:00:00.000Z",
      },
    ],
  };

  await withFetch(
    async (input, init) => {
      const url = new URL(String(input), "http://ripple.test");
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ method: init?.method || "GET", path: url.pathname, body });

      if (url.pathname.endsWith("/events")) {
        return new Response(
          JSON.stringify({
            events: [
              {
                event_id: "evt-1",
                task_id: "task/with space",
                user_id: "default",
                type: "task_action_started",
                details: { action_id: "act/1" },
                created_at: "2026-06-17T09:00:00.000Z",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.pathname.endsWith("/run-now")) {
        return new Response(
          JSON.stringify({
            job_id: "job-1",
            provider: "codex",
            status: "completed",
            output_file: null,
            events_file: null,
            created_at: "2026-06-17T09:00:00.000Z",
            updated_at: "2026-06-17T09:01:00.000Z",
            exit_code: 0,
            prompt_preview: "整理客户方案",
            sandbox_cwd: "/workspace",
            stdout_tail: "",
            stderr_tail: "",
            error: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.pathname.endsWith("/actions")) {
        return new Response(
          JSON.stringify({
            action: {
              ...taskResponse.actions[0],
              action_id: "act/created",
              kind: "waiting_user",
              title: "等用户确认",
              due_at: "2026-06-18T09:00:00.000Z",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      if (url.pathname === "/v1/tasks") {
        return new Response(JSON.stringify({ tasks: [taskResponse.task], count: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname.endsWith("/tasks")) {
        return new Response(JSON.stringify({ tasks: [taskResponse.task], count: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify(taskResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    async () => {
      const tasks = await fetchTasks();
      assert.equal(tasks[0]?.taskId, "task/with space");
      assert.equal(tasks[0]?.pinned, true);
      assert.equal(tasks[0]?.progress?.currentActionTitle, "生成报价");
      assert.equal((await fetchSessionTasks("srv-detail"))[0]?.sourceSessionId, "srv-detail");
      assert.equal(
        (await fetchTask("task/with space")).actions[0]?.nextWakeupAt,
        "2026-06-18T09:00:00.000Z"
      );
      assert.equal((await confirmTask("task/with space")).task.status, "in_progress");
      assert.equal((await runTaskNow("task/with space")).job_id, "job-1");
      assert.equal((await cancelTask("task/with space")).task.taskId, "task/with space");
      assert.equal((await updateTask("task/with space", { pinned: false })).task.pinned, true);
      assert.equal((await deleteTask("task/with space")).taskId, "task/with space");
      const taskEvents = await fetchTaskEvents("task/with space");
      assert.equal(taskEvents[0]?.eventType, "task_action_started");
      assert.deepEqual(taskEvents[0]?.payload, { action_id: "act/1" });
      assert.equal(
        (
          await createTaskAction("task/with space", {
            title: "等用户确认",
            kind: "waiting_user",
            nextWakeupAt: "2026-06-18T09:00",
          })
        ).title,
        "等用户确认"
      );
      assert.equal(
        (
          await updateTaskAction("task/with space", "act/1", {
            status: "completed",
            resultSummary: "已完成报价草案。",
            sequenceIndex: 2,
          })
        ).action.resultSummary,
        "已完成报价草案。"
      );
    }
  );

  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.path}`),
    [
      "GET /v1/tasks",
      "GET /v1/sessions/srv-detail/tasks",
      "GET /v1/tasks/task%2Fwith%20space",
      "POST /v1/tasks/task%2Fwith%20space/confirm",
      "POST /v1/tasks/task%2Fwith%20space/run-now",
      "DELETE /v1/tasks/task%2Fwith%20space",
      "PATCH /v1/tasks/task%2Fwith%20space",
      "POST /v1/tasks/task%2Fwith%20space/delete",
      "GET /v1/tasks/task%2Fwith%20space/events",
      "POST /v1/tasks/task%2Fwith%20space/actions",
      "PATCH /v1/tasks/task%2Fwith%20space/actions/act%2F1",
    ]
  );
  assert.equal((requests[6]?.body as Record<string, unknown>)?.pinned, false);
  assert.equal((requests[9]?.body as Record<string, unknown>)?.title, "等用户确认");
  assert.equal((requests[9]?.body as Record<string, unknown>)?.kind, "waiting_user");
  assert.notEqual(
    (requests[9]?.body as Record<string, unknown>)?.next_wakeup_at,
    "2026-06-18T09:00"
  );
  assert.match(
    String((requests[9]?.body as Record<string, unknown>)?.next_wakeup_at),
    /^2026-06-18T\d{2}:00:00\.000Z$/
  );
  assert.deepEqual(requests[10]?.body, {
    status: "completed",
    result_summary: "已完成报价草案。",
    sequence_index: 2,
  });
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

async function testResponsesStreamDeltaFeedsChatCallbacks() {
  const deltas: string[] = [];
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
      async () =>
        new Response(
          [
            'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_session-1"}}\n\n',
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n',
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" world"}\n\n',
            'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }
        ),
      async () => {
        await sendChatMessage("session-1", "hi", "codex-test", {
          onMessageDelta: (delta) => deltas.push(delta),
          onToolCall: () => undefined,
          onToolResult: () => undefined,
          onUsage: () => undefined,
          onComplete: () => undefined,
          onError: () => undefined,
        });
      }
    );
  } finally {
    globals.document = previousDocument;
    globals.window = previousWindow;
  }

  assert.deepEqual(deltas, ["hello", " world"]);
}

async function testResponsesStreamCompletedDoesNotReportCodexTurnDiff() {
  const runtimeEvents: unknown[] = [];
  const changedFiles: unknown[] = [];
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
      async () =>
        new Response(
          [
            'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_session-1"}}\n\n',
            'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","ripple_codex_turn_diff":{"type":"codex_turn_diff_updated","codex_method":"turn/diff/updated","turn_id":"turn-1","diff":"diff --git a/app/src/App.tsx b/app/src/App.tsx\\n+new"}}}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }
        ),
      async () => {
        await sendChatMessage("session-1", "hi", "codex-test", {
          onMessageDelta: () => undefined,
          onToolCall: () => undefined,
          onToolResult: () => undefined,
          onUsage: () => undefined,
          onRuntimeEvent: (event) => runtimeEvents.push(event),
          onChangedFiles: (files) => changedFiles.push(...files),
          onComplete: () => undefined,
          onError: () => undefined,
        });
      }
    );
  } finally {
    globals.document = previousDocument;
    globals.window = previousWindow;
  }

  assert.deepEqual(runtimeEvents, []);
  assert.deepEqual(changedFiles, []);
}

async function testResponsesStreamCompletedReportsChangedFilesWithoutPatch() {
  const changedFiles: unknown[] = [];
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
      async () =>
        new Response(
          [
            'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_session-1"}}\n\n',
            'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","ripple_changed_files":{"files":[{"path":"app/src/App.tsx","status":"modified","additions":3,"deletions":1,"patch":"diff --git a/app/src/App.tsx b/app/src/App.tsx\\n+new"},{"path":"docs/new.md","status":"added","additions":2}]}}}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }
        ),
      async () => {
        await sendChatMessage("session-1", "hi", "codex-test", {
          onMessageDelta: () => undefined,
          onToolCall: () => undefined,
          onToolResult: () => undefined,
          onUsage: () => undefined,
          onChangedFiles: (files) => changedFiles.push(...files),
          onComplete: () => undefined,
          onError: () => undefined,
        });
      }
    );
  } finally {
    globals.document = previousDocument;
    globals.window = previousWindow;
  }

  assert.deepEqual(changedFiles, [
    { path: "app/src/App.tsx", status: "modified", additions: 3, deletions: 1 },
    { path: "docs/new.md", status: "added", additions: 2 },
  ]);
}

async function testSendChatMessagePassesRequiredSkillsAndScreenContext() {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
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
      async (input, init) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
        });
        return new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
      async () => {
        await sendChatMessage(
          "session-1",
          "这个按钮有什么用？",
          "codex-test",
          {
            onMessageDelta: () => undefined,
            onToolCall: () => undefined,
            onToolResult: () => undefined,
            onUsage: () => undefined,
            onComplete: () => undefined,
            onError: () => undefined,
          },
          {
            requiredSkillIds: ["ripple:viaim-product-support"],
            screenContext: {
              app: "ripple",
              screen_id: "session.chat",
            },
          }
        );
      }
    );
  } finally {
    globals.document = previousDocument;
    globals.window = previousWindow;
  }

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body.metadata, {
    ripple_session_id: "session-1",
    required_skill_ids: ["ripple:viaim-product-support"],
    screen_context: {
      app: "ripple",
      screen_id: "session.chat",
    },
  });
}

async function testSendChatMessagePassesClientContextOption() {
  const requests: Array<{ body: Record<string, unknown> }> = [];
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
  const clientContext = {
    schema_version: "ripple.client_context.v1",
    software: {
      host_app: {
        app_id: "viaim.meeting",
      },
      screen: {
        screen_id: "meeting.detail",
      },
    },
    devices: [
      {
        kind: "ai_headset",
        state: {
          noise_control: "anc",
        },
      },
    ],
  };

  try {
    await withFetch(
      async (_input, init) => {
        requests.push({
          body: JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
        });
        return new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
      async () => {
        await sendChatMessage(
          "session-1",
          "根据当前上下文解释一下",
          "codex-test",
          {
            onMessageDelta: () => undefined,
            onToolCall: () => undefined,
            onToolResult: () => undefined,
            onUsage: () => undefined,
            onComplete: () => undefined,
            onError: () => undefined,
          },
          {
            requiredSkillIds: ["ripple:viaim-product-support"],
            clientContext,
          }
        );
      }
    );
  } finally {
    globals.document = previousDocument;
    globals.window = previousWindow;
  }

  assert.equal(requests.length, 1);
  assert.deepEqual((requests[0].body.metadata as Record<string, unknown>)?.required_skill_ids, [
    "ripple:viaim-product-support",
  ]);
  assert.equal(
    (
      (requests[0].body.metadata as Record<string, unknown>)?.client_context as Record<
        string,
        unknown
      >
    )?.schema_version,
    "ripple.client_context.v1"
  );
}

async function testSendChatMessagePassesBrowserContextOption() {
  const requests: Array<{ body: Record<string, unknown> }> = [];
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
  const browserContext = {
    schema_version: "ripple.browser_context.v1",
    active: true,
    page: {
      url: "https://example.com/article",
      title: "Example article",
      visible_text: "Important article body",
    },
  };

  try {
    await withFetch(
      async (_input, init) => {
        requests.push({
          body: JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
        });
        return new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
      async () => {
        await sendChatMessage(
          "session-1",
          "总结当前网页",
          "codex-test",
          {
            onMessageDelta: () => undefined,
            onToolCall: () => undefined,
            onToolResult: () => undefined,
            onUsage: () => undefined,
            onComplete: () => undefined,
            onError: () => undefined,
          },
          {
            browserContext,
          }
        );
      }
    );
  } finally {
    globals.document = previousDocument;
    globals.window = previousWindow;
  }

  assert.equal(requests.length, 1);
  assert.equal(
    (
      (requests[0].body.metadata as Record<string, unknown>)?.browser_context as Record<
        string,
        unknown
      >
    )?.schema_version,
    "ripple.browser_context.v1"
  );
  assert.equal(
    (
      (
        (requests[0].body.metadata as Record<string, unknown>)?.browser_context as Record<
          string,
          unknown
        >
      )?.page as Record<string, unknown>
    )?.url,
    "https://example.com/article"
  );
}

function testApiDoesNotExposeBrowserPageFallback() {
  const source = readFileSync(new URL("./api.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /fetchBrowserPage/);
  assert.doesNotMatch(source, /\/browser\/page/);
  assert.doesNotMatch(source, /preview_html/);
}

async function testSendChatMessageDoesNotSendPreferredSkillIds() {
  const requests: Array<{ body: Record<string, unknown> }> = [];
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
      async (_input, init) => {
        requests.push({
          body: JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
        });
        return new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
      async () => {
        await sendChatMessage(
          "session-1",
          "hello",
          "codex-test",
          {
            onMessageDelta: () => undefined,
            onToolCall: () => undefined,
            onToolResult: () => undefined,
            onUsage: () => undefined,
            onComplete: () => undefined,
            onError: () => undefined,
          },
          {
            preferredSkillIds: ["ripple:unused"],
          } as unknown as Parameters<typeof sendChatMessage>[4]
        );
      }
    );
  } finally {
    globals.document = previousDocument;
    globals.window = previousWindow;
  }

  assert.equal(requests.length, 1);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      requests[0].body.metadata as Record<string, unknown>,
      "preferred_skill_ids"
    ),
    false
  );
}

async function testSessionControlActionUsesStructuredResponsesInput() {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
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
      async (input, init) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
        });
        return new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
      async () => {
        await sendSessionControlAction(
          "session-1",
          "Connect Google Workspace",
          {
            type: "connector.auth.start",
            connector: "google_workspace",
            source: "connectors_page",
          },
          "codex-test",
          {
            onMessageDelta: () => undefined,
            onToolCall: () => undefined,
            onToolResult: () => undefined,
            onUsage: () => undefined,
            onComplete: () => undefined,
            onError: () => undefined,
          }
        );
      }
    );
  } finally {
    globals.document = previousDocument;
    globals.window = previousWindow;
  }

  assert.equal(requests[0]?.url, "http://140.143.229.103:8810/v1/responses");
  assert.equal(requests[0]?.body.previous_response_id, "resp_session-1");
  const input = requests[0]?.body.input as Array<Record<string, unknown>>;
  const content = input[0]?.content as Array<Record<string, unknown>>;
  assert.deepEqual(content, [
    {
      type: "ripple_control_action",
      label: "Connect Google Workspace",
      action: {
        type: "connector.auth.start",
        connector: "google_workspace",
        source: "connectors_page",
      },
    },
  ]);
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

function testViteDevServerProxiesV1ToPublicRippleServer() {
  const config = readFileSync(new URL("../../vite.config.ts", import.meta.url), "utf8");

  assert.match(config, /proxy/);
  assert.match(config, new RegExp(String.raw`["']/v1["']`));
  assert.match(config, new RegExp(String.raw`http://140\.143\.229\.103:8810`));
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

test("api client behavior", async () => {
  testDefaultApiOriginUsesPublicBaseUrl();
  testDevDefaultApiUrlUsesSameOriginProxy();
  testViteDevServerProxiesV1ToPublicRippleServer();
  testChatStreamingStaysOpenWhenPageIsHidden();
  testChatStreamingAcceptsImageRuntimeEvents();
  await testRenameEndpointNotFoundAsksForServerRestart();
  await testRenamePathNotFoundStaysFileSpecific();
  await testRenameConflictUsesFriendlyMessage();
  await testSessionIdIsEncodedInPath();
  await testTaskTriggerApisUseTaskScopedRoutes();
  testApiClientExposesMemoryEndpoints();
  await testMemoryApisUseExpectedRoutesAndPayloads();
  await testConnectorManagementApisEncodeNamesAndPayloads();
  await testCapabilityApisUseUnifiedCatalogAndSkillPatch();
  await testSkillApisUseUserFacingSkillEndpoints();
  await testChangePasswordPostsCurrentAndNewPassword();
  await testAvatarApisUseServerProfileStorage();
  await testAvatarImageRejectsExternalUrlsBeforeAuthFetch();
  await testUpdateUserProfilePatchesDisplayName();
  await testAuthHeadersUseUserSessionWithoutSpoofableUserId();
  await testAuthHeadersKeepServiceKeyUserIdCompatibility();
  testParseWorkspaceLinkDecodesEncodedSandboxPath();
  await testWorkspaceFilePreviewPathNotFoundStaysFileSpecific();
  await testWorkspaceDocumentPreviewUsesPreviewEndpoint();
  await testWorkspaceDownloadDecodesUtf8ContentDispositionFilename();
  await testCreateTaskTriggerAddsOffsetForNonUtcRunAt();
  await testFetchSessionsNormalizesBackendShape();
  await testForkSessionPostsToForkEndpointAndNormalizesSession();
  await testCreateSessionNormalizesBackendShape();
  await testCreateSessionPostsSelectedModel();
  await testUpdateSessionPatchesSelectedModel();
  await testCreateSessionPostsContextFolderPath();
  await testFetchSessionDetailsNormalizesBackendShape();
  await testAgentDelegationApisUseExpectedRoutesAndPayloads();
  await testAgentContactApisUseExpectedRoutesAndPayloads();
  await testConversationAndAgentInvocationApisUseExpectedRoutesAndPayloads();
  await testListApisFollowBackendPaginationCursors();
  testSessionFollowUpClientApisAreRemoved();
  await testTaskApisUseExpectedBackendShape();
  await testFetchSessionsRejectsServerFailures();
  await testFetchSessionsRejectsNetworkFailures();
  await testWorkspaceSearchDefaultsToNameScope();
  await testChatStreamUsesServerConflictDetail();
  await testResponsesStreamDeltaFeedsChatCallbacks();
  await testResponsesStreamCompletedDoesNotReportCodexTurnDiff();
  await testResponsesStreamCompletedReportsChangedFilesWithoutPatch();
  await testSendChatMessagePassesRequiredSkillsAndScreenContext();
  await testSendChatMessagePassesClientContextOption();
  await testSendChatMessagePassesBrowserContextOption();
  testApiDoesNotExposeBrowserPageFallback();
  await testSendChatMessageDoesNotSendPreferredSkillIds();
  await testSessionControlActionUsesStructuredResponsesInput();
});
