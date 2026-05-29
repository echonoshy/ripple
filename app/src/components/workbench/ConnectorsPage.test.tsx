import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import ConnectorsPage from "./ConnectorsPage";

const noop = () => {};

function renderConnectorsPage() {
  return renderToStaticMarkup(<ConnectorsPage userId="default" onBack={noop} />);
}

function testConnectorsPageHasMobileSpecificCopy() {
  const html = renderConnectorsPage();

  assert.match(html, /sm:hidden[^>]*>Connectors</);
  assert.match(html, /hidden sm:inline[^>]*>Connectors</);
  assert.match(html, /sm:hidden[^>]*>0\/0 ready</);
  assert.match(html, /hidden sm:inline[^>]*>0\/0 connected</);
  assert.match(html, /sm:hidden[^>]*>Refresh</);
  assert.match(html, /hidden sm:inline[^>]*>Refresh</);
  assert.match(html, /sm:hidden[^>]*>No connectors</);
  assert.match(html, /hidden sm:inline[^>]*>No connectors</);
  assert.match(html, /aria-label="Back to settings"/);
  assert.match(html, /lg:hidden/);
}

testConnectorsPageHasMobileSpecificCopy();

function testConnectorsPageCachesAndThrottlesBackgroundRefresh() {
  const source = readFileSync(new URL("./ConnectorsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /CONNECTOR_CACHE_TTL_MS/);
  assert.match(source, /connectorSnapshotInflight/);
  assert.match(source, /CONNECTOR_FOCUS_REFRESH_THROTTLE_MS/);
  assert.match(source, /loadConnectors\(\{ background: true, force: true \}\)/);
}

testConnectorsPageCachesAndThrottlesBackgroundRefresh();

function testConnectorsPageHasManagementActions() {
  const source = readFileSync(new URL("./ConnectorsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /cancelConnectorAuth/);
  assert.doesNotMatch(source, /revokeConnector/);
  assert.match(source, /handleDisconnect\(connector,\s*\{\s*email:\s*account\.email/);
  assert.match(source, /notionToken/);
  assert.doesNotMatch(source, /remote revoke/i);
}

testConnectorsPageHasManagementActions();

function testConnectorsPageAdvancesFeishuSetupBeforeCompletingAuth() {
  const source = readFileSync(new URL("./ConnectorsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /connector\.name === "feishu" && !deviceCode/);
  assert.match(source, /startConnectorAuth\(connector\.name\)/);
  assert.match(source, /pendingExternalUrl/);
}

testConnectorsPageAdvancesFeishuSetupBeforeCompletingAuth();

function testConnectorsPageKeepsBilibiliAuthQrOnly() {
  const source = readFileSync(new URL("./ConnectorsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /maybeUrl && connector\.name !== "bilibili"/);
  assert.match(source, /connector\.name === "bilibili"\s*\?\s*null\s*:/);
}

testConnectorsPageKeepsBilibiliAuthQrOnly();

console.log("connectors page tests passed");
