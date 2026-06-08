"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Loader2,
  MessageSquare,
  Pencil,
  Plug,
  Power,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  AuthError,
  deleteSkill,
  disconnectConnector,
  fetchCapabilities,
  fetchGogcliAccounts,
  fetchSkills,
  updateSkill,
  validateSkill,
} from "@/lib/api";
import { type MessageKey, useI18n } from "@/i18n";
import type {
  CapabilityInfo,
  ConnectorInfo,
  ConnectorStatus,
  GogcliAccountInfo,
  SessionControlAction,
  SkillInfo,
  SkillUserStatus,
} from "@/types";
import {
  LUCIDE_NAV_STROKE_WIDTH,
  MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS,
  MOBILE_PAGE_TOP_SAFE_AREA_CLASS,
  TYPOGRAPHY_BODY_CLASS,
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_META_MEDIUM_CLASS,
  TYPOGRAPHY_MICRO_MEDIUM_CLASS,
  TYPOGRAPHY_PAGE_TITLE_CLASS,
  WORKBENCH_FIELD_CLASS,
  WORKBENCH_MOBILE_ICON_BUTTON_CLASS,
  WORKBENCH_PAGE_BACKGROUND_CLASS,
  WORKBENCH_PAGE_CONTENT_CLASS,
  WORKBENCH_SECTION_CLASS,
} from "./stylePrimitives";
import {
  mobileStackCommitTransition,
  mobilePageSwitchTransition,
  mobilePageVariants,
  mobileStackReturnTransition,
  mobileSwipeBackConfig,
  reducedMobilePageVariants,
  reducedMotionTransition,
  resolveMobileSwipeBackRelease,
  shouldCancelMobileSwipeBack,
  shouldClaimMobileSwipeBack,
  shouldGuardMobileSwipeBackScroll,
  shouldReleaseMobileSwipeBackScrollGuard,
} from "./motionPrimitives";
import MobilePageHeader from "./MobilePageHeader";
import { SkillDescriptionMarkdown } from "./SkillDescriptionMarkdown";

const SKILL_REFRESH_THROTTLE_MS = 10_000;
const CONNECTOR_REFRESH_THROTTLE_MS = 30_000;
const SKILLS_PAGE_TEXT_PRIMARY_CLASS = "text-[#1F2329]";
const SKILLS_PAGE_TEXT_SECONDARY_CLASS = "text-[#646A73]";
const SKILLS_PAGE_TEXT_TERTIARY_CLASS = "text-[#8F959E]";
const SKILLS_PAGE_BORDER_CLASS = "border-[#DEE0E3]";
const SKILLS_PAGE_DIVIDER_CLASS = "border-[#EFF0F1]";
const SKILL_ACTION_BUTTON_CLASS = `inline-flex h-10 items-center gap-1.5 rounded-lg border ${SKILLS_PAGE_BORDER_CLASS} bg-white px-2.5 text-[#2B2F36] transition-colors hover:bg-[#F8F9FA] disabled:cursor-not-allowed disabled:opacity-60 sm:h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`;
const SKILL_CREATE_ACTION_BUTTON_CLASS = `inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#1456F0]/30 bg-[#1456F0] text-white shadow-[0_8px_18px_rgba(20,86,240,0.18)] transition-all hover:bg-[#0F4BD8] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 lg:h-10 lg:w-auto lg:gap-1.5 lg:px-3 ${TYPOGRAPHY_META_MEDIUM_CLASS}`;
const SKILL_DANGER_ACTION_BUTTON_CLASS = `inline-flex h-10 items-center gap-1.5 rounded-lg border border-[#FAD4D4] bg-white px-2.5 text-[#B42318] transition-colors hover:bg-[#FFF1F0] disabled:cursor-not-allowed disabled:opacity-60 sm:h-8 ${TYPOGRAPHY_META_MEDIUM_CLASS}`;

interface SkillSnapshot {
  skills: SkillInfo[];
  loadedAt: number;
}

interface ConnectorSnapshot {
  connectors: ConnectorInfo[];
  statuses: Record<string, ConnectorStatus>;
  accounts: GogcliAccountInfo[];
  loadedAt: number;
}

interface SkillsPageProps {
  userId: string;
  onBack?: () => void;
  onOpenChat?: (prompt: string, options?: { autoSend?: boolean; newSession?: boolean }) => void;
  onOpenSessionAction?: (action: SessionControlAction, label: string) => void;
  onConnectorStateChange?: () => Promise<unknown> | unknown;
  onMobileBackGestureScopeChange?: (active: boolean) => void;
  resetToRootRequest?: number;
}

type SkillSourceId = "user" | "system";
type SkillCategoryGroupId =
  | "custom"
  | "feishu"
  | "google_workspace"
  | "bilibili"
  | "notion"
  | "general";
type SkillCategorySectionId = "user" | "connected_services" | "general";

interface SkillCategory {
  id: string;
  sourceId: SkillSourceId;
  groupId: SkillCategoryGroupId;
  labelKey?: MessageKey;
  label?: string;
  skills: SkillInfo[];
}

interface SkillCategorySection {
  id: SkillCategorySectionId;
  sourceId: SkillSourceId;
  labelKey: MessageKey;
  categories: SkillCategory[];
}

interface SkillsCategoryBackSwipeIntentInput {
  startX?: number;
  deltaX: number;
  deltaY: number;
  viewportWidth: number;
}

interface SkillsCategoryBackSwipeReleaseInput {
  x: number;
  velocityX: number;
  viewportWidth: number;
}

interface SkillsCategoryBackSwipeReleaseResolution {
  shouldCloseCategory: boolean;
  commitDistance: number;
}

interface SkillsCategoryBackSwipeDragState {
  pointerId: number;
  startX: number;
  startY: number;
  viewportWidth: number;
  claimed: boolean;
  lastX: number;
  lastTime: number;
  velocityX: number;
  scrollElement: HTMLElement | null;
  startScrollTop: number;
}

interface SkillsCategoryBackSwipeTouchGuardState {
  startX: number;
  startY: number;
  viewportWidth: number;
  isGuarding: boolean;
  scrollElement: HTMLElement | null;
  startScrollTop: number;
}

interface SkillsCategoryBackSwipeScrollLockState {
  scrollElement: HTMLElement;
  startScrollTop: number;
  previousOverflowY: string;
  previousOverscrollBehaviorY: string;
}

const CATEGORY_ORDER: SkillCategoryGroupId[] = [
  "custom",
  "feishu",
  "google_workspace",
  "bilibili",
  "notion",
  "general",
];

const CATEGORY_LABELS: Record<SkillCategoryGroupId, { label?: string; labelKey?: MessageKey }> = {
  custom: { labelKey: "skills.groupCustom" },
  feishu: { label: "Feishu / Lark" },
  google_workspace: { label: "Google Workspace" },
  bilibili: { label: "Bilibili" },
  notion: { label: "Notion" },
  general: { labelKey: "skills.groupGeneral" },
};

const CATEGORY_SUMMARY_KEYS: Record<SkillCategoryGroupId, MessageKey> = {
  custom: "skills.categorySummaries.custom",
  feishu: "skills.categorySummaries.feishu",
  google_workspace: "skills.categorySummaries.googleWorkspace",
  bilibili: "skills.categorySummaries.bilibili",
  notion: "skills.categorySummaries.notion",
  general: "skills.categorySummaries.general",
};

const SKILLS_CATEGORY_BACK_SWIPE_INTERACTIVE_SELECTOR =
  "a, button, input, textarea, select, summary, [contenteditable='true'], [role='button'], [data-ripple-ignore-skills-swipe]";

function currentTimeMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function skillsCategoryBackSwipeViewportWidth(): number {
  return typeof window === "undefined" ? 0 : window.innerWidth;
}

function isInteractiveSkillsCategoryBackSwipeTarget(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return Boolean(target.closest(SKILLS_CATEGORY_BACK_SWIPE_INTERACTIVE_SELECTOR));
}

function ensureSkillsCategoryBackSwipeScrollLock(
  currentLock: SkillsCategoryBackSwipeScrollLockState | null,
  scrollElement: HTMLElement | null,
  startScrollTop: number
): SkillsCategoryBackSwipeScrollLockState | null {
  if (currentLock) return currentLock;
  if (!scrollElement) return null;
  const lock = {
    scrollElement,
    startScrollTop,
    previousOverflowY: scrollElement.style.overflowY,
    previousOverscrollBehaviorY: scrollElement.style.overscrollBehaviorY,
  };
  scrollElement.scrollTop = startScrollTop;
  scrollElement.style.overflowY = "hidden";
  scrollElement.style.overscrollBehaviorY = "contain";
  return lock;
}

function releaseSkillsCategoryBackSwipeScrollLock(
  lock: SkillsCategoryBackSwipeScrollLockState | null
): void {
  if (!lock) return;
  const { scrollElement, startScrollTop, previousOverflowY, previousOverscrollBehaviorY } = lock;
  scrollElement.style.overflowY = previousOverflowY;
  scrollElement.style.overscrollBehaviorY = previousOverscrollBehaviorY;
  scrollElement.scrollTop = startScrollTop;
}

export function shouldGuardSkillsCategoryBackSwipeScroll({
  startX,
  deltaX,
  deltaY,
  viewportWidth,
}: SkillsCategoryBackSwipeIntentInput): boolean {
  return shouldGuardMobileSwipeBackScroll({ startX, deltaX, deltaY, viewportWidth });
}

export function shouldClaimSkillsCategoryBackSwipe({
  startX,
  deltaX,
  deltaY,
  viewportWidth,
}: SkillsCategoryBackSwipeIntentInput): boolean {
  return shouldClaimMobileSwipeBack({ startX, deltaX, deltaY, viewportWidth });
}

export function shouldCancelSkillsCategoryBackSwipe({
  startX,
  deltaX,
  deltaY,
  viewportWidth,
}: SkillsCategoryBackSwipeIntentInput): boolean {
  return shouldCancelMobileSwipeBack({ startX, deltaX, deltaY, viewportWidth });
}

