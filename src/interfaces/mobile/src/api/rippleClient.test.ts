import assert from "node:assert/strict";
import test from "node:test";

import { createRippleClient, normalizeApiBaseUrl, parseSseEvents } from "./rippleClient";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

test("normalizes server URL to the Ripple /v1 API base", () => {
  assert.equal(normalizeApiBaseUrl("http://192.168.1.8:8810"), "http://192.168.1.8:8810/v1");
  assert.equal(normalizeApiBaseUrl("http://192.168.1.8:8810/"), "http://192.168.1.8:8810/v1");
  assert.equal(normalizeApiBaseUrl("http://192.168.1.8:8810/v1/"), "http://192.168.1.8:8810/v1");
});

test("sends Ripple auth headers and user id on API requests", async () => {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const client = createRippleClient({
    serverUrl: "http://ripple.local:8810",
    apiKey: "secret-key",
    userId: "lake",
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
      });
      return jsonResponse({ data: [{ id: "sonnet", owned_by: "ripple" }] });
    },
  });

  const models = await client.listModels();

  assert.deepEqual(models, [{ id: "sonnet", owned_by: "ripple" }]);
  assert.equal(requests[0].url, "http://ripple.local:8810/v1/models");
  assert.equal(requests[0].headers.Authorization, "Bearer secret-key");
  assert.equal(requests[0].headers["X-Ripple-User-Id"], "lake");
});

test("parses OpenAI-style SSE data frames and ignores DONE", () => {
  const events = parseSseEvents(
    [
      'data: {"choices":[{"delta":{"content":"Hi"}}]}',
      "",
      'data: {"type":"tool_call","id":"tool_1","name":"Bash","input":{"command":"ls"}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
  );

  assert.deepEqual(events, [
    { choices: [{ delta: { content: "Hi" } }] },
    { type: "tool_call", id: "tool_1", name: "Bash", input: { command: "ls" } },
  ]);
});
