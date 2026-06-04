import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/i18n";
import WorkbenchShell from "./WorkbenchShell";

function renderShell() {
  return renderToStaticMarkup(
    <I18nProvider initialPreference="en-US">
      <WorkbenchShell
        topBar={<div>Product top bar</div>}
        content={<div>Content</div>}
        inspector={null}
      />
    </I18nProvider>
  );
}

function renderShellWithMobileNav() {
  return renderToStaticMarkup(
    <I18nProvider initialPreference="en-US">
      <WorkbenchShell
        topBar={<div>Product top bar</div>}
        content={<div>Content</div>}
        inspector={null}
        mobileNav={<div>Mobile nav</div>}
      />
    </I18nProvider>
  );
}

function renderShellWithInspector() {
  return renderToStaticMarkup(
    <I18nProvider initialPreference="en-US">
      <WorkbenchShell
        topBar={<div>Product top bar</div>}
        content={<div>Content</div>}
        inspector={<div>Inspector</div>}
      />
    </I18nProvider>
  );
}

function renderShellWithCollapsedInspector() {
  return renderToStaticMarkup(
    <I18nProvider initialPreference="en-US">
      <WorkbenchShell
        topBar={<div>Product top bar</div>}
        content={<div>Content</div>}
        inspector={<div>Inspector</div>}
        isInspectorCollapsed
        onExpandInspector={() => {}}
      />
    </I18nProvider>
  );
}

function renderShellWithStoredInspectorWidth(storedValue: string) {
  const globalWithWindow = globalThis as typeof globalThis & { window?: unknown };
  const previousWindow = globalWithWindow.window;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => (key.includes("inspectorWidth") ? storedValue : null),
        setItem: () => {},
      },
    },
  });

  try {
    return renderShellWithInspector();
  } finally {
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalWithWindow, "window");
    } else {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: previousWindow,
      });
    }
  }
}

function testDesktopShellUsesFixedProductTopBar() {
  const html = renderShell();

  assert.match(html, />Product top bar</);
  assert.match(html, /data-ripple-shell-top-bar="true"/);
  assert.match(html, /lg:flex/);
  assert.doesNotMatch(html, /aria-label="Resize navigation"/);
  assert.doesNotMatch(html, /style="width:300px"/);
}

testDesktopShellUsesFixedProductTopBar();

function testShellUsesDynamicViewportForIosWebview() {
  const html = renderShell();

  assert.match(html, /h-dvh/);
  assert.match(html, /min-h-dvh/);
}

testShellUsesDynamicViewportForIosWebview();

function testShellCanRenderTopLevelMobileNavigation() {
  const html = renderShellWithMobileNav();

  assert.match(html, />Mobile nav</);
}

testShellCanRenderTopLevelMobileNavigation();

function testInspectorDefaultsWiderAndResizable() {
  const html = renderShellWithInspector();

  assert.match(html, /style="width:460px"/);
  assert.match(html, /aria-label="Resize workspace panel"/);
  assert.match(html, /aria-valuemin="300"/);
  assert.doesNotMatch(html, /aria-label="Resize workspace panel"[^>]*aria-valuemax/);
  assert.match(html, /aria-valuenow="460"/);
}

testInspectorDefaultsWiderAndResizable();

function testInspectorMigratesPreviousDefaultWidth() {
  const html = renderShellWithStoredInspectorWidth("380");

  assert.match(html, /style="width:460px"/);
}

testInspectorMigratesPreviousDefaultWidth();

function testCollapsedInspectorUsesEdgeHandle() {
  const html = renderShellWithCollapsedInspector();

  assert.match(html, /data-ripple-panel-edge-handle="workspace-panel"/);
  assert.match(html, /top-1\/2/);
  assert.match(html, /bg-white\/82/);
  assert.match(html, /text-\[#007aff\]/);
  assert.doesNotMatch(html, /top-6/);
  assert.doesNotMatch(html, /bg-\[#007aff\][\s\S]*text-white/);
  assert.doesNotMatch(html, /top-\[14px\] right-4 z-30/);
}

testCollapsedInspectorUsesEdgeHandle();

console.log("workbench shell tests passed");
