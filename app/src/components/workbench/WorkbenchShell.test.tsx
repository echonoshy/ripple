import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import WorkbenchShell from "./WorkbenchShell";

function renderShell() {
  return renderToStaticMarkup(
    <WorkbenchShell
      topBar={<div>Product top bar</div>}
      content={<div>Content</div>}
      inspector={null}
    />
  );
}

function renderShellWithMobileNav() {
  return renderToStaticMarkup(
    <WorkbenchShell
      topBar={<div>Product top bar</div>}
      content={<div>Content</div>}
      inspector={null}
      mobileNav={<div>Mobile nav</div>}
    />
  );
}

function renderShellWithInspector() {
  return renderToStaticMarkup(
    <WorkbenchShell
      topBar={<div>Product top bar</div>}
      content={<div>Content</div>}
      inspector={<div>Inspector</div>}
    />
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

console.log("workbench shell tests passed");
