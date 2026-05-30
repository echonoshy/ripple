"use client";

import { ChevronRight } from "lucide-react";
import WorkspaceExplorer from "@/components/WorkspaceExplorer";
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
  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-[#e5e7eb] bg-white">
      <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-[#e5e7eb] bg-white pr-2 pl-4">
        <div className="flex h-full items-end pb-0">
          <div className="inline-flex h-9 items-center border-b-2 border-[#2463eb] text-sm font-medium text-[#2463eb]">
            Files
          </div>
        </div>
        <button
          type="button"
          onClick={onCollapse}
          aria-label="Collapse panel"
          title="Collapse panel"
          className="mt-2 inline-flex h-8 w-8 items-center justify-center rounded-full border border-transparent text-[#6b7280] transition-colors hover:border-[#e5e7eb] hover:bg-[#f3f4f6] hover:text-[#0d0d0d]"
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
