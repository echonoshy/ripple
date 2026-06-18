import assert from "node:assert/strict";

import {
  AuthError,
  authHeaders,
  clearApiKey,
  getApiOrigin,
  getAuthMode,
  getUserId,
  responseDetail,
  resolveApiUrl,
  setApiKey,
  setUserId,
  setUserSessionToken,
} from "./apiTransport";

async function withBrowserStorage(run: () => Promise<void>) {
  const globals = globalThis as unknown as { window?: { localStorage: Storage } };
  const previousWindow = globals.window;
  const values = new Map<string, string>();
  globals.window = {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
      clear: () => {
        values.clear();
      },
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() {
        return values.size;
      },
    },
  };
  try {
    await run();
  } finally {
    globals.window = previousWindow;
  }
}

function testApiUrlResolutionStaysDeviceReachableByDefault() {
  assert.equal(resolveApiUrl({ DEV: true }), "/v1");
  assert.equal(
    resolveApiUrl({ DEV: true, VITE_RIPPLE_API_URL: "http://localhost:8810" }),
    "http://localhost:8810/v1"
  );
  assert.equal(resolveApiUrl({ PROD: true }), "http://140.143.229.103:8810/v1");
  assert.equal(getApiOrigin(), "http://140.143.229.103:8810");
}

async function testAuthHeadersSeparateServiceAndUserAuthModes() {
  await withBrowserStorage(async () => {
    setUserId("alice");
    setApiKey("service-token");

    assert.equal(getAuthMode(), "service");
    assert.deepEqual(authHeaders(), {
      "X-Ripple-User-Id": "alice",
      Authorization: "Bearer service-token",
    });

    setUserSessionToken("user-token", "bob");

    assert.equal(getAuthMode(), "user");
    assert.equal(getUserId(), "bob");
    assert.deepEqual(authHeaders(), {
      Authorization: "Bearer user-token",
    });

    clearApiKey();
  });
}

async function testResponseDetailReadsStringAndStructuredDetail() {
  assert.equal(
    await responseDetail(
      new Response(JSON.stringify({ detail: "plain detail" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    ),
    "plain detail"
  );
  assert.equal(
    await responseDetail(
      new Response(JSON.stringify({ detail: { message: "nested detail" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    ),
    "nested detail"
  );
}

function testAuthErrorNameIsStable() {
  const error = new AuthError();
  assert.equal(error.name, "AuthError");
  assert.equal(error.message, "Authentication required");
}

testApiUrlResolutionStaysDeviceReachableByDefault();
await testAuthHeadersSeparateServiceAndUserAuthModes();
await testResponseDetailReadsStringAndStructuredDetail();
testAuthErrorNameIsStable();

console.log("api transport tests passed");