export function shouldReleaseSkillsCategoryBackSwipeScrollGuard({
  startX,
  deltaX,
  deltaY,
  viewportWidth,
}: SkillsCategoryBackSwipeIntentInput): boolean {
  return shouldReleaseMobileSwipeBackScrollGuard({ startX, deltaX, deltaY, viewportWidth });
}

export function resolveSkillsCategoryBackSwipeRelease({
  x,
  velocityX,
  viewportWidth,
}: SkillsCategoryBackSwipeReleaseInput): SkillsCategoryBackSwipeReleaseResolution {
  const release = resolveMobileSwipeBackRelease({ x, velocityX, viewportWidth });

  return { shouldCloseCategory: release.shouldCommit, commitDistance: release.commitDistance };
}

interface SkillCategoryLogoMeta {
  shellClass: string;
  dotClass: string;
}

const CATEGORY_LOGO_META: Record<SkillCategoryGroupId, SkillCategoryLogoMeta> = {
  custom: {
    shellClass: "border-[#BACEFD] bg-[#F0F5FF] text-[#1456F0]",
    dotClass: "bg-[#1456F0]",
  },
  feishu: {
    shellClass: "border-[#C7EFFF] bg-white",
    dotClass: "bg-[#18C6FF]",
  },
  google_workspace: {
    shellClass: "border-[#DEE0E3] bg-white",
    dotClass: "bg-[#34A853]",
  },
  bilibili: {
    shellClass: "border-[#FFD5E6] bg-white",
    dotClass: "bg-[#23ADE5]",
  },
  notion: {
    shellClass: "border-[#DFE0E3] bg-white",
    dotClass: "bg-[#1F2329]",
  },
  general: {
    shellClass: "border-[#D8E8DE] bg-[#F0F9F4] text-[#16845B]",
    dotClass: "bg-[#22A06B]",
  },
};

const SKILL_STATUS_RANK: Record<string, number> = {
  needs_connection: 0,
  needs_confirmation: 1,
  needs_fix: 1,
  unavailable: 1,
  not_enabled: 2,
  disabled: 2,
  available: 3,
};

const STATUS_FILTERS = [
  "all",
  "available",
  "enabled",
  "not_enabled",
  "needs_connection",
  "needs_confirmation",
  "needs_fix",
  "unavailable",
] as const;

const skillSnapshotCache = new Map<string, SkillSnapshot>();
const skillSnapshotInflight = new Map<string, Promise<SkillSnapshot>>();
const connectorSnapshotCache = new Map<string, ConnectorSnapshot>();
const connectorSnapshotInflight = new Map<string, Promise<ConnectorSnapshot>>();
type Translator = ReturnType<typeof useI18n>["t"];

const FEISHU_FAVICON_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAGUklEQVR4nN2aC3BMVxjHo0VEJxVJGHQ6RWeqSod6tMQjpV4dLRVTM+rZUc8WoYqZKlpFvWq01eaJopiIx3iUbFDPEkpCJbt5sbG7iIQkK9nd2M3+6tzdHZGstXs3IvrNfNmbm829/9/5vnPOPed+PoCP3f2AlsBgYMn935fVMF8KjACC7x/7OnSLH7WAAGA2oAZKgNIa6kLbJWAS0EBoFwD1gcXAXcBKzbcyQG/X7C8AugKFT1uVDCu6H40wARAP3HvaamSY0BzvYyd5FlKnognNRT6e/EeptQxjFXlVmdsAQryiOJ/1BTqvfWPhddJLS7BUQeDdAhC3ybPcY+ZNFU0zjuKTluCV10pLoGXmCc4YC/E2Fh6lkNlqJbJAQ6uskzyXpvAK4vk0BV2vniHnntGrOHgEgDQIW/mr5Da91efwVSZ6BVFXmcisXBUGL/qExwAO05iNhGmSqecFhEilRhlHOCulkrw4yAYQt9OajQzTpuDnBURtpYJhmhTullmqF8BhOrOJ4dqLXkH4qQ6RZJAXBa8BhF03mxilu0R9lTyIOkoFY3X/ypofqgRA2A2ziRHaS1LHlAMRnH5EGpG8ArBa4a5BHoAIfnapgT4556TO6SlAvfRDbNDryNMbUev0pGbdJkV1S3JxLM4V6ktdA9wzw5ajkHVdHoTI4aMlt2mTfcp98aoE6qYp8D28n4E7jjE/IonxCw8zZPp+BkzcLbk4Fue+jzzLvmNXOXc5F6PJUhmgxAQf/wBfxoJSIxcCthbd4KWMo4+PxOUEaifuo2HULvwnb6JBaBT+70TwYpcIGnSNJCDE5uJYnBPeov8GZiw/zp0ikxR1pwCdZsD0KEi9Jg9CPON8m5flcmSqlXwQ33U78Z+0icDQaIJCogjq/ngXACIKFov10REQAB3DYWokXMj2HEBcOtdSyvvXzjt95Kh14QD11myn4cBYt4ULbxwazTe/nMZseTBauQToEA7jfoLEZDCYPINwPHI0zzz2UCoJ8X6rtxPYL4agbu6Lb9QzmtCxO8grMDw0W7gEEP7WdPjgO1ifaPu7J2axWlmRf5UXVIceiF8ZZxPvpnCHN3k3ht/3KB9qfbcApEhMh9C5sGoXpFxxH8D2GF7KQM156lw4iN/yOAL7ei5etH7vcTu5dcdQaa52C8AB0X6aLaX2JEGxm3OOuOFWjZagZfGyxAtv2iuGLX+mV2p9jwDKp9SABbByJ/yT+XiADHUB4StP0KRvrCzxovX7TdhNXoHzdYPHAI5ovD0TRq+GWAWotM7FHzilZsScg1L+etJhK+Z+XEKm09aXDeAYoURKhXwFE9fCtuOgu21LGrWuiDWbU+gxJp6GIZEEyhTfuGc0w2cf4E7Ro/NVNkDFvtFnnm3yW7vPxMh5p2jRfx0BIREEdY+UJT64exStB2/hyNlcysoe/ZjtNUD5vtFuKoTMMvPa6BxeHZZMs/67adRzPYHdIgjq5j5IYLdImrz3BwuiM9CXuF4jVBlA+Yh0nAEdplloO/4WrcdcoflHx2naN14CeQBTEShSOh/cI5ZXBin4/Mcc1Lll0hNytQKUd+k6M6DdlGLafnaTViNVtBh6mmYD9tC412Y70G8E94ihSZ9tvPxhIq+PyiBsYQHpOtfCqwXgIbdfs/0XRt6ckE+bcTpaj70q+Ruf5kiA7SYXMWiRlROpPLblqx+gAkynCi7ODV4Mxy6D2YP1fSWAkaug85MGcOJTfoW/lfCI4d49gFIzrNljm6Q6VINo0eFFYy2Ns60Cy2Tsb1VaE9+4Az/vhQHznxyE47qfrIBdp+GWF69XnO5KFBZDag4s2moDKX/TqhA+ZDGsS7S1usnLVysut1Xy9ZCuhYgDMHKlLdwi7J7AOL7bYw6MWgXbT0LWDbjr+Q6K5wAO0xtAkwcnUyHqIExeC2GLofNM56I7hUPPuTB0CXy9EWISIDkbNPlgrLwz8uQBHCZGCNFyuQWgzbe15BkV7DsLe5Nsn6eVkJQOV27aviOiKNYO7o7rTxTAmYmRQ4xeIpfFp4CUM5rItf/FS75n+TXrdgEw1B6FZ83E7NFFAPjbizv09p3Bmm5We1mE0FzfUewhCicmAxeB4hpQ1OGq2ENtL0wJcBR7ONzXXsoywl7a8rTLayr6EnspUEt7aZCk+z80tqKb3XO3FwAAAABJRU5ErkJggg==";

function cachedSkillSnapshot(userId: string): SkillSnapshot | null {
  return skillSnapshotCache.get(userId) || null;
}

function freshSkillSnapshot(userId: string): SkillSnapshot | null {
  const snapshot = cachedSkillSnapshot(userId);
  if (!snapshot) return null;
  return Date.now() - snapshot.loadedAt < SKILL_REFRESH_THROTTLE_MS ? snapshot : null;
}

function hasSkillSnapshot(userId: string): boolean {
  return skillSnapshotCache.has(userId);
}

async function fetchSkillSnapshot(userId: string, force = false): Promise<SkillSnapshot> {
  const freshSnapshot = force ? null : freshSkillSnapshot(userId);
  if (freshSnapshot) return freshSnapshot;
  const inflightSnapshot = skillSnapshotInflight.get(userId);
  if (!force && inflightSnapshot) return inflightSnapshot;

  const nextInflight = (async () => {
    const skills = await fetchSkills();
    const snapshot = { skills, loadedAt: Date.now() };
    skillSnapshotCache.set(userId, snapshot);
    return snapshot;
  })();
  skillSnapshotInflight.set(userId, nextInflight);

  try {
    return await nextInflight;
  } finally {
    if (skillSnapshotInflight.get(userId) === nextInflight) {
      skillSnapshotInflight.delete(userId);
    }
  }
}

function cachedConnectorSnapshot(userId: string): ConnectorSnapshot | null {
  return connectorSnapshotCache.get(userId) || null;
}

function freshConnectorSnapshot(userId: string): ConnectorSnapshot | null {
  const snapshot = cachedConnectorSnapshot(userId);
  if (!snapshot) return null;
  return Date.now() - snapshot.loadedAt < CONNECTOR_REFRESH_THROTTLE_MS ? snapshot : null;
}

function hasConnectorSnapshot(userId: string): boolean {
  return connectorSnapshotCache.has(userId);
}

function connectorFromCapability(capability: CapabilityInfo): ConnectorInfo | null {
  if (capability.type !== "connector") return null;
  if (capability.connector) return capability.connector;
  return {
    name: capability.name,
    display_name: capability.display_name,
    description: capability.description,
    auth_type: "runtime",
    kind: "user_connector",
    auth_flow: "none",
    auth_surfaces: { web: false, chat: false },
    auth_start_path: null,
    auth_complete_path: null,
    auth_cancel_path: null,
    disconnect_path: null,
    accounts_path: null,
    supports_account_disconnect: false,
  };
}

