"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowBigLeft,
  CheckCircle2,
  Loader2,
  Pencil,
  Plug,
  Plus,
  Power,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import {
  createSkill,
  deleteSkill,
  fetchSkills,
  updateSkill,
  validateSkill,
} from "@/lib/api";
import { type MessageKey, useI18n } from "@/i18n";
import type { SkillDraftInput, SkillInfo, SkillUserStatus } from "@/types";
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
  onOpenConnectors?: () => void;
}

const defaultDraft: SkillDraftInput = {
  display_name: "",
  description: "",
  when_to_use: "",
  steps: [""],
  output_format: "",
  requires_connectors: [],
  requires_user_confirmation: false,
  test_example: "",
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

function groupSkills(skills: SkillInfo[]) {
  return {
    available: skills.filter((skill) => skill.user_status === "available"),
    needsConnection: skills.filter((skill) => skill.user_status === "needs_connection"),
    needsFix: skills.filter(
      (skill) => skill.user_status === "needs_fix" || skill.user_status === "unavailable"
    ),
    notEnabled: skills.filter(
      (skill) => skill.user_status === "not_enabled" || skill.user_status === "disabled"
    ),
    mine: skills.filter((skill) => skill.source === "user"),
  };
}

export default function SkillsPage({ userId, onBack, onOpenConnectors }: SkillsPageProps) {
  const { t } = useI18n();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [draft, setDraft] = useState<SkillDraftInput>(defaultDraft);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busySkillId, setBusySkillId] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState(0);

  const loadSkills = useCallback(
    async (force = false) => {
      const now = Date.now();
      if (!force && now - lastRefreshAt < SKILL_REFRESH_THROTTLE_MS) return;
      setIsLoading(true);
      setActionError(null);
      try {
        const next = await fetchSkills();
        setSkills(next);
        setLastRefreshAt(Date.now());
      } catch (error) {
        setActionError(error instanceof Error ? error.message : t("skills.failed"));
      } finally {
        setIsLoading(false);
      }
    },
    [lastRefreshAt, t]
  );

  useEffect(() => {
    void loadSkills(true);
  }, [loadSkills, userId]);

  const grouped = useMemo(() => groupSkills(skills), [skills]);
  const availableCount = grouped.available.length;

  const updateDraft = useCallback((patch: Partial<SkillDraftInput>) => {
    setDraft((current) => ({ ...current, ...patch }));
  }, []);

  const handleCreate = useCallback(async () => {
    const steps = (draft.steps || []).map((step) => step.trim()).filter(Boolean);
    if (!draft.description.trim() || steps.length === 0) return;
    setIsLoading(true);
    setActionError(null);
    try {
      const created = await createSkill({ ...draft, steps });
      setSkills((current) => [created, ...current.filter((skill) => skill.id !== created.id)]);
      setDraft(defaultDraft);
      setIsCreateOpen(false);
      setActionMessage(t("skills.saved"));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("skills.failed"));
    } finally {
      setIsLoading(false);
    }
  }, [draft, t]);

  const replaceSkill = useCallback((next: SkillInfo) => {
    setSkills((current) => current.map((skill) => (skill.id === next.id ? next : skill)));
  }, []);

  const handleValidate = useCallback(
    async (skill: SkillInfo) => {
      setBusySkillId(skill.id);
      setActionError(null);
      try {
        const validation = await validateSkill(skill.id);
        replaceSkill({ ...skill, validation, user_status: validation.passed ? "not_enabled" : "needs_fix" });
        setActionMessage(t("skills.tested"));
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
      <article
        key={skill.id}
        data-ripple-skill-card="true"
        className="overflow-hidden rounded-lg border border-[#dfe6f4] bg-white/78 shadow-[0_8px_22px_rgba(44,63,123,0.05)]"
      >
        <div className="flex items-start gap-2.5 p-2.5">
          <div className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#dfe6f4] bg-[#f8faff] text-[#007aff]">
            {skillStatusIcon(status)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <h2 className={`truncate text-[#111827] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>
                {skillTitle(skill)}
              </h2>
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
            <p className={`mt-1 text-[#4b5563] ${TYPOGRAPHY_BODY_CLASS}`}>{skill.description}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 border-t border-[#e8edf7] bg-[#fbfcff]/62 px-2.5 py-1.5">
          {status === "needs_connection" && (
            <button
              type="button"
              onClick={onOpenConnectors}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[#cfe4ff] bg-[#eaf4ff] px-2.5 text-[#0067d6] transition-colors hover:bg-[#dcefff] disabled:opacity-60"
            >
              <Plug size={13} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
              <span className={TYPOGRAPHY_MICRO_MEDIUM_CLASS}>{t("skills.connectService")}</span>
            </button>
          )}
          {!readOnly && (
            <>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void handleValidate(skill)}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[#dfe6f4] bg-white px-2.5 text-[#374151] transition-colors hover:border-[#cfe4ff] hover:bg-[#f8faff] disabled:opacity-60"
              >
                {isBusy ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                <span className={TYPOGRAPHY_MICRO_MEDIUM_CLASS}>{t("skills.test")}</span>
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
            </>
          )}
          {readOnly && (
            <span className={`inline-flex h-8 items-center rounded-full px-2.5 text-[#667085] ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`}>
              {t("skills.readOnly")}
            </span>
          )}
        </div>
      </article>
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
              onClick={() => setIsCreateOpen((value) => !value)}
              className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-[#cfe4ff] bg-[#eaf4ff] text-[#007aff] shadow-[0_6px_18px_rgba(0,122,255,0.10)] transition-all hover:bg-[#dcefff] active:scale-[0.98] lg:h-10 lg:w-auto lg:gap-1.5 lg:px-3"
              aria-label={t("skills.create")}
              title={t("skills.create")}
            >
              {isCreateOpen ? <X size={18} /> : <Plus size={18} />}
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

        {isCreateOpen && (
          <section
            data-ripple-skill-create-form="true"
            className="space-y-2 rounded-lg border border-[#dfe6f4] bg-white/78 p-2.5 shadow-[0_8px_22px_rgba(44,63,123,0.05)]"
          >
            <div className={`text-[#111827] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>
              {t("skills.createTitle")}
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              <input
                value={draft.display_name || ""}
                onChange={(event) => updateDraft({ display_name: event.target.value })}
                aria-label={t("skills.name")}
                placeholder={t("skills.name")}
                className="h-9 rounded-lg border border-[#dfe6f4] bg-white px-2.5 text-sm outline-none focus:border-[#8ec8ff]"
              />
              <input
                value={draft.when_to_use || ""}
                onChange={(event) => updateDraft({ when_to_use: event.target.value })}
                aria-label={t("skills.whenToUse")}
                placeholder={t("skills.whenToUse")}
                className="h-9 rounded-lg border border-[#dfe6f4] bg-white px-2.5 text-sm outline-none focus:border-[#8ec8ff]"
              />
            </div>
            <textarea
              value={draft.description}
              onChange={(event) => updateDraft({ description: event.target.value })}
              aria-label={t("skills.description")}
              placeholder={t("skills.description")}
              className="min-h-20 w-full rounded-lg border border-[#dfe6f4] bg-white px-2.5 py-2 text-sm outline-none focus:border-[#8ec8ff]"
            />
            <textarea
              value={(draft.steps || []).join("\n")}
              onChange={(event) => updateDraft({ steps: event.target.value.split("\n") })}
              aria-label={t("skills.steps")}
              placeholder={t("skills.steps")}
              className="min-h-20 w-full rounded-lg border border-[#dfe6f4] bg-white px-2.5 py-2 text-sm outline-none focus:border-[#8ec8ff]"
            />
            <div className="grid gap-2 md:grid-cols-2">
              <input
                value={draft.output_format || ""}
                onChange={(event) => updateDraft({ output_format: event.target.value })}
                aria-label={t("skills.outputFormat")}
                placeholder={t("skills.outputFormat")}
                className="h-9 rounded-lg border border-[#dfe6f4] bg-white px-2.5 text-sm outline-none focus:border-[#8ec8ff]"
              />
              <input
                value={draft.test_example || ""}
                onChange={(event) => updateDraft({ test_example: event.target.value })}
                aria-label={t("skills.testExample")}
                placeholder={t("skills.testExample")}
                className="h-9 rounded-lg border border-[#dfe6f4] bg-white px-2.5 text-sm outline-none focus:border-[#8ec8ff]"
              />
            </div>
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setIsCreateOpen(false)}
                className="inline-flex h-8 items-center rounded-full border border-[#dfe6f4] bg-white px-3 text-[#374151]"
              >
                <span className={TYPOGRAPHY_MICRO_MEDIUM_CLASS}>{t("skills.cancel")}</span>
              </button>
              <button
                type="button"
                onClick={() => void handleCreate()}
                className="inline-flex h-8 items-center rounded-full bg-[#007aff] px-3 text-white disabled:bg-[#d0d7e2]"
                disabled={isLoading}
              >
                <span className={TYPOGRAPHY_MICRO_MEDIUM_CLASS}>{t("skills.createDraft")}</span>
              </button>
            </div>
          </section>
        )}

        {skills.length === 0 ? (
          <div className={`flex h-32 items-center justify-center rounded-xl border border-dashed border-[#dfe6f4] bg-white/52 text-[#667085] ${TYPOGRAPHY_BODY_CLASS}`}>
            {t("skills.empty")}
          </div>
        ) : (
          <div className="grid gap-2 lg:grid-cols-2">
            {[
              ...grouped.needsConnection,
              ...grouped.needsFix,
              ...grouped.available,
              ...grouped.notEnabled,
            ].map(renderSkillCard)}
          </div>
        )}
      </div>
    </div>
  );
}
