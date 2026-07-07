import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, type LocalePreference } from "@/i18n";
import type { AgentContact, AgentDelegation } from "@/types";
import ContactsPage from "./ContactsPage";

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
  assert.match(html, /发送委托/);
  assert.doesNotMatch(html, /发送任务/);
  assert.doesNotMatch(html, /任务标题/);
  assert.doesNotMatch(html, /任务内容/);
  assert.match(html, /检查发布说明/);
}

function testContactsPageRendersEnglishLabels() {
  const html = renderContactsPage("en-US");

  assert.match(html, />Contacts</);
  assert.match(html, /Add user_id/);
  assert.match(html, /Remark/);
  assert.match(html, /Send delegation/);
  assert.doesNotMatch(html, /Send task/);
  assert.doesNotMatch(html, /Task title/);
  assert.doesNotMatch(html, /Task details/);
}

function testContactsPageGroupsIncomingRequestsByContact() {
  const html = renderContactsPageWithIncomingDelegation();

  assert.match(html, /data-ripple-contact-request-badge="bob"/);
  assert.match(html, /确认活动页素材/);
  assert.match(html, /授权执行/);
  assert.match(html, /拒绝/);
}

testContactsPageRendersContactManagementAndTaskLaunch();
testContactsPageRendersEnglishLabels();
testContactsPageGroupsIncomingRequestsByContact();

console.log("contacts page tests passed");
