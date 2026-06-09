import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  cancelConnectorAuth,
  cancelSessionConnectorAuth,
  changePassword,
  compactSessionContext,
  createSchedule,
  createSession,
  deleteUserAvatar,
  deleteSchedule,
  deleteScheduleRun,
  deleteSession,
  downloadRunOutput,
  downloadWorkspaceFile,
  fetchSchedules,
  fetchScheduleRuns,
  fetchSessions,
  fetchSessionDetails,
  fetchRun,
  fetchRunOutputText,
  fetchUserAvatarImage,
  fetchModels,
  fetchWorkspaceDocumentPreview,
  fetchWorkspaceFilePreview,
  getApiOrigin,
  parseWorkspaceLink,
  renameWorkspaceEntry,
  resolveSessionPermissionRequest,
  resolveApiUrl,
  runScheduleNow,
  searchWorkspaceFiles,
  sendChatMessage,
  sendSessionControlAction,
  stopSession,
  updateSchedule,
  updateSession,
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

async function testScheduleRunApisEncodeIdsAndDownloadOutput() {
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  const scheduleId = "schedule/with space";
  const jobId = "agent/with space";

  await withFetch(
    async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method || "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (init?.method === "DELETE") {
        return new Response(JSON.stringify({ ok: true, job_id: jobId, deleted: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/output")) {
        return new Response("finished output", {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": 'attachment; filename="agent-output.txt"',
          },
        });
      }
      if (url.includes("/schedules/")) {
        return new Response(
          JSON.stringify({
            runs: [
              {
                job_id: jobId,
                provider: "codex",
                status: "completed",
                output_file: null,
                events_file: null,
                output_available: true,
                events_available: false,
                created_at: "2026-05-30T00:00:00Z",
                updated_at: "2026-05-30T00:00:10Z",
                exit_code: 0,
                prompt_preview: "say hi",
                sandbox_cwd: "/workspace",
                stdout_tail: "",
                stderr_tail: "",
                error: null,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          job_id: jobId,
          provider: "codex",
          status: "completed",
          output_file: null,
          events_file: null,
          output_available: true,
          events_available: false,
          created_at: "2026-05-30T00:00:00Z",
          updated_at: "2026-05-30T00:00:10Z",
          exit_code: 0,
          prompt_preview: "say hi",
          sandbox_cwd: "/workspace",
          stdout_tail: "",
          stderr_tail: "",
          error: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
    async () => {
      const scheduleRun = (await fetchScheduleRuns(scheduleId))[0];
      assert.equal(scheduleRun?.job_id, jobId);
      assert.equal(scheduleRun?.output_available, true);
      const run = await fetchRun(jobId);
      assert.equal(run.job_id, jobId);
      assert.equal(run.output_available, true);
      const downloaded = await downloadRunOutput(jobId);
      assert.equal(downloaded.filename, "agent-output.txt");
      assert.equal(await downloaded.blob.text(), "finished output");
      assert.equal(await fetchRunOutputText(jobId), "finished output");
      assert.equal(await deleteScheduleRun(scheduleId, jobId), true);
    }
  );

  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.url}`),
    [
      "GET http://140.143.229.103:8810/v1/schedules/schedule%2Fwith%20space/runs?limit=5",
      "GET http://140.143.229.103:8810/v1/runs/agent%2Fwith%20space",
      "GET http://140.143.229.103:8810/v1/runs/agent%2Fwith%20space/output",
      "GET http://140.143.229.103:8810/v1/runs/agent%2Fwith%20space/output",
      "DELETE http://140.143.229.103:8810/v1/schedules/schedule%2Fwith%20space/runs/agent%2Fwith%20space",
    ]
  );
  assert.equal(requests.at(-1)?.body, JSON.stringify({ confirm: true }));
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

async function testCreateScheduleAddsOffsetForNonUtcRunAt() {
  let body: unknown = null;

  await withFetch(
    async (_input, init) => {
      body = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({
          schedule_id: "sch-created",
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
      await createSchedule({
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
          projectId: null,
          projectName: null,
          projectRoot: null,
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
          project_id: null,
          project_name: null,
          project_root: null,
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
      assert.equal(session.projectId, null);
      assert.equal(session.projectName, null);
      assert.equal(session.projectRoot, null);
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
        projectId: null,
        projectName: null,
        projectRoot: null,
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

async function testSessionControlActionUsesStructuredChatBlock() {
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

  assert.equal(requests[0]?.url, "http://140.143.229.103:8810/v1/chat/completions");
  assert.equal(requests[0]?.body.session_id, "session-1");
  const messages = requests[0]?.body.messages as Array<Record<string, unknown>>;
  const content = messages[0]?.content as Array<Record<string, unknown>>;
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
  await testScheduleIdIsEncodedInPath();
  await testScheduleRunApisEncodeIdsAndDownloadOutput();
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
  await testScheduleApiUsesExpectedBackendShape();
  await testCreateScheduleAddsOffsetForNonUtcRunAt();
  await testFetchSessionsNormalizesBackendShape();
  await testCreateSessionNormalizesBackendShape();
  await testCreateSessionPostsSelectedModel();
  await testUpdateSessionPatchesSelectedModel();
  await testCreateSessionPostsContextFolderPath();
  await testFetchSessionDetailsNormalizesBackendShape();
  await testFetchSessionsRejectsServerFailures();
  await testFetchSessionsRejectsNetworkFailures();
  await testWorkspaceSearchDefaultsToNameScope();
  await testChatStreamUsesServerConflictDetail();
  await testSessionControlActionUsesStructuredChatBlock();
});
