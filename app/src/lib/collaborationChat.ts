import type {
  AgentContact,
  AgentInvocation,
  Conversation,
  ConversationMessage,
  WorkbenchSessionSummary,
} from "@/types";

const COLLABORATION_SESSION_PREFIX = "conversation:";

interface CollaborationSummaryInput {
  conversation: Conversation;
  contact: AgentContact;
  messages: ConversationMessage[];
  currentUserId: string;
}

export interface AgentMentionCommand {
  targetUserId: string;
  prompt: string;
}

export function collaborationSessionId(conversationId: string): string {
  return `${COLLABORATION_SESSION_PREFIX}${conversationId}`;
}

export function conversationIdFromCollaborationSessionId(sessionId: string): string | null {
  if (!sessionId.startsWith(COLLABORATION_SESSION_PREFIX)) return null;
  const conversationId = sessionId.slice(COLLABORATION_SESSION_PREFIX.length).trim();
  return conversationId || null;
}

export function isCollaborationSessionId(sessionId: string | null | undefined): boolean {
  return Boolean(sessionId && conversationIdFromCollaborationSessionId(sessionId));
}

export function buildCollaborationSessionSummary({
  conversation,
  contact,
  messages,
  currentUserId,
}: CollaborationSummaryInput): WorkbenchSessionSummary {
  const lastMessage = messages[messages.length - 1] || null;
  const pendingApprovalCount = messages.filter((message) =>
    isPendingApprovalForCurrentUser(message.body.invocation, currentUserId)
  ).length;
  return {
    kind: "conversation",
    sessionId: collaborationSessionId(conversation.conversationId),
    conversationId: conversation.conversationId,
    contactUserId: contact.contactUserId,
    title: contact.profile.userName || contact.profile.displayName || contact.contactUserId,
    pinned: false,
    status: pendingApprovalCount > 0 ? "waiting_for_approval" : "idle",
    attention: pendingApprovalCount > 0 ? "needs_input" : undefined,
    model: "conversation",
    lastActivityAt:
      lastMessage?.createdAt ||
      conversation.lastMessageAt ||
      conversation.updatedAt ||
      conversation.createdAt,
    messageCount: messages.length,
    changedFileCount: 0,
    pendingApprovalCount,
  };
}

export function parseAgentMentionCommand(
  value: string,
  allowedUserIds: string[]
): AgentMentionCommand | null {
  const trimmed = value.trim();
  const match = /^@([A-Za-z0-9_-]{1,64})-agent(?:\s+([\s\S]+))?$/.exec(trimmed);
  if (!match) return null;
  const targetUserId = match[1];
  const prompt = (match[2] || "").trim();
  if (!prompt || !allowedUserIds.includes(targetUserId)) return null;
  return { targetUserId, prompt };
}

function isPendingApprovalForCurrentUser(
  invocation: AgentInvocation | undefined,
  currentUserId: string
): boolean {
  return invocation?.targetUserId === currentUserId && invocation.status === "pending_approval";
}
