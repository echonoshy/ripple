"use client";

import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  Clock3,
  Loader2,
  Pencil,
  RefreshCw,
  Save,
  Send,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { type MessageKey, useI18n } from "@/i18n";
import type { AgentContact, AgentContactRequest, AgentDelegation } from "@/types";
import MobilePageHeader from "./MobilePageHeader";
import {
  LUCIDE_STANDARD_STROKE_WIDTH,
  MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS,
  MOBILE_PAGE_TOP_SAFE_AREA_CLASS,
  TYPOGRAPHY_BODY_CLASS,
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_META_MEDIUM_CLASS,
  TYPOGRAPHY_PAGE_TITLE_CLASS,
  TYPOGRAPHY_SECTION_TITLE_CLASS,
  WORKBENCH_DANGER_BUTTON_CLASS,
  WORKBENCH_FIELD_CLASS,
  WORKBENCH_ICON_BUTTON_CLASS,
  WORKBENCH_PAGE_BACKGROUND_CLASS,
  WORKBENCH_PAGE_CONTENT_CLASS,
  WORKBENCH_PRIMARY_BUTTON_CLASS,
  WORKBENCH_SECTION_CLASS,
  WORKBENCH_SECONDARY_BUTTON_CLASS,
  WORKBENCH_STATUS_DANGER_CLASS,
  WORKBENCH_STATUS_NEUTRAL_CLASS,
  WORKBENCH_STATUS_SUCCESS_CLASS,
  WORKBENCH_STATUS_WARNING_CLASS,
} from "./stylePrimitives";

export interface ContactDelegationCreateInput {
  targetUserId: string;
  taskTitle: string;
  taskPrompt: string;
}

interface ContactsPageProps {
  userId: string;
  contacts: AgentContact[];
  sentContactRequests?: AgentContactRequest[];
  receivedContactRequests?: AgentContactRequest[];
  sentDelegations: AgentDelegation[];
  receivedDelegations: AgentDelegation[];
  pendingActionKey?: string | null;
  onAddContact: (contactUserId: string) => Promise<void> | void;
  onUpdateContact: (contactUserId: string, input: { remark: string }) => Promise<void> | void;
  onRemoveContact: (contactUserId: string) => Promise<void> | void;
  onCreateDelegation: (input: ContactDelegationCreateInput) => Promise<void> | void;
  onAcceptContactRequest?: (requestId: string) => Promise<void> | void;
  onRejectContactRequest?: (requestId: string) => Promise<void> | void;
  onAcceptDelegation?: (delegationId: string) => Promise<void> | void;
  onRejectDelegation?: (delegationId: string) => Promise<void> | void;
  onRefresh?: () => Promise<unknown> | unknown;
}

function contactDisplayName(contact: AgentContact): string {
  return contact.profile.userName || contact.profile.displayName || contact.contactUserId;
}

function contactPrimaryName(contact: AgentContact): string {
  return contact.remark || contactDisplayName(contact);
}

function contactSecondaryText(contact: AgentContact): string {
  const parts = [`@${contact.contactUserId}`];
  const displayName = contactDisplayName(contact);
  if (displayName && displayName !== contact.contactUserId && displayName !== contact.remark) {
    parts.push(displayName);
  }
  if (contact.profile.login) {
    parts.push(contact.profile.login);
  }
  return parts.join(" · ");
}

function syntheticContact(userId: string, profile?: AgentContactRequest["requesterProfile"]): AgentContact {
  return {
    ownerUserId: "",
    contactUserId: userId,
    remark: "",
    createdAt: "",
    updatedAt: "",
    profile: {
      userId,
      userName: profile?.userName || profile?.displayName || profile?.login || userId,
      displayName: profile?.displayName ?? null,
      login: profile?.login ?? null,
      avatarUri: profile?.avatarUri ?? null,
    },
  };
}

