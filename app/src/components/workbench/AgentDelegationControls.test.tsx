import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AgentContact, AgentDelegation } from "@/types";
import {
  AgentDelegationCreateDialog,
  AgentDelegationStatusCard,
  DelegatedSessionBanner,
  DelegationClarificationCard,
  controlRequestToDelegationClarification,
} from "./AgentDelegationControls";

const delegation: AgentDelegation = {
  delegationId: "dlg-1",
  requesterUserId: "alice",
  requesterSessionId: "sess-a",
  targetUserId: "bob",
  targetSessionId: "sess-b",
  targetJobId: "job-b",
  status: "awaiting_requester_info",
  taskTitle: "Review release",
  taskPrompt: "Review the release notes.",
  createdAt: "2026-07-04T01:00:00Z",
  updatedAt: "2026-07-04T01:01:00Z",
  acceptedAt: "2026-07-04T01:02:00Z",
  completedAt: null,
  pendingClarification: { question: "Which version should I inspect?" },
  lastAnswerEvent: null,
  reason: null,
  error: null,
};

const contact: AgentContact = {
  ownerUserId: "alice",
  contactUserId: "bob",
  remark: "",
  createdAt: "2026-07-06T01:00:00Z",
  updatedAt: "2026-07-06T01:01:00Z",
  profile: {
    userId: "bob",
    userName: "Bob",
    displayName: "Bob",
    login: "bob@example.com",
    avatarUri: null,
  },
};

async function noopAsync() {}

function testAgentDelegationControlsRenderExplicitSurfaces() {
  const statusHtml = renderToStaticMarkup(<AgentDelegationStatusCard delegation={delegation} />);
  assert.match(statusHtml, /Review release/);
  assert.match(statusHtml, /需要补充信息/);

  const completedStatusHtml = renderToStaticMarkup(
    <AgentDelegationStatusCard
      delegation={{
        ...delegation,
        status: "completed",
        completedAt: "2026-07-04T01:05:00Z",
        resultText: "最终产物：发布说明可以发布，但要补充兼容性说明。",
        resultStatus: "completed",
        resultUpdatedAt: "2026-07-04T01:05:00Z",
        resultJobId: "job-b",
        resultOutputAvailable: true,
      }}
    />
  );
  assert.match(completedStatusHtml, /委托产物/);
  assert.match(completedStatusHtml, /发布说明可以发布/);

  const delegatedBannerHtml = renderToStaticMarkup(
    <DelegatedSessionBanner delegation={delegation} />
  );
  assert.match(delegatedBannerHtml, /新开的执行 session/);
  assert.match(delegatedBannerHtml, /Review the release notes/);

  const dialogHtml = renderToStaticMarkup(
    <AgentDelegationCreateDialog
      sourceSessionId="sess-a"
      defaultTaskTitle="Review release"
      defaultTaskPrompt="Review the release notes."
      pending={false}
      onClose={() => undefined}
      onSubmit={noopAsync}
    />
  );
  assert.match(dialogHtml, /委托给其他用户/);
  assert.match(dialogHtml, /user_id/);
  assert.match(dialogHtml, /委托标题/);
  assert.match(dialogHtml, /委托说明/);
  assert.doesNotMatch(dialogHtml, /任务标题/);
  assert.doesNotMatch(dialogHtml, /任务内容/);

  const contactDialogHtml = renderToStaticMarkup(
    <AgentDelegationCreateDialog
      sourceSessionId="sess-a"
      defaultTaskTitle="Review release"
      defaultTaskPrompt="Review the release notes."
      contacts={[contact]}
      pending={false}
      onClose={() => undefined}
      onAddContact={noopAsync}
      onSubmit={noopAsync}
    />
  );
  assert.match(contactDialogHtml, /已添加用户/);
  assert.match(contactDialogHtml, /Bob/);
  assert.match(contactDialogHtml, /bob@example.com/);
  assert.match(contactDialogHtml, /添加 user_id/);
  assert.doesNotMatch(contactDialogHtml, /把任务委托/);

  const clarification = controlRequestToDelegationClarification({
    type: "agent_delegation_clarification",
    delegation_id: "dlg-1",
    target_user_id: "bob",
    question: "Which version should I inspect?",
    reason: "The request was ambiguous.",
  });
  assert.equal(clarification?.delegationId, "dlg-1");

  const clarificationHtml = renderToStaticMarkup(
    <DelegationClarificationCard request={clarification!} pending={false} onAnswer={noopAsync} />
  );
  assert.match(clarificationHtml, /对方 agent 需要补充信息/);
  assert.match(clarificationHtml, /Which version should I inspect/);
}

await testAgentDelegationControlsRenderExplicitSurfaces();
