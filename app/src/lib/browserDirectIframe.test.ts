import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const sourceUrl = new URL("./browserDirectIframe.ts", import.meta.url);

async function testDirectIframeAllowsAnyHttpUrlInDev() {
  assert.equal(existsSync(sourceUrl), true, "browserDirectIframe.ts should define iframe policy");

  const { isDirectBrowserIframeUrl } = await import("./browserDirectIframe");

  assert.equal(isDirectBrowserIframeUrl("https://yun.viaim.cn/cloud/workspace"), true);
  assert.equal(isDirectBrowserIframeUrl("https://github.com/"), true);
  assert.equal(isDirectBrowserIframeUrl("http://example.com/path"), true);
  assert.equal(isDirectBrowserIframeUrl("javascript:alert(1)"), false);
  assert.equal(isDirectBrowserIframeUrl("data:text/html,hi"), false);
}

function testDirectIframePolicyIsAuditable() {
  const source = readFileSync(sourceUrl, "utf8");

  assert.match(source, /isDirectBrowserIframeUrl/);
  assert.match(source, /protocol === "https:" \|\| url\.protocol === "http:"/);
  assert.doesNotMatch(source, /TRUSTED_DIRECT_BROWSER_HOSTS/);
}

await testDirectIframeAllowsAnyHttpUrlInDev();
testDirectIframePolicyIsAuditable();

console.log("browser direct iframe tests passed");
