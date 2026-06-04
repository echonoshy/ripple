"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowBigLeft,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Loader2,
  Pencil,
  Plug,
  MessageSquare,
  Power,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { deleteSkill, fetchSkills, updateSkill, validateSkill } from "@/lib/api";
import { type MessageKey, useI18n } from "@/i18n";
import type { SessionControlAction, SkillInfo, SkillUserStatus } from "@/types";
import {
  COMPACT_IOS_PAGE_BACKGROUND,
  LUCIDE_NAV_STROKE_WIDTH,
  LUCIDE_STANDARD_STROKE_WIDTH,
  MOBILE_GLASS_ICON_BUTTON_CLASS,
  MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS,
  MOBILE_PAGE_TOP_SAFE_AREA_CLASS,
  TYPOGRAPHY_BODY_CLASS,
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_META_MEDIUM_CLASS,
  TYPOGRAPHY_MICRO_MEDIUM_CLASS,
  TYPOGRAPHY_PAGE_TITLE_CLASS,
  WORKBENCH_PAGE_CONTENT_CLASS,
} from "./stylePrimitives";

const SKILL_REFRESH_THROTTLE_MS = 10_000;
const SKILLS_PAGE_TEXT_PRIMARY_CLASS = "text-[#1F2329]";
const SKILLS_PAGE_TEXT_SECONDARY_CLASS = "text-[#646A73]";
const SKILLS_PAGE_TEXT_TERTIARY_CLASS = "text-[#8F959E]";
const SKILLS_PAGE_BORDER_CLASS = "border-[#DEE0E3]";
const SKILLS_PAGE_DIVIDER_CLASS = "border-[#EFF0F1]";
const SKILL_ACTION_BUTTON_CLASS = `inline-flex h-8 items-center gap-1.5 rounded-lg border ${SKILLS_PAGE_BORDER_CLASS} bg-white px-2.5 text-[#2B2F36] transition-colors hover:bg-[#F8F9FA] disabled:opacity-60 ${TYPOGRAPHY_META_MEDIUM_CLASS}`;
const SKILL_PRIMARY_ACTION_BUTTON_CLASS = `inline-flex h-11 w-11 items-center justify-center rounded-full border border-[#1456F0]/30 bg-[#1456F0] text-white shadow-[0_8px_18px_rgba(20,86,240,0.18)] transition-all hover:bg-[#0F4BD8] active:scale-[0.98] disabled:opacity-60 lg:h-10 lg:w-auto lg:gap-1.5 lg:px-3 ${TYPOGRAPHY_META_MEDIUM_CLASS}`;
const SKILL_DANGER_ACTION_BUTTON_CLASS = `inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#FAD4D4] bg-white px-2.5 text-[#B42318] transition-colors hover:bg-[#FFF1F0] disabled:opacity-60 ${TYPOGRAPHY_META_MEDIUM_CLASS}`;

interface SkillSnapshot {
  skills: SkillInfo[];
  loadedAt: number;
}

interface SkillsPageProps {
  userId: string;
  onBack?: () => void;
  onOpenChat?: (prompt: string, options?: { autoSend?: boolean; newSession?: boolean }) => void;
  onOpenSessionAction?: (action: SessionControlAction, label: string) => void;
}

type SkillSourceId = "user" | "system";
type SkillConnectorGroupId =
  | "feishu"
  | "google_workspace"
  | "bilibili"
  | "notion"
  | "custom"
  | "general";

interface SkillConnectorGroup {
  id: string;
  groupId: SkillConnectorGroupId;
  sourceId: SkillSourceId;
  labelKey?: MessageKey;
  label?: string;
  status: SkillUserStatus | string;
  defaultOpen: boolean;
  skills: SkillInfo[];
}

interface SkillSourceSection {
  id: SkillSourceId;
  labelKey: MessageKey;
  groups: SkillConnectorGroup[];
}

const CONNECTOR_GROUP_ORDER: SkillConnectorGroupId[] = [
  "custom",
  "feishu",
  "google_workspace",
  "bilibili",
  "notion",
  "general",
];

const CONNECTOR_GROUP_LABELS: Record<
  SkillConnectorGroupId,
  { label?: string; labelKey?: MessageKey }
