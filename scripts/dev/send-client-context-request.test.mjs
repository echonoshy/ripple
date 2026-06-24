import assert from "node:assert/strict";

import {
  buildClientContextPayload,
  buildTechnicalSummary,
  normalizeApiUrl,
  parseArgs,
  redactSecret,
  summarizeSseLine,
} from "./send-client-context-request.mjs";

function testNormalizeApiUrl() {
  assert.equal(normalizeApiUrl("http://127.0.0.1:8810"), "http://127.0.0.1:8810/v1");
  assert.equal(normalizeApiUrl("http://127.0.0.1:8810/v1/"), "http://127.0.0.1:8810/v1");
}

function testBuildPayloadIncludesClientContext() {
  const payload = buildClientContextPayload({
    model: "codex-test",
    prompt: "解释当前页面和耳机状态",
    sessionId: "session-client-context-demo",
    stream: true,
  });

  assert.equal(payload.model, "codex-test");
  assert.equal(payload.stream, true);
  assert.equal(payload.metadata.ripple_session_id, "session-client-context-demo");
  assert.deepEqual(payload.metadata.required_skill_ids, ["ripple:ripple-ui-explainer"]);
  assert.equal(payload.metadata.client_context.schema_version, "ripple.client_context.v1");
  assert.equal(payload.metadata.client_context.software.host_app.app_id, "viaim.meeting");
  assert.equal(payload.metadata.client_context.software.screen.screen_id, "meeting.detail");
  assert.equal(payload.metadata.client_context.devices[0].kind, "ai_headset");
  assert.equal(payload.metadata.client_context.devices[0].state.noise_control, "anc");
}

function testParseArgsKeepsBackendOnlyDefaults() {
  const options = parseArgs([
    "--url",
    "http://localhost:8810",
    "--api-key",
    "key_test",
    "--user-id",
    "demo_user",
    "--model",
    "codex-low",
    "--prompt",
    "hello",
    "--no-stream",
  ]);

  assert.equal(options.apiUrl, "http://localhost:8810/v1");
  assert.equal(options.apiKey, "key_test");
  assert.equal(options.userId, "demo_user");
  assert.equal(options.model, "codex-low");
  assert.equal(options.prompt, "hello");
  assert.equal(options.stream, false);
  assert.equal(options.showRequest, true);
  assert.equal(options.showEvents, true);
}

function testParseArgsCanHideTechnicalNoise() {
  const options = parseArgs(["--hide-request", "--hide-events"]);

  assert.equal(options.showRequest, false);
  assert.equal(options.showEvents, false);
}

function testTechnicalSummaryRedactsApiKeyButShowsPayload() {
  const options = parseArgs([
    "--api-key",
    "rk-ripple-2026",
    "--user-id",
    "demo_user",
    "--session-id",
    "session-client-context-demo",
  ]);
  const payload = buildClientContextPayload(options);
  const summary = buildTechnicalSummary(options, payload);

  assert.equal(redactSecret("rk-ripple-2026"), "rk-r...2026");
  assert.match(summary, /POST http:\/\/127\.0\.0\.1:8810\/v1\/responses/);
  assert.match(summary, /Authorization: Bearer rk-r\.\.\.2026/);
  assert.match(summary, /"schema_version": "ripple.client_context.v1"/);
  assert.match(summary, /"kind": "ai_headset"/);
  assert.doesNotMatch(summary, /Bearer rk-ripple-2026/);
}

function testSseSummaryShowsErrorDetails() {
  const summary = summarizeSseLine(
    'data: {"type":"ripple.codex_error","message":"model failed","detail":{"code":"bad_model"}}'
  );

  assert.equal(summary.type, "ripple.codex_error");
  assert.match(summary.log, /model failed/);
  assert.match(summary.log, /bad_model/);
}

testNormalizeApiUrl();
testBuildPayloadIncludesClientContext();
testParseArgsKeepsBackendOnlyDefaults();
testParseArgsCanHideTechnicalNoise();
testTechnicalSummaryRedactsApiKeyButShowsPayload();
testSseSummaryShowsErrorDetails();

console.log("send client context request tests passed");
