import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, type LocalePreference } from "@/i18n";
import type { AgentContact, AgentDelegation, Conversation, ConversationMessage } from "@/types";
import ContactsPage from "./ContactsPage";

const contactsPageSource = readFileSync(new URL("./ContactsPage.tsx", import.meta.url), "utf8");

const contact: AgentContact = {
  ownerUserId: "alice",
  contactUserId: "bob",
  remark: "发布负责人",
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

const delegation: AgentDelegation = {
  delegationId: "dlg-1",
  requesterUserId: "alice",
  requesterSessionId: "sess-a",
  targetUserId: "bob",
  targetSessionId: null,
  targetJobId: null,
  status: "pending_acceptance",
  taskTitle: "检查发布说明",
  taskPrompt: "帮我检查发布说明是否清楚。",
  createdAt: "2026-07-06T01:10:00Z",
  updatedAt: "2026-07-06T01:11:00Z",
  acceptedAt: null,
  completedAt: null,
  pendingClarification: null,
  lastAnswerEvent: null,
  reason: null,
  error: null,
};

const incomingDelegation: AgentDelegation = {
  ...delegation,
  delegationId: "dlg-incoming",
  requesterUserId: "bob",
  requesterSessionId: "sess-bob",
  targetUserId: "alice",
  taskTitle: "确认活动页素材",
  taskPrompt: "请帮我确认活动页素材能不能发布。",
};

function noop() {}
async function noopAsync() {}

const completedDelegation: AgentDelegation = {
  ...delegation,
  status: "completed",
  completedAt: "2026-07-06T01:20:00Z",
  resultText: "最终产物：发布说明可以发布，但建议补一段兼容性说明。",
  resultStatus: "completed",
  resultUpdatedAt: "2026-07-06T01:20:00Z",
  resultJobId: "job-b",
  resultOutputAvailable: true,
};

const contactWithAvatar: AgentContact = {
  ...contact,
  profile: {
    ...contact.profile,
    avatarUri: "https://cdn.example.com/bob.png",
  },
};

const conversation: Conversation = {
  conversationId: "conv-1",
  kind: "direct",
  directKey: "alice:bob",
  title: null,
  createdByUserId: "alice",
  createdAt: "2026-07-07T01:00:00Z",
  updatedAt: "2026-07-07T01:02:00Z",
  lastMessageAt: "2026-07-07T01:02:00Z",
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

const conversationMessages: ConversationMessage[] = [
  {
    conversationId: "conv-1",
    seq: 1,
    messageId: "cmsg-1",
    senderUserId: "alice",
    senderActorType: "user",
    senderActorId: "alice",
    kind: "text",
    body: { text: "我们要把这个方案整理成文档" },
    createdAt: "2026-07-07T01:01:00Z",
  },
  {
    conversationId: "conv-1",
    seq: 2,
    messageId: "cmsg-2",
    senderUserId: "alice",
    senderActorType: "user",
    senderActorId: "alice",
    kind: "agent_invocation",
    body: {
      text: "@bob-agent 帮我们整理上面的方案",
      invocation: {
        invocationId: "ainv-1",
        conversationId: "conv-1",
        requestMessageId: "cmsg-2",
        requesterUserId: "alice",
        targetUserId: "bob",
        targetAgentId: "bob-agent",
        status: "pending_approval",
        prompt: "@bob-agent 帮我们整理上面的方案",
        requiresTargetApproval: true,
        contextSnapshot: { conversationId: "conv-1", messages: [] },
        createdAt: "2026-07-07T01:02:00Z",
        updatedAt: "2026-07-07T01:02:00Z",
      },
    },
    createdAt: "2026-07-07T01:02:00Z",
  },
  {
    conversationId: "conv-1",
    seq: 3,
    messageId: "cmsg-3",
    senderUserId: "bob",
    senderActorType: "agent",
    senderActorId: "bob-agent",
    kind: "agent_invocation_event",
    body: {
      eventType: "completed",
      text: "整理完成：方案分为对话、授权和执行三层。",
      invocation: {
        invocationId: "ainv-1",
        conversationId: "conv-1",
        requestMessageId: "cmsg-2",
        requesterUserId: "alice",
        targetUserId: "bob",
        targetAgentId: "bob-agent",
        status: "completed",
        prompt: "@bob-agent 帮我们整理上面的方案",
        requiresTargetApproval: true,
        contextSnapshot: { conversationId: "conv-1", messages: [] },
        createdAt: "2026-07-07T01:02:00Z",
        updatedAt: "2026-07-07T01:05:00Z",
        completedAt: "2026-07-07T01:05:00Z",
        resultText: "整理完成：方案分为对话、授权和执行三层。",
      },
    },
    createdAt: "2026-07-07T01:05:00Z",
  },
];

function renderContactsPage(locale: LocalePreference = "zh-CN") {
  return renderToStaticMarkup(
    <I18nProvider initialPreference={locale}>
      <ContactsPage
        userId="alice"
        contacts={[contact]}
        sentDelegations={[delegation]}
        receivedDelegations={[]}
        pendingActionKey={null}
        onAddContact={noopAsync}
        onUpdateContact={noopAsync}
        onRemoveContact={noopAsync}
        onCreateDelegation={noopAsync}
        conversationByContactUserId={{ bob: conversation }}
        conversationMessagesById={{ "conv-1": conversationMessages }}
        onEnsureDirectConversation={noopAsync}
        onSendConversationMessage={noopAsync}
        onCreateAgentInvocation={noopAsync}
        onOpenSession={noop}
        onRefresh={noop}
      />
    </I18nProvider>
  );
}

function renderContactsPageWithAvatar(locale: LocalePreference = "zh-CN") {
  return renderToStaticMarkup(
    <I18nProvider initialPreference={locale}>
      <ContactsPage
        userId="alice"
        contacts={[contactWithAvatar]}
        sentDelegations={[delegation]}
        receivedDelegations={[]}
        pendingActionKey={null}
        onAddContact={noopAsync}
        onUpdateContact={noopAsync}
        onRemoveContact={noopAsync}
        onCreateDelegation={noopAsync}
        onOpenSession={noop}
        onRefresh={noop}
      />
    </I18nProvider>
  );
}

function renderContactsPageWithIncomingDelegation(locale: LocalePreference = "zh-CN") {
  return renderToStaticMarkup(
    <I18nProvider initialPreference={locale}>
      <ContactsPage
        userId="alice"
        contacts={[contact]}
        sentDelegations={[delegation]}
        receivedDelegations={[incomingDelegation]}
        pendingActionKey={null}
        onAddContact={noopAsync}
        onUpdateContact={noopAsync}
        onRemoveContact={noopAsync}
        onCreateDelegation={noopAsync}
        onAcceptDelegation={noopAsync}
        onRejectDelegation={noopAsync}
        onOpenSession={noop}
        onRefresh={noop}
      />
    </I18nProvider>
  );
}

function renderContactsPageWithCompletedResult(locale: LocalePreference = "zh-CN") {
  return renderToStaticMarkup(
    <I18nProvider initialPreference={locale}>
      <ContactsPage
        userId="alice"
        contacts={[contact]}
        sentDelegations={[completedDelegation]}
        receivedDelegations={[]}
        pendingActionKey={null}
        onAddContact={noopAsync}
        onUpdateContact={noopAsync}
        onRemoveContact={noopAsync}
        onCreateDelegation={noopAsync}
        onOpenSession={noop}
        onRefresh={noop}
      />
    </I18nProvider>
  );
}

function testContactsPageRendersContactManagementAndTaskLaunch() {
  const html = renderContactsPage();

  assert.match(html, /data-ripple-contacts-page="true"/);
  assert.match(html, />联系人</);
  assert.match(html, /添加 user_id/);
  assert.match(html, /备注/);
  assert.match(html, /发布负责人/);
  assert.match(html, /Bob/);
  assert.match(html, /bob@example.com/);
  assert.match(html, /data-ripple-contact-row="bob"/);
  const rowHtml =
    html.match(/data-ripple-contact-row="bob"[\s\S]*?data-ripple-contact-row-end="bob"/)?.[0] || "";
  assert.match(rowHtml, /Bob/);
  assert.match(rowHtml, /@bob/);
  assert.match(rowHtml, /发布负责人/);
  assert.doesNotMatch(rowHtml, /请求 Agent/);
  assert.doesNotMatch(rowHtml, /移除联系人/);
  assert.match(html, /协作对话/);
  assert.match(html, /我们要把这个方案整理成文档/);
  assert.match(html, /@bob-agent/);
  assert.match(html, /@alice-agent/);
  assert.match(html, /等待 Bob 授权/);
  assert.match(html, /Agent 已完成/);
  assert.match(html, /整理完成：方案分为对话、授权和执行三层。/);
  assert.match(html, /请求 Agent/);
  assert.doesNotMatch(html, /发送委托/);
  assert.doesNotMatch(html, /发送任务/);
  assert.doesNotMatch(html, /任务标题/);
  assert.doesNotMatch(html, /任务内容/);
  assert.match(html, /检查发布说明/);
  assert.doesNotMatch(html, /最近委托/);
  assert.match(html, /data-ripple-edit-remark-button="bob"/);
  assert.doesNotMatch(html, /placeholder="例如 发布负责人"/);
}

function testContactsPageRendersEnglishLabels() {
  const html = renderContactsPage("en-US");

  assert.match(html, />Contacts</);
  assert.match(html, /Add user_id/);
  assert.match(html, /Edit remark/);
  assert.match(html, /Request Agent/);
  assert.doesNotMatch(html, /Send delegation/);
  assert.doesNotMatch(html, /Send task/);
  assert.doesNotMatch(html, /Task title/);
  assert.doesNotMatch(html, /Task details/);
  assert.doesNotMatch(html, /Recent delegations/);
}

function testContactsPageKeepsRemarkInContactSummary() {
  const html = renderContactsPage();
  const summaryRemarkHtml =
    html.match(
      /data-ripple-contact-summary-remark="bob"[\s\S]*?data-ripple-contact-summary-remark-end="bob"/
    )?.[0] || "";

  assert.match(summaryRemarkHtml, /发布负责人/);
  assert.match(summaryRemarkHtml, /data-ripple-edit-remark-button="bob"/);
  assert.doesNotMatch(contactsPageSource, /t\("contacts\.remark"\)/);
}

function testContactsPageCreatesDelegationsFromPromptOnly() {
  assert.doesNotMatch(contactsPageSource, /const \[taskTitle/);
  assert.doesNotMatch(contactsPageSource, /contacts\.taskTitle/);
  assert.doesNotMatch(contactsPageSource, /contacts\.taskTitlePlaceholder/);
  assert.match(contactsPageSource, /deriveDelegationTitle/);
  assert.match(contactsPageSource, /onOpenSession\?\.\(item\.sessionId\)/);
}

function testContactsPageRendersAvatarWhenAvailable() {
  const html = renderContactsPageWithAvatar();

  assert.match(html, /src="https:\/\/cdn\.example\.com\/bob\.png"/);
}

function testContactsPageGroupsIncomingRequestsByContact() {
  const html = renderContactsPageWithIncomingDelegation();

  assert.match(html, /data-ripple-contact-request-badge="bob"/);
  assert.match(html, /确认活动页素材/);
  assert.match(html, /授权执行/);
  assert.match(html, /拒绝/);
}

function testContactsPageShowsCompletedDelegationResult() {
  const html = renderContactsPageWithCompletedResult();

  assert.match(html, /Agent 结果/);
  assert.doesNotMatch(html, /委托产物/);
  assert.match(html, /发布说明可以发布/);
  assert.doesNotMatch(html, /只显示状态/);
}

function testContactsPageShowsCollapsibleSessionHistory() {
  const html = renderContactsPageWithCompletedResult();

  assert.match(html, /data-ripple-contact-history="bob"/);
  assert.match(html, /data-ripple-contact-history-session="sess-a"/);
  assert.match(html, /检查发布说明/);
  assert.match(html, /打开会话/);
}

function testContactsPageGuardsDirectConversationBootstrap() {
  assert.match(contactsPageSource, /ensuredConversationContactIdRef/);
  assert.match(contactsPageSource, /selectedExistingContactId/);
  assert.doesNotMatch(
    contactsPageSource,
    /void onEnsureDirectConversation\?\.\(selectedExistingContact\.contactUserId\);\n\s*}, \[onEnsureDirectConversation, selectedExistingContact\]\);/
  );
}

testContactsPageRendersContactManagementAndTaskLaunch();
testContactsPageRendersEnglishLabels();
testContactsPageKeepsRemarkInContactSummary();
testContactsPageCreatesDelegationsFromPromptOnly();
testContactsPageRendersAvatarWhenAvailable();
testContactsPageGroupsIncomingRequestsByContact();
testContactsPageShowsCompletedDelegationResult();
testContactsPageShowsCollapsibleSessionHistory();
testContactsPageGuardsDirectConversationBootstrap();

console.log("contacts page tests passed");
