"use client";

import WorkspaceExplorer from "@/components/WorkspaceExplorer";
import { ArrowLeft } from "lucide-react";

interface FilesPageProps {
  userId: string;
  refreshToken: number;
  onBack?: () => void;
}

export default function FilesPage({ userId, refreshToken, onBack }: FilesPageProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-[radial-gradient(circle_at_16%_0%,rgba(47,107,255,0.12),transparent_34%),radial-gradient(circle_at_88%_8%,rgba(139,92,246,0.11),transparent_32%),#fbfdff] pb-[calc(88px+env(safe-area-inset-bottom))] lg:pb-0">
      <div className="shrink-0 border-b border-[#e8edf7] bg-white/72 px-4 py-3 shadow-[0_8px_22px_rgba(44,63,123,0.04)] backdrop-blur-2xl md:px-5">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            {onBack ? (
              <button
                type="button"
                onClick={onBack}
                aria-label="Back to settings"
                title="Back to settings"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#dfe6f4] bg-white text-[#384152] hover:bg-[#f7f8fa] lg:hidden"
              >
                <ArrowLeft size={17} />
              </button>
            ) : null}
            <h1 className="text-[20px] leading-7 font-semibold tracking-normal text-[#111827]">
              Files
            </h1>
            <div className="font-[family-name:var(--font-mono)] text-[11px] text-[#7a8496]">
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
