import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import WorkbenchShell from "./WorkbenchShell";

function noop() {}

function renderShell() {
  return renderToStaticMarkup(
    <WorkbenchShell
      nav={<div>Navigation</div>}
      content={<div>Content</div>}
      inspector={null}
      isNavOpen={false}
      onCloseNav={noop}
    />
  );
}

function renderShellWithInspector() {
  return renderToStaticMarkup(
    <WorkbenchShell
      nav={<div>Navigation</div>}
      content={<div>Content</div>}
      inspector={<div>Inspector</div>}
      isNavOpen={false}
      onCloseNav={noop}
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

function testDesktopNavigationDefaultsWiderAndResizable() {
  const html = renderShell();

  assert.doesNotMatch(html, />Top bar</);
  assert.match(html, /style="width:300px"/);
  assert.match(html, /role="separator"/);
  assert.match(html, /aria-label="Resize navigation"/);
  assert.match(html, /aria-valuemin="220"/);
  assert.match(html, /aria-valuemax="420"/);
  assert.match(html, /aria-valuenow="300"/);
  assert.match(html, /cursor-col-resize/);
}

testDesktopNavigationDefaultsWiderAndResizable();

function testShellUsesDynamicViewportForIosWebview() {
  const html = renderShell();

  assert.match(html, /h-dvh/);
  assert.match(html, /min-h-dvh/);
}

testShellUsesDynamicViewportForIosWebview();

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