> = {
  feishu: { label: "Feishu / Lark" },
  google_workspace: { label: "Google Workspace" },
  bilibili: { label: "Bilibili" },
  notion: { label: "Notion" },
  custom: { labelKey: "skills.groupCustom" },
  general: { labelKey: "skills.groupGeneral" },
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

const skillSnapshotCache = new Map<string, SkillSnapshot>();
const skillSnapshotInflight = new Map<string, Promise<SkillSnapshot>>();

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

function connectorGroupIdForSkill(skill: SkillInfo): SkillConnectorGroupId {
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

function groupStatusForSkills(skills: SkillInfo[]): SkillUserStatus | string {
  return (
    [...skills].sort((left, right) => skillStatusRank(left) - skillStatusRank(right))[0]
      ?.user_status || "not_enabled"
  );
}

function shouldDefaultOpenGroup(sourceId: SkillSourceId, status: string): boolean {
  return (
    sourceId === "user" ||
    status === "needs_connection" ||
    status === "needs_fix" ||
    status === "unavailable"
  );
}

function sortSkillsForDisplay(skills: SkillInfo[]): SkillInfo[] {
  return [...skills].sort((left, right) => {
    const rank = skillStatusRank(left) - skillStatusRank(right);
    if (rank !== 0) return rank;
    return skillTitle(left).localeCompare(skillTitle(right));
  });
}

function buildSkillSections(skills: SkillInfo[]): SkillSourceSection[] {
  const grouped = new Map<SkillSourceId, Map<SkillConnectorGroupId, SkillInfo[]>>();
  for (const skill of skills) {
    const sourceId = sourceIdForSkill(skill);
    const groupId = connectorGroupIdForSkill(skill);
    const sourceGroups = grouped.get(sourceId) || new Map<SkillConnectorGroupId, SkillInfo[]>();
    sourceGroups.set(groupId, [...(sourceGroups.get(groupId) || []), skill]);
    grouped.set(sourceId, sourceGroups);
  }

  return [
    { id: "user" as const, labelKey: "skills.mine" as const },
    { id: "system" as const, labelKey: "skills.builtIn" as const },
  ]
    .map((source) => {
      const sourceGroups = grouped.get(source.id);
      const groups = CONNECTOR_GROUP_ORDER.flatMap((groupId) => {
        const groupSkills = sourceGroups?.get(groupId);
        if (!groupSkills?.length) return [];
        const status = groupStatusForSkills(groupSkills);
        const labelConfig = CONNECTOR_GROUP_LABELS[groupId];
        return [
          {
            id: `${source.id}:${groupId}`,
            groupId,
            sourceId: source.id,
            label: labelConfig.label,
            labelKey: labelConfig.labelKey,
            status,
            defaultOpen: shouldDefaultOpenGroup(source.id, status),
            skills: sortSkillsForDisplay(groupSkills),
          },
        ];
      });
      return { ...source, groups };
    })
    .filter((section) => section.groups.length > 0);
}

function connectorNameForGroup(group: SkillConnectorGroup): string | null {
  if (
    group.groupId === "feishu" ||
    group.groupId === "google_workspace" ||
    group.groupId === "bilibili" ||
    group.groupId === "notion"
  ) {
    return group.groupId;
  }
  return null;
}

export default function SkillsPage({
  userId,
  onBack,
  onOpenChat,
  onOpenSessionAction,
}: SkillsPageProps) {
  const { t } = useI18n();
  const [skills, setSkills] = useState<SkillInfo[]>(
    () => cachedSkillSnapshot(userId)?.skills || []
  );
  const [isLoading, setIsLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busySkillId, setBusySkillId] = useState<string | null>(null);
  const [openGroupIds, setOpenGroupIds] = useState<Set<string>>(new Set());
  const loadRequestIdRef = useRef(0);
  const lastRefreshAtRef = useRef(cachedSkillSnapshot(userId)?.loadedAt || 0);

  const applySnapshot = useCallback((snapshot: SkillSnapshot) => {
    setSkills(snapshot.skills);
    lastRefreshAtRef.current = snapshot.loadedAt;
  }, []);

  const loadSkills = useCallback(
    async (options: { force?: boolean; background?: boolean } = {}) => {
      const cached = options.force ? null : cachedSkillSnapshot(userId);
      if (cached) {
        applySnapshot(cached);
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
        applySnapshot(snapshot);
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
    [applySnapshot, t, userId]
  );

  useEffect(() => {
    const cached = cachedSkillSnapshot(userId);
    if (cached) {
      applySnapshot(cached);
    } else {
      setSkills([]);
      lastRefreshAtRef.current = 0;
    }
    void loadSkills({ background: hasSkillSnapshot(userId) });
  }, [applySnapshot, loadSkills, userId]);

  const sections = useMemo(() => buildSkillSections(skills), [skills]);
  const availableCount = useMemo(
    () => skills.filter((skill) => skill.user_status === "available").length,
    [skills]
  );
  const defaultOpenGroupKey = useMemo(
    () =>
      sections
        .flatMap((section) => section.groups)
        .filter((group) => group.defaultOpen)
        .map((group) => group.id)
        .join("|"),
    [sections]
  );

  useEffect(() => {
    setOpenGroupIds(
      new Set(
        sections
          .flatMap((section) => section.groups)
          .filter((group) => group.defaultOpen)
          .map((group) => group.id)
      )
    );
  }, [defaultOpenGroupKey, sections]);

  const openCreateSkillChat = useCallback(() => {
    onOpenChat?.(t("skills.createChatPrompt"), { autoSend: true, newSession: true });
  }, [onOpenChat, t]);

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
    (group: SkillConnectorGroup) => {
      const name = group.label || (group.labelKey ? t(group.labelKey) : t("skills.groupGeneral"));
      const connector = connectorNameForGroup(group);
      if (connector && onOpenSessionAction) {
        onOpenSessionAction(
          {
            type: "connector.auth.start",
            connector,
            source: "skills_page",
          },
          t("skills.connectChatPrompt", { name })
        );
        return;
      }
      onOpenChat?.(t("skills.connectChatPrompt", { name }), { autoSend: true });
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

  const toggleGroup = useCallback((groupId: string) => {
    setOpenGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const handleValidate = useCallback(
    async (skill: SkillInfo) => {
      setBusySkillId(skill.id);
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
      setBusySkillId(skill.id);
      setActionError(null);
      try {
        await deleteSkill(skill.id);
        updateCachedSkills((current) => current.filter((item) => item.id !== skill.id));
        setActionMessage(t("skills.deleted"));
      } catch (error) {
        setActionError(error instanceof Error ? error.message : t("skills.failed"));
      } finally {
        setBusySkillId(null);
      }
    },
    [t, updateCachedSkills]
  );

  const renderSkillCard = (skill: SkillInfo) => {
    const status = (skill.user_status || "not_enabled") as SkillUserStatus;
    const isBusy = busySkillId === skill.id;
    const readOnly = Boolean(skill.read_only || skill.source !== "user");
    const canEdit = !readOnly && skill.can_edit !== false && Boolean(onOpenChat);

    return (
      <details
        key={skill.id}
        data-ripple-skill-card="true"
        className="group/skill overflow-hidden bg-white/86"
      >
        <summary className="flex cursor-pointer list-none items-start gap-2.5 px-2.5 py-2.5 transition-colors hover:bg-[#F8F9FA] [&::-webkit-details-marker]:hidden">
          <div
            className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-[#F8F9FA] text-[#1456F0] ${SKILLS_PAGE_BORDER_CLASS}`}
          >
            <ChevronRight
              size={14}
              className="transition-transform group-open/skill:rotate-90"
              strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <h3
                className={`truncate ${SKILLS_PAGE_TEXT_PRIMARY_CLASS} ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
              >
                {skillTitle(skill)}
              </h3>
              <span
                className={`inline-flex h-6 items-center gap-1 rounded-full border px-2 ${TYPOGRAPHY_MICRO_MEDIUM_CLASS} ${skillStatusClass(status)}`}
              >
                {skillStatusIcon(status)}
                {t(skillStatusKey(status))}
              </span>
              <span className={`${SKILLS_PAGE_TEXT_TERTIARY_CLASS} ${TYPOGRAPHY_META_CLASS}`}>
                {readOnly ? t("skills.builtIn") : t("skills.mine")}
              </span>
            </div>
            <p
              className={`mt-1 line-clamp-2 ${SKILLS_PAGE_TEXT_SECONDARY_CLASS} group-open/skill:hidden ${TYPOGRAPHY_META_CLASS}`}
            >
              {skill.description}
            </p>
          </div>
        </summary>
        <div
          className={`space-y-2 border-t bg-[#F8F9FA]/70 px-2.5 py-2 ${SKILLS_PAGE_DIVIDER_CLASS}`}
        >
          <p className={`${SKILLS_PAGE_TEXT_SECONDARY_CLASS} ${TYPOGRAPHY_META_CLASS}`}>
            {skill.description}
          </p>
          {!readOnly && (
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void handleValidate(skill)}
                className={SKILL_ACTION_BUTTON_CLASS}
              >
                {isBusy ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <CheckCircle2 size={13} />
                )}
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
                onClick={() => canEdit && openEditSkillChat(skill)}
                className={`${SKILL_ACTION_BUTTON_CLASS} ${canEdit ? "" : "pointer-events-none opacity-60"}`}
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
                {t("skills.delete")}
              </button>
            </div>
          )}
          {readOnly && (
            <span
              className={`inline-flex h-7 items-center ${SKILLS_PAGE_TEXT_TERTIARY_CLASS} ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`}
            >
              {t("skills.readOnly")}
            </span>
          )}
        </div>
      </details>
    );
  };

  const renderConnectorGroup = (group: SkillConnectorGroup) => {
    const isOpen = openGroupIds.has(group.id);
    const availableInGroup = group.skills.filter(
      (skill) => skill.user_status === "available"
    ).length;
    const groupLabel =
      group.label || (group.labelKey ? t(group.labelKey) : t("skills.groupGeneral"));
    const needsConnection = group.skills.some((skill) => skill.user_status === "needs_connection");

    return (
      <section
        key={group.id}
        data-ripple-skill-connector-group="true"
        className={`overflow-hidden rounded-xl border bg-white/82 shadow-[0_10px_24px_rgba(31,35,41,0.045)] backdrop-blur-xl ${SKILLS_PAGE_BORDER_CLASS}`}
      >
        <div
          className={`flex items-center gap-2 border-b bg-[#F8F9FA]/88 px-2.5 py-2 ${SKILLS_PAGE_DIVIDER_CLASS}`}
        >
          <button
            type="button"
            onClick={() => toggleGroup(group.id)}
            aria-expanded={isOpen}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            {isOpen ? (
              <ChevronDown size={15} className={`shrink-0 ${SKILLS_PAGE_TEXT_TERTIARY_CLASS}`} />
            ) : (
              <ChevronRight size={15} className={`shrink-0 ${SKILLS_PAGE_TEXT_TERTIARY_CLASS}`} />
            )}
            <div className="min-w-0 flex-1">
              <div
                className={`truncate ${SKILLS_PAGE_TEXT_PRIMARY_CLASS} ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
              >
                {groupLabel}
              </div>
              <div className={`mt-0.5 ${SKILLS_PAGE_TEXT_TERTIARY_CLASS} ${TYPOGRAPHY_META_CLASS}`}>
                {t("skills.readyCount", {
                  available: availableInGroup,
                  total: group.skills.length,
                })}
              </div>
            </div>
            <span
              className={`hidden h-6 shrink-0 items-center gap-1 rounded-full border px-2 sm:inline-flex ${TYPOGRAPHY_MICRO_MEDIUM_CLASS} ${skillStatusClass(group.status)}`}
            >
              {skillStatusIcon(group.status)}
              {t(skillStatusKey(group.status))}
            </span>
          </button>
          {needsConnection && (
            <button
              type="button"
              data-ripple-skill-group-connect="true"
              onClick={() => openConnectorChat(group)}
              disabled={!onOpenChat && !onOpenSessionAction}
              className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[#BACEFD] bg-[#F0F5FF] px-2.5 text-[#1456F0] transition-colors hover:bg-[#E8F0FF] disabled:opacity-60 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
            >
              <Plug size={13} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
              {t("skills.connectService")}
            </button>
          )}
        </div>
        {isOpen && (
          <div className="divide-y divide-[#EFF0F1]">{group.skills.map(renderSkillCard)}</div>
        )}
      </section>
    );
  };

  const renderSourceSection = (section: SkillSourceSection) => {
    const sectionSkills = section.groups.flatMap((group) => group.skills);
    const availableInSection = sectionSkills.filter(
      (skill) => skill.user_status === "available"
    ).length;

    return (
      <section key={section.id} data-ripple-skill-source-section="true" className="space-y-2">
        <div className="flex items-end justify-between gap-2 px-0.5">
          <div className={`${SKILLS_PAGE_TEXT_PRIMARY_CLASS} ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>
            {t(section.labelKey)}
          </div>
          <div className={`${SKILLS_PAGE_TEXT_TERTIARY_CLASS} ${TYPOGRAPHY_META_CLASS}`}>
            {t("skills.readyCount", {
              available: availableInSection,
              total: sectionSkills.length,
            })}
          </div>
        </div>
        <div className="space-y-2">{section.groups.map(renderConnectorGroup)}</div>
      </section>
    );
  };

  return (
    <div
      data-ripple-skills-page="true"
      className={`h-full min-h-0 overflow-y-auto ${COMPACT_IOS_PAGE_BACKGROUND} px-3 ${MOBILE_PAGE_TOP_SAFE_AREA_CLASS} ${MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS} ${SKILLS_PAGE_TEXT_PRIMARY_CLASS} md:px-6 lg:pb-5`}
    >
      <div className={`${WORKBENCH_PAGE_CONTENT_CLASS} space-y-2.5`}>
        <header className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2.5">
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                aria-label={t("connectors.backToSettings")}
                title={t("connectors.backToSettings")}
                className={`${MOBILE_GLASS_ICON_BUTTON_CLASS} mt-0.5 lg:hidden`}
              >
                <ArrowBigLeft size={15} strokeWidth={LUCIDE_NAV_STROKE_WIDTH} />
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
              className={SKILL_PRIMARY_ACTION_BUTTON_CLASS}
              aria-label={t("skills.create")}
              title={t("skills.create")}
            >
              <MessageSquare size={18} />
              <span className="hidden lg:inline">{t("skills.create")}</span>
            </button>
            <button
              type="button"
              onClick={() => void loadSkills({ force: true })}
              disabled={isLoading}
              title={t("skills.refresh")}
              aria-label={t("skills.refresh")}
              className={`${MOBILE_GLASS_ICON_BUTTON_CLASS} shrink-0 disabled:cursor-not-allowed disabled:opacity-60 lg:h-10 lg:w-auto lg:gap-1.5 lg:border-[#DEE0E3] lg:bg-white/82 lg:px-3 lg:shadow-[0_8px_18px_rgba(31,35,41,0.045)] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
            >
              {isLoading ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <RefreshCw size={18} strokeWidth={LUCIDE_NAV_STROKE_WIDTH} />
              )}
              <span className="hidden lg:inline">{t("skills.refresh")}</span>
            </button>
          </div>
        </header>

        {(actionMessage || actionError) && (
          <div
            className={`rounded-lg border px-3 py-2 ${TYPOGRAPHY_META_MEDIUM_CLASS} ${
              actionError
                ? "border-[#FDCACA] bg-[#FFF1F0] text-[#B42318]"
                : "border-[#BACEFD] bg-[#F0F5FF] text-[#1456F0]"
            }`}
          >
            {actionError || actionMessage}
          </div>
        )}

        {skills.length === 0 ? (
          <div
            className={`flex h-32 items-center justify-center rounded-xl border border-dashed ${SKILLS_PAGE_BORDER_CLASS} bg-white/56 ${SKILLS_PAGE_TEXT_TERTIARY_CLASS} ${TYPOGRAPHY_BODY_CLASS}`}
          >
            {t("skills.empty")}
          </div>
        ) : (
          <div className="space-y-3">{sections.map(renderSourceSection)}</div>
        )}
      </div>
    </div>
  );
}
