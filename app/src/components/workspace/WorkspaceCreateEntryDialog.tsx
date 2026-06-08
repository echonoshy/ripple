import React from "react";
import {
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_MEDIUM_CLASS,
  TYPOGRAPHY_MOBILE_BODY_CLASS,
  WORKBENCH_FIELD_CLASS,
  WORKBENCH_FLOATING_SURFACE_CLASS,
  WORKBENCH_PRIMARY_BUTTON_CLASS,
  WORKBENCH_SECONDARY_BUTTON_CLASS,
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
        className={`w-80 p-5 ${WORKBENCH_FLOATING_SURFACE_CLASS}`}
      >
        <h3 className={`mb-3 text-[#1F2329] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>
          {modal.kind === "file" ? t("files.createNewFile") : t("files.createNewFolder")}
        </h3>
        <input
          autoFocus
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder={modal.kind === "file" ? t("files.filePlaceholder") : t("files.folderPlaceholder")}
          className={`mb-4 h-10 w-full px-4 ${WORKBENCH_FIELD_CLASS} ${TYPOGRAPHY_MOBILE_BODY_CLASS}`}
          disabled={saving}
        />
        <div className={`flex justify-end gap-2 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}>
          <button
            type="button"
            onClick={onCancel}
            className={`py-1.5 ${WORKBENCH_SECONDARY_BUTTON_CLASS}`}
            disabled={saving}
          >
            {t("files.cancel")}
          </button>
          <button
            type="submit"
            className={`py-1.5 ${WORKBENCH_PRIMARY_BUTTON_CLASS}`}
            disabled={saving}
          >
            {saving ? t("files.creating") : t("files.create")}
          </button>
        </div>
      </form>
    </div>
  );
}
