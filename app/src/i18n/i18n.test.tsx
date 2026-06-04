import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  I18nProvider,
  createDateTimeFormatters,
  interpolateMessage,
  normalizeLocalePreference,
  resolveLocale,
  SUPPORTED_LOCALES,
  type LocalePreference,
  useI18n,
} from "./index";

function testSupportedLocalesAreLimitedToChineseAndEnglish() {
  assert.deepEqual(SUPPORTED_LOCALES, ["zh-CN", "en-US"]);
}

function testNormalizesStoredLocalePreference() {
  assert.equal(normalizeLocalePreference("system"), "system");
  assert.equal(normalizeLocalePreference("zh-CN"), "zh-CN");
  assert.equal(normalizeLocalePreference("en-US"), "en-US");
  assert.equal(normalizeLocalePreference("fr-FR"), null);
  assert.equal(normalizeLocalePreference(null), null);
}

function testResolvesLocaleFromPreferenceBeforeSystemLanguages() {
  assert.equal(resolveLocale("en-US", ["zh-CN"]), "en-US");
  assert.equal(resolveLocale("zh-CN", ["en-US"]), "zh-CN");
}

function testResolvesLocaleFromSystemLanguages() {
  assert.equal(resolveLocale("system", ["zh-Hans-CN", "en-US"]), "zh-CN");
  assert.equal(resolveLocale("system", ["en-GB", "zh-CN"]), "en-US");
  assert.equal(resolveLocale("system", ["fr-FR"]), "zh-CN");
  assert.equal(resolveLocale(null, []), "zh-CN");
}

function testInterpolatesMessages() {
  assert.equal(interpolateMessage("Hello {name}", { name: "Ripple" }), "Hello Ripple");
  assert.equal(interpolateMessage("Missing {name}", {}), "Missing {name}");
}

function testFormatsDatesWithResolvedLocale() {
  const date = new Date("2026-06-01T08:30:00.000Z");
  const zh = createDateTimeFormatters("zh-CN", "UTC");
  const en = createDateTimeFormatters("en-US", "UTC");

  assert.equal(zh.formatDate(date, { month: "short", day: "numeric" }), "6月1日");
  assert.equal(en.formatDate(date, { month: "short", day: "numeric" }), "Jun 1");
}

function testProviderSuppliesTranslationsAndPreference() {
  function Probe() {
    const { locale, preference, t } = useI18n();
    return (
      <div>
        <span>{locale}</span>
        <span>{preference}</span>
        <span>{t("settings.language.title")}</span>
      </div>
    );
  }

  const html = renderToStaticMarkup(
    <I18nProvider initialPreference={"en-US" satisfies LocalePreference}>
      <Probe />
    </I18nProvider>
  );

  assert.match(html, />en-US</);
  assert.match(html, />Language</);
}

function testUseI18nFallsBackToDefaultChineseWithoutProvider() {
  function Probe() {
    const { locale, t } = useI18n();
    return (
      <div>
        <span>{locale}</span>
        <span>{t("settings.language.title")}</span>
      </div>
    );
  }

  const html = renderToStaticMarkup(<Probe />);

  assert.match(html, />zh-CN</);
  assert.match(html, />语言</);
}

testSupportedLocalesAreLimitedToChineseAndEnglish();
testNormalizesStoredLocalePreference();
testResolvesLocaleFromPreferenceBeforeSystemLanguages();
testResolvesLocaleFromSystemLanguages();
testInterpolatesMessages();
testFormatsDatesWithResolvedLocale();
testProviderSuppliesTranslationsAndPreference();
testUseI18nFallsBackToDefaultChineseWithoutProvider();

console.log("i18n tests passed");