function delegationStatusLabel(status: string, t: ReturnType<typeof useI18n>["t"]): string {
  const labels: Record<string, MessageKey> = {
    pending_acceptance: "contacts.status.pendingAcceptance",
    running: "contacts.status.running",
    awaiting_target_permission: "contacts.status.awaitingTargetPermission",
    awaiting_requester_info: "contacts.status.awaitingRequesterInfo",
    completed: "contacts.status.completed",
    failed: "contacts.status.failed",
    cancelled: "contacts.status.cancelled",
    rejected: "contacts.status.rejected",
  };
  return t(labels[status] || "contacts.status.unknown");
}

function delegationStatusClass(status: string): string {
  if (status === "completed") return WORKBENCH_STATUS_SUCCESS_CLASS;
  if (status === "failed" || status === "cancelled" || status === "rejected") {
    return WORKBENCH_STATUS_DANGER_CLASS;
  }
  if (
    status === "pending_acceptance" ||
    status === "awaiting_target_permission" ||
    status === "awaiting_requester_info"
  ) {
    return WORKBENCH_STATUS_WARNING_CLASS;
  }
  return WORKBENCH_STATUS_NEUTRAL_CLASS;
}

function formatDelegationTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ContactsPage({
  userId,
  contacts,
  sentContactRequests = [],
  receivedContactRequests = [],
  sentDelegations,
  receivedDelegations,
  pendingActionKey = null,
  onAddContact,
  onUpdateContact,
  onRemoveContact,
  onCreateDelegation,
  onAcceptContactRequest,
  onRejectContactRequest,
  onAcceptDelegation,
  onRejectDelegation,
  onRefresh,
}: ContactsPageProps) {
  const { t } = useI18n();
  const [selectedContactId, setSelectedContactId] = useState("");
  const [newContactUserId, setNewContactUserId] = useState("");
  const [remarkDraftState, setRemarkDraftState] = useState<{
    contactUserId: string;
    value: string;
  } | null>(null);
  const [taskDialogContactId, setTaskDialogContactId] = useState<string | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskPrompt, setTaskPrompt] = useState("");

  const pendingIncomingDelegations = useMemo(
    () => receivedDelegations.filter((delegation) => delegation.status === "pending_acceptance"),
    [receivedDelegations]
  );
  const pendingIncomingContactRequests = useMemo(
    () => receivedContactRequests.filter((request) => request.status === "pending"),
    [receivedContactRequests]
  );
  const pendingSentContactRequests = useMemo(
    () => sentContactRequests.filter((request) => request.status === "pending"),
    [sentContactRequests]
  );
  const contactRows = useMemo(() => {
    const rows = [...contacts];
    const existingIds = new Set(rows.map((contact) => contact.contactUserId));
    for (const request of pendingIncomingContactRequests) {
      if (existingIds.has(request.requesterUserId)) continue;
      rows.push(syntheticContact(request.requesterUserId, request.requesterProfile));
      existingIds.add(request.requesterUserId);
    }
    for (const request of pendingSentContactRequests) {
      if (existingIds.has(request.targetUserId)) continue;
      rows.push(syntheticContact(request.targetUserId, request.targetProfile));
      existingIds.add(request.targetUserId);
    }
    for (const delegation of pendingIncomingDelegations) {
      if (existingIds.has(delegation.requesterUserId)) continue;
      rows.push(syntheticContact(delegation.requesterUserId));
      existingIds.add(delegation.requesterUserId);
    }
    return rows;
  }, [
    contacts,
    pendingIncomingContactRequests,
    pendingIncomingDelegations,
    pendingSentContactRequests,
  ]);
  const contactIds = useMemo(
    () => new Set(contactRows.map((contact) => contact.contactUserId)),
    [contactRows]
  );
  const incomingDelegationsByRequesterId = useMemo(() => {
    const groups = new Map<string, AgentDelegation[]>();
    for (const delegation of pendingIncomingDelegations) {
      const group = groups.get(delegation.requesterUserId) || [];
      group.push(delegation);
      groups.set(delegation.requesterUserId, group);
    }
    return groups;
  }, [pendingIncomingDelegations]);
  const incomingContactRequestsByRequesterId = useMemo(() => {
    const groups = new Map<string, AgentContactRequest[]>();
    for (const request of pendingIncomingContactRequests) {
      const group = groups.get(request.requesterUserId) || [];
      group.push(request);
      groups.set(request.requesterUserId, group);
    }
    return groups;
  }, [pendingIncomingContactRequests]);
  const sentContactRequestsByTargetId = useMemo(() => {
    const groups = new Map<string, AgentContactRequest[]>();
    for (const request of pendingSentContactRequests) {
      const group = groups.get(request.targetUserId) || [];
      group.push(request);
      groups.set(request.targetUserId, group);
    }
    return groups;
  }, [pendingSentContactRequests]);
  const visibleDelegations = useMemo(
    () =>
      sentDelegations
        .filter((delegation) => contactIds.size === 0 || contactIds.has(delegation.targetUserId))
        .slice(0, 8),
    [contactIds, sentDelegations]
  );
  const incomingCount = pendingIncomingDelegations.length;
  const pendingRequestCount = incomingCount + pendingIncomingContactRequests.length;
  const effectiveSelectedContactId = contactRows.some(
    (contact) => contact.contactUserId === selectedContactId
  )
    ? selectedContactId
    : contactRows[0]?.contactUserId || "";
  const selectedContact =
    contactRows.find((contact) => contact.contactUserId === effectiveSelectedContactId) || null;
  const selectedExistingContact =
    contacts.find((contact) => contact.contactUserId === effectiveSelectedContactId) || null;
  const taskDialogContact =
    contacts.find((contact) => contact.contactUserId === taskDialogContactId) || null;
  const selectedIncomingDelegations =
    incomingDelegationsByRequesterId.get(effectiveSelectedContactId) || [];
  const selectedIncomingContactRequests =
    incomingContactRequestsByRequesterId.get(effectiveSelectedContactId) || [];
  const selectedSentContactRequests =
    sentContactRequestsByTargetId.get(effectiveSelectedContactId) || [];
  const remarkDraft =
    selectedExistingContact && remarkDraftState?.contactUserId === selectedExistingContact.contactUserId
      ? remarkDraftState.value
      : selectedExistingContact?.remark || "";
  const isAddingContact = Boolean(pendingActionKey && pendingActionKey.startsWith("contact:"));
  const isCreatingTask = pendingActionKey === "create";
  const isSavingRemark =
    selectedExistingContact &&
    pendingActionKey === `update-contact:${selectedExistingContact.contactUserId}`;
  const canAddContact = Boolean(newContactUserId.trim()) && !isAddingContact;
  const canSaveRemark = Boolean(
    selectedExistingContact &&
      remarkDraft.trim() !== selectedExistingContact.remark &&
      !isSavingRemark
  );
  const canSubmitTask =
    Boolean(taskDialogContact && taskTitle.trim() && taskPrompt.trim()) && !isCreatingTask;

  return (
    <div
      data-ripple-contacts-page="true"
      className={`flex h-full min-h-0 flex-col overflow-hidden ${WORKBENCH_PAGE_BACKGROUND_CLASS} px-3 ${MOBILE_PAGE_TOP_SAFE_AREA_CLASS} ${MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS} text-[#1F2329] md:px-6 lg:pb-5`}
    >
      <MobilePageHeader
        title={t("contacts.title")}
        subtitle={t("contacts.subtitle")}
        actions={
          <button
            type="button"
            aria-label={t("contacts.refresh")}
            title={t("contacts.refresh")}
            onClick={() => onRefresh?.()}
            className={WORKBENCH_ICON_BUTTON_CLASS}
          >
            <RefreshCw size={16} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
          </button>
        }
      />

      <div className={`${WORKBENCH_PAGE_CONTENT_CLASS} flex min-h-0 flex-1 flex-col py-4 lg:py-5`}>
        <header className="mb-4 hidden items-center justify-between gap-4 lg:flex">
          <div className="min-w-0">
            <h1 className={`${TYPOGRAPHY_PAGE_TITLE_CLASS} text-[#1F2329]`}>
              {t("contacts.title")}
            </h1>
            <p className={`${TYPOGRAPHY_BODY_CLASS} mt-1 text-[#646A73]`}>
              {t("contacts.subtitle")} · {t("contacts.currentUser", { userId })}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onRefresh?.()}
            className={`h-9 ${WORKBENCH_SECONDARY_BUTTON_CLASS} ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
          >
            <RefreshCw size={14} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
            {t("contacts.refresh")}
          </button>
        </header>

        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
          <section className={`${WORKBENCH_SECTION_CLASS} flex min-h-0 flex-col overflow-hidden`}>
            <div className="border-b border-[#EFF0F1] px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 className={`${TYPOGRAPHY_SECTION_TITLE_CLASS} text-[#1F2329]`}>
                    {t("contacts.title")}
                  </h2>
                  <p className={`${TYPOGRAPHY_META_CLASS} mt-0.5 text-[#646A73]`}>
                    {t("contacts.contactCount", { count: contacts.length })}
                  </p>
                </div>
                <span
                  className={`inline-flex items-center gap-1 ${TYPOGRAPHY_META_MEDIUM_CLASS} ${WORKBENCH_STATUS_NEUTRAL_CLASS}`}
                >
                  <Users size={13} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
                  {contacts.length}
                </span>
              </div>

              <form
                className="mt-3 flex gap-2"
                onSubmit={async (event) => {
                  event.preventDefault();
                  const nextContactUserId = newContactUserId.trim();
                  if (!nextContactUserId || isAddingContact) return;
                  await onAddContact(nextContactUserId);
                  setNewContactUserId("");
                  setSelectedContactId(nextContactUserId);
                }}
              >
                <input
                  value={newContactUserId}
                  onChange={(event) => setNewContactUserId(event.target.value)}
                  placeholder={t("contacts.addUserIdPlaceholder")}
                  aria-label={t("contacts.addUserId")}
                  className={`h-9 min-w-0 flex-1 px-3 ${WORKBENCH_FIELD_CLASS} ${TYPOGRAPHY_BODY_CLASS}`}
                />
                <button
                  type="submit"
                  disabled={!canAddContact}
                  className={`h-9 shrink-0 ${WORKBENCH_SECONDARY_BUTTON_CLASS} ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                >
                  {isAddingContact ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <UserPlus size={14} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
                  )}
                  {t("contacts.add")}
                </button>
              </form>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {contactRows.length === 0 ? (
                <div
                  className={`flex items-start gap-2 rounded-lg border border-dashed border-[#DEE0E3] bg-[#F8F9FA] px-3 py-4 ${TYPOGRAPHY_BODY_CLASS} text-[#646A73]`}
                >
                  <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[#8F959E]" />
                  {t("contacts.noContacts")}
                </div>
              ) : (
                <div className="grid gap-2">
                  {contactRows.map((contact) => {
                    const selected = contact.contactUserId === effectiveSelectedContactId;
                    const removing = pendingActionKey === `remove-contact:${contact.contactUserId}`;
                    const contactIncomingDelegations =
                      incomingDelegationsByRequesterId.get(contact.contactUserId) || [];
                    const contactIncomingContactRequests =
                      incomingContactRequestsByRequesterId.get(contact.contactUserId) || [];
                    const contactRequestCount =
                      contactIncomingDelegations.length + contactIncomingContactRequests.length;
                    const isExistingContact = contacts.some(
                      (existingContact) => existingContact.contactUserId === contact.contactUserId
                    );
                    return (
                      <div
                        key={contact.contactUserId}
                        className={`group flex min-h-14 items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors ${
                          selected
                            ? "border-[#1456F0] bg-[#F0F5FF]"
                            : "border-[#DEE0E3] bg-white hover:bg-[#F8F9FA]"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedContactId(contact.contactUserId)}
                          className="grid min-w-0 flex-1 grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-2 text-left"
                        >
                          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-[#1456F0]">
                            <Bot size={15} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
                          </span>
                          <span className="min-w-0">
                            <span
                              className={`block truncate ${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}
                            >
                              {contactPrimaryName(contact)}
                            </span>
                            <span
                              className={`block truncate ${TYPOGRAPHY_META_CLASS} text-[#646A73]`}
                            >
                              {contactSecondaryText(contact)}
                            </span>
                          </span>
                          {contactRequestCount > 0 ? (
                            <span
                              data-ripple-contact-request-badge={contact.contactUserId}
                              className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[#F53F3F] px-1.5 text-[11px] leading-5 font-medium text-white"
                            >
                              {contactRequestCount}
                            </span>
                          ) : selected ? (
                            <Check
                              size={15}
                              className="shrink-0 text-[#1456F0]"
                              strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH}
                            />
                          ) : null}
                        </button>
                        {isExistingContact ? (
                          <>
                            <button
                              type="button"
                              aria-label={`${t("contacts.sendTask")} ${contact.contactUserId}`}
                              title={t("contacts.sendTask")}
                              disabled={Boolean(pendingActionKey)}
                              onClick={() => {
                                setSelectedContactId(contact.contactUserId);
                                setTaskTitle("");
                                setTaskPrompt("");
                                setTaskDialogContactId(contact.contactUserId);
                              }}
                              className={`${WORKBENCH_SECONDARY_BUTTON_CLASS} h-8 shrink-0 !px-2`}
                            >
                              <Send size={13} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
                              <span className="hidden sm:inline">{t("contacts.sendTask")}</span>
                            </button>
                            <button
                              type="button"
                              aria-label={`${t("contacts.removeContact")} ${contact.contactUserId}`}
                              title={t("contacts.removeContact")}
                              disabled={Boolean(pendingActionKey)}
                              onClick={() => onRemoveContact(contact.contactUserId)}
                              className={`${WORKBENCH_DANGER_BUTTON_CLASS} h-8 w-8 shrink-0 !px-0`}
                            >
                              {removing ? (
                                <Loader2 size={13} className="animate-spin" />
                              ) : (
                                <Trash2 size={13} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
                              )}
                            </button>
                          </>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          <div className="grid min-h-0 content-start gap-4">
            <section className={`${WORKBENCH_SECTION_CLASS} overflow-hidden`}>
              <div className="border-b border-[#EFF0F1] px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className={`${TYPOGRAPHY_SECTION_TITLE_CLASS} text-[#1F2329]`}>
                      {t("contacts.contactDetails")}
                    </h2>
                    <p className={`${TYPOGRAPHY_META_CLASS} mt-0.5 text-[#646A73]`}>
                      {selectedContact
                        ? t("contacts.startTaskFor", {
                            userId: selectedContact.contactUserId,
                          })
                        : t("contacts.chooseContactFirst")}
                    </p>
                  </div>
                  <span
                    className={`inline-flex shrink-0 items-center gap-1 ${TYPOGRAPHY_META_MEDIUM_CLASS} ${WORKBENCH_STATUS_NEUTRAL_CLASS}`}
                  >
                    <Clock3 size={13} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
                    {pendingRequestCount}
                  </span>
                </div>
              </div>
              {selectedContact ? (
                <div className="grid gap-4 px-4 py-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#F0F5FF] text-[#1456F0]">
                      <Bot size={18} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
                    </span>
                    <div className="min-w-0">
                      <div className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} truncate text-[#1F2329]`}>
                        {contactPrimaryName(selectedContact)}
                      </div>
                      <div className={`${TYPOGRAPHY_META_CLASS} mt-0.5 truncate text-[#646A73]`}>
                        {contactSecondaryText(selectedContact)}
                      </div>
                    </div>
                  </div>

                  {(selectedIncomingContactRequests.length > 0 ||
                    selectedSentContactRequests.length > 0) && (
                    <section className="grid gap-2 rounded-lg border border-[#EFF0F1] bg-[#F8F9FA] p-3">
                      <h3 className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}>
                        {t("contacts.contactRequests")}
                      </h3>
                      {selectedIncomingContactRequests.map((request) => {
                        const accepting =
                          pendingActionKey === `accept-contact-request:${request.requestId}`;
                        const rejecting =
                          pendingActionKey === `reject-contact-request:${request.requestId}`;
                        return (
                          <article
                            key={request.requestId}
                            className="rounded-lg border border-[#DEE0E3] bg-white px-3 py-2.5"
                          >
                            <div className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}>
                              @{request.requesterUserId}
                            </div>
                            {request.message ? (
                              <div className={`${TYPOGRAPHY_META_CLASS} mt-1 text-[#2B2F36]`}>
                                {t("contacts.contactRequestMessage")}：{request.message}
                              </div>
                            ) : null}
                            <div className="mt-2 flex justify-end gap-2">
                              <button
                                type="button"
                                disabled={Boolean(pendingActionKey)}
                                onClick={() => onRejectContactRequest?.(request.requestId)}
                                className={`h-8 ${WORKBENCH_DANGER_BUTTON_CLASS} ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                              >
                                {rejecting ? (
                                  <Loader2 size={13} className="animate-spin" />
                                ) : (
                                  <X size={13} />
                                )}
                                {t("contacts.rejectContactRequest")}
                              </button>
                              <button
                                type="button"
                                disabled={Boolean(pendingActionKey)}
                                onClick={() => onAcceptContactRequest?.(request.requestId)}
                                className={`h-8 ${WORKBENCH_PRIMARY_BUTTON_CLASS} ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                              >
                                {accepting ? (
                                  <Loader2 size={13} className="animate-spin" />
                                ) : (
                                  <Check size={13} />
                                )}
                                {t("contacts.acceptContactRequest")}
                              </button>
                            </div>
                          </article>
                        );
                      })}
                      {selectedSentContactRequests.map((request) => (
                        <article
                          key={request.requestId}
                          className={`rounded-lg border border-[#FAD355]/45 bg-[#FFF8DB] px-3 py-2.5 ${TYPOGRAPHY_META_CLASS} text-[#8B5E00]`}
                        >
                          {t("contacts.contactRequestPending")}
                        </article>
                      ))}
                    </section>
                  )}

                  {selectedIncomingDelegations.length > 0 ? (
                    <section className="grid gap-2 rounded-lg border border-[#EFF0F1] bg-[#F8F9FA] p-3">
                      <h3 className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}>
                        {t("contacts.incomingRequests")}
                      </h3>
                      {selectedIncomingDelegations.map((delegation) => {
                        const accepting = pendingActionKey === `accept:${delegation.delegationId}`;
                        const rejecting = pendingActionKey === `reject:${delegation.delegationId}`;
                        return (
                          <article
                            key={delegation.delegationId}
                            className="rounded-lg border border-[#DEE0E3] bg-white px-3 py-2.5"
                          >
                            <div className="flex min-w-0 items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div
                                  className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} truncate text-[#1F2329]`}
                                >
                                  {delegation.taskTitle}
                                </div>
                                <div
                                  className={`${TYPOGRAPHY_META_CLASS} mt-0.5 truncate text-[#646A73]`}
                                >
                                  @{delegation.requesterUserId} ·{" "}
                                  {formatDelegationTime(delegation.updatedAt)}
                                </div>
                              </div>
                              <span
                                className={`shrink-0 ${TYPOGRAPHY_META_MEDIUM_CLASS} ${delegationStatusClass(
                                  delegation.status
                                )}`}
                              >
                                {delegationStatusLabel(delegation.status, t)}
                              </span>
                            </div>
                            <div
                              className={`mt-1 line-clamp-2 ${TYPOGRAPHY_META_CLASS} text-[#2B2F36]`}
                            >
                              {delegation.taskPrompt}
                            </div>
                            <div className="mt-2 flex justify-end gap-2">
                              <button
                                type="button"
                                disabled={Boolean(pendingActionKey)}
                                onClick={() => onRejectDelegation?.(delegation.delegationId)}
                                className={`h-8 ${WORKBENCH_DANGER_BUTTON_CLASS} ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                              >
                                {rejecting ? (
                                  <Loader2 size={13} className="animate-spin" />
                                ) : (
                                  <X size={13} />
                                )}
                                {t("contacts.rejectDelegation")}
                              </button>
                              <button
                                type="button"
                                disabled={Boolean(pendingActionKey)}
                                onClick={() => onAcceptDelegation?.(delegation.delegationId)}
                                className={`h-8 ${WORKBENCH_PRIMARY_BUTTON_CLASS} ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                              >
                                {accepting ? (
                                  <Loader2 size={13} className="animate-spin" />
                                ) : (
                                  <Check size={13} />
                                )}
                                {t("contacts.acceptDelegation")}
                              </button>
                            </div>
                          </article>
                        );
                      })}
                    </section>
                  ) : null}

                  {selectedExistingContact ? (
                    <form
                      className="grid gap-2"
                      onSubmit={async (event) => {
                        event.preventDefault();
                        if (!selectedExistingContact || !canSaveRemark) return;
                        await onUpdateContact(selectedExistingContact.contactUserId, {
                          remark: remarkDraft.trim(),
                        });
                      }}
                    >
                      <label className="grid gap-1">
                        <span
                          className={`inline-flex items-center gap-1 ${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#2B2F36]`}
                        >
                          <Pencil size={13} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
                          {t("contacts.remark")}
                        </span>
                        <input
                          value={remarkDraft}
                          onChange={(event) =>
                            setRemarkDraftState(
                              selectedExistingContact
                                ? {
                                    contactUserId: selectedExistingContact.contactUserId,
                                    value: event.target.value,
                                  }
                                : null
                            )
                          }
                          placeholder={t("contacts.remarkPlaceholder")}
                          disabled={Boolean(isSavingRemark)}
                          className={`h-10 px-3 ${WORKBENCH_FIELD_CLASS} ${TYPOGRAPHY_BODY_CLASS}`}
                        />
                      </label>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className={`${TYPOGRAPHY_META_CLASS} text-[#646A73]`}>
                          {selectedExistingContact.remark || t("contacts.emptyRemark")}
                        </span>
                        <button
                          type="submit"
                          disabled={!canSaveRemark}
                          className={`h-9 ${WORKBENCH_SECONDARY_BUTTON_CLASS} ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                        >
                          {isSavingRemark ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <Save size={14} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
                          )}
                          {t("contacts.saveRemark")}
                        </button>
                      </div>
                    </form>
                  ) : null}

                  {selectedExistingContact ? (
                    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#EFF0F1] pt-3">
                      <button
                        type="button"
                        disabled={Boolean(pendingActionKey)}
                        onClick={() => {
                          setTaskTitle("");
                          setTaskPrompt("");
                          setTaskDialogContactId(selectedExistingContact.contactUserId);
                        }}
                        className={`h-10 ${WORKBENCH_PRIMARY_BUTTON_CLASS} ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                      >
                        <Send size={14} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
                        {t("contacts.sendTask")}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div
                  className={`m-4 rounded-lg border border-dashed border-[#DEE0E3] bg-[#F8F9FA] px-3 py-4 ${TYPOGRAPHY_BODY_CLASS} text-[#646A73]`}
                >
                  {t("contacts.chooseContactFirst")}
                </div>
              )}
            </section>

            <section className={`${WORKBENCH_SECTION_CLASS} overflow-hidden`}>
              <div className="border-b border-[#EFF0F1] px-4 py-3">
                <h2 className={`${TYPOGRAPHY_SECTION_TITLE_CLASS} text-[#1F2329]`}>
                  {t("contacts.recentTasks")}
                </h2>
              </div>
              <div className="grid gap-2 p-3">
                {visibleDelegations.length === 0 ? (
                  <div
                    className={`rounded-lg border border-dashed border-[#DEE0E3] bg-[#F8F9FA] px-3 py-4 ${TYPOGRAPHY_BODY_CLASS} text-[#646A73]`}
                  >
                    {t("contacts.noRecentTasks")}
                  </div>
                ) : (
                  visibleDelegations.map((delegation) => (
                    <article
                      key={delegation.delegationId}
                      className="rounded-lg border border-[#DEE0E3] bg-white px-3 py-2.5"
                    >
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div
                            className={`${TYPOGRAPHY_BODY_MEDIUM_CLASS} truncate text-[#1F2329]`}
                          >
                            {delegation.taskTitle}
                          </div>
                          <div
                            className={`${TYPOGRAPHY_META_CLASS} mt-0.5 truncate text-[#646A73]`}
                          >
                            @{delegation.targetUserId} ·{" "}
                            {formatDelegationTime(delegation.updatedAt)}
                          </div>
                        </div>
                        <span
                          className={`shrink-0 ${TYPOGRAPHY_META_MEDIUM_CLASS} ${delegationStatusClass(
                            delegation.status
                          )}`}
                        >
                          {delegationStatusLabel(delegation.status, t)}
                        </span>
                      </div>
                      <div className={`mt-1 line-clamp-2 ${TYPOGRAPHY_META_CLASS} text-[#2B2F36]`}>
                        {delegation.taskPrompt}
                      </div>
                    </article>
                  ))
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
      {taskDialogContact ? (
        <div className="fixed inset-0 z-50 flex items-end bg-[rgba(31,35,41,0.36)] p-0 sm:items-center sm:justify-center sm:p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="contacts-send-task-title"
            className="max-h-[calc(100vh-24px)] w-full overflow-hidden rounded-t-xl border border-[#DEE0E3] bg-white shadow-[0_12px_32px_rgba(31,35,41,0.18)] sm:max-w-xl sm:rounded-xl"
          >
            <div className="flex items-start justify-between gap-3 border-b border-[#EFF0F1] px-4 py-3">
              <div className="min-w-0">
                <h2
                  id="contacts-send-task-title"
                  className={`${TYPOGRAPHY_SECTION_TITLE_CLASS} text-[#1F2329]`}
                >
                  {t("contacts.sendTaskTitle")}
                </h2>
                <p className={`${TYPOGRAPHY_META_CLASS} mt-0.5 text-[#646A73]`}>
                  {t("contacts.startTaskFor", { userId: taskDialogContact.contactUserId })}
                </p>
              </div>
              <button
                type="button"
                aria-label={t("contacts.cancelTask")}
                title={t("contacts.cancelTask")}
                disabled={isCreatingTask}
                onClick={() => setTaskDialogContactId(null)}
                className={WORKBENCH_ICON_BUTTON_CLASS}
              >
                <X size={16} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
              </button>
            </div>
            <form
              className="grid gap-3 px-4 py-4"
              onSubmit={async (event) => {
                event.preventDefault();
                if (!taskDialogContact || !canSubmitTask) return;
                await onCreateDelegation({
                  targetUserId: taskDialogContact.contactUserId,
                  taskTitle: taskTitle.trim(),
                  taskPrompt: taskPrompt.trim(),
                });
                setTaskTitle("");
                setTaskPrompt("");
                setTaskDialogContactId(null);
              }}
            >
              <label className="grid gap-1">
                <span className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#2B2F36]`}>
                  {t("contacts.taskTitle")}
                </span>
                <input
                  value={taskTitle}
                  onChange={(event) => setTaskTitle(event.target.value)}
                  placeholder={t("contacts.taskTitlePlaceholder")}
                  disabled={isCreatingTask}
                  className={`h-10 px-3 ${WORKBENCH_FIELD_CLASS} ${TYPOGRAPHY_BODY_CLASS}`}
                />
              </label>
              <label className="grid gap-1">
                <span className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#2B2F36]`}>
                  {t("contacts.taskDetails")}
                </span>
                <textarea
                  value={taskPrompt}
                  onChange={(event) => setTaskPrompt(event.target.value)}
                  rows={6}
                  placeholder={t("contacts.taskDetailsPlaceholder")}
                  disabled={isCreatingTask}
                  className={`min-h-32 resize-none px-3 py-2 ${WORKBENCH_FIELD_CLASS} ${TYPOGRAPHY_BODY_CLASS}`}
                />
              </label>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={isCreatingTask}
                  onClick={() => setTaskDialogContactId(null)}
                  className={`h-10 ${WORKBENCH_SECONDARY_BUTTON_CLASS} ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                >
                  {t("contacts.cancelTask")}
                </button>
                <button
                  type="submit"
                  disabled={!canSubmitTask}
                  className={`h-10 ${WORKBENCH_PRIMARY_BUTTON_CLASS} ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                >
                  {isCreatingTask ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Send size={14} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
                  )}
                  {t("contacts.submitTask")}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}
