"use client";

import WorkspaceExplorer from "@/components/WorkspaceExplorer";

interface FilesPageProps {
  userId: string;
  refreshToken: number;
}

export default function FilesPage({ userId, refreshToken }: FilesPageProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-white pb-[calc(72px+env(safe-area-inset-bottom))] lg:pb-0">
      <div className="shrink-0 border-b border-[#e5e7eb] bg-white px-4 py-3 md:px-5">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-3">
            <h1 className="text-[20px] leading-7 font-semibold tracking-normal text-[#0d0d0d]">
              Files
            </h1>
            <div className="font-[family-name:var(--font-mono)] text-xs text-[#6b7280]">
              <span className="sm:hidden">Workspace</span>
              <span className="hidden sm:inline">/workspace</span>
            </div>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <WorkspaceExplorer userId={userId} refreshToken={refreshToken} />
      </div>
    </div>
  );
}
