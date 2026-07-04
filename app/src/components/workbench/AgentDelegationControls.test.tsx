import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AgentDelegation } from "@/types";
import {
  AgentDelegationCreateDialog,
  AgentDelegationStatusCard,
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

async function noopAsync() {}

function testAgentDelegationControlsRenderExplicitSurfaces() {
  const statusHtml = renderToStaticMarkup(<AgentDelegationStatusCard delegation={delegation} />);
  assert.match(statusHtml, /Review release/);
  assert.match(statusHtml, /需要补充信息/);

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
