import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  deleteTask,
  fetchTasks,
  fetchTaskDetails,
  getApiOrigin,
  renameWorkspaceEntry,
  resolveTaskPermissionRequest,
  resolveApiUrl,
  searchWorkspaceFiles,
  stopTask,
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

async function testTaskSessionIdIsEncodedInPath() {
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
      await fetchTaskDetails(sessionId);
      await deleteTask(sessionId);
      await stopTask(sessionId);
      await resolveTaskPermissionRequest(sessionId, "allow");
    }
  );

  assert.deepEqual(urls, [
    "https://test-oauth.weilai.ai/v1/tasks/session%2Fwith%20space",
    "https://test-oauth.weilai.ai/v1/tasks/session%2Fwith%20space",
    "https://test-oauth.weilai.ai/v1/tasks/session%2Fwith%20space/stop",
    "https://test-oauth.weilai.ai/v1/tasks/session%2Fwith%20space/permissions/resolve",
  ]);
}

async function testFetchTasksRejectsServerFailures() {
  await withFetch(
    async () => response(500, "session store unavailable"),
    async () => {
      await assert.rejects(
        () => fetchTasks(),
        (error) => error instanceof Error && error.message === "session store unavailable"
      );
    }
  );
}

async function testFetchTasksRejectsNetworkFailures() {
  await withFetch(
    async () => {
      throw new TypeError("Failed to fetch");
    },
    async () => {
      await assert.rejects(
        () => fetchTasks(),
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

function testDefaultApiOriginUsesPublicBaseUrl() {
  assert.equal(getApiOrigin(), "https://test-oauth.weilai.ai");
}

function testDevDefaultApiUrlUsesSameOriginProxy() {
  assert.equal(resolveApiUrl({ DEV: true }), "/v1");
  assert.equal(
    resolveApiUrl({ DEV: true, VITE_RIPPLE_API_URL: "http://localhost:8810/v1" }),
    "http://localhost:8810/v1"
  );
  assert.equal(resolveApiUrl({ PROD: true }), "https://test-oauth.weilai.ai/v1");
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

testDefaultApiOriginUsesPublicBaseUrl();
testDevDefaultApiUrlUsesSameOriginProxy();
testViteDevServerProxiesV1ToLocalRippleServer();
testChatStreamingStaysOpenWhenPageIsHidden();
await testRenameEndpointNotFoundAsksForServerRestart();
await testRenamePathNotFoundStaysFileSpecific();
await testRenameConflictUsesFriendlyMessage();
await testTaskSessionIdIsEncodedInPath();
await testFetchTasksRejectsServerFailures();
await testFetchTasksRejectsNetworkFailures();
await testWorkspaceSearchDefaultsToNameScope();

console.log("api tests passed");
