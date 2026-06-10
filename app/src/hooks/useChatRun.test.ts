import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CONNECTOR_AUTH_POLL_TIMEOUT_MS,
  SESSION_TITLE_REFRESH_DELAYS_MS,
  connectorAuthRequiresSessionAttention,
  connectorAuthPollPayloadFromEvent,
  shouldAutoOpenConnectorAuthWindow,
  shouldContinueConnectorAuthPoll,
  shouldStartConnectorAuthPoll,
  uploadPendingLocalImagesForSend,
} from "./useChatRun";
import type { PendingLocalImage } from "@/lib/pendingImages";
import type { ConnectorAuthChatEvent } from "@/types";

function pendingImage(name: string): PendingLocalImage {
  return {
    id: `local-${name}`,
    file: new File(["image"], name, { type: "image/png" }),
    name,
    mimeType: "image/png",
    previewUrl: `blob:${name}`,
    size: 5,
    source: "paste",
  };
}

function authEvent(
  overrides: Partial<ConnectorAuthChatEvent> & {
    data?: Record<string, unknown>;
    source?: string;
  }
): ConnectorAuthChatEvent {
  const { data, source, ...eventOverrides } = overrides;
  return {
    type: "connector_auth_required",
    connector: "feishu",
    display_name: "Feishu",
    auth_flow: "browser",
    stage: "awaiting_setup",
    message: "Open the URL.",
    action: {
      name: overrides.connector || "feishu",
      ok: true,
      stage: overrides.stage || "awaiting_setup",
      detail: "",
      source,
      data: data || {},
    },
    ...eventOverrides,
  };
}

function testFeishuSetupAuthStartsAutomaticPoll() {
  const payload = connectorAuthPollPayloadFromEvent(
    authEvent({ data: { setup_url: "https://open.feishu.cn/page/cli?user_code=abc" } })
  );

  assert.deepEqual(payload, {
    connector: "feishu",
    tag: "setup",
    url: "https://open.feishu.cn/page/cli?user_code=abc",
    popup: null,
    mode: "skill",
  });
  assert.equal(payload && shouldStartConnectorAuthPoll(payload), true);
}

function testFeishuUserAuthStartsAutomaticPoll() {
  const payload = connectorAuthPollPayloadFromEvent(
    authEvent({
      stage: "awaiting_user_auth",
      data: { oauth_url: "https://accounts.feishu.cn/device" },
    })
  );

  assert.deepEqual(payload, {
    connector: "feishu",
    tag: "auth",
    url: "https://accounts.feishu.cn/device",
    popup: null,
    mode: "skill",
  });
}

function testGoogleAuthStillStartsAutomaticPoll() {
  const payload = connectorAuthPollPayloadFromEvent(
    authEvent({
      connector: "google_workspace",
      display_name: "Google Workspace",
      stage: "awaiting_browser_callback",
      data: { oauth_url: "https://accounts.google.com/o/oauth2/auth?state=abc" },
    })
  );

  assert.deepEqual(payload, {
    connector: "google_workspace",
    tag: "auth",
    url: "https://accounts.google.com/o/oauth2/auth?state=abc",
    popup: null,
    mode: "skill",
  });
}

function testConnectorPageGoogleAuthDoesNotStartAutomaticPoll() {
  const event = authEvent({
    connector: "google_workspace",
    display_name: "Google Workspace",
    stage: "awaiting_browser_callback",
    source: "connectors_page",
    data: { oauth_url: "https://accounts.google.com/o/oauth2/auth?state=abc" },
  });
  const payload = connectorAuthPollPayloadFromEvent(event);

  assert.deepEqual(payload, {
    connector: "google_workspace",
    tag: "auth",
    url: "https://accounts.google.com/o/oauth2/auth?state=abc",
    popup: null,
    mode: "connect",
  });
  assert.equal(payload && shouldStartConnectorAuthPoll(payload), false);
  assert.equal(connectorAuthRequiresSessionAttention(event), false);
}

function testSkillGoogleAuthKeepsSessionAttentionWhilePolling() {
  const event = authEvent({
    connector: "google_workspace",
    display_name: "Google Workspace",
    stage: "awaiting_browser_callback",
    data: { oauth_url: "https://accounts.google.com/o/oauth2/auth?state=abc" },
  });

  assert.equal(connectorAuthRequiresSessionAttention(event), true);
}

