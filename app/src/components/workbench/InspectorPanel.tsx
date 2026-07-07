"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import WorkspaceExplorer from "@/components/WorkspaceExplorer";
import { useI18n } from "@/i18n";
import type { WorkspaceFileOpenRequest } from "@/types";
import type { ChatBrowserContext } from "@/lib/api";
import BrowserPanel from "./BrowserPanel";
import { WORKBENCH_ICON_BUTTON_CLASS, WORKBENCH_TOP_BAR_CLASS } from "./stylePrimitives";

type InspectorTab = "files" | "browser";

interface InspectorPanelProps {
  userId: string;
  refreshToken: number;
  onCollapse?: () => void;
  openFileRequest?: WorkspaceFileOpenRequest | null;
  onOpenFileRequestConsumed?: (requestId: number) => void;
  onBrowserContextChange?: (context: ChatBrowserContext | null) => void;
}

export default function InspectorPanel({
  userId,
  refreshToken,
  onCollapse,
  openFileRequest,
  onOpenFileRequestConsumed,
  onBrowserContextChange = () => undefined,
}: InspectorPanelProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<InspectorTab>("files");
  const displayedTab: InspectorTab = openFileRequest ? "files" : activeTab;

  const tabClassName = (tab: InspectorTab) =>
    `inline-flex h-9 items-center border-b-2 px-0 text-sm font-medium transition-colors ${
      displayedTab === tab
        ? "border-[#1456F0] text-[#1456F0]"
        : "border-transparent text-[#646A73] hover:text-[#1F2329]"
    }`;

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-[#DEE0E3] bg-white">
      <div
        className={`flex h-[52px] shrink-0 items-center justify-between pr-2 pl-4 ${WORKBENCH_TOP_BAR_CLASS}`}
      >
        <div role="tablist" className="flex h-full items-end gap-6 pb-0">
          <button
            type="button"
            role="tab"
            aria-selected={displayedTab === "files"}
            onClick={() => setActiveTab("files")}
            className={tabClassName("files")}
          >
            {t("files.title")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={displayedTab === "browser"}
            onClick={() => setActiveTab("browser")}
            className={tabClassName("browser")}
          >
            {t("browser.title")}
          </button>
        </div>
        <button
          type="button"
          onClick={onCollapse}
          aria-label={t("common.collapsePanel")}
          title={t("common.collapsePanel")}
          className={`${WORKBENCH_ICON_BUTTON_CLASS} mt-2 text-[#646A73] hover:text-[#1F2329]`}
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {displayedTab === "files" ? (
          <WorkspaceExplorer
            userId={userId}
            refreshToken={refreshToken}
            openFileRequest={openFileRequest}
            onOpenFileRequestConsumed={onOpenFileRequestConsumed}
          />
        ) : (
          <BrowserPanel onBrowserContextChange={onBrowserContextChange} />
        )}
      </div>
    </aside>
  );
}
