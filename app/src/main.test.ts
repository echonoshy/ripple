import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");

assert.doesNotMatch(source, /ClientContextDemoPage/);
assert.doesNotMatch(source, /client-context-demo/);
assert.match(source, /<App \/>/);

console.log("main entry tests passed");
