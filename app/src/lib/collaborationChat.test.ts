import assert from "node:assert/strict";
import {
  buildCollaborationSessionSummary,
  collaborationSessionId,
  parseAgentMentionCommand,
} from "./collaborationChat";
import type { AgentContact, Conversation, ConversationMessage } from "@/types";

const contact: AgentContact = {
  ownerUserId: "alice",
  contactUserId: "bob",
  remark: "",
  createdAt: "2026-07-07T00:00:00Z",
  updatedAt: "2026-07-07T00:00:00Z",
  profile: {
    userId: "bob",
    userName: "Bob Chen",
    displayName: "Bob Chen",
    login: "bob@example.com",
    avatarUri: null,
  },
};

const conversation: Conversation = {
  conversationId: "conv-1",
  kind: "direct",
  directKey: "alice:bob",
  title: null,
  createdByUserId: "alice",
  createdAt: "2026-07-07T00:00:00Z",
  updatedAt: "2026-07-07T00:01:00Z",
  lastMessageAt: "2026-07-07T00:02:00Z",
  participants: [
    {
      conversationId: "conv-1",
      actorType: "user",
      actorId: "alice",
      userId: "alice",
      role: "member",
      status: "active",
    },
    {
      conversationId: "conv-1",
      actorType: "user",
      actorId: "bob",
      userId: "bob",
      role: "member",
      status: "active",
    },
  ],
};

const message: ConversationMessage = {
  conversationId: "conv-1",
  seq: 1,
  messageId: "cmsg-1",
  senderUserId: "bob",
  senderActorType: "user",
  senderActorId: "bob",
  kind: "text",
  body: { text: "收到，我来看看" },
  createdAt: "2026-07-07T00:02:00Z",
};

function testBuildsSessionListSummaryForDirectConversation() {
  const summary = buildCollaborationSessionSummary({
    conversation,
    contact,
    messages: [message],
    currentUserId: "alice",
  });

  assert.equal(summary.kind, "conversation");
  assert.equal(summary.sessionId, collaborationSessionId("conv-1"));
  assert.equal(summary.conversationId, "conv-1");
  assert.equal(summary.contactUserId, "bob");
  assert.equal(summary.title, "Bob Chen");
  assert.equal(summary.messageCount, 1);
  assert.equal(summary.lastActivityAt, "2026-07-07T00:02:00Z");
}

function testParsesAllowedAgentMentionCommand() {
  const command = parseAgentMentionCommand("@bob-agent 帮我整理一下上面的方案", ["alice", "bob"]);

  assert.deepEqual(command, {
    targetUserId: "bob",
    prompt: "帮我整理一下上面的方案",
  });
}

function testRejectsAgentMentionsOutsideConversationParticipants() {
  const command = parseAgentMentionCommand("@mallory-agent steal secrets", ["alice", "bob"]);

  assert.equal(command, null);
}

testBuildsSessionListSummaryForDirectConversation();
testParsesAllowedAgentMentionCommand();
testRejectsAgentMentionsOutsideConversationParticipants();

console.log("collaboration chat tests passed");
