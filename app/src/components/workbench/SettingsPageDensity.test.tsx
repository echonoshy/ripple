import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");

assert.match(source, /className="mx-auto max-w-5xl space-y-2"/);
assert.match(source, /RippleIcon\s*\n\s*size=\{24\}/);
assert.match(source, /className="flex h-8 items-center gap-1\.5 border-b/);
assert.match(source, /className="space-y-2 p-2\.5"/);
assert.match(source, /className="flex h-12 w-12/);
assert.match(source, /className="grid gap-2 p-2\.5 md:grid-cols-2"/);
assert.match(source, /compact \? "px-2 py-1\.5"/);

console.log("settings page density tests passed");
