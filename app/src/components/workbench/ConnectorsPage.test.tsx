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

  assert.match(html, /sm:hidden[^>]*>Links</);
  assert.match(html, /hidden sm:inline[^>]*>Links</);
  assert.match(html, /sm:hidden[^>]*>0\/0 ready</);
  assert.match(html, /hidden sm:inline[^>]*>0\/0 connected</);
  assert.doesNotMatch(html, /sm:hidden[^>]*>Refresh</);
  assert.match(html, /hidden lg:inline[^>]*>Refresh</);
  assert.match(html, /sm:hidden[^>]*>No links</);
  assert.match(html, /hidden sm:inline[^>]*>No links</);
  assert.match(html, /aria-label="Back to settings"/);
  assert.match(html, /aria-label="Refresh"/);
  assert.match(html, /lg:hidden/);
}

testConnectorsPageHasMobileSpecificCopy();

function testConnectorsPageUsesCatalogWithoutSkillManagement() {
  const source = readFileSync(new URL("./ConnectorsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /fetchCapabilities/);
  assert.doesNotMatch(source, /updateSkillCapability/);
  assert.doesNotMatch(source, /capabilitySections/);
  assert.doesNotMatch(source, /Ripple Skills/);
  assert.doesNotMatch(source, /User Skills/);
  assert.doesNotMatch(source, /Runtime Capabilities/);
  assert.doesNotMatch(source, /data-ripple-capability-card="true"/);
  assert.doesNotMatch(source, /handleToggleSkill/);
}

testConnectorsPageUsesCatalogWithoutSkillManagement();

function testConnectorsPageDoesNotExposeCredentialStorageDetails() {
  const source = readFileSync(new URL("./ConnectorsPage.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /Per-user credentials stored inside the current sandbox boundary/);
  assert.doesNotMatch(source, /sandbox boundary/i);
  assert.match(source, /t\("connectors\.sectionDescription"\)/);
}

testConnectorsPageDoesNotExposeCredentialStorageDetails();

function testConnectorsPageDoesNotDuplicateConnectorDescriptionsAsStatusDetails() {
  const source = readFileSync(new URL("./ConnectorsPage.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /detail:\s*capability\.description/);
}

testConnectorsPageDoesNotDuplicateConnectorDescriptionsAsStatusDetails();

function testConnectorsPageLocalizesConnectorDescriptions() {
  const source = readFileSync(new URL("./ConnectorsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /localizedConnectorDescription\(connector,\s*t\)/);
  assert.doesNotMatch(
    source,
    /<p className=\{`mt-1 text-\[#667085\][\s\S]{0,160}\{connector\.description\}/
  );
}

testConnectorsPageLocalizesConnectorDescriptions();

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

  assert.match(source, /onOpenSessionAction/);
  assert.match(source, /type: "connector\.auth\.start"/);
  assert.doesNotMatch(source, /startConnectorAuth/);
  assert.doesNotMatch(source, /completeConnectorAuth/);
  assert.doesNotMatch(source, /cancelConnectorAuth/);
  assert.doesNotMatch(source, /revokeConnector/);
  assert.match(source, /handleDisconnect\(connector,\s*\{\s*email:\s*account\.email/);
  assert.doesNotMatch(source, /remote revoke/i);
}

testConnectorsPageHasManagementActions();

function testConnectorsPageDelegatesAuthToSession() {
  const source = readFileSync(new URL("./ConnectorsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /handleStartAuth\(connector\)/);
  assert.match(source, /onOpenSessionAction\?\.\s*\(/);
  assert.match(source, /source: "connectors_page"/);
  assert.doesNotMatch(source, /pendingExternalUrl/);
  assert.doesNotMatch(source, /handleCompletePendingAuth/);
}

testConnectorsPageDelegatesAuthToSession();

function testConnectorsPageLeavesQrRenderingToSession() {
  const source = readFileSync(new URL("./ConnectorsPage.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /qrcodeImageUrl/);
  assert.doesNotMatch(source, /qrcodeContent/);
  assert.doesNotMatch(source, /bilibiliQrAlt/);
}

testConnectorsPageLeavesQrRenderingToSession();

function testConnectorsPageDoesNotOwnExternalAuthWindows() {
  const source = readFileSync(new URL("./ConnectorsPage.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /import \{ openExternalUrl \} from "@\/lib\/platform";/);
  assert.doesNotMatch(source, /openExternalUrl\(/);
  assert.doesNotMatch(source, /handleOpenPendingExternalUrl/);
  assert.doesNotMatch(source, /window\.open\(/);
}

testConnectorsPageDoesNotOwnExternalAuthWindows();

function testConnectorsPageUsesOfficialLogoComponentsWithoutExternalAssets() {
  const source = readFileSync(new URL("./ConnectorsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /ConnectorOfficialLogo/);
  assert.match(source, /GoogleWorkspaceLogo/);
  assert.match(source, /NotionLogo/);
  assert.match(source, /FeishuLogo/);
  assert.match(source, /BilibiliLogo/);
  assert.match(source, /FEISHU_FAVICON_DATA_URI/);
  assert.match(source, /data:image\/png;base64/);
  assert.match(source, /src=\{FEISHU_FAVICON_DATA_URI\}/);
  assert.match(source, /data-ripple-connector-official-logo="true"/);
  assert.match(source, /data-ripple-connector-card="true"/);
  assert.match(source, /data-ripple-connector-status-pill="true"/);
  assert.doesNotMatch(source, /src=\{.*logo/i);
  assert.doesNotMatch(source, /bg-\[linear-gradient/);
  assert.doesNotMatch(source, /accentClass/);
  assert.doesNotMatch(
    source,
    /<IconTile tone=\{connectorStatusIconTone\(status\)\} size="md">[\s\S]{0,120}<Plug size=\{15\}/
  );
}

testConnectorsPageUsesOfficialLogoComponentsWithoutExternalAssets();

function testConnectorsPageUsesCompactMobileDensity() {
  const source = readFileSync(new URL("./ConnectorsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /COMPACT_IOS_PAGE_BACKGROUND/);
  assert.match(source, /MOBILE_GLASS_ICON_BUTTON_CLASS/);
  assert.match(source, /className=\{`\$\{MOBILE_GLASS_ICON_BUTTON_CLASS\} shrink-0/);
  assert.match(source, /<span className="hidden lg:inline">\{t\("connectors\.refresh"\)\}<\/span>/);
  assert.doesNotMatch(source, /sm:hidden">\{t\("connectors\.refresh"\)\}/);
  assert.match(source, /MOBILE_PAGE_TOP_SAFE_AREA_CLASS/);
  assert.match(source, /MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS/);
  assert.match(source, /LUCIDE_NAV_STROKE_WIDTH/);
  assert.doesNotMatch(source, /pb-\[calc\(88px\+env\(safe-area-inset-bottom\)\)\]/);
  assert.doesNotMatch(source, /circle_at_16%_0%/);
  assert.match(source, /WORKBENCH_PAGE_CONTENT_CLASS/);
  assert.match(source, /className=\{`\$\{WORKBENCH_PAGE_CONTENT_CLASS\} space-y-2`\}/);
  assert.match(source, /data-ripple-connector-logo-shell="true"/);
  assert.match(source, /<ConnectorOfficialLogo connector=\{connector\} status=\{status\} \/>/);
  assert.match(source, /inline-flex h-9 w-9 shrink-0/);
  assert.match(source, /<div className="space-y-2">/);
  assert.match(source, /<section key=\{section\.kind\} className="space-y-1\.5">/);
  assert.match(source, /<div className="grid gap-2 lg:grid-cols-2">/);
  assert.match(source, /<div className="flex items-start gap-2\.5 p-2\.5">/);
  assert.match(source, /border-t border-\[#e8edf7\] bg-\[#fbfcff\]\/62 px-2\.5 py-1\.5/);
  assert.match(source, /inline-flex h-8 items-center gap-1\.5 rounded-full/);
  assert.doesNotMatch(source, /data-ripple-connector-status-pill[\s\S]{0,180}text-\[10px\]/);
}

testConnectorsPageUsesCompactMobileDensity();

function testConnectorsPageRendersChineseChrome() {
  const html = renderConnectorsPage("zh-CN");

  assert.match(html, /aria-label="返回设置"/);
  assert.match(html, /sm:hidden[^>]*>连接服务</);
  assert.match(html, /0\/0 就绪/);
  assert.doesNotMatch(html, /sm:hidden[^>]*>刷新</);
  assert.match(html, /hidden lg:inline[^>]*>刷新</);
  assert.match(html, /aria-label="刷新"/);
  assert.match(html, />暂无连接器</);
}

testConnectorsPageRendersChineseChrome();

console.log("connectors page tests passed");
