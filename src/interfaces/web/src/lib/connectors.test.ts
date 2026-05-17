import assert from "node:assert/strict";

import {
  actionUrl,
  connectorAuthMode,
  connectorStatusTone,
  extractFeishuDeviceCode,
  needsCallbackInput,
  needsDeviceFlowComplete,
} from "./connectors";
import type { ConnectorActionResponse, ConnectorInfo, ConnectorStatus } from "@/types";

function connector(overrides: Partial<ConnectorInfo>): ConnectorInfo {
  return {
    name: "notion",
    display_name: "Notion",
    description: "Notion API access",
    auth_type: "token",
    auth_start_path: "/v1/connectors/notion/auth/start",
    auth_complete_path: null,
    disconnect_path: "/v1/connectors/notion/disconnect",
    accounts_path: null,
    ...overrides,
  };
}

function status(overrides: Partial<ConnectorStatus>): ConnectorStatus {
  return {
    name: "notion",
    connected: false,
    required: true,
    detail: "",
    metadata: {},
    ...overrides,
  };
}

function action(overrides: Partial<ConnectorActionResponse>): ConnectorActionResponse {
  return {
    name: "google_workspace",
    ok: true,
    stage: "awaiting_user_callback_url",
    detail: "",
    data: {},
    ...overrides,
  };
}

function testConnectorAuthModeFollowsBackendAuthType() {
  assert.equal(connectorAuthMode(connector({ auth_type: "token" })), "token");
  assert.equal(connectorAuthMode(connector({ auth_type: "oauth" })), "oauth");
  assert.equal(connectorAuthMode(connector({ auth_type: "qr" })), "qr");
  assert.equal(connectorAuthMode(connector({ auth_type: "cli" })), "status_only");
}

function testConnectorStatusToneUsesConnectionState() {
  assert.equal(connectorStatusTone(status({ connected: true, required: false })), "connected");
  assert.equal(connectorStatusTone(status({ connected: false, required: true })), "needs_setup");
  assert.equal(connectorStatusTone(null), "unknown");
}

function testGoogleOauthActionCanRequireCallbackInput() {
  assert.equal(needsCallbackInput(action({ stage: "awaiting_user_callback_url" })), true);
  assert.equal(needsCallbackInput(action({ stage: "awaiting_browser_callback" })), false);
  assert.equal(needsCallbackInput(action({ stage: "authorized" })), false);
}

function testDeviceFlowActionCanRequireComplete() {
  assert.equal(
    needsDeviceFlowComplete(
      action({
        name: "feishu",
        stage: "awaiting_user_auth",
        data: { device_code: "device-123" },
      })
    ),
    true
  );
  assert.equal(needsDeviceFlowComplete(action({ stage: "awaiting_user_auth", data: {} })), false);
  assert.equal(
    needsDeviceFlowComplete(action({ stage: "authorized", data: { device_code: "x" } })),
    false
  );
}

function testActionUrlPrefersOauthThenSetup() {
  assert.equal(
    actionUrl(action({ data: { oauth_url: "https://auth.example" } })),
    "https://auth.example"
  );
  assert.equal(
    actionUrl(action({ data: { setup_url: "https://setup.example" } })),
    "https://setup.example"
  );
  assert.equal(
    actionUrl(
      action({ data: { oauth_url: "https://auth.example", setup_url: "https://setup.example" } })
    ),
    "https://auth.example"
  );
}

function testExtractFeishuDeviceCodeFromChatText() {
  assert.equal(
    extractFeishuDeviceCode("[FEISHU_AUTH]\ndevice_code: abc-123\nhttps://accounts.feishu.cn/x"),
    "abc-123"
  );
  assert.equal(
    extractFeishuDeviceCode("[FEISHU_AUTH]\n设备码：XYZ_789\nhttps://accounts.feishu.cn/x"),
    "XYZ_789"
  );
  assert.equal(extractFeishuDeviceCode("[FEISHU_AUTH]\nhttps://accounts.feishu.cn/x"), "");
}

testConnectorAuthModeFollowsBackendAuthType();
testConnectorStatusToneUsesConnectionState();
testGoogleOauthActionCanRequireCallbackInput();
testDeviceFlowActionCanRequireComplete();
testActionUrlPrefersOauthThenSetup();
testExtractFeishuDeviceCodeFromChatText();

console.log("connectors tests passed");
