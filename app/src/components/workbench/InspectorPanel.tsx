"use client";

import WorkspaceExplorer from "@/components/WorkspaceExplorer";

interface InspectorPanelProps {
  userId: string;
  refreshToken: number;
}

export default function InspectorPanel({ userId, refreshToken }: InspectorPanelProps) {
  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-[#e5e7eb] bg-white">
      <div className="flex h-[52px] shrink-0 items-end border-b border-[#e5e7eb] bg-white px-4">
        <div className="inline-flex h-9 items-center border-b-2 border-[#2463eb] text-sm font-medium text-[#2463eb]">
          Files
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <WorkspaceExplorer userId={userId} refreshToken={refreshToken} />
      </div>
    </aside>
  );
}
