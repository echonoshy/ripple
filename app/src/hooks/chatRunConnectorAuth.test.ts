import assert from "node:assert/strict";

import {
  CONNECTOR_AUTH_POLL_TIMEOUT_MS,
  connectorAuthPollPayloadFromEvent,
  connectorAuthRequiresSessionAttention,
  shouldContinueConnectorAuthPoll,
  shouldStartConnectorAuthPoll,
} from "./chatRunConnectorAuth";
import type { ConnectorAuthChatEvent } from "@/types";

function connectorAuthEvent(
  overrides: Partial<ConnectorAuthChatEvent> & { data?: Record<string, unknown> }
): ConnectorAuthChatEvent {
  const { data, ...eventOverrides } = overrides;
  return {
    type: "connector_auth_required",
    connector: "google_workspace",
    display_name: "Google Workspace",
    auth_flow: "browser",
    stage: "awaiting_browser_callback",
    message: "Open the URL.",
    action: {
      name: "google_workspace",
      ok: true,
      stage: "awaiting_browser_callback",
      detail: "",
      source: "skills_page",
      data: data || {},
    },
    ...eventOverrides,
  };
}

function testSkillConnectorAuthProducesPollPayloadAndAttention() {
  const event = connectorAuthEvent({
    data: { oauth_url: "https://accounts.google.com/o/oauth2/auth?state=abc" },
  });
  const payload = connectorAuthPollPayloadFromEvent(event);

  assert.deepEqual(payload, {
    connector: "google_workspace",
    tag: "auth",
    url: "https://accounts.google.com/o/oauth2/auth?state=abc",
    popup: null,
    mode: "skill",
  });
  assert.equal(payload && shouldStartConnectorAuthPoll(payload), true);
  assert.equal(connectorAuthRequiresSessionAttention(event), true);
}

function testConnectorAuthPollStopsAtTimeoutAndTerminalStage() {
  const event = connectorAuthEvent({
    connector: "feishu",
    data: { setup_url: "https://open.feishu.cn/setup" },
  });

  assert.equal(
    shouldContinueConnectorAuthPoll(event, "feishu", CONNECTOR_AUTH_POLL_TIMEOUT_MS - 1),
    true
  );
  assert.equal(
    shouldContinueConnectorAuthPoll(event, "feishu", CONNECTOR_AUTH_POLL_TIMEOUT_MS),
    false
  );
  assert.equal(
    shouldContinueConnectorAuthPoll({ ...event, stage: "auth_failed" }, "feishu", 0),
    false
  );
}

testSkillConnectorAuthProducesPollPayloadAndAttention();
testConnectorAuthPollStopsAtTimeoutAndTerminalStage();

console.log("chat run connector auth tests passed");
