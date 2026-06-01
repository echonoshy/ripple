import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, type LocalePreference } from "@/i18n";
import ConnectorsPage from "./ConnectorsPage";

const noop = () => {};

function renderConnectorsPage(locale: LocalePreference = "en-US") {
  return renderToStaticMarkup(
    <I18nProvider initialPreference={locale}>
      <ConnectorsPage userId="default" onBack={noop} />
    </I18nProvider>
  );
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

function testConnectorsPageDoesNotExposeCredentialStorageDetails() {
  const source = readFileSync(new URL("./ConnectorsPage.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /Per-user credentials stored inside the current sandbox boundary/);
  assert.doesNotMatch(source, /sandbox boundary/i);
  assert.match(source, /t\("connectors\.sectionDescription"\)/);
}

testConnectorsPageDoesNotExposeCredentialStorageDetails();

function testConnectorsPageCachesAndThrottlesBackgroundRefresh() {
  const source = readFileSync(new URL("./ConnectorsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /CONNECTOR_CACHE_TTL_MS/);
  assert.match(source, /connectorSnapshotInflight/);
  assert.match(source, /CONNECTOR_FOCUS_REFRESH_THROTTLE_MS/);
  assert.match(source, /loadConnectors\(\{ background: true, force: true \}\)/);
}

testConnectorsPageCachesAndThrottlesBackgroundRefresh();

function testConnectorsPageDismissesActionMessageAutomatically() {
  const source = readFileSync(new URL("./ConnectorsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /ACTION_MESSAGE_DISMISS_MS/);
  assert.match(source, /if \(!actionMessage\) return/);
  assert.match(source, /window\.setTimeout\(\(\) => \{/);
  assert.match(source, /setActionMessage\(null\)/);
  assert.match(source, /window\.clearTimeout\(timer\)/);
}

testConnectorsPageDismissesActionMessageAutomatically();

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

function testConnectorsPageUsesSystemSoftTilesNotProviderLogos() {
  const source = readFileSync(new URL("./ConnectorsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /IconTile/);
  assert.match(source, /connectorStatusIconTone/);
  assert.doesNotMatch(source, /google-logo|notion-logo|feishu-logo|bilibili-logo/i);
}

testConnectorsPageUsesSystemSoftTilesNotProviderLogos();

function testConnectorsPageUsesCompactMobileDensity() {
  const source = readFileSync(new URL("./ConnectorsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /COMPACT_IOS_PAGE_BACKGROUND/);
  assert.match(source, /MOBILE_GLASS_ICON_BUTTON_CLASS/);
  assert.match(source, /LUCIDE_NAV_STROKE_WIDTH/);
  assert.match(source, /pt-\[max\(env\(safe-area-inset-top\),12px\)\]/);
  assert.match(source, /pb-\[calc\(88px\+env\(safe-area-inset-bottom\)\)\]/);
  assert.doesNotMatch(source, /circle_at_16%_0%/);
  assert.match(source, /className="mx-auto max-w-5xl space-y-3"/);
  assert.match(source, /rounded-xl border border-\[#dfe6f4\]/);
  assert.match(source, /<IconTile tone=\{connectorStatusIconTone\(status\)\} size="md">/);
  assert.match(source, /inline-flex h-7 items-center gap-1\.5 rounded-full/);
}

testConnectorsPageUsesCompactMobileDensity();

function testConnectorsPageRendersChineseChrome() {
  const html = renderConnectorsPage("zh-CN");

  assert.match(html, /aria-label="返回设置"/);
  assert.match(html, /sm:hidden[^>]*>连接器</);
  assert.match(html, /0\/0 就绪/);
  assert.match(html, />刷新</);
  assert.match(html, />暂无连接器</);
}

testConnectorsPageRendersChineseChrome();

console.log("connectors page tests passed");
