import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, type LocalePreference } from "@/i18n";
import AuthGateway from "./AuthGateway";

function noop() {}

function renderGateway(
  overrides: Partial<React.ComponentProps<typeof AuthGateway>> = {},
  locale: LocalePreference = "en-US"
) {
  return renderToStaticMarkup(
    <I18nProvider initialPreference={locale}>
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
    </I18nProvider>
  );
}

function testGatewayShowsPrimaryLoginWithoutProductIntroModule() {
  const html = renderGateway();
  const developerAccessMatches = html.match(/>Developer access</g) || [];

  assert.match(html, /data-ripple-auth-gateway="true"/);
  assert.match(html, /pt-\[calc\(max\(env\(safe-area-inset-top\),12px\)\+20px\)\]/);
  assert.match(html, /pb-\[max\(env\(safe-area-inset-bottom\),20px\)\]/);
  assert.match(html, /data-ripple-brand-wordmark="true"/);
  assert.match(
    html,
    /<span[^>]*>Flow<\/span>[\s\S]*<span[^>]*>with<\/span>[\s\S]*<span[^>]*>Ripple<\/span>/
  );
  assert.match(html, />Each ripple of iteration converges toward the solution\./);
  assert.match(html, />每一次迭代的涟漪，都是向解的收敛。</);
  assert.match(html, />Your AI workspace</);
  assert.doesNotMatch(html, />Agent control plane</);
  assert.match(html, />Sign in to Ripple</);
  assert.doesNotMatch(html, />Use your account credentials to continue\.</);
  assert.doesNotMatch(html, />Workspace gateway</);
  assert.doesNotMatch(html, />One entry for sessions, files, connectors, and scheduled work/);
  assert.doesNotMatch(html, />Workspace-scoped files</);
  assert.doesNotMatch(html, />Session history and runs</);
  assert.doesNotMatch(html, />Connector authorization</);
  assert.doesNotMatch(html, />Automations and schedules</);
  assert.doesNotMatch(html, />Workspace isolation</);
  assert.match(html, /aria-label="Email"/);
  assert.match(html, /placeholder="Email"/);
  assert.match(html, /autoComplete="email"/);
  assert.doesNotMatch(html, /Email or username/);
  assert.match(html, /aria-label="Password"/);
  assert.match(html, />Sign in</);
  assert.equal(developerAccessMatches.length, 1);
}

function testGatewayHeroBrandMarkAndInputsAreReadable() {
  const html = renderGateway();
  const source = readFileSync(new URL("./AuthGateway.tsx", import.meta.url), "utf8");
  const heroMark = html.match(/<div[^>]*data-ripple-auth-hero-mark="true"[^>]*>/)?.[0];
  const heroLabel = html.match(/<p[^>]*data-ripple-auth-hero-label="true"[^>]*>/)?.[0];
  const brandWith = html.match(/<span[^>]*data-ripple-auth-brand-with="true"[^>]*>/)?.[0];

  assert.ok(heroMark);
  assert.ok(heroLabel);
  assert.ok(brandWith);
  assert.match(heroMark, /h-16/);
  assert.match(heroMark, /w-16/);
  assert.match(source, /<RippleIcon size=\{56\} className="h-14 w-14 rounded-\[14px\]"/);
  assert.doesNotMatch(source, /<RippleIcon size=\{44\} className="h-11 w-11/);
  assert.match(heroLabel, /text-\[15px\]/);
  assert.match(heroLabel, /tracking-\[0\.14em\]/);
  assert.match(brandWith, /text-\[20px\]/);
  assert.match(brandWith, /sm:text-\[22px\]/);
  assert.doesNotMatch(brandWith, /TYPOGRAPHY_MICRO/);
  assert.match(source, /function FieldIcon/);
  assert.match(source, /<IconTile tone="neutral" size="sm"/);
  assert.match(source, /className="absolute top-1\/2 left-3\.5/);
  assert.match(source, /className=\{`h-12[\s\S]*pl-12[\s\S]*text-\[16px\]/);
  assert.match(source, /<Mail size=\{16\}/);
  assert.match(source, /<KeyRound size=\{16\}/);
}

function testGatewayMainContentSitsSlightlyHigher() {
  const html = renderGateway();
  const main = html.match(/<main[^>]*data-ripple-auth-main="true"[^>]*>/)?.[0];

  assert.ok(main);
  assert.match(main, /justify-center/);
  assert.match(main, /-translate-y-6/);
  assert.match(main, /sm:-translate-y-8/);
  assert.match(main, /lg:-translate-y-10/);
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
  assert.match(html, /aria-label="Email"/);
  assert.match(html, /aria-label="Display name"/);
  assert.doesNotMatch(html, /Email or username/);
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

function testGatewayRendersChineseLoginCopy() {
  const html = renderGateway({}, "zh-CN");

  assert.match(html, /data-ripple-brand-wordmark="true"/);
  assert.match(html, /aria-label="Flow with Ripple"/);
  assert.match(html, />每一次迭代的涟漪，都是向解的收敛。</);
  assert.match(html, />Each ripple of iteration converges toward the solution\./);
  assert.match(html, />你的 AI 工作空间</);
  assert.match(html, />登录 Ripple</);
  assert.doesNotMatch(html, />使用你的账号凭据继续。</);
  assert.match(html, /aria-label="邮箱"/);
  assert.match(html, /aria-label="密码"/);
  assert.match(html, />登录</);
  assert.match(html, />有邀请码？</);
  assert.match(html, />开发者访问</);
}

testGatewayShowsPrimaryLoginWithoutProductIntroModule();
testGatewayHeroBrandMarkAndInputsAreReadable();
testGatewayMainContentSitsSlightlyHigher();
testGatewayDoesNotUseOldEqualWeightModeTabs();
testGatewayShowsInviteFormWhenSelected();
testGatewayShowsDeveloperAccessAsSecondaryMode();
testGatewayShowsErrorsWithActionableTone();
testGatewayRendersChineseLoginCopy();

console.log("auth gateway tests passed");
