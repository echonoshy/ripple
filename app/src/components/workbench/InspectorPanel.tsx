"use client";

import { ChevronRight } from "lucide-react";
import WorkspaceExplorer from "@/components/WorkspaceExplorer";
import { useI18n } from "@/i18n";
import type { WorkspaceFileOpenRequest } from "@/types";

interface InspectorPanelProps {
  userId: string;
  refreshToken: number;
  onCollapse?: () => void;
  openFileRequest?: WorkspaceFileOpenRequest | null;
  onOpenFileRequestConsumed?: (requestId: number) => void;
}

export default function InspectorPanel({
  userId,
  refreshToken,
  onCollapse,
  openFileRequest,
  onOpenFileRequestConsumed,
}: InspectorPanelProps) {
  const { t } = useI18n();
  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-[#DEE0E3] bg-white/86 backdrop-blur-xl">
      <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-[#DEE0E3]/70 bg-white/82 pr-2 pl-4 backdrop-blur-2xl">
        <div className="flex h-full items-end pb-0">
          <div className="inline-flex h-9 items-center border-b-2 border-[#1456F0] text-sm font-medium text-[#1456F0]">
            {t("files.title")}
          </div>
        </div>
        <button
          type="button"
          onClick={onCollapse}
          aria-label={t("common.collapsePanel")}
          title={t("common.collapsePanel")}
          className="mt-2 inline-flex h-8 w-8 items-center justify-center rounded-full border border-transparent text-[#646A73] transition-colors hover:border-[#DEE0E3] hover:bg-[#F5F6F7] hover:text-[#1F2329]"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <WorkspaceExplorer
          userId={userId}
          refreshToken={refreshToken}
          openFileRequest={openFileRequest}
          onOpenFileRequestConsumed={onOpenFileRequestConsumed}
        />
      </div>
    </aside>
  );
}
