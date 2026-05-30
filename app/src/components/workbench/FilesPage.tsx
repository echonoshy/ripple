"use client";

import WorkspaceExplorer from "@/components/WorkspaceExplorer";
import type { ProjectInfo } from "@/types";

interface FilesPageProps {
  userId: string;
  refreshToken: number;
  onBack?: () => void;
  projects?: ProjectInfo[];
  activeProjectId?: string | null;
  onProjectSelect?: (project: ProjectInfo | null) => void;
  onCreateProject?: (input: { name: string; rootPath: string }) => Promise<ProjectInfo | null>;
}

export default function FilesPage({
  userId,
  refreshToken,
  onBack,
  projects = [],
  activeProjectId = null,
  onProjectSelect,
  onCreateProject,
}: FilesPageProps) {
  return (
    <div
      data-ripple-files-page="finder-stage"
      className="flex h-full min-h-0 flex-col overflow-hidden bg-[radial-gradient(circle_at_16%_0%,rgba(47,107,255,0.12),transparent_34%),radial-gradient(circle_at_88%_8%,rgba(139,92,246,0.11),transparent_32%),#fbfdff] p-3 pt-[max(env(safe-area-inset-top),12px)] pb-[calc(88px+env(safe-area-inset-bottom))] text-[#111827] md:p-5 md:pt-[max(env(safe-area-inset-top),20px)] lg:pb-5"
    >
      <WorkspaceExplorer
        userId={userId}
        refreshToken={refreshToken}
        presentation="page"
        onBack={onBack}
        projects={projects}
        activeProjectId={activeProjectId}
        onProjectSelect={onProjectSelect}
        onCreateProject={onCreateProject}
      />
    </div>
  );
}
