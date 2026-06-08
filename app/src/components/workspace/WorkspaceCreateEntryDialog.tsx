import React from "react";
import {
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_MEDIUM_CLASS,
  TYPOGRAPHY_MOBILE_BODY_CLASS,
} from "@/components/workbench/stylePrimitives";
import { useI18n } from "@/i18n";

export interface WorkspaceCreationModalState {
  visible: boolean;
  kind: "file" | "directory";
}

interface WorkspaceCreateEntryDialogProps {
  modal: WorkspaceCreationModalState | null;
  draft: string;
  saving: boolean;
  onDraftChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: (event: React.FormEvent) => void;
}

export default function WorkspaceCreateEntryDialog({
  modal,
  draft,
  saving,
  onDraftChange,
  onCancel,
  onSubmit,
}: WorkspaceCreateEntryDialogProps) {
  const { t } = useI18n();
  if (!modal?.visible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[1px]">
      <form
        onSubmit={onSubmit}
        className="w-80 rounded-2xl border border-[#DEE0E3] bg-white p-5 shadow-2xl"
      >
        <h3 className={`mb-3 text-[#1F2329] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>
          {modal.kind === "file" ? t("files.createNewFile") : t("files.createNewFolder")}
        </h3>
        <input
          autoFocus
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder={modal.kind === "file" ? t("files.filePlaceholder") : t("files.folderPlaceholder")}
          className={`mb-4 h-10 w-full rounded-full border border-[#DEE0E3] bg-white px-4 outline-none focus:border-[#8FB1FF] ${TYPOGRAPHY_MOBILE_BODY_CLASS}`}
          disabled={saving}
        />
        <div className={`flex justify-end gap-2 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-[#DEE0E3] bg-white px-4 py-1.5 text-[#2B2F36] transition-all duration-200 hover:bg-[#f9fafb]"
            disabled={saving}
          >
            {t("files.cancel")}
          </button>
          <button
            type="submit"
            className="rounded-full bg-[#1456F0] px-4 py-1.5 text-white shadow-[0_8px_18px_rgba(20,86,240,0.20)] transition-all duration-200 hover:bg-[#0F4BD8] active:scale-[0.98]"
            disabled={saving}
          >
            {saving ? t("files.creating") : t("files.create")}
          </button>
        </div>
      </form>
    </div>
  );
}
