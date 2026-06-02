"use client";

import WorkspaceExplorer from "@/components/WorkspaceExplorer";
import type { WorkspaceFileOpenRequest } from "@/types";
import {
  COMPACT_IOS_PAGE_BACKGROUND,
  MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS,
  MOBILE_PAGE_TOP_SAFE_AREA_CLASS,
} from "./stylePrimitives";

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
      className={`flex h-full min-h-0 flex-col overflow-hidden ${COMPACT_IOS_PAGE_BACKGROUND} px-3 ${MOBILE_PAGE_TOP_SAFE_AREA_CLASS} ${MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS} text-[#111827] md:px-6 lg:pb-5`}
    >
      <div className="mx-auto w-full max-w-5xl flex-1 flex flex-col min-h-0">
        <WorkspaceExplorer
          userId={userId}
          refreshToken={refreshToken}
          presentation="page"
          onBack={onBack}
          openFileRequest={openFileRequest}
          onOpenFileRequestConsumed={onOpenFileRequestConsumed}
        />
      </div>
    </div>
  );
}
