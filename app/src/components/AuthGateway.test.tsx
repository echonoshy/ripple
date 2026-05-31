import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import AuthGateway from "./AuthGateway";

function noop() {}

function renderGateway(overrides: Partial<React.ComponentProps<typeof AuthGateway>> = {}) {
  return renderToStaticMarkup(
    <AuthGateway
      authMode="login"
      authErrorMsg=""
      isAuthSubmitting={false}
      loginInput=""
      passwordInput=""
      inviteCodeInput=""
      inviteDisplayNameInput=""
      keyInput=""
      authUserIdInput=""
      authUserIdError={null}
      onModeChange={noop}
      onAuthErrorClear={noop}
      onAuthUserIdErrorClear={noop}
      onLoginInputChange={noop}
      onPasswordInputChange={noop}
      onInviteCodeInputChange={noop}
      onInviteDisplayNameInputChange={noop}
      onKeyInputChange={noop}
      onAuthUserIdInputChange={noop}
      onPasswordLogin={noop}
      onInviteClaim={noop}
      onServiceAuth={noop}
      {...overrides}
    />
  );
}

function testGatewayShowsPrimaryLoginWithoutProductIntroModule() {
  const html = renderGateway();

  assert.match(html, /data-ripple-auth-gateway="true"/);
  assert.match(html, />Your AI workspace</);
  assert.doesNotMatch(html, />Agent control plane</);
  assert.match(html, />Sign in to Ripple</);
  assert.doesNotMatch(html, />Workspace gateway</);
  assert.doesNotMatch(html, />One entry for sessions, files, connectors, and scheduled work/);
  assert.doesNotMatch(html, />Workspace-scoped files</);
  assert.doesNotMatch(html, />Session history and runs</);
  assert.doesNotMatch(html, />Connector authorization</);
  assert.doesNotMatch(html, />Automations and schedules</);
  assert.doesNotMatch(html, />Workspace isolation</);
  assert.match(html, /aria-label="Email or username"/);
  assert.match(html, /aria-label="Password"/);
  assert.match(html, />Sign in</);
}

function testGatewayDoesNotUseOldEqualWeightModeTabs() {
  const html = renderGateway();
  const source = readFileSync(new URL("./AuthGateway.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(html, /Login<\/button>[\s\S]*Invite<\/button>[\s\S]*API key<\/button>/);
  assert.doesNotMatch(source, /grid-cols-3/);
  assert.match(html, />Have an invite code\?/);
  assert.match(html, />Developer access</);
}

function testGatewayShowsInviteFormWhenSelected() {
  const html = renderGateway({ authMode: "invite" });

  assert.match(html, />Create your workspace access</);
  assert.match(html, /aria-label="Invite code"/);
  assert.match(html, /aria-label="Display name"/);
  assert.match(html, />Create account</);
  assert.match(html, />Back to sign in/);
}

function testGatewayShowsDeveloperAccessAsSecondaryMode() {
  const html = renderGateway({ authMode: "service" });

  assert.match(html, />Developer access</);
  assert.match(html, />Use a service API key for development or controlled deployments/);
  assert.match(html, /aria-label="Service API key"/);
  assert.match(html, /aria-label="Workspace user ID"/);
  assert.match(html, />User ID determines the isolated workspace sandbox/);
  assert.match(html, />Connect with API key</);
}

function testGatewayShowsErrorsWithActionableTone() {
  const html = renderGateway({ authErrorMsg: "Invalid login or password." });

  assert.match(html, /role="alert"/);
  assert.match(html, />Invalid login or password\./);
}

testGatewayShowsPrimaryLoginWithoutProductIntroModule();
testGatewayDoesNotUseOldEqualWeightModeTabs();
testGatewayShowsInviteFormWhenSelected();
testGatewayShowsDeveloperAccessAsSecondaryMode();
testGatewayShowsErrorsWithActionableTone();

console.log("auth gateway tests passed");