function connectorStatusFromCapability(capability: CapabilityInfo): ConnectorStatus {
  return {
    name: capability.name,
    connected: capability.enabled,
    required: !capability.enabled,
    detail: "",
    metadata: {
      capability_status: capability.status,
    },
  };
}

async function fetchConnectorSnapshot(userId: string, force = false): Promise<ConnectorSnapshot> {
  const freshSnapshot = force ? null : freshConnectorSnapshot(userId);
  if (freshSnapshot) return freshSnapshot;
  const inflightSnapshot = connectorSnapshotInflight.get(userId);
  if (!force && inflightSnapshot) return inflightSnapshot;

  const nextInflight = (async () => {
    const capabilities = await fetchCapabilities();
    const connectors = capabilities
      .map(connectorFromCapability)
      .filter((connector): connector is ConnectorInfo => connector !== null);
    const statuses = Object.fromEntries(
      capabilities
        .filter((capability) => capability.type === "connector")
        .map((capability) => [capability.name, connectorStatusFromCapability(capability)])
    );
    const google = connectors.find((connector) => connector.name === "google_workspace");
    const accountData = google?.accounts_path ? await fetchGogcliAccounts(false) : null;
    const snapshot = {
      connectors,
      statuses,
      accounts: accountData?.accounts || [],
      loadedAt: Date.now(),
    };
    connectorSnapshotCache.set(userId, snapshot);
    return snapshot;
  })();
  connectorSnapshotInflight.set(userId, nextInflight);

  try {
    return await nextInflight;
  } finally {
    if (connectorSnapshotInflight.get(userId) === nextInflight) {
      connectorSnapshotInflight.delete(userId);
    }
  }
}

function skillTitle(skill: SkillInfo): string {
  return skill.display_name || skill.name;
}

function safeSkillDirectoryName(value: string): string {
  const parts = value
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== "." && part !== "..");
  return parts.join("-") || "skill";
}

function skillEditDirectory(skill: SkillInfo): string {
  const normalizedPath = (skill.path || "").replace(/\\/g, "/");
  const workspaceIndex = normalizedPath.lastIndexOf("/workspace/");
  const skillsIndex = normalizedPath.lastIndexOf("/skills/");
  let candidate = "";
  if (workspaceIndex >= 0) {
    candidate = normalizedPath.slice(workspaceIndex + "/workspace/".length);
  } else if (normalizedPath.startsWith("/workspace/")) {
    candidate = normalizedPath.slice("/workspace/".length);
  } else if (skillsIndex >= 0) {
    candidate = `skills/${normalizedPath.slice(skillsIndex + "/skills/".length)}`;
  } else if (normalizedPath.startsWith("skills/")) {
    candidate = normalizedPath;
  }
  if (candidate.endsWith("/SKILL.md")) {
    candidate = candidate.slice(0, -"/SKILL.md".length);
  }
  const parts = candidate.split("/").filter((part) => part && part !== "." && part !== "..");
  if (parts.length >= 2 && parts[0] === "skills") {
    return parts.join("/");
  }
  const fallbackName = skill.id.startsWith("user:") ? skill.id.slice("user:".length) : skill.name;
  return `skills/${safeSkillDirectoryName(fallbackName)}`;
}

function skillStatusKey(status: string | undefined): MessageKey {
  if (status === "available") return "skills.available";
  if (status === "needs_connection") return "skills.needsConnection";
  if (status === "needs_confirmation") return "skills.needsConfirmation";
  if (status === "needs_fix") return "skills.needsFix";
  if (status === "disabled") return "skills.disabled";
  if (status === "unavailable") return "skills.unavailable";
  return "skills.notEnabled";
}

function skillStatusClass(status: string | undefined): string {
  if (status === "available") return "border-[#22A06B]/20 bg-[#E4F8EE]/78 text-[#16845B]";
  if (status === "needs_connection") return "border-[#FAD355]/45 bg-[#FFF8DB]/82 text-[#8B5E00]";
  if (status === "needs_confirmation") return "border-[#BACEFD] bg-[#F0F5FF] text-[#1456F0]";
  if (status === "needs_fix") return "border-[#FDCACA]/45 bg-[#FFF1F0]/82 text-[#B42318]";
  if (status === "disabled") return "border-[#DEE0E3] bg-[#F8F9FA] text-[#8F959E]";
  if (status === "unavailable") return "border-[#DEE0E3] bg-[#F8F9FA] text-[#8F959E]";
  return "border-[#BACEFD] bg-[#F0F5FF] text-[#1456F0]";
}

function skillStatusIcon(status: string | undefined) {
  if (status === "available") return <CheckCircle2 size={13} />;
  if (status === "needs_connection") return <Plug size={13} />;
  if (status === "needs_fix" || status === "unavailable") return <AlertTriangle size={13} />;
  return <Power size={13} />;
}

function skillStatusRank(skill: SkillInfo): number {
  return SKILL_STATUS_RANK[skill.user_status || "not_enabled"] ?? 4;
}

function sourceIdForSkill(skill: SkillInfo): SkillSourceId {
  if (skill.display_source === "user" || skill.display_source === "system") {
    return skill.display_source;
  }
  return skill.source === "user" ? "user" : "system";
}

function categoryGroupIdForSkill(skill: SkillInfo): SkillCategoryGroupId {
  const connector = skill.related_connector || skill.requires_connectors?.[0] || "";
  if (connector === "feishu" || connector === "lark" || skill.name.startsWith("lark-")) {
    return "feishu";
  }
  if (connector === "google_workspace" || skill.name.startsWith("gog-")) {
    return "google_workspace";
  }
  if (connector === "bilibili" || skill.name.startsWith("bilibili-")) {
    return "bilibili";
  }
  if (connector === "notion" || skill.name.startsWith("notion-")) {
    return "notion";
  }
  return sourceIdForSkill(skill) === "user" ? "custom" : "general";
}

function connectorNameForCategory(category: SkillCategory | null | undefined): string | null {
  if (!category) return null;
  if (
    category.groupId === "feishu" ||
    category.groupId === "google_workspace" ||
    category.groupId === "bilibili" ||
    category.groupId === "notion"
  ) {
    return category.groupId;
  }
  return null;
}

function GoogleWorkspaceLogo() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-6 w-6">
      <path
        fill="#4285f4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34a853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C4 20.53 7.7 23 12 23z"
      />
      <path
        fill="#fbbc05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#ea4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 4 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

function NotionLogo() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-6 w-6">
      <path
        fill="#1F2329"
        d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z"
      />
    </svg>
  );
}

function FeishuLogo() {
  return (
    <img
      src={FEISHU_FAVICON_DATA_URI}
      alt=""
      aria-hidden="true"
      className="h-6 w-6 object-contain"
      draggable={false}
    />
  );
}

function BilibiliLogo() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-6 w-6">
      <path
        fill="#23ade5"
        d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L9.653 4.44c.071.071.134.142.187.213h4.267a.836.836 0 0 1 .16-.213l2.853-2.747c.267-.249.573-.373.92-.373.347 0 .662.151.929.4.267.249.391.551.391.907 0 .355-.124.657-.373.906zM5.333 7.24c-.746.018-1.373.276-1.88.773-.506.498-.769 1.13-.786 1.894v7.52c.017.764.28 1.395.786 1.893.507.498 1.134.756 1.88.773h13.334c.746-.017 1.373-.275 1.88-.773.506-.498.769-1.129.786-1.893v-7.52c-.017-.765-.28-1.396-.786-1.894-.507-.497-1.134-.755-1.88-.773zM8 11.107c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c0-.373.129-.689.386-.947.258-.257.574-.386.947-.386zm8 0c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c.017-.391.15-.711.4-.96.249-.249.56-.373.933-.373Z"
      />
    </svg>
  );
}

function categoryLogoNode(groupId: SkillCategoryGroupId) {
  if (groupId === "google_workspace") return <GoogleWorkspaceLogo />;
  if (groupId === "notion") return <NotionLogo />;
  if (groupId === "feishu") return <FeishuLogo />;
  if (groupId === "bilibili") return <BilibiliLogo />;
  if (groupId === "custom") return <Pencil size={18} />;
  return <Sparkles size={18} />;
}

function categoryConnectionDotClass(
  category: SkillCategory,
  status: ConnectorStatus | null | undefined
): string {
  if (!connectorNameForCategory(category)) return CATEGORY_LOGO_META[category.groupId].dotClass;
  if (status?.connected) return CATEGORY_LOGO_META[category.groupId].dotClass;
  if (status) return "bg-[#D99900]";
  return "bg-[#8F959E]";
}

function CategoryLogo({
  category,
  status,
}: {
  category: SkillCategory;
  status: ConnectorStatus | null | undefined;
}) {
  const logo = CATEGORY_LOGO_META[category.groupId];
  const hasConnector = Boolean(connectorNameForCategory(category));
  return (
    <span
      data-ripple-skill-category-logo="true"
      aria-hidden="true"
      className={`relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border shadow-[0_4px_10px_rgba(31,35,41,0.035)] ${logo.shellClass}`}
    >
      {categoryLogoNode(category.groupId)}
      {hasConnector && (
        <span
          className={`absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-white ${categoryConnectionDotClass(
            category,
            status
          )}`}
        />
      )}
    </span>
  );
}

function categorySummary(category: SkillCategory, accountCount: number, t: Translator): string {
  return t(CATEGORY_SUMMARY_KEYS[category.groupId], { count: accountCount });
}

function sortSkillsForDisplay(skills: SkillInfo[]): SkillInfo[] {
  return [...skills].sort((left, right) => {
    const rank = skillStatusRank(left) - skillStatusRank(right);
    if (rank !== 0) return rank;
    return skillTitle(left).localeCompare(skillTitle(right));
  });
}