function testBilibiliAuthDoesNotStartAutomaticPollOrOpen() {
  const payload = connectorAuthPollPayloadFromEvent(
    authEvent({
      connector: "bilibili",
      display_name: "Bilibili",
      stage: "awaiting_user",
      data: {
        qrcode_image_url: "/v1/bilibili/qrcode.png?content=encoded",
        app_url:
          "bilibili://browser?url=https%3A%2F%2Faccount.bilibili.com%2Fh5%2Faccount-h5%2Fauth%2Fscan-web%3Fqrcode_key%3Dabc",
        qrcode_content: "https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=abc",
      },
    })
  );

  assert.equal(payload, null);
}

function testAuthorizedConnectorEventDoesNotStartPoll() {
  const payload = connectorAuthPollPayloadFromEvent(
    authEvent({
      type: "connector_auth_updated",
      stage: "authorized",
      data: { oauth_url: "https://accounts.feishu.cn/device" },
    })
  );

  assert.equal(payload, null);
}

function testConnectorAuthPollContinuesOnlyBeforeTimeout() {
  assert.equal(
    shouldContinueConnectorAuthPoll(
      authEvent({ stage: "awaiting_setup" }),
      "feishu",
      CONNECTOR_AUTH_POLL_TIMEOUT_MS - 1
    ),
    true
  );
  assert.equal(
    shouldContinueConnectorAuthPoll(
      authEvent({ stage: "awaiting_setup" }),
      "feishu",
      CONNECTOR_AUTH_POLL_TIMEOUT_MS
    ),
    false
  );
}

function testConnectorAuthPollStopsOnTerminalStages() {
  assert.equal(
    shouldContinueConnectorAuthPoll(authEvent({ stage: "auth_failed" }), "feishu", 0),
    false
  );
  assert.equal(
    shouldContinueConnectorAuthPoll(authEvent({ stage: "invalid_request" }), "feishu", 0),
    false
  );
  assert.equal(
    shouldContinueConnectorAuthPoll(
      authEvent({ connector: "google_workspace", stage: "awaiting_browser_callback" }),
      "feishu",
      0
    ),
    false
  );
  assert.equal(shouldContinueConnectorAuthPoll(null, "feishu", 0), false);
}

function testFeishuConnectorAuthPollDoesNotAutoOpenBrowserOnRunComplete() {
  assert.equal(shouldAutoOpenConnectorAuthWindow("feishu"), false);
}

function testGoogleConnectorAuthPollDoesNotAutoOpenBrowserOnRunComplete() {
  const source = readFileSync(new URL("./useChatRun.ts", import.meta.url), "utf8");

  assert.equal(shouldAutoOpenConnectorAuthWindow("google_workspace"), false);
  assert.match(
    source,
    /openAuthWindow:\s*shouldAutoOpenConnectorAuthWindow\(\s*pendingConnectorAuthPayload\.connector\s*\)/
  );
}

