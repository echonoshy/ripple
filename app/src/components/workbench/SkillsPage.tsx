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
import {
  deleteSkill,
  fetchSkills,
  updateSkill,
  validateSkill,
} from "@/lib/api";
import { type MessageKey, useI18n } from "@/i18n";
import type { SkillInfo, SkillUserStatus } from "@/types";
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
} from "./stylePrimitives";

const SKILL_REFRESH_THROTTLE_MS = 10_000;

interface SkillsPageProps {
  userId: string;
  onBack?: () => void;
  onOpenChat?: (prompt: string) => void;
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

const CONNECTOR_GROUP_LABELS: Record<SkillConnectorGroupId, { label?: string; labelKey?: MessageKey }> = {
  feishu: { label: "Feishu / Lark" },
  google_workspace: { label: "Google Workspace" },
  bilibili: { label: "Bilibili" },
  notion: { label: "Notion" },
  custom: { labelKey: "skills.groupCustom" },
  general: { labelKey: "skills.groupGeneral" },
};

const SKILL_STATUS_RANK: Record<string, number> = {
  needs_connection: 0,
  needs_fix: 1,
  unavailable: 1,
  not_enabled: 2,
  disabled: 2,
  available: 3,
};

function skillTitle(skill: SkillInfo): string {
  return skill.display_name || skill.name;
}

function skillStatusKey(status: string | undefined): MessageKey {
  if (status === "available") return "skills.available";
  if (status === "needs_connection") return "skills.needsConnection";
  if (status === "needs_fix") return "skills.needsFix";
  if (status === "disabled") return "skills.disabled";
  if (status === "unavailable") return "skills.unavailable";
  return "skills.notEnabled";
}

function skillStatusClass(status: string | undefined): string {
  if (status === "available") return "border-[#1a7f37]/20 bg-[#dafbe1]/78 text-[#1a7f37]";
  if (status === "needs_connection") return "border-[#f2cc79]/45 bg-[#fff8df]/82 text-[#7d4e00]";
  if (status === "needs_fix") return "border-[#f2a7a7]/45 bg-[#fff1f1]/82 text-[#9f1c1c]";
  if (status === "disabled") return "border-[#dfe6f4] bg-white/76 text-[#667085]";
  if (status === "unavailable") return "border-[#d7d7dd] bg-[#f2f2f7]/82 text-[#667085]";
  return "border-[#cfe4ff] bg-[#eaf4ff]/74 text-[#0067d6]";
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
  return [...skills].sort((left, right) => skillStatusRank(left) - skillStatusRank(right))[0]
    ?.user_status || "not_enabled";
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

export default function SkillsPage({ userId, onBack, onOpenChat }: SkillsPageProps) {
  const { t } = useI18n();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busySkillId, setBusySkillId] = useState<string | null>(null);
  const [openGroupIds, setOpenGroupIds] = useState<Set<string>>(new Set());
  const lastRefreshAtRef = useRef(0);

  const loadSkills = useCallback(
    async (force = false) => {
      const now = Date.now();
      if (!force && now - lastRefreshAtRef.current < SKILL_REFRESH_THROTTLE_MS) return;
      setIsLoading(true);
      setActionError(null);
      try {
        const next = await fetchSkills();
        setSkills(next);
        lastRefreshAtRef.current = Date.now();
      } catch (error) {
        setActionError(error instanceof Error ? error.message : t("skills.failed"));
      } finally {
        setIsLoading(false);
      }
    },
    [t]
  );

  useEffect(() => {
    void loadSkills(true);
  }, [loadSkills, userId]);

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
    onOpenChat?.(t("skills.createChatPrompt"));
  }, [onOpenChat, t]);

  const openConnectorChat = useCallback(
    (group: SkillConnectorGroup) => {
      onOpenChat?.(
        t("skills.connectChatPrompt", {
          name: group.label || (group.labelKey ? t(group.labelKey) : t("skills.groupGeneral")),
        })
      );
    },
    [onOpenChat, t]
  );

  const replaceSkill = useCallback((next: SkillInfo) => {
    setSkills((current) => current.map((skill) => (skill.id === next.id ? next : skill)));
  }, []);

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
        replaceSkill({ ...skill, validation, user_status: validation.passed ? "not_enabled" : "needs_fix" });
        setActionMessage(t("skills.validated"));
      } catch (error) {
        setActionError(error instanceof Error ? error.message : t("skills.failed"));
      } finally {
        setBusySkillId(null);
      }
    },
    [replaceSkill, t]
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
        setSkills((current) => current.filter((item) => item.id !== skill.id));
        setActionMessage(t("skills.deleted"));
      } catch (error) {
        setActionError(error instanceof Error ? error.message : t("skills.failed"));
      } finally {
        setBusySkillId(null);
      }
    },
    [t]
  );

  const renderSkillCard = (skill: SkillInfo) => {
    const status = (skill.user_status || "not_enabled") as SkillUserStatus;
    const isBusy = busySkillId === skill.id;
    const readOnly = Boolean(skill.read_only || skill.source !== "user");

    return (
      <details
        key={skill.id}
        data-ripple-skill-card="true"
        className="group/skill overflow-hidden bg-white/78"
      >
        <summary className="flex cursor-pointer list-none items-start gap-2.5 px-2.5 py-2.5 transition-colors hover:bg-[#f8faff] [&::-webkit-details-marker]:hidden">
          <div className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#dfe6f4] bg-[#f8faff] text-[#007aff]">
            <ChevronRight
              size={14}
              className="transition-transform group-open/skill:rotate-90"
              strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <h3 className={`truncate text-[#111827] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>
                {skillTitle(skill)}
              </h3>
              <span
                className={`inline-flex h-6 items-center gap-1 rounded-full border px-2 ${TYPOGRAPHY_MICRO_MEDIUM_CLASS} ${skillStatusClass(status)}`}
              >
                {skillStatusIcon(status)}
                {t(skillStatusKey(status))}
              </span>
              <span className={`text-[#667085] ${TYPOGRAPHY_META_CLASS}`}>
                {readOnly ? t("skills.builtIn") : t("skills.mine")}
              </span>
            </div>
            <p className={`mt-1 line-clamp-2 text-[#667085] group-open/skill:hidden ${TYPOGRAPHY_META_CLASS}`}>
              {skill.description}
            </p>
          </div>
        </summary>
        <div className="space-y-2 border-t border-[#e8edf7] bg-[#fbfcff]/62 px-2.5 py-2">
          <p className={`text-[#4b5563] ${TYPOGRAPHY_META_CLASS}`}>{skill.description}</p>
          {!readOnly && (
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void handleValidate(skill)}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[#dfe6f4] bg-white px-2.5 text-[#374151] transition-colors hover:border-[#cfe4ff] hover:bg-[#f8faff] disabled:opacity-60"
              >
                {isBusy ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                <span className={TYPOGRAPHY_MICRO_MEDIUM_CLASS}>{t("skills.validate")}</span>
              </button>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void handleToggle(skill)}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[#dfe6f4] bg-white px-2.5 text-[#374151] transition-colors hover:border-[#cfe4ff] hover:bg-[#f8faff] disabled:opacity-60"
              >
                <Power size={13} />
                <span className={TYPOGRAPHY_MICRO_MEDIUM_CLASS}>
                  {skill.desired_state === "enabled" ? t("skills.disable") : t("skills.enable")}
                </span>
              </button>
              <button
                type="button"
                disabled
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[#dfe6f4] bg-white px-2.5 text-[#9ca3af] disabled:opacity-70"
              >
                <Pencil size={13} />
                <span className={TYPOGRAPHY_MICRO_MEDIUM_CLASS}>{t("skills.edit")}</span>
              </button>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void handleDelete(skill)}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[#f2d1d1] bg-white px-2.5 text-[#9f1c1c] transition-colors hover:bg-[#fff1f1] disabled:opacity-60"
              >
                <Trash2 size={13} />
                <span className={TYPOGRAPHY_MICRO_MEDIUM_CLASS}>{t("skills.delete")}</span>
              </button>
            </div>
          )}
          {readOnly && (
            <span className={`inline-flex h-7 items-center rounded-full text-[#667085] ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`}>
              {t("skills.readOnly")}
            </span>
          )}
        </div>
      </details>
    );
  };

  const renderConnectorGroup = (group: SkillConnectorGroup) => {
    const isOpen = openGroupIds.has(group.id);
    const availableInGroup = group.skills.filter((skill) => skill.user_status === "available").length;
    const groupLabel = group.label || (group.labelKey ? t(group.labelKey) : t("skills.groupGeneral"));
    const needsConnection = group.skills.some((skill) => skill.user_status === "needs_connection");

    return (
      <section
        key={group.id}
        data-ripple-skill-connector-group="true"
        className="overflow-hidden rounded-lg border border-[#dfe6f4] bg-white/78 shadow-[0_8px_22px_rgba(44,63,123,0.05)]"
      >
        <div className="flex items-center gap-2 border-b border-[#e8edf7] bg-[#fbfcff]/72 px-2.5 py-2">
          <button
            type="button"
            onClick={() => toggleGroup(group.id)}
            aria-expanded={isOpen}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            {isOpen ? (
              <ChevronDown size={15} className="shrink-0 text-[#667085]" />
            ) : (
              <ChevronRight size={15} className="shrink-0 text-[#667085]" />
            )}
            <div className="min-w-0 flex-1">
              <div className={`truncate text-[#111827] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>
                {groupLabel}
              </div>
              <div className={`mt-0.5 text-[#7a8496] ${TYPOGRAPHY_META_CLASS}`}>
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
              disabled={!onOpenChat}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-[#cfe4ff] bg-[#eaf4ff] px-2.5 text-[#0067d6] transition-colors hover:bg-[#dcefff] disabled:opacity-60"
            >
              <Plug size={13} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
              <span className={TYPOGRAPHY_MICRO_MEDIUM_CLASS}>{t("skills.connectService")}</span>
            </button>
          )}
        </div>
        {isOpen && <div className="divide-y divide-[#e8edf7]">{group.skills.map(renderSkillCard)}</div>}
      </section>
    );
  };

  const renderSourceSection = (section: SkillSourceSection) => {
    const sectionSkills = section.groups.flatMap((group) => group.skills);
    const availableInSection = sectionSkills.filter((skill) => skill.user_status === "available").length;

    return (
      <section key={section.id} data-ripple-skill-source-section="true" className="space-y-2">
        <div className="flex items-end justify-between gap-2 px-0.5">
          <div className={`text-[#111827] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>{t(section.labelKey)}</div>
          <div className={`text-[#7a8496] ${TYPOGRAPHY_META_CLASS}`}>
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
      className={`h-full min-h-0 overflow-y-auto ${COMPACT_IOS_PAGE_BACKGROUND} px-3 ${MOBILE_PAGE_TOP_SAFE_AREA_CLASS} ${MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS} text-[#111827] md:px-6 lg:pb-5`}
    >
      <div className="mx-auto max-w-5xl space-y-2">
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
              <div className={`mt-1 text-[#7a8496] ${TYPOGRAPHY_META_CLASS}`}>
                {t("skills.readyCount", { available: availableCount, total: skills.length })}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={openCreateSkillChat}
              disabled={!onOpenChat}
              className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-[#cfe4ff] bg-[#eaf4ff] text-[#007aff] shadow-[0_6px_18px_rgba(0,122,255,0.10)] transition-all hover:bg-[#dcefff] active:scale-[0.98] lg:h-10 lg:w-auto lg:gap-1.5 lg:px-3"
              aria-label={t("skills.create")}
              title={t("skills.create")}
            >
              <MessageSquare size={18} />
              <span className="hidden lg:inline">{t("skills.create")}</span>
            </button>
            <button
              type="button"
              onClick={() => void loadSkills(true)}
              disabled={isLoading}
              title={t("skills.refresh")}
              aria-label={t("skills.refresh")}
              className={`${MOBILE_GLASS_ICON_BUTTON_CLASS} shrink-0 disabled:cursor-not-allowed disabled:opacity-60 lg:h-10 lg:w-auto lg:gap-1.5 lg:border-[#dfe6f4] lg:bg-white/78 lg:px-3 lg:shadow-[0_8px_18px_rgba(44,63,123,0.05)] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
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
                ? "border-[#f2d1d1] bg-[#fff1f1] text-[#9f1c1c]"
                : "border-[#cfe4ff] bg-[#eaf4ff] text-[#0067d6]"
            }`}
          >
            {actionError || actionMessage}
          </div>
        )}

        {skills.length === 0 ? (
          <div className={`flex h-32 items-center justify-center rounded-xl border border-dashed border-[#dfe6f4] bg-white/52 text-[#667085] ${TYPOGRAPHY_BODY_CLASS}`}>
            {t("skills.empty")}
          </div>
        ) : (
          <div className="space-y-3">
            {sections.map(renderSourceSection)}
          </div>
        )}
      </div>
    </div>
  );
}