function buildSkillCategories(skills: SkillInfo[]): SkillCategorySection[] {
  const grouped = new Map<SkillSourceId, Map<SkillCategoryGroupId, SkillInfo[]>>();
  for (const skill of skills) {
    const sourceId = sourceIdForSkill(skill);
    const groupId = categoryGroupIdForSkill(skill);
    const sourceGroups = grouped.get(sourceId) || new Map<SkillCategoryGroupId, SkillInfo[]>();
    sourceGroups.set(groupId, [...(sourceGroups.get(groupId) || []), skill]);
    grouped.set(sourceId, sourceGroups);
  }

  return [
    {
      id: "user" as const,
      sourceId: "user" as const,
      labelKey: "skills.categoryMine" as const,
      groups: ["custom"],
    },
    {
      id: "connected_services" as const,
      sourceId: "system" as const,
      labelKey: "skills.categoryConnectedServices" as const,
      groups: ["feishu", "google_workspace", "bilibili", "notion"],
    },
    {
      id: "general" as const,
      sourceId: "system" as const,
      labelKey: "skills.categoryGeneral" as const,
      groups: ["general"],
    },
  ]
    .map((section) => {
      const sourceGroups = grouped.get(section.sourceId);
      const categories = CATEGORY_ORDER.filter((groupId) =>
        section.groups.includes(groupId)
      ).flatMap((groupId) => {
        const categorySkills = sourceGroups?.get(groupId);
        if (!categorySkills?.length) return [];
        const label = CATEGORY_LABELS[groupId];
        return [
          {
            id: `${section.id}:${groupId}`,
            sourceId: section.sourceId,
            groupId,
            label: label.label,
            labelKey: label.labelKey,
            skills: sortSkillsForDisplay(categorySkills),
          },
        ];
      });
      return {
        id: section.id,
        sourceId: section.sourceId,
        labelKey: section.labelKey,
        categories,
      };
    })
    .filter((section) => section.categories.length > 0);
}

function skillMatchesStatusFilter(skill: SkillInfo, statusFilter: string): boolean {
  if (statusFilter === "all") return true;
  if (statusFilter === "enabled") return skill.desired_state === "enabled" || skill.enabled;
  if (statusFilter === "not_enabled") {
    return (
      skill.user_status === "not_enabled" || (!skill.enabled && skill.desired_state !== "enabled")
    );
  }
  return skill.user_status === statusFilter;
}