function testConnectorAuthPopupUrlResetAllowsManualRetry() {
  const source = readFileSync(new URL("./useChatRun.ts", import.meta.url), "utf8");

  assert.match(
    source,
    /const clearConnectorAuthPoll = useCallback\(\(\) => \{[\s\S]{0,500}feishuAuthPopupUrlRef\.current = null;/
  );
}

function testAttachmentUploadsKeepSuccessfulFilesWhenOneUploadFails() {
  const source = readFileSync(new URL("./useChatRun.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /Promise\.all\(files\.map\(\(file\) => uploadWorkspaceAttachment/);
  assert.match(source, /for \(const file of files\)/);
  assert.match(source, /setAttachmentUploadError/);
}

function testSessionTitleRefreshUsesShortDelayedPolls() {
  assert.deepEqual(SESSION_TITLE_REFRESH_DELAYS_MS, [750, 2000, 5000]);
}

function testCompletedRunRefreshesSessionsWithoutListLoading() {
  const source = readFileSync(new URL("./useChatRun.ts", import.meta.url), "utf8");
  const completeBlock =
    source.match(/onComplete: \(\) => \{[\s\S]*?onWorkspaceRefresh\(\);[\s\S]*?\n {8}\},/)
      ?.[0] || "";
  const silentRefreshCalls =
    completeBlock.match(/loadSessions\(\{ showLoading: false \}\)/g) || [];

  assert.equal(silentRefreshCalls.length, 2);
  assert.doesNotMatch(completeBlock, /loadSessions\(\);/);
}

function testSessionActionRefreshesStaySilentAfterInitialLoad() {
  const source = readFileSync(new URL("./useChatRun.ts", import.meta.url), "utf8");
  const silentRefreshCalls =
    source.match(/getSessionActions\(\)\.loadSessions\(\{ showLoading: false \}\)/g) || [];

  assert.ok(silentRefreshCalls.length >= 8);
  assert.doesNotMatch(source, /getSessionActions\(\)\.loadSessions\(\)/);
}

async function testPendingLocalImagesUploadToWorkspaceRefsBeforeSend() {
  const uploadedNames: string[] = [];
  const result = await uploadPendingLocalImagesForSend(
    [pendingImage("paste-a.png"), pendingImage("paste-b.png")],
    async (file) => {
      uploadedNames.push(file.name);
      return {
        path: `/workspace/uploads/${file.name}`,
        name: file.name,
        mime_type: file.type,
        size: file.size,
        kind: "image" as const,
      };
    }
  );

  assert.deepEqual(uploadedNames, ["paste-a.png", "paste-b.png"]);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.files, [
    {
      path: "/workspace/uploads/paste-a.png",
      name: "paste-a.png",
      mime_type: "image/png",
      kind: "image",
    },
    {
      path: "/workspace/uploads/paste-b.png",
      name: "paste-b.png",
      mime_type: "image/png",
      kind: "image",
    },
  ]);
}

async function testPendingLocalImageUploadFailuresStopSendFlow() {
  const result = await uploadPendingLocalImagesForSend([pendingImage("broken.png")], async () => {
    throw new Error("upload exploded");
  });

  assert.deepEqual(result.files, []);
  assert.deepEqual(result.failures, ["broken.png: upload exploded"]);
}

function testSendFlowKeepsLocalImagesWhenSendTimeUploadFails() {
  const source = readFileSync(new URL("./useChatRun.ts", import.meta.url), "utf8");

  assert.match(source, /uploadPendingLocalImagesForSend\(\s*localImagesForSend/);
  assert.match(source, /if \(localUpload\.failures\.length > 0\) \{/);
  assert.match(source, /setAttachmentUploadError\(summarizeAttachmentUploadErrors/);
  assert.match(source, /return;/);
  assert.match(source, /clearPendingLocalImages\(\);/);
}

function testSendFlowCanForceFreshSession() {
  const source = readFileSync(new URL("./useChatRun.ts", import.meta.url), "utf8");

  assert.match(source, /createSession: \(model\?: string \| null\) => Promise<string \| null>/);
  assert.match(source, /newSession\?: boolean/);
  assert.match(
    source,
    /options\.newSession\s*\?\s*await sessionActions\.createSession\(selectedModel\)\s*:\s*await sessionActions\.ensureSession\(selectedModel\)/
  );
}

function testSessionDetailsPassSessionIdWhenUpdatingModel() {
  const source = readFileSync(new URL("./useChatRun.ts", import.meta.url), "utf8");

  assert.match(
    source,
    /onSelectedModelChange: \(model: string, sessionId\?: string \| null\) => void/
  );
  assert.match(source, /onSelectedModelChange\(details\.model,\s*details\.sessionId\)/);
}

function testFreshSessionSendDoesNotCarryCurrentViewState() {
  const source = readFileSync(new URL("./useChatRun.ts", import.meta.url), "utf8");

  assert.match(source, /const baseMessages = options\.newSession \? \[\] : messages;/);
  assert.match(
    source,
    /const baseRuntimeTimelineEvents = options\.newSession \? \[\] : runtimeTimelineEvents;/
  );
  assert.match(source, /const baseTokenUsage = options\.newSession \? emptyUsage : tokenUsage;/);
  assert.match(source, /const basePlanSteps = options\.newSession \? \[\] : planSteps;/);
  assert.match(source, /const initialMessages: Message\[] = \[\s*...baseMessages,/);
  assert.match(source, /runtimeTimelineEvents: baseRuntimeTimelineEvents,/);
}

function testSessionControlActionsStartFreshSessions() {
  const source = readFileSync(new URL("./useChatRun.ts", import.meta.url), "utf8");

  assert.match(
    source,
    /handleSendMessage\(label,\s*\{\s*controlAction:\s*action,\s*newSession:\s*true\s*\}\)/
  );
}

function testSendErrorsReleaseSessionForRetry() {
  const source = readFileSync(new URL("./useChatRun.ts", import.meta.url), "utf8");

  assert.match(source, /let streamHadError = false;/);
  assert.match(source, /streamHadError = true;/);
  assert.match(source, /if \(streamHadError\) return;/);

  const onErrorBlock = source.match(/onError: \(err\) => \{([\s\S]*?)\n\s*\},\n\s*\};/);
  assert.ok(onErrorBlock, "send onError block should exist");
  assert.match(onErrorBlock[1], /runningViewStatesRef\.current\.delete\(activeSessionId\)/);
  assert.match(onErrorBlock[1], /clearSessionRunning\(activeSessionId\)/);
}

function testAskUserMarksBackgroundSessionAsNewResult() {
  const source = readFileSync(new URL("./useChatRun.ts", import.meta.url), "utf8");
  const toolAskUserBlock = source.match(/if \(toolCall\.name === "AskUser"\) \{[\s\S]*?\n\s*\}/)
    ?.[0] || "";
  const stopAskUserBlock =
    source.match(/if \(data\.stop_reason === "ask_user"[\s\S]*?\n\s*\}/)?.[0] || "";

  assert.match(toolAskUserBlock, /onSessionAttention\?\.\(activeSessionId, "completed"\)/);
  assert.match(stopAskUserBlock, /onSessionAttention\?\.\(activeSessionId, "completed"\)/);
}

function testPermissionRequestKeepsApprovalAttention() {
  const source = readFileSync(new URL("./useChatRun.ts", import.meta.url), "utf8");
  const permissionStopBlock =
    source.match(/if \(data\.stop_reason === "permission_request"[\s\S]*?\n\s*\}/)?.[0] ||
    "";

  assert.match(permissionStopBlock, /onSessionAttention\?\.\(activeSessionId, "needs_input"\)/);
  assert.match(source, /onPermissionRequest:[\s\S]*onSessionAttention\?\.\(activeSessionId, "needs_input"\)/);
}

test("useChatRun behavior", async () => {
  testFeishuSetupAuthStartsAutomaticPoll();
  testFeishuUserAuthStartsAutomaticPoll();
  testGoogleAuthStillStartsAutomaticPoll();
  testConnectorPageGoogleAuthDoesNotStartAutomaticPoll();
  testSkillGoogleAuthKeepsSessionAttentionWhilePolling();
  testBilibiliAuthDoesNotStartAutomaticPollOrOpen();
  testAuthorizedConnectorEventDoesNotStartPoll();
  testConnectorAuthPollContinuesOnlyBeforeTimeout();
  testConnectorAuthPollStopsOnTerminalStages();
  testFeishuConnectorAuthPollDoesNotAutoOpenBrowserOnRunComplete();
  testGoogleConnectorAuthPollDoesNotAutoOpenBrowserOnRunComplete();
  testConnectorAuthPopupUrlResetAllowsManualRetry();
  testAttachmentUploadsKeepSuccessfulFilesWhenOneUploadFails();
  testSessionTitleRefreshUsesShortDelayedPolls();
  testCompletedRunRefreshesSessionsWithoutListLoading();
  testSessionActionRefreshesStaySilentAfterInitialLoad();
  await testPendingLocalImagesUploadToWorkspaceRefsBeforeSend();
  await testPendingLocalImageUploadFailuresStopSendFlow();
  testSendFlowKeepsLocalImagesWhenSendTimeUploadFails();
  testSendFlowCanForceFreshSession();
  testSessionDetailsPassSessionIdWhenUpdatingModel();
  testFreshSessionSendDoesNotCarryCurrentViewState();
  testSessionControlActionsStartFreshSessions();
  testSendErrorsReleaseSessionForRetry();
  testAskUserMarksBackgroundSessionAsNewResult();
  testPermissionRequestKeepsApprovalAttention();
});
