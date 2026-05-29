import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CONNECTOR_AUTH_POLL_TIMEOUT_MS,
  connectorAuthPollPayloadFromEvent,
  shouldContinueConnectorAuthPoll,
} from "./useChatRun";
import type { ConnectorAuthChatEvent } from "@/types";

function authEvent(
  overrides: Partial<ConnectorAuthChatEvent> & { data?: Record<string, unknown> }
): ConnectorAuthChatEvent {
  return {
    type: "connector_auth_required",
    connector: "feishu",
    display_name: "Feishu",
    auth_flow: "browser",
    stage: "awaiting_setup",
    message: "Open the URL.",
    action: {
      name: overrides.connector || "feishu",
      ok: true,
      stage: overrides.stage || "awaiting_setup",
      detail: "",
      data: overrides.data || {},
    },
    ...overrides,
  };
}

function testFeishuSetupAuthStartsAutomaticPoll() {
  const payload = connectorAuthPollPayloadFromEvent(
    authEvent({ data: { setup_url: "https://open.feishu.cn/page/cli?user_code=abc" } })
  );

  assert.deepEqual(payload, {
    connector: "feishu",
    tag: "setup",
    url: "https://open.feishu.cn/page/cli?user_code=abc",
    popup: null,
  });
}

function testFeishuUserAuthStartsAutomaticPoll() {
  const payload = connectorAuthPollPayloadFromEvent(
    authEvent({
      stage: "awaiting_user_auth",
      data: { oauth_url: "https://accounts.feishu.cn/device" },
    })
  );

  assert.deepEqual(payload, {
    connector: "feishu",
    tag: "auth",
    url: "https://accounts.feishu.cn/device",
    popup: null,
  });
}

function testGoogleAuthStillStartsAutomaticPoll() {
  const payload = connectorAuthPollPayloadFromEvent(
    authEvent({
      connector: "google_workspace",
      display_name: "Google Workspace",
      stage: "awaiting_browser_callback",
      data: { oauth_url: "https://accounts.google.com/o/oauth2/auth?state=abc" },
    })
  );

  assert.deepEqual(payload, {
    connector: "google_workspace",
    tag: "auth",
    url: "https://accounts.google.com/o/oauth2/auth?state=abc",
    popup: null,
  });
}

function testBilibiliAuthDoesNotStartAutomaticPollOrOpen() {
  const payload = connectorAuthPollPayloadFromEvent(
    authEvent({
      connector: "bilibili",
      display_name: "Bilibili",
      stage: "awaiting_user",
      data: {
        qrcode_image_url: "/v1/bilibili/qrcode.png?content=encoded",
        app_url:
          "bilibili://browser?url=https%3A%2F%2Faccount.bilibili.com%2Fh5%2Faccount-h5%2Fauth%2Fscan-web%3Fqrcode_key%3Dabc",
        qrcode_content: "https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=abc",
      },
    })
  );

  assert.equal(payload, null);
}

function testAuthorizedConnectorEventDoesNotStartPoll() {
  const payload = connectorAuthPollPayloadFromEvent(
    authEvent({
      type: "connector_auth_updated",
      stage: "authorized",
      data: { oauth_url: "https://accounts.feishu.cn/device" },
    })
  );

  assert.equal(payload, null);
}

function testConnectorAuthPollContinuesOnlyBeforeTimeout() {
  assert.equal(
    shouldContinueConnectorAuthPoll(
      authEvent({ stage: "awaiting_setup" }),
      "feishu",
      CONNECTOR_AUTH_POLL_TIMEOUT_MS - 1
    ),
    true
  );
  assert.equal(
    shouldContinueConnectorAuthPoll(
      authEvent({ stage: "awaiting_setup" }),
      "feishu",
      CONNECTOR_AUTH_POLL_TIMEOUT_MS
    ),
    false
  );
}

function testConnectorAuthPollStopsOnTerminalStages() {
  assert.equal(
    shouldContinueConnectorAuthPoll(authEvent({ stage: "auth_failed" }), "feishu", 0),
    false
  );
  assert.equal(
    shouldContinueConnectorAuthPoll(authEvent({ stage: "invalid_request" }), "feishu", 0),
    false
  );
  assert.equal(
    shouldContinueConnectorAuthPoll(
      authEvent({ connector: "google_workspace", stage: "awaiting_browser_callback" }),
      "feishu",
      0
    ),
    false
  );
  assert.equal(shouldContinueConnectorAuthPoll(null, "feishu", 0), false);
}

function testAttachmentUploadsKeepSuccessfulFilesWhenOneUploadFails() {
  const source = readFileSync(new URL("./useChatRun.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /Promise\.all\(files\.map\(\(file\) => uploadWorkspaceAttachment/);
  assert.match(source, /for \(const file of files\)/);
  assert.match(source, /setAttachmentUploadError/);
}

testFeishuSetupAuthStartsAutomaticPoll();
testFeishuUserAuthStartsAutomaticPoll();
testGoogleAuthStillStartsAutomaticPoll();
testBilibiliAuthDoesNotStartAutomaticPollOrOpen();
testAuthorizedConnectorEventDoesNotStartPoll();
testConnectorAuthPollContinuesOnlyBeforeTimeout();
testConnectorAuthPollStopsOnTerminalStages();
testAttachmentUploadsKeepSuccessfulFilesWhenOneUploadFails();

console.log("useChatRun tests passed");
