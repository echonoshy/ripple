"use client";

import WorkspaceExplorer from "@/components/WorkspaceExplorer";
import type { WorkspaceFileOpenRequest } from "@/types";
import { COMPACT_IOS_PAGE_BACKGROUND } from "./stylePrimitives";

interface FilesPageProps {
  userId: string;
  refreshToken: number;
  onBack?: () => void;
  openFileRequest?: WorkspaceFileOpenRequest | null;
  onOpenFileRequestConsumed?: (requestId: number) => void;
}

export default function FilesPage({
  userId,
  refreshToken,
  onBack,
  openFileRequest,
  onOpenFileRequestConsumed,
}: FilesPageProps) {
  return (
    <div
      data-ripple-files-page="finder-stage"
      className={`flex h-full min-h-0 flex-col overflow-hidden ${COMPACT_IOS_PAGE_BACKGROUND} p-3 pt-[max(env(safe-area-inset-top),12px)] pb-[calc(88px+env(safe-area-inset-bottom))] text-[#111827] md:p-5 md:pt-[max(env(safe-area-inset-top),20px)] lg:pb-5`}
    >
      <WorkspaceExplorer
        userId={userId}
        refreshToken={refreshToken}
        presentation="page"
        onBack={onBack}
        openFileRequest={openFileRequest}
        onOpenFileRequestConsumed={onOpenFileRequestConsumed}
      />
    </div>
  );
}
