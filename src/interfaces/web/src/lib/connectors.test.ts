import assert from "node:assert/strict";

import {
  actionUrl,
  connectorAuthMode,
  connectorGroupSections,
  connectorKindLabel,
  connectorStatusTone,
  extractFeishuDeviceCode,
  feishuAuthFollowup,
  navigateExternalAuthWindow,
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
    kind: "user_connector",
    auth_flow: "token",
    auth_surfaces: { web: true, chat: true },
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

function testConnectorGroupsSeparateRuntimeCapabilitiesFromUserConnectors() {
  const sections = connectorGroupSections([
    connector({ name: "notion", display_name: "Notion", kind: "user_connector" }),
    connector({
      name: "codex_image_generation",
      display_name: "Image Generation",
      auth_type: "runtime",
      kind: "runtime_capability",
      auth_flow: "none",
      auth_surfaces: { web: false, chat: false },
      auth_start_path: null,
      disconnect_path: null,
    }),
  ]);

  assert.equal(sections[0].kind, "runtime_capability");
  assert.equal(sections[0].title, "Runtime Capabilities");
  assert.equal(sections[0].connectors[0].name, "codex_image_generation");
  assert.equal(sections[1].kind, "user_connector");
  assert.equal(sections[1].title, "User Connectors");
  assert.equal(sections[1].connectors[0].name, "notion");
  assert.equal(connectorKindLabel("runtime_capability"), "Runtime Capability");
  assert.equal(connectorKindLabel("user_connector"), "User Connector");
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

function testFeishuFollowupAdvancesSetupAndUserAuthAutomatically() {
  assert.equal(
    feishuAuthFollowup(
      action({
        name: "feishu",
        stage: "awaiting_setup",
        data: { setup_url: "https://setup.example" },
      })
    ),
    "poll_setup"
  );
  assert.equal(
    feishuAuthFollowup(
      action({
        name: "feishu",
        stage: "awaiting_user_auth",
        data: {
          oauth_url: "https://accounts.feishu.cn/device",
          device_code: "device-123",
        },
      })
    ),
    "poll_user_auth"
  );
  assert.equal(feishuAuthFollowup(action({ name: "notion", stage: "awaiting_user_auth" })), "none");
  assert.equal(
    feishuAuthFollowup(action({ name: "feishu", ok: false, stage: "auth_failed" })),
    "none"
  );
}

function testNavigateExternalAuthWindowReusesOpenWindow() {
  let fallbackUrl = "";
  let focused = false;
  const authWindow = {
    closed: false,
    location: { href: "about:blank" },
    focus: () => {
      focused = true;
    },
  };

  const result = navigateExternalAuthWindow(
    authWindow,
    "https://accounts.feishu.cn/device",
    (url) => {
      fallbackUrl = url;
      return null;
    }
  );

  assert.equal(result, authWindow);
  assert.equal(authWindow.location.href, "https://accounts.feishu.cn/device");
  assert.equal(focused, true);
  assert.equal(fallbackUrl, "");
}

function testNavigateExternalAuthWindowFallsBackWhenWindowClosed() {
  const fallbackWindow = { closed: false, location: { href: "about:blank" } };
  const result = navigateExternalAuthWindow(
    { closed: true, location: { href: "about:blank" } },
    "https://accounts.feishu.cn/device",
    (url) => {
      fallbackWindow.location.href = url;
      return fallbackWindow;
    }
  );

  assert.equal(result, fallbackWindow);
  assert.equal(fallbackWindow.location.href, "https://accounts.feishu.cn/device");
}

testConnectorAuthModeFollowsBackendAuthType();
testConnectorGroupsSeparateRuntimeCapabilitiesFromUserConnectors();
testConnectorStatusToneUsesConnectionState();
testGoogleOauthActionCanRequireCallbackInput();
testDeviceFlowActionCanRequireComplete();
testActionUrlPrefersOauthThenSetup();
testExtractFeishuDeviceCodeFromChatText();
testFeishuFollowupAdvancesSetupAndUserAuthAutomatically();
testNavigateExternalAuthWindowReusesOpenWindow();
testNavigateExternalAuthWindowFallsBackWhenWindowClosed();

console.log("connectors tests passed");