function skillSearchText(skill: SkillInfo): string {
  return [
    skill.id,
    skill.name,
    skill.display_name,
    skill.description,
    skill.related_connector,
    ...(skill.requires_connectors || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function filterCategorySkills(
  skills: SkillInfo[],
  searchQuery: string,
  statusFilter: string
): SkillInfo[] {
  const query = searchQuery.trim().toLowerCase();
  return skills.filter((skill) => {
    if (!skillMatchesStatusFilter(skill, statusFilter)) return false;
    if (!query) return true;
    return skillSearchText(skill).includes(query);
  });
}

function connectorStatusClass(status: ConnectorStatus | null | undefined): string {
  if (status?.connected) return "border-[#22A06B]/20 bg-[#E4F8EE]/78 text-[#16845B]";
  if (status) return "border-[#FAD355]/45 bg-[#FFF8DB]/82 text-[#8B5E00]";
  return "border-[#DEE0E3] bg-[#F8F9FA] text-[#8F959E]";
}

function actionDetail(result: Record<string, unknown>, fallback: string): string {
  return typeof result.detail === "string" && result.detail.trim() ? result.detail : fallback;
}

export default function SkillsPage({
  userId,
  onBack,
  onOpenChat,
  onOpenSessionAction,
  onConnectorStateChange,
  onMobileBackGestureScopeChange,
  resetToRootRequest = 0,
}: SkillsPageProps) {
  const { t } = useI18n();
  const reduceMotion = useReducedMotion();
  const categorySwipeX = useMotionValue(0);
  const [skills, setSkills] = useState<SkillInfo[]>(
    () => cachedSkillSnapshot(userId)?.skills || []
  );
  const [connectors, setConnectors] = useState<ConnectorInfo[]>(
    () => cachedConnectorSnapshot(userId)?.connectors || []
  );
  const [connectorStatuses, setConnectorStatuses] = useState<Record<string, ConnectorStatus>>(
    () => cachedConnectorSnapshot(userId)?.statuses || {}
  );
  const [googleAccounts, setGoogleAccounts] = useState<GogcliAccountInfo[]>(
    () => cachedConnectorSnapshot(userId)?.accounts || []
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isConnectorLoading, setIsConnectorLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busySkillId, setBusySkillId] = useState<string | null>(null);
  const [pendingConnectorAction, setPendingConnectorAction] = useState<string | null>(null);
  const [confirmConnectorAction, setConfirmConnectorAction] = useState<string | null>(null);
  const [confirmDeleteSkillId, setConfirmDeleteSkillId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [categoryTransitionDirection, setCategoryTransitionDirection] = useState(0);
  const [skipNextCategoryTransition, setSkipNextCategoryTransition] = useState(false);
  const [isCategorySwipeActive, setIsCategorySwipeActive] = useState(false);
  const [expandedDescriptionSkillId, setExpandedDescriptionSkillId] = useState<string | null>(null);
  const skillsPageScrollRef = useRef<HTMLDivElement | null>(null);
  const categorySwipeDragStateRef = useRef<SkillsCategoryBackSwipeDragState | null>(null);
  const categorySwipeTouchGuardStateRef = useRef<SkillsCategoryBackSwipeTouchGuardState | null>(
    null
  );
  const categorySwipeScrollLockRef = useRef<SkillsCategoryBackSwipeScrollLockState | null>(null);
  const categorySwipeAnimationRef = useRef<ReturnType<typeof animate> | null>(null);
  const loadRequestIdRef = useRef(0);
  const connectorLoadRequestIdRef = useRef(0);
  const lastRefreshAtRef = useRef(cachedSkillSnapshot(userId)?.loadedAt || 0);
  const lastConnectorRefreshAtRef = useRef(cachedConnectorSnapshot(userId)?.loadedAt || 0);

  const applySkillSnapshot = useCallback((snapshot: SkillSnapshot) => {
    setSkills(snapshot.skills);
    lastRefreshAtRef.current = snapshot.loadedAt;
  }, []);

  const applyConnectorSnapshot = useCallback((snapshot: ConnectorSnapshot) => {
    setConnectors(snapshot.connectors);
    setConnectorStatuses(snapshot.statuses);
    setGoogleAccounts(snapshot.accounts);
    lastConnectorRefreshAtRef.current = snapshot.loadedAt;
  }, []);

  const loadConnectors = useCallback(
    async (options: { force?: boolean; background?: boolean } = {}) => {
      const cached = options.force ? null : cachedConnectorSnapshot(userId);
      if (cached) {
        applyConnectorSnapshot(cached);
        if (Date.now() - cached.loadedAt < CONNECTOR_REFRESH_THROTTLE_MS) return;
      }

      const now = Date.now();
      if (
        !options.force &&
        now - lastConnectorRefreshAtRef.current < CONNECTOR_REFRESH_THROTTLE_MS
      ) {
        return;
      }

      const requestId = connectorLoadRequestIdRef.current + 1;
      connectorLoadRequestIdRef.current = requestId;
      if (!options.background) setIsConnectorLoading(true);
      try {
        const snapshot = await fetchConnectorSnapshot(userId, options.force);
        if (connectorLoadRequestIdRef.current !== requestId) return;
        applyConnectorSnapshot(snapshot);
        await onConnectorStateChange?.();
      } catch (error) {
        if (connectorLoadRequestIdRef.current === requestId) {
          setActionError(error instanceof Error ? error.message : t("skills.failed"));
        }
      } finally {
        if (connectorLoadRequestIdRef.current === requestId) {
          setIsConnectorLoading(false);
        }
      }
    },
    [applyConnectorSnapshot, onConnectorStateChange, t, userId]
  );

  const loadSkills = useCallback(
    async (options: { force?: boolean; background?: boolean } = {}) => {
      const cached = options.force ? null : cachedSkillSnapshot(userId);
      if (cached) {
        applySkillSnapshot(cached);
        if (Date.now() - cached.loadedAt < SKILL_REFRESH_THROTTLE_MS) return;
      }

      const now = Date.now();
      if (!options.force && now - lastRefreshAtRef.current < SKILL_REFRESH_THROTTLE_MS) return;

      const requestId = loadRequestIdRef.current + 1;
      loadRequestIdRef.current = requestId;
      if (!options.background) setIsLoading(true);
      setActionError(null);
      try {
        const snapshot = await fetchSkillSnapshot(userId, options.force);
        if (loadRequestIdRef.current !== requestId) return;
        applySkillSnapshot(snapshot);
      } catch (error) {
        if (loadRequestIdRef.current === requestId) {
          setActionError(error instanceof Error ? error.message : t("skills.failed"));
        }
      } finally {
        if (loadRequestIdRef.current === requestId) {
          setIsLoading(false);
        }
      }
    },
    [applySkillSnapshot, t, userId]
  );

  useEffect(() => {
    const cached = cachedSkillSnapshot(userId);
    if (cached) {
      applySkillSnapshot(cached);
    } else {
      setSkills([]);
      lastRefreshAtRef.current = 0;
    }
    void loadSkills({ background: hasSkillSnapshot(userId) });
  }, [applySkillSnapshot, loadSkills, userId]);

  useEffect(() => {
    const cached = cachedConnectorSnapshot(userId);
    if (cached) {
      applyConnectorSnapshot(cached);
    } else {
      setConnectors([]);
      setConnectorStatuses({});
      setGoogleAccounts([]);
      lastConnectorRefreshAtRef.current = 0;
    }
    void loadConnectors({ background: hasConnectorSnapshot(userId) });
  }, [applyConnectorSnapshot, loadConnectors, userId]);

  const categories = useMemo(() => buildSkillCategories(skills), [skills]);
  const flatCategories = useMemo(
    () => categories.flatMap((section) => section.categories),
    [categories]
  );
  const selectedCategory = useMemo(
    () => flatCategories.find((category) => category.id === selectedCategoryId) || null,
    [flatCategories, selectedCategoryId]
  );
  const availableCount = useMemo(
    () => skills.filter((skill) => skill.user_status === "available").length,
    [skills]
  );
  const filteredSections = useMemo(
    () =>
      categories
        .map((section) => ({
          ...section,
          categories: section.categories
            .map((category) => ({
              ...category,
              skills: filterCategorySkills(category.skills, searchQuery, statusFilter),
            }))
            .filter((category) => category.skills.length > 0),
        }))
        .filter((section) => section.categories.length > 0),
    [categories, searchQuery, statusFilter]
  );
  const selectedCategorySkills = useMemo(
    () =>
      selectedCategory
        ? filterCategorySkills(selectedCategory.skills, searchQuery, statusFilter)
        : [],
    [searchQuery, selectedCategory, statusFilter]
  );
  const activeFilterCount = (searchQuery.trim() ? 1 : 0) + (statusFilter !== "all" ? 1 : 0);

  const stopCategorySwipeAnimation = useCallback(() => {
    categorySwipeAnimationRef.current?.stop();
    categorySwipeAnimationRef.current = null;
  }, []);

  const releaseCategorySwipeScrollLock = useCallback(() => {
    releaseSkillsCategoryBackSwipeScrollLock(categorySwipeScrollLockRef.current);
    categorySwipeScrollLockRef.current = null;
  }, []);

  const animateCategorySwipeTo = useCallback(
    (target: number, onComplete?: () => void, transition = mobileStackReturnTransition) => {
      stopCategorySwipeAnimation();
      if (reduceMotion) {
        categorySwipeX.set(target);
        onComplete?.();
        return;
      }

      const animation = animate(categorySwipeX, target, transition);
      categorySwipeAnimationRef.current = animation;
      void animation.then(() => {
        if (categorySwipeAnimationRef.current === animation) {
          categorySwipeAnimationRef.current = null;
        }
        onComplete?.();
      });
    },
    [categorySwipeX, reduceMotion, stopCategorySwipeAnimation]
  );

  const resetCategorySwipeState = useCallback(() => {
    stopCategorySwipeAnimation();
    categorySwipeDragStateRef.current = null;
    categorySwipeTouchGuardStateRef.current = null;
    releaseCategorySwipeScrollLock();
    setIsCategorySwipeActive(false);
    categorySwipeX.set(0);
  }, [categorySwipeX, releaseCategorySwipeScrollLock, stopCategorySwipeAnimation]);

  const scrollSkillsPageToTop = useCallback(() => {
    skillsPageScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  const openCategory = useCallback(
    (categoryId: string) => {
      resetCategorySwipeState();
      setSkipNextCategoryTransition(true);
      setCategoryTransitionDirection(0);
      setConfirmDeleteSkillId(null);
      setExpandedDescriptionSkillId(null);
      setSelectedCategoryId(categoryId);
      scrollSkillsPageToTop();
    },
    [resetCategorySwipeState, scrollSkillsPageToTop]
  );

  const closeCategory = useCallback(() => {
    resetCategorySwipeState();
    setSkipNextCategoryTransition(true);
    setCategoryTransitionDirection(0);
    setConfirmDeleteSkillId(null);
    setExpandedDescriptionSkillId(null);
    setSelectedCategoryId(null);
    scrollSkillsPageToTop();
  }, [resetCategorySwipeState, scrollSkillsPageToTop]);

  const closeCategoryWithSwipeCommit = useCallback(() => {
    categorySwipeDragStateRef.current = null;
    categorySwipeTouchGuardStateRef.current = null;
    releaseCategorySwipeScrollLock();
    setIsCategorySwipeActive(false);
    setSkipNextCategoryTransition(true);
    setCategoryTransitionDirection(-1);
    setConfirmDeleteSkillId(null);
    setExpandedDescriptionSkillId(null);
    setSelectedCategoryId(null);
    const resetSwipeX = () => categorySwipeX.set(0);
    if (typeof window === "undefined") {
      resetSwipeX();
    } else {
      window.requestAnimationFrame(resetSwipeX);
    }
  }, [categorySwipeX, releaseCategorySwipeScrollLock]);

  useEffect(
    () => () => {
      stopCategorySwipeAnimation();
      releaseSkillsCategoryBackSwipeScrollLock(categorySwipeScrollLockRef.current);
      categorySwipeScrollLockRef.current = null;
    },
    [stopCategorySwipeAnimation]
  );

  useEffect(() => {
    onMobileBackGestureScopeChange?.(Boolean(selectedCategoryId));
  }, [onMobileBackGestureScopeChange, selectedCategoryId]);

  useEffect(
    () => () => {
      onMobileBackGestureScopeChange?.(false);
    },
    [onMobileBackGestureScopeChange]
  );

  useEffect(() => {
    if (resetToRootRequest <= 0) return;
    resetCategorySwipeState();
    setSkipNextCategoryTransition(true);
    setCategoryTransitionDirection(0);
    setConfirmDeleteSkillId(null);
    setExpandedDescriptionSkillId(null);
    setSelectedCategoryId(null);
    scrollSkillsPageToTop();
  }, [resetCategorySwipeState, resetToRootRequest, scrollSkillsPageToTop]);

  useEffect(() => {
    if (!skipNextCategoryTransition || selectedCategoryId) return;
    if (typeof window === "undefined") {
      setSkipNextCategoryTransition(false);
      return;
    }
    const frame = window.requestAnimationFrame(() => setSkipNextCategoryTransition(false));
    return () => window.cancelAnimationFrame(frame);
  }, [selectedCategoryId, skipNextCategoryTransition]);

  const handleCategorySwipePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!selectedCategoryId) return;
      if (!event.isPrimary || event.pointerType !== "touch") return;
      const viewportWidth = skillsCategoryBackSwipeViewportWidth();
      if (viewportWidth >= mobileSwipeBackConfig.desktopMinWidth) return;
      if (isInteractiveSkillsCategoryBackSwipeTarget(event.target)) return;
      stopCategorySwipeAnimation();
      const scrollElement = event.currentTarget;

      categorySwipeDragStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        viewportWidth,
        claimed: false,
        lastX: event.clientX,
        lastTime: currentTimeMs(),
        velocityX: 0,
        scrollElement,
        startScrollTop: scrollElement.scrollTop,
      };
    },
    [selectedCategoryId, stopCategorySwipeAnimation]
  );

  const handleCategorySwipePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const dragState = categorySwipeDragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) return;

      const deltaX = event.clientX - dragState.startX;
      const deltaY = event.clientY - dragState.startY;

      if (
        !dragState.claimed &&
        shouldCancelSkillsCategoryBackSwipe({
          startX: dragState.startX,
          deltaX,
          deltaY,
          viewportWidth: dragState.viewportWidth,
        })
      ) {
        categorySwipeDragStateRef.current = null;
        releaseCategorySwipeScrollLock();
        return;
      }

      if (
        !dragState.claimed &&
        shouldClaimSkillsCategoryBackSwipe({
          startX: dragState.startX,
          deltaX,
          deltaY,
          viewportWidth: dragState.viewportWidth,
        })
      ) {
        dragState.claimed = true;
        setIsCategorySwipeActive(true);
        categorySwipeScrollLockRef.current = ensureSkillsCategoryBackSwipeScrollLock(
          categorySwipeScrollLockRef.current,
          dragState.scrollElement,
          dragState.startScrollTop
        );
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture can fail when the platform has already ended the gesture.
        }
      }

      if (!dragState.claimed) return;

      event.preventDefault();
      const currentTime = currentTimeMs();
      const elapsed = Math.max(1, currentTime - dragState.lastTime);
      dragState.velocityX = ((event.clientX - dragState.lastX) / elapsed) * 1000;
      dragState.lastX = event.clientX;
      dragState.lastTime = currentTime;
      categorySwipeX.set(Math.max(0, deltaX));
    },
    [categorySwipeX, releaseCategorySwipeScrollLock]
  );

  const handleCategorySwipePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const dragState = categorySwipeDragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) return;

      categorySwipeDragStateRef.current = null;
      releaseCategorySwipeScrollLock();
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Matching setPointerCapture may not have succeeded on every platform.
      }

      if (!dragState.claimed) return;
      event.preventDefault();

      const release = resolveSkillsCategoryBackSwipeRelease({
        x: categorySwipeX.get(),
        velocityX: dragState.velocityX,
        viewportWidth: dragState.viewportWidth,
      });

      if (!release.shouldCloseCategory) {
        animateCategorySwipeTo(0, () => {
          setIsCategorySwipeActive(false);
        });
        return;
      }

      setIsCategorySwipeActive(true);
      animateCategorySwipeTo(
        dragState.viewportWidth,
        closeCategoryWithSwipeCommit,
        mobileStackCommitTransition
      );
    },
    [
      animateCategorySwipeTo,
      categorySwipeX,
      closeCategoryWithSwipeCommit,
      releaseCategorySwipeScrollLock,
    ]
  );

  const handleCategorySwipePointerCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const dragState = categorySwipeDragStateRef.current;
      if (dragState && dragState.pointerId === event.pointerId) {
        categorySwipeDragStateRef.current = null;
        releaseCategorySwipeScrollLock();
        animateCategorySwipeTo(0, () => {
          setIsCategorySwipeActive(false);
        });
      }
    },
    [animateCategorySwipeTo, releaseCategorySwipeScrollLock]
  );

  const handleCategorySwipeTouchStartCapture = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      if (!selectedCategoryId) return;
      if (event.touches.length !== 1) return;
      const viewportWidth = skillsCategoryBackSwipeViewportWidth();
      if (viewportWidth >= mobileSwipeBackConfig.desktopMinWidth) return;
      if (isInteractiveSkillsCategoryBackSwipeTarget(event.target)) return;
      const touch = event.touches[0];
      if (!touch) return;
      stopCategorySwipeAnimation();
      const scrollElement = event.currentTarget;

      categorySwipeTouchGuardStateRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        viewportWidth,
        isGuarding: false,
        scrollElement,
        startScrollTop: scrollElement.scrollTop,
      };
    },
    [selectedCategoryId, stopCategorySwipeAnimation]
  );

  const handleCategorySwipeTouchMoveCapture = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const guardState = categorySwipeTouchGuardStateRef.current;
      const touch = event.touches[0];
      if (!guardState || !touch) return;

      const deltaX = touch.clientX - guardState.startX;
      const deltaY = touch.clientY - guardState.startY;

      if (
        guardState.isGuarding &&
        shouldReleaseSkillsCategoryBackSwipeScrollGuard({
          startX: guardState.startX,
          deltaX,
          deltaY,
          viewportWidth: guardState.viewportWidth,
        })
      ) {
        categorySwipeTouchGuardStateRef.current = null;
        releaseCategorySwipeScrollLock();
        return;
      }

      if (
        !guardState.isGuarding &&
        shouldCancelSkillsCategoryBackSwipe({
          startX: guardState.startX,
          deltaX,
          deltaY,
          viewportWidth: guardState.viewportWidth,
        })
      ) {
        categorySwipeTouchGuardStateRef.current = null;
        releaseCategorySwipeScrollLock();
        return;
      }

      if (
        guardState.isGuarding ||
        shouldGuardSkillsCategoryBackSwipeScroll({
          startX: guardState.startX,
          deltaX,
          deltaY,
          viewportWidth: guardState.viewportWidth,
        })
      ) {
        guardState.isGuarding = true;
        event.preventDefault();
        categorySwipeScrollLockRef.current = ensureSkillsCategoryBackSwipeScrollLock(
          categorySwipeScrollLockRef.current,
          guardState.scrollElement,
          guardState.startScrollTop
        );
      }
    },
    [releaseCategorySwipeScrollLock]
  );

  const clearCategorySwipeTouchGuard = useCallback(() => {
    categorySwipeTouchGuardStateRef.current = null;
    if (!categorySwipeDragStateRef.current?.claimed) releaseCategorySwipeScrollLock();
  }, [releaseCategorySwipeScrollLock]);

  const openCreateSkillChat = useCallback(() => {
    onOpenChat?.(t("skills.createChatPrompt"), { autoSend: true, newSession: true });
  }, [onOpenChat, t]);

  const clearFilters = useCallback(() => {
    setSearchQuery("");
    setStatusFilter("all");
    setIsFilterOpen(false);
  }, []);

  const openEditSkillChat = useCallback(
    (skill: SkillInfo) => {
      onOpenChat?.(
        t("skills.editChatPrompt", {
          name: skillTitle(skill),
          id: skill.id,
          directory: skillEditDirectory(skill),
        }),
        { autoSend: true, newSession: true }
      );
    },
    [onOpenChat, t]
  );

  const openConnectorChat = useCallback(
    (connector: string, label: string) => {
      if (onOpenSessionAction) {
        onOpenSessionAction(
          {
            type: "connector.auth.start",
            connector,
            source: "skills_page",
          },
          t("skills.connectChatPrompt", { name: label })
        );
        return;
      }
      onOpenChat?.(t("skills.connectChatPrompt", { name: label }), { autoSend: true });
    },
    [onOpenChat, onOpenSessionAction, t]
  );

  const updateCachedSkills = useCallback(
    (updater: (current: SkillInfo[]) => SkillInfo[]) => {
      setSkills((current) => {
        const nextSkills = updater(current);
        const snapshot = { skills: nextSkills, loadedAt: Date.now() };
        skillSnapshotCache.set(userId, snapshot);
        lastRefreshAtRef.current = snapshot.loadedAt;
        return nextSkills;
      });
    },
    [userId]
  );

  const replaceSkill = useCallback(
    (next: SkillInfo) => {
      updateCachedSkills((current) =>
        current.map((skill) => (skill.id === next.id ? next : skill))
      );
    },
    [updateCachedSkills]
  );

  const handleValidate = useCallback(
    async (skill: SkillInfo) => {
      setBusySkillId(skill.id);
      setConfirmDeleteSkillId(null);
      setActionError(null);
      try {
        const validation = await validateSkill(skill.id);
        replaceSkill({ ...skill, validation });
        await loadSkills({ force: true, background: true });
        setActionMessage(t("skills.validated"));
      } catch (error) {
        setActionError(error instanceof Error ? error.message : t("skills.failed"));
      } finally {
        setBusySkillId(null);
      }
    },
    [loadSkills, replaceSkill, t]
  );

  const handleToggle = useCallback(
    async (skill: SkillInfo) => {
      setBusySkillId(skill.id);
      setConfirmDeleteSkillId(null);
      setActionError(null);
      try {
        const next = await updateSkill(skill.id, { enabled: skill.desired_state !== "enabled" });
        replaceSkill(next);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : t("skills.failed"));
      } finally {
        setBusySkillId(null);
      }
    },
    [replaceSkill, t]
  );

  const handleDelete = useCallback(
    async (skill: SkillInfo) => {
      if (confirmDeleteSkillId !== skill.id) {
        setConfirmDeleteSkillId(skill.id);
        setActionError(null);
        setActionMessage(null);
        return;
      }
      setBusySkillId(skill.id);
      setActionError(null);
      try {
        await deleteSkill(skill.id);
        updateCachedSkills((current) => current.filter((item) => item.id !== skill.id));
        setConfirmDeleteSkillId(null);
        setActionMessage(t("skills.deleted"));
      } catch (error) {
        setActionError(error instanceof Error ? error.message : t("skills.failed"));
      } finally {
        setBusySkillId(null);
      }
    },
    [confirmDeleteSkillId, t, updateCachedSkills]
  );

  const handleDisconnectConnector = useCallback(
    async (connectorName: string, payload: Record<string, unknown> = {}) => {
      const accountSuffix = typeof payload.email === "string" ? `:${payload.email}` : "";
      const actionKey = `${connectorName}:disconnect${accountSuffix}`;
      if (confirmConnectorAction !== actionKey) {
        setConfirmConnectorAction(actionKey);
        return;
      }
      setPendingConnectorAction(actionKey);
      setActionError(null);
      setActionMessage(null);
      try {
        const result = await disconnectConnector(connectorName, payload);
        setActionMessage(actionDetail(result, t("skills.connectorUpdated")));
        setConfirmConnectorAction(null);
        await loadConnectors({ force: true });
      } catch (error) {
        if (error instanceof AuthError) {
          setActionError(t("skills.failed"));
        } else {
          setActionError(error instanceof Error ? error.message : t("skills.failed"));
        }
      } finally {
        setPendingConnectorAction(null);
      }
    },
    [confirmConnectorAction, loadConnectors, t]
  );

  const refreshAll = useCallback(async () => {
    await Promise.all([loadSkills({ force: true }), loadConnectors({ force: true })]);
  }, [loadConnectors, loadSkills]);

  const categoryLabel = useCallback(
    (category: SkillCategory) =>
      category.label || (category.labelKey ? t(category.labelKey) : t("skills.groupGeneral")),
    [t]
  );

  const statusFilterLabel = useCallback(
    (filter: string) => {
      if (filter === "all") return t("skills.filterAll");
      if (filter === "enabled") return t("skills.enabled");
      return t(skillStatusKey(filter));
    },
    [t]
  );

  const renderSkillCard = (skill: SkillInfo) => {
    const status = (skill.user_status || "not_enabled") as SkillUserStatus;
    const statusKey = skillStatusKey(status);
    const statusLabel = t(statusKey);
    const isBusy = busySkillId === skill.id;
    const readOnly = Boolean(skill.read_only || skill.source !== "user");
    const canEdit = !readOnly && skill.can_edit !== false && Boolean(onOpenChat);
    const isDescriptionExpanded = expandedDescriptionSkillId === skill.id;
    const isConfirmingDelete = confirmDeleteSkillId === skill.id;

    return (
      <div
        key={skill.id}
        data-ripple-skill-card="true"
        className="grid gap-2 bg-white px-2.5 py-2.5 transition-colors hover:bg-[#F8F9FA] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
      >
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <h3
              className={`truncate ${SKILLS_PAGE_TEXT_PRIMARY_CLASS} ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
            >
              {skillTitle(skill)}
            </h3>
            <span
              data-ripple-skill-status-icon="true"
              aria-label={statusLabel}
              title={statusLabel}
              className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${skillStatusClass(
                status
              )}`}
            >
              {skillStatusIcon(status)}
            </span>
          </div>
          <SkillDescriptionMarkdown
            content={skill.description}
            clamp={!isDescriptionExpanded}
            expanded={isDescriptionExpanded}
            onToggle={() =>
              setExpandedDescriptionSkillId((current) => (current === skill.id ? null : skill.id))
            }
            className={`mt-1 ${SKILLS_PAGE_TEXT_SECONDARY_CLASS} ${TYPOGRAPHY_META_CLASS}`}
          />
        </div>
        {!readOnly && (
          <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
            <button
              type="button"
              disabled={isBusy}
              onClick={() => void handleValidate(skill)}
              className={SKILL_ACTION_BUTTON_CLASS}
            >
              {isBusy ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
              {t("skills.validate")}
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={() => void handleToggle(skill)}
              className={SKILL_ACTION_BUTTON_CLASS}
            >
              <Power size={13} />
              {skill.desired_state === "enabled" ? t("skills.disable") : t("skills.enable")}
            </button>
            <button
              type="button"
              disabled={!canEdit}
              onClick={() => openEditSkillChat(skill)}
              className={SKILL_ACTION_BUTTON_CLASS}
            >
              <Pencil size={13} />
              {t("skills.edit")}
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={() => void handleDelete(skill)}
              className={SKILL_DANGER_ACTION_BUTTON_CLASS}
            >
              <Trash2 size={13} />
              {isConfirmingDelete ? t("skills.confirmDelete") : t("skills.delete")}
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderSearchAndFilters = () => (
    <div className="space-y-2">
      <div className="flex min-w-0 items-center gap-2">
        <label
          className={`${WORKBENCH_FIELD_CLASS} flex h-10 min-w-0 flex-1 items-center gap-2 px-3`}
        >
          <Search size={15} className={SKILLS_PAGE_TEXT_TERTIARY_CLASS} />
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t("skills.searchPlaceholder")}
            className={`min-w-0 flex-1 bg-transparent outline-none ${SKILLS_PAGE_TEXT_PRIMARY_CLASS} ${TYPOGRAPHY_BODY_CLASS} placeholder:text-[#8F959E]`}
          />
        </label>
        <button
          type="button"
          data-ripple-skill-filter-control="true"
          onClick={() => setIsFilterOpen((open) => !open)}
          className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border bg-white px-3 text-[#2B2F36] transition-colors hover:bg-[#F8F9FA] ${SKILLS_PAGE_BORDER_CLASS} ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
        >
          <SlidersHorizontal size={14} />
          <span className="hidden sm:inline">{t("skills.filter")}</span>
          {activeFilterCount > 0 && (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[#1456F0] px-1 text-[11px] leading-none text-white">
              {activeFilterCount}
            </span>
          )}
        </button>
      </div>
      {isFilterOpen && (
        <div
          className={`flex flex-wrap items-center gap-1.5 rounded-xl border bg-white p-2 ${SKILLS_PAGE_BORDER_CLASS}`}
        >
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter}
              type="button"
              onClick={() => setStatusFilter(filter)}
              className={`inline-flex h-8 items-center rounded-lg border px-2.5 ${TYPOGRAPHY_META_MEDIUM_CLASS} ${
                statusFilter === filter
                  ? "border-[#BACEFD] bg-[#F0F5FF] text-[#1456F0]"
                  : "border-[#DEE0E3] bg-white text-[#646A73]"
              }`}
            >
              {statusFilterLabel(filter)}
            </button>
          ))}
          {(searchQuery || statusFilter !== "all") && (
            <button
              type="button"
              onClick={clearFilters}
              className={`inline-flex h-8 items-center gap-1 rounded-lg border border-[#DEE0E3] bg-white px-2.5 text-[#646A73] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
            >
              <X size={12} />
              {t("skills.clearFilters")}
            </button>
          )}
        </div>
      )}
    </div>
  );

  const renderActiveFilterNotice = () => {
    if (activeFilterCount === 0) return null;
    return (
      <div
        data-ripple-skill-active-filter-notice="true"
        className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 ${WORKBENCH_SECTION_CLASS}`}
      >
        <div className={`${SKILLS_PAGE_TEXT_SECONDARY_CLASS} ${TYPOGRAPHY_META_MEDIUM_CLASS}`}>
          {t("skills.activeFilters")}
        </div>
        <button
          type="button"
          onClick={clearFilters}
          className={`inline-flex h-8 items-center gap-1 rounded-lg border border-[#DEE0E3] bg-white px-2.5 text-[#646A73] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
        >
          <X size={12} />
          {t("skills.clearFilters")}
        </button>
      </div>
    );
  };

  const renderConnectorPanel = (category: SkillCategory) => {
    const connectorName = connectorNameForCategory(category);
    if (!connectorName) return null;
    const connector = connectors.find((item) => item.name === connectorName);
    const status = connectorStatuses[connectorName] || null;
    const label = connector?.display_name || categoryLabel(category);
    const disconnectActionKey = `${connectorName}:disconnect`;
    const connected = Boolean(status?.connected);

    return (
      <div
        data-ripple-skill-connector-panel="true"
        className={`${WORKBENCH_SECTION_CLASS} p-3`}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className={`${SKILLS_PAGE_TEXT_PRIMARY_CLASS} ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>
              {label}
            </div>
            <div className={`mt-0.5 ${SKILLS_PAGE_TEXT_TERTIARY_CLASS} ${TYPOGRAPHY_META_CLASS}`}>
              {status?.detail || t("skills.connectorPanelHint")}
            </div>
          </div>
          <span
            className={`inline-flex h-6 shrink-0 items-center rounded-full border px-2 ${TYPOGRAPHY_MICRO_MEDIUM_CLASS} ${connectorStatusClass(
              status
            )}`}
          >
            {connected ? t("skills.connectorConnected") : t("skills.connectorNotConnected")}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {!connected && (
            <button
              type="button"
              onClick={() => openConnectorChat(connectorName, label)}
              disabled={!onOpenChat && !onOpenSessionAction}
              className={`inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#BACEFD] bg-[#F0F5FF] px-2.5 text-[#1456F0] transition-colors hover:bg-[#E8F0FF] disabled:opacity-60 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
            >
              <Plug size={13} />
              {t("skills.connectService")}
            </button>
          )}
          {connected && connector?.disconnect_path && (
            <button
              type="button"
              onClick={() => void handleDisconnectConnector(connectorName)}
              disabled={pendingConnectorAction === disconnectActionKey}
              className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 transition-colors disabled:opacity-60 ${TYPOGRAPHY_META_MEDIUM_CLASS} ${
                confirmConnectorAction === disconnectActionKey
                  ? "border-[#FAD4D4] bg-[#FFF1F0] text-[#B42318]"
                  : "border-[#DEE0E3] bg-white text-[#2B2F36] hover:bg-[#F8F9FA]"
              }`}
            >
              {pendingConnectorAction === disconnectActionKey ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Trash2 size={13} />
              )}
              {confirmConnectorAction === disconnectActionKey
                ? t("skills.confirmDisconnect")
                : t("skills.disconnectService")}
            </button>
          )}
        </div>
        {connectorName === "google_workspace" && googleAccounts.length > 0 && (
          <div
            className={`mt-2 divide-y overflow-hidden rounded-lg border ${SKILLS_PAGE_DIVIDER_CLASS}`}
          >
            {googleAccounts.map((account) => {
              const actionKey = `${connectorName}:disconnect:${account.email}`;
              return (
                <div
                  key={account.email}
                  data-ripple-skill-connector-account="true"
                  className={`flex flex-wrap items-center justify-between gap-2 bg-white px-2.5 py-2 ${TYPOGRAPHY_META_CLASS}`}
                >
                  <div className="min-w-0">
                    <div className="truncate font-[family-name:var(--font-mono)]">
                      {account.email}
                    </div>
                    <div className={`${SKILLS_PAGE_TEXT_TERTIARY_CLASS} ${TYPOGRAPHY_META_CLASS}`}>
                      {account.valid === false
                        ? t("skills.connectorAccountInvalid")
                        : t("skills.connectorAccountReady")}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void handleDisconnectConnector(connectorName, { email: account.email })
                    }
                    disabled={pendingConnectorAction === actionKey}
                    className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 disabled:opacity-60 ${TYPOGRAPHY_META_MEDIUM_CLASS} ${
                      confirmConnectorAction === actionKey
                        ? "border-[#FAD4D4] bg-[#FFF1F0] text-[#B42318]"
                        : "border-[#DEE0E3] bg-white text-[#2B2F36]"
                    }`}
                  >
                    {pendingConnectorAction === actionKey ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Trash2 size={13} />
                    )}
                    {confirmConnectorAction === actionKey
                      ? t("skills.confirmDisconnect")
                      : t("skills.removeAccount")}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const renderCategoryRow = (category: SkillCategory) => {
    const connectorName = connectorNameForCategory(category);
    const status = connectorName ? connectorStatuses[connectorName] : null;
    const summary = categorySummary(category, googleAccounts.length, t);
    const availableInCategory = category.skills.filter(
      (skill) => skill.user_status === "available"
    ).length;
    const connectorStatusLabel = connectorName
      ? status?.connected
        ? t("skills.connectorConnected")
        : t("skills.connectorNotConnected")
      : null;
    const mobileConnectorStatusLabel =
      connectorName === "google_workspace" && googleAccounts.length > 0 && connectorStatusLabel
        ? `${connectorStatusLabel} · ${t("skills.accountCount", { count: googleAccounts.length })}`
        : connectorStatusLabel;

    return (
      <button
        key={category.id}
        type="button"
        data-ripple-skill-category-row="true"
        onClick={() => openCategory(category.id)}
        className="flex min-h-[76px] w-full items-center gap-3 bg-white px-3 py-2.5 text-left transition-colors hover:bg-[#F8F9FA] active:bg-[#EFF0F1]"
      >
        <CategoryLogo category={category} status={status} />
        <div className="min-w-0 flex-1">
          <div
            className={`truncate ${SKILLS_PAGE_TEXT_PRIMARY_CLASS} ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
          >
            {categoryLabel(category)}
          </div>
          <div
            className={`mt-1 line-clamp-1 ${SKILLS_PAGE_TEXT_SECONDARY_CLASS} ${TYPOGRAPHY_META_CLASS}`}
          >
            {summary}
          </div>
          <div className={`mt-1 ${SKILLS_PAGE_TEXT_TERTIARY_CLASS} ${TYPOGRAPHY_META_CLASS}`}>
            {t("skills.readyCount", {
              available: availableInCategory,
              total: category.skills.length,
            })}
          </div>
          {mobileConnectorStatusLabel && (
            <span
              data-ripple-skill-category-mobile-status="true"
              className={`mt-1.5 inline-flex h-6 max-w-full items-center truncate rounded-full border px-2 sm:hidden ${TYPOGRAPHY_MICRO_MEDIUM_CLASS} ${connectorStatusClass(
                status
              )}`}
            >
              {mobileConnectorStatusLabel}
            </span>
          )}
        </div>
        {connectorName && (
          <span
            className={`hidden h-6 shrink-0 items-center rounded-full border px-2 sm:inline-flex ${TYPOGRAPHY_MICRO_MEDIUM_CLASS} ${connectorStatusClass(
              status
            )}`}
          >
            {connectorStatusLabel}
          </span>
        )}
        <ChevronRight size={16} className={`shrink-0 ${SKILLS_PAGE_TEXT_TERTIARY_CLASS}`} />
      </button>
    );
  };

  const renderCategoryIndex = () => (
    <div data-ripple-skill-category-index="true" className="space-y-3">
      {filteredSections.map((section) => (
        <section key={section.id} className="space-y-2">
          <div
            className={`px-0.5 ${SKILLS_PAGE_TEXT_PRIMARY_CLASS} ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
          >
            {t(section.labelKey)}
          </div>
          <div
            data-ripple-skill-category-group="true"
            className={`overflow-hidden rounded-lg border ${SKILLS_PAGE_BORDER_CLASS} bg-white shadow-[0_1px_2px_rgba(31,35,41,0.04)] divide-y divide-[#EFF0F1]`}
          >
            {section.categories.map(renderCategoryRow)}
          </div>
        </section>
      ))}
      {filteredSections.length === 0 && (
        <div
          className={`flex h-28 items-center justify-center rounded-xl border border-dashed ${SKILLS_PAGE_BORDER_CLASS} bg-white ${SKILLS_PAGE_TEXT_TERTIARY_CLASS} ${TYPOGRAPHY_BODY_CLASS}`}
        >
          {t("skills.noResults")}
        </div>
      )}
    </div>
  );

  const renderEmptySkillsState = () => (
    <div
      className={`flex h-32 items-center justify-center rounded-xl border border-dashed ${SKILLS_PAGE_BORDER_CLASS} bg-white ${SKILLS_PAGE_TEXT_TERTIARY_CLASS} ${TYPOGRAPHY_BODY_CLASS}`}
    >
      {t("skills.empty")}
    </div>
  );

  const renderActionMessage = () => {
    if (!actionMessage && !actionError) return null;
    return (
      <div
        className={`rounded-lg border px-3 py-2 ${TYPOGRAPHY_META_MEDIUM_CLASS} ${
          actionError
            ? "border-[#FDCACA] bg-[#FFF1F0] text-[#B42318]"
            : "border-[#BACEFD] bg-[#F0F5FF] text-[#1456F0]"
        }`}
      >
        {actionError || actionMessage}
      </div>
    );
  };

  const renderCategoryIndexPage = () => (
    <div data-ripple-skill-category-index-page="true" className="space-y-2.5">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label={t("connectors.backToSettings")}
              title={t("connectors.backToSettings")}
              className={`${WORKBENCH_MOBILE_ICON_BUTTON_CLASS} mt-0.5 lg:hidden`}
            >
              <ArrowLeft size={15} strokeWidth={LUCIDE_NAV_STROKE_WIDTH} />
            </button>
          )}
          <div className="min-w-0">
            <h1 className={TYPOGRAPHY_PAGE_TITLE_CLASS}>
              <span className="sm:hidden">{t("skills.title")}</span>
              <span className="hidden sm:inline">{t("skills.title")}</span>
            </h1>
            <div className={`mt-1 ${SKILLS_PAGE_TEXT_TERTIARY_CLASS} ${TYPOGRAPHY_META_CLASS}`}>
              {t("skills.readyCount", { available: availableCount, total: skills.length })}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={openCreateSkillChat}
            disabled={!onOpenChat}
            className={SKILL_CREATE_ACTION_BUTTON_CLASS}
            aria-label={t("skills.create")}
            title={t("skills.create")}
          >
            <MessageSquare size={18} />
            <span className="hidden lg:inline">{t("skills.create")}</span>
          </button>
          <button
            type="button"
            onClick={() => void refreshAll()}
            disabled={isLoading || isConnectorLoading}
            title={t("skills.refresh")}
            aria-label={t("skills.refresh")}
            className={`${WORKBENCH_MOBILE_ICON_BUTTON_CLASS} shrink-0 disabled:cursor-not-allowed disabled:opacity-60 lg:h-10 lg:w-auto lg:gap-1.5 lg:px-3 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
          >
            {isLoading || isConnectorLoading ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <RefreshCw size={18} strokeWidth={LUCIDE_NAV_STROKE_WIDTH} />
            )}
            <span className="hidden lg:inline">{t("skills.refresh")}</span>
          </button>
        </div>
      </header>
      {renderActionMessage()}
      {renderSearchAndFilters()}
      {skills.length === 0 ? renderEmptySkillsState() : renderCategoryIndex()}
    </div>
  );

  const renderCategoryDetail = (category: SkillCategory) => (
    <section data-ripple-skill-category-detail="true" className="space-y-2.5">
      <MobilePageHeader
        title={categoryLabel(category)}
        subtitle={t("skills.readyCount", {
          available: category.skills.filter((skill) => skill.user_status === "available").length,
          total: category.skills.length,
        })}
        backLabel={t("skills.backToCategories")}
        onBack={closeCategory}
        className="-mx-3 -mt-[max(env(safe-area-inset-top),12px)] md:-mx-6"
      />
      <div className="hidden items-start gap-2 lg:flex">
        <button
          type="button"
          onClick={closeCategory}
          aria-label={t("skills.backToCategories")}
          title={t("skills.backToCategories")}
          className={`${WORKBENCH_MOBILE_ICON_BUTTON_CLASS} shrink-0 lg:h-10 lg:w-10`}
        >
          <ArrowLeft size={15} strokeWidth={LUCIDE_NAV_STROKE_WIDTH} />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className={TYPOGRAPHY_PAGE_TITLE_CLASS}>{categoryLabel(category)}</h2>
          <div className={`mt-1 ${SKILLS_PAGE_TEXT_TERTIARY_CLASS} ${TYPOGRAPHY_META_CLASS}`}>
            {t("skills.readyCount", {
              available: category.skills.filter((skill) => skill.user_status === "available")
                .length,
              total: category.skills.length,
            })}
          </div>
        </div>
      </div>
      {renderConnectorPanel(category)}
      {renderActiveFilterNotice()}
      <div className={`overflow-hidden ${WORKBENCH_SECTION_CLASS}`}>
        {selectedCategorySkills.length === 0 ? (
          <div
            className={`flex h-28 items-center justify-center ${SKILLS_PAGE_TEXT_TERTIARY_CLASS} ${TYPOGRAPHY_BODY_CLASS}`}
          >
            {t("skills.noResults")}
          </div>
        ) : (
          <div className="divide-y divide-[#EFF0F1]">
            {selectedCategorySkills.map(renderSkillCard)}
          </div>
        )}
      </div>
    </section>
  );

  const renderCategoryDetailPage = (category: SkillCategory) => (
    <div data-ripple-skill-category-detail-page="true" className="space-y-2.5">
      {renderActionMessage()}
      {renderCategoryDetail(category)}
    </div>
  );

  const renderCategoryStage = () => {
    if (!selectedCategory) return renderCategoryIndexPage();

    return (
      <div
        data-ripple-skill-category-swipe-stack="true"
        className="relative h-full min-h-0 min-w-0 overflow-hidden bg-[#F5F6F7] lg:h-auto lg:overflow-visible"
      >
        <div
          data-ripple-skill-category-index-underlay="true"
          aria-hidden="true"
          className={`pointer-events-none absolute inset-0 z-0 overflow-y-auto px-3 ${MOBILE_PAGE_TOP_SAFE_AREA_CLASS} ${MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS} lg:hidden ${
            isCategorySwipeActive ? "opacity-100" : "opacity-0"
          }`}
        >
          {renderCategoryIndexPage()}
        </div>
        <motion.div
          data-ripple-skill-category-swipe-sheet="true"
          data-ripple-skill-category-scroll="detail"
          data-ripple-skill-category-swiping={isCategorySwipeActive ? "true" : "false"}
          style={{ x: categorySwipeX }}
          className={`absolute inset-0 z-10 h-full min-h-0 touch-pan-y overflow-y-auto bg-[#F5F6F7] px-3 ${MOBILE_PAGE_TOP_SAFE_AREA_CLASS} ${MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS} ${isCategorySwipeActive ? "shadow-[-18px_0_44px_rgba(31,35,41,0.18)]" : "shadow-none"} ${isCategorySwipeActive ? "will-change-transform" : "will-change-auto"} lg:relative lg:inset-auto lg:h-auto lg:overflow-visible lg:px-0 lg:pt-0 lg:pb-0 lg:shadow-none lg:will-change-auto`}
          onPointerDown={handleCategorySwipePointerDown}
          onPointerMove={handleCategorySwipePointerMove}
          onPointerUp={handleCategorySwipePointerUp}
          onPointerCancel={handleCategorySwipePointerCancel}
          onTouchStartCapture={handleCategorySwipeTouchStartCapture}
          onTouchMoveCapture={handleCategorySwipeTouchMoveCapture}
          onTouchEndCapture={clearCategorySwipeTouchGuard}
          onTouchCancelCapture={clearCategorySwipeTouchGuard}
        >
          {renderCategoryDetailPage(selectedCategory)}
        </motion.div>
      </div>
    );
  };
  const shouldRenderStaticCategoryContent = skipNextCategoryTransition;
  const renderCategoryMotionContent = () => {
    if (shouldRenderStaticCategoryContent) {
      return (
        <div
          data-ripple-skill-category-static-stage="true"
          className={`w-full min-w-0 ${selectedCategory ? "h-full min-h-0 lg:h-auto" : ""}`}
        >
          {selectedCategory ? renderCategoryStage() : renderCategoryIndexPage()}
        </div>
      );
    }

    return (
      <AnimatePresence
        mode="popLayout"
        initial={false}
        custom={skipNextCategoryTransition ? 0 : categoryTransitionDirection}
      >
        <motion.div
          key={selectedCategory ? `detail:${selectedCategory.id}` : "index"}
          data-ripple-skill-category-motion-stage="true"
          custom={skipNextCategoryTransition ? 0 : categoryTransitionDirection}
          variants={
            skipNextCategoryTransition || reduceMotion
              ? reducedMobilePageVariants
              : mobilePageVariants
          }
          initial={skipNextCategoryTransition ? false : "enter"}
          animate="center"
          exit="exit"
          transition={
            skipNextCategoryTransition || reduceMotion
              ? reducedMotionTransition
              : mobilePageSwitchTransition
          }
          className={`w-full min-w-0 ${selectedCategory ? "h-full min-h-0 lg:h-auto" : ""}`}
        >
          {renderCategoryStage()}
        </motion.div>
      </AnimatePresence>
    );
  };

  return (
    <div
      ref={skillsPageScrollRef}
      data-ripple-skills-page="true"
      className={`flex h-full min-h-0 touch-pan-y flex-col ${WORKBENCH_PAGE_BACKGROUND_CLASS} ${SKILLS_PAGE_TEXT_PRIMARY_CLASS} ${
        selectedCategory
          ? "overflow-hidden px-0 pt-0 pb-0 lg:overflow-y-auto lg:px-6 lg:pt-[max(env(safe-area-inset-top),12px)] lg:pb-5"
          : `overflow-y-auto px-3 ${MOBILE_PAGE_TOP_SAFE_AREA_CLASS} ${MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS} md:px-6 lg:pb-5`
      }`}
    >
      <div
        className={`${WORKBENCH_PAGE_CONTENT_CLASS} ${
          selectedCategory ? "h-full min-h-0 lg:h-auto" : "relative"
        }`}
      >
        {renderCategoryMotionContent()}
      </div>
    </div>
  );
}
