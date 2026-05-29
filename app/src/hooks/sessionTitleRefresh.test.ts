import assert from "node:assert/strict";

import { SESSION_TITLE_REFRESH_DELAYS_MS } from "./useChatRun";

assert.deepEqual(SESSION_TITLE_REFRESH_DELAYS_MS, [750, 2000, 5000]);

console.log("session title refresh tests passed");
