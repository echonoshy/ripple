import assert from "node:assert/strict";

import {
  CLIENT_CONTEXT_DEMO_STORAGE_KEY,
  VIAIM_MEETING_DEMO_ID,
  buildViaimMeetingDemoClientContext,
  getChatClientContextSnapshot,
  mergeRequiredSkillIds,
  readClientContextDemoSettings,
  resetClientContextDemoSettings,
  saveClientContextDemoSettings,
} from "./clientContext";

function withBrowserWindow(href: string, run: (values: Map<string, string>) => void) {
  const globals = globalThis as unknown as {
    window?: {
      localStorage: Storage;
      location: Pick<Location, "href">;
      __RIPPLE_CLIENT_CONTEXT__?: unknown;
      __RIPPLE_CLIENT_CONTEXT_PROVIDER__?: () => unknown;
      RippleAndroidGesture?: unknown;
    };
  };
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
    location: { href },
  };

  try {
    run(values);
  } finally {
    globals.window = previousWindow;
  }
}

function testSnapshotIsEmptyWithoutHostOrDemo() {
  withBrowserWindow("https://demo.example.com/", () => {
    assert.deepEqual(getChatClientContextSnapshot(), {});
  });
}

function testViaimMeetingDemoCanBeEnabledFromStorage() {
  withBrowserWindow("https://demo.example.com/", (values) => {
    values.set(CLIENT_CONTEXT_DEMO_STORAGE_KEY, VIAIM_MEETING_DEMO_ID);

    const snapshot = getChatClientContextSnapshot();

    assert.deepEqual(snapshot.requiredSkillIds, ["ripple:viaim-product-support"]);
    assert.equal(snapshot.clientContext?.schema_version, "ripple.client_context.v1");
    assert.equal(snapshot.clientContext?.software?.host_app?.app_id, "viaim.meeting");
    assert.equal(snapshot.clientContext?.software?.screen?.layout, "mobile");
    assert.equal(snapshot.clientContext?.devices?.[0]?.source, "mock");
    assert.equal(snapshot.clientContext?.devices?.[0]?.state?.left_battery_percent, 80);
  });
}

function testLocalhost8824EnablesViaimMeetingDemoByDefault() {
  withBrowserWindow("http://localhost:8824/", () => {
    const snapshot = getChatClientContextSnapshot();

    assert.deepEqual(snapshot.requiredSkillIds, ["ripple:viaim-product-support"]);
    assert.equal(snapshot.clientContext?.software?.host_app?.app_id, "viaim.meeting");
    assert.equal(snapshot.clientContext?.devices?.[0]?.state?.left_battery_percent, 80);
  });
}

function testAndroidTauriShellEnablesViaimMeetingDemoByDefault() {
  withBrowserWindow("tauri://localhost/", () => {
    (window as Window & { RippleAndroidGesture?: unknown }).RippleAndroidGesture = {};

    const snapshot = getChatClientContextSnapshot();

    assert.deepEqual(snapshot.requiredSkillIds, ["ripple:viaim-product-support"]);
    assert.equal(snapshot.clientContext?.software?.host_app?.app_id, "viaim.meeting");
    assert.equal(snapshot.clientContext?.devices?.[0]?.state?.left_battery_percent, 80);
  });
}

function testViaimMeetingDemoCanBeEnabledFromUrl() {
  withBrowserWindow(
    `https://demo.example.com/?ripple_client_context_demo=${VIAIM_MEETING_DEMO_ID}`,
    () => {
      const snapshot = getChatClientContextSnapshot();

      assert.equal(snapshot.clientContext?.software?.screen?.screen_id, "meeting.detail");
      assert.equal(snapshot.clientContext?.software?.selection?.display_name, "产品周会");
    }
  );
}

