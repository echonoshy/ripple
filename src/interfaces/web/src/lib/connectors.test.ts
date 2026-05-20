import assert from "node:assert/strict";

import { connectorGroupSections, connectorKindLabel, connectorStatusTone } from "./connectors";
import type { ConnectorInfo, ConnectorStatus } from "@/types";

function connector(overrides: Partial<ConnectorInfo>): ConnectorInfo {
  return {
    name: "notion",
    display_name: "Notion",
    description: "Notion API access",
    auth_type: "token",
    kind: "user_connector",
    auth_flow: "token",
    auth_surfaces: { web: false, chat: true },
    auth_start_path: null,
    auth_complete_path: null,
    disconnect_path: null,
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

testConnectorGroupsSeparateRuntimeCapabilitiesFromUserConnectors();
testConnectorStatusToneUsesConnectionState();

console.log("connectors tests passed");
