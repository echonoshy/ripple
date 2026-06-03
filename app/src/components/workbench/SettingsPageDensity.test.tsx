import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");

assert.match(source, /className="mx-auto max-w-5xl space-y-2\.5"/);
assert.match(source, /RippleIcon\s*\n\s*size=\{28\}/);
assert.match(source, /flex min-h-10 items-center gap-1\.5 border-b/);
assert.match(source, /className="space-y-1\.5 p-2"/);
assert.match(source, /flex h-12 w-12/);
assert.match(source, /settingsAccountActionButtonClass =[\s\S]*h-9 w-full/);
assert.match(source, /MOBILE_PAGE_TOP_SAFE_AREA_CLASS/);
assert.match(source, /MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS/);
assert.match(source, /className="grid gap-1\.5 p-2\.5 md:grid-cols-2"/);
assert.match(source, /data-ripple-settings-token-grid[\s\S]*grid-cols-3/);
assert.match(source, /const baseClassName = compact[\s\S]*\? "px-1\.5 py-1"/);
assert.match(source, /TYPOGRAPHY_BODY_MEDIUM_CLASS/);

console.log("settings page density tests passed");