function testHostProviderSnapshotWinsAndDropsSecrets() {
  withBrowserWindow("https://demo.example.com/", () => {
    const clientContextWindow = window as Window & {
      __RIPPLE_CLIENT_CONTEXT_PROVIDER__?: () => unknown;
    };
    clientContextWindow.__RIPPLE_CLIENT_CONTEXT_PROVIDER__ = () => ({
      clientContext: {
        software: {
          host_app: {
            app_id: "viaim.meeting",
            api_key: "rk-secret",
          },
          screen: {
            screen_id: "meeting.live",
          },
        },
        devices: [
          {
            identity: {
              manufacturer: "viaim",
            },
            state: {
              left_battery_percent: 66,
              cookie: "private-cookie",
            },
          },
        ],
      },
      requiredSkillIds: ["ripple:viaim-product-support", "ripple:viaim-product-support", ""],
    });

    const snapshot = getChatClientContextSnapshot();

    assert.deepEqual(snapshot.requiredSkillIds, ["ripple:viaim-product-support"]);
    assert.equal(snapshot.clientContext?.schema_version, "ripple.client_context.v1");
    assert.equal(snapshot.clientContext?.software?.screen?.screen_id, "meeting.live");
    assert.equal(snapshot.clientContext?.software?.host_app?.api_key, undefined);
    assert.equal(snapshot.clientContext?.devices?.[0]?.state?.cookie, undefined);
  });
}

function testMergeRequiredSkillIdsKeepsManualSelectionFirst() {
  assert.deepEqual(
    mergeRequiredSkillIds(
      ["ripple:custom-skill", "ripple:viaim-product-support"],
      ["ripple:viaim-product-support"]
    ),
    ["ripple:custom-skill", "ripple:viaim-product-support"]
  );
}

function testClientContextSupportsEditableDemoSettings() {
  withBrowserWindow("https://demo.example.com/", () => {
    const saved = saveClientContextDemoSettings({
      screenTitle: "实时转写",
      selectionName: "董事会",
      screenLayout: "desktop",
      connectionState: "disconnected",
      leftBatteryPercent: 63,
      rightBatteryPercent: 61,
      caseBatteryPercent: 44,
      noiseControl: "transparency",
      recording: true,
    });

    assert.deepEqual(readClientContextDemoSettings(), saved);

    const context = buildViaimMeetingDemoClientContext(readClientContextDemoSettings());
    assert.equal(context.software?.screen?.title, "实时转写");
    assert.equal(context.software?.screen?.layout, "desktop");
    assert.equal(context.software?.selection?.display_name, "董事会");
    assert.equal(context.devices?.[0]?.connection?.state, "disconnected");
    assert.equal(context.devices?.[0]?.state?.left_battery_percent, 63);
    assert.equal(context.devices?.[0]?.state?.right_battery_percent, 61);
    assert.equal(context.devices?.[0]?.state?.case_battery_percent, 44);
    assert.equal(context.devices?.[0]?.state?.noise_control, "transparency");
    assert.equal(context.devices?.[0]?.state?.recording, true);

    resetClientContextDemoSettings();
    assert.equal(readClientContextDemoSettings().screenTitle, "会议详情");
  });
}

function testSavedDemoSettingsEnableChatSnapshot() {
  withBrowserWindow("https://demo.example.com/", () => {
    saveClientContextDemoSettings({
      leftBatteryPercent: 31,
      rightBatteryPercent: 29,
      caseBatteryPercent: 70,
    });

    const snapshot = getChatClientContextSnapshot();

    assert.deepEqual(snapshot.requiredSkillIds, ["ripple:viaim-product-support"]);
    assert.equal(snapshot.clientContext?.devices?.[0]?.state?.left_battery_percent, 31);
    assert.equal(snapshot.clientContext?.devices?.[0]?.state?.right_battery_percent, 29);
    assert.equal(snapshot.clientContext?.devices?.[0]?.state?.case_battery_percent, 70);
  });
}

testSnapshotIsEmptyWithoutHostOrDemo();
testViaimMeetingDemoCanBeEnabledFromStorage();
testLocalhost8824EnablesViaimMeetingDemoByDefault();
testAndroidTauriShellEnablesViaimMeetingDemoByDefault();
testViaimMeetingDemoCanBeEnabledFromUrl();
testHostProviderSnapshotWinsAndDropsSecrets();
testMergeRequiredSkillIdsKeepsManualSelectionFirst();
testClientContextSupportsEditableDemoSettings();
testSavedDemoSettingsEnableChatSnapshot();

console.log("client context tests passed");
