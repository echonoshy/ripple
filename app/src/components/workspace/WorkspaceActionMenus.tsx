import React from "react";
import { createPortal } from "react-dom";
import {
  Clipboard,
  Copy,
  Download,
  Edit3,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  Loader2,
  RefreshCw,
  Scissors,
  Trash2,
  X,
} from "lucide-react";
import MobileActionSheet from "@/components/workbench/MobileActionSheet";
import {
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_META_MEDIUM_CLASS,
  WORKBENCH_MENU_CLASS,
  WORKBENCH_MENU_DANGER_ITEM_CLASS,
  WORKBENCH_MENU_ITEM_CLASS,
} from "@/components/workbench/stylePrimitives";
import { useI18n } from "@/i18n";
import type { ViewportMenuAnchorRect } from "@/lib/menuPosition";
import type { WorkspaceEntry } from "@/types";

export interface WorkspaceClipboardState {
  items: WorkspaceEntry[];
  action: "copy" | "move";
}

export interface WorkspaceContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  entry: WorkspaceEntry | null;
  anchorRect: ViewportMenuAnchorRect | null;
  align: "left" | "right";
  measuredHeight: number | null;
}

interface WorkspaceActionMenusProps {
  contextMenu: WorkspaceContextMenuState;
  contextMenuRef: React.RefObject<HTMLDivElement | null>;
  clipboard: WorkspaceClipboardState | null;
  isPagePresentation: boolean;
  isActionsMenuOpen: boolean;
  mobileActionEntry: WorkspaceEntry | null;
  mobilePathLabel: string;
  currentPath: string;
  loading: boolean;
  startRename: (entry: WorkspaceEntry) => void;
  handleCut: (entry: WorkspaceEntry) => void;
  handleCopy: (entry: WorkspaceEntry) => void;
  handleCopyAbsoluteSandboxPath: (entry: WorkspaceEntry) => void;
  handleDownloadFile: (path: string) => void;
  handleDelete: (entry: WorkspaceEntry) => void;
  handlePaste: () => void;
  clearClipboard: () => void;
  setCreationModal: (modal: { visible: boolean; kind: "file" | "directory" } | null) => void;
  setContextMenu: React.Dispatch<React.SetStateAction<WorkspaceContextMenuState>>;
  setIsActionsMenuOpen: (open: boolean) => void;
  setMobileActionEntry: (entry: WorkspaceEntry | null) => void;
  loadDirectory: (path: string) => void;
  openEntry: (entry: WorkspaceEntry) => void;
}

export default function WorkspaceActionMenus({
  contextMenu,
  contextMenuRef,
  clipboard,
  isPagePresentation,
  isActionsMenuOpen,
  mobileActionEntry,
  mobilePathLabel,
  currentPath,
  loading,
  startRename,
  handleCut,
  handleCopy,
  handleCopyAbsoluteSandboxPath,
  handleDownloadFile,
  handleDelete,
  handlePaste,
  clearClipboard,
  setCreationModal,
  setContextMenu,
  setIsActionsMenuOpen,
  setMobileActionEntry,
  loadDirectory,
  openEntry,
}: WorkspaceActionMenusProps) {
  const { t } = useI18n();
  const closeActionsMenu = () => setIsActionsMenuOpen(false);
  const menuItemClass = `${WORKBENCH_MENU_ITEM_CLASS} ${TYPOGRAPHY_META_MEDIUM_CLASS}`;
  const menuDangerItemClass = `${WORKBENCH_MENU_DANGER_ITEM_CLASS} ${TYPOGRAPHY_META_MEDIUM_CLASS}`;

  const contextMenuPortal =
    contextMenu.visible && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={contextMenuRef}
            style={{ top: contextMenu.y, left: contextMenu.x }}
            className={`animate-in fade-in-50 zoom-in-95 fixed z-50 max-h-[calc(100dvh-104px)] w-[220px] overflow-y-auto duration-100 ${TYPOGRAPHY_META_CLASS} ${WORKBENCH_MENU_CLASS}`}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            {contextMenu.entry ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    if (contextMenu.entry) startRename(contextMenu.entry);
                    setContextMenu((prev: WorkspaceContextMenuState) => ({ ...prev, visible: false }));
                  }}
                  className={menuItemClass}
                >
                  <Edit3 size={13} className="shrink-0 text-[#646A73]" /> {t("files.rename")}
                </button>
                <button
                  type="button"
                  onClick={() => contextMenu.entry && handleCut(contextMenu.entry)}
                  className={menuItemClass}
                >
                  <Scissors size={13} className="shrink-0 text-[#646A73]" /> {t("files.cutMove")}
                </button>
                <button
                  type="button"
                  onClick={() => contextMenu.entry && handleCopy(contextMenu.entry)}
                  className={menuItemClass}
                >
                  <Copy size={13} className="shrink-0 text-[#646A73]" /> {t("files.copy")}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    contextMenu.entry && handleCopyAbsoluteSandboxPath(contextMenu.entry)
                  }
                  className={`${menuItemClass} font-[family-name:var(--font-mono)]`}
                >
                  <FileText size={13} className="shrink-0 text-[#646A73]" />{" "}
                  {t("files.copySandboxPath")}
                </button>
                {contextMenu.entry.kind === "file" && (
                  <button
                    type="button"
                    onClick={() => {
                      if (contextMenu.entry) handleDownloadFile(contextMenu.entry.path);
                      setContextMenu((prev: WorkspaceContextMenuState) => ({ ...prev, visible: false }));
                    }}
                    className={menuItemClass}
                  >
                    <Download size={13} className="shrink-0 text-[#646A73]" /> {t("files.download")}
                  </button>
                )}
                <div className="my-1 border-t border-[#DEE0E3]" />
                <button
                  type="button"
                  onClick={() => contextMenu.entry && handleDelete(contextMenu.entry)}
                  className={menuDangerItemClass}
                >
                  <Trash2 size={13} className="shrink-0 text-[#B42318]" /> {t("files.delete")}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={!clipboard}
                  onClick={handlePaste}
                  className={`${menuItemClass} disabled:cursor-not-allowed disabled:opacity-40`}
                >
                  <Clipboard size={13} className="shrink-0 text-[#646A73]" />
                  {clipboard ? (
                    <>
                      {clipboard.items.length === 1
                        ? t("files.pasteNamed", { name: clipboard.items[0]?.name || "" })
                        : t("files.pasteItems", { count: clipboard.items.length })}
                    </>
                  ) : (
                    t("files.paste")
                  )}
                </button>
                {clipboard ? (
                  <button
                    type="button"
                    onClick={clearClipboard}
                    className={`${menuItemClass} text-[#646A73]`}
                  >
                    <X size={13} className="shrink-0 text-[#646A73]" />
                    {t("files.clearClipboard")}
                  </button>
                ) : null}
                <div className="my-1 border-t border-[#DEE0E3]" />
                <button
                  type="button"
                  onClick={() => {
                    setCreationModal({ visible: true, kind: "file" });
                    setContextMenu((prev: WorkspaceContextMenuState) => ({ ...prev, visible: false }));
                  }}
                  className={`${menuItemClass} disabled:cursor-not-allowed disabled:opacity-40`}
                >
                  <FilePlus size={13} className="shrink-0 text-[#646A73]" /> {t("files.newFile")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreationModal({ visible: true, kind: "directory" });
                    setContextMenu((prev: WorkspaceContextMenuState) => ({ ...prev, visible: false }));
                  }}
                  className={`${menuItemClass} disabled:cursor-not-allowed disabled:opacity-40`}
                >
                  <FolderPlus size={13} className="shrink-0 text-[#646A73]" />{" "}
                  {t("files.newFolder")}
                </button>
              </>
            )}
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <MobileActionSheet
        open={isPagePresentation && isActionsMenuOpen}
        data-ripple-files-mobile-actions-sheet
        title={t("files.moreFileActions")}
        subtitle={mobilePathLabel}
        closeLabel={t("files.cancel")}
        onClose={closeActionsMenu}
        actions={[
          {
            key: "refresh",
            label: t("files.refreshWorkspace"),
            icon: <RefreshCw size={16} />,
            loading,
            disabled: loading,
            onClick: () => {
              closeActionsMenu();
              loadDirectory(currentPath);
            },
          },
          {
            key: "paste",
            label: clipboard
              ? clipboard.items.length === 1
                ? t("files.pasteNamed", { name: clipboard.items[0]?.name || "" })
                : t("files.pasteItems", { count: clipboard.items.length })
              : t("files.paste"),
            icon: <Clipboard size={16} />,
            disabled: !clipboard,
            onClick: () => {
              closeActionsMenu();
              handlePaste();
            },
          },
          ...(clipboard
            ? [
                {
                  key: "clear-clipboard",
                  label: t("files.clearClipboard"),
                  icon: <X size={16} />,
                  onClick: () => {
                    clearClipboard();
                    closeActionsMenu();
                  },
                },
              ]
            : []),
          {
            key: "new-file",
            label: t("files.newFile"),
            icon: <FilePlus size={16} />,
            onClick: () => {
              setCreationModal({ visible: true, kind: "file" });
              closeActionsMenu();
            },
          },
          {
            key: "new-folder",
            label: t("files.newFolder"),
            icon: <FolderPlus size={16} />,
            onClick: () => {
              setCreationModal({ visible: true, kind: "directory" });
              closeActionsMenu();
            },
          },
        ]}
      />
      <MobileActionSheet
        open={isPagePresentation && Boolean(mobileActionEntry)}
        data-ripple-files-mobile-entry-actions-sheet
        title={mobileActionEntry?.name || t("files.moreActions")}
        subtitle={mobileActionEntry?.path}
        closeLabel={t("files.cancel")}
        onClose={() => setMobileActionEntry(null)}
        actions={
          mobileActionEntry
            ? [
                {
                  key: "open",
                  label: t("files.open"),
                  icon:
                    mobileActionEntry.kind === "directory" ? (
                      <Folder size={16} />
                    ) : (
                      <FileText size={16} />
                    ),
                  onClick: () => {
                    const entry = mobileActionEntry;
                    setMobileActionEntry(null);
                    openEntry(entry);
                  },
                },
                {
                  key: "rename",
                  label: t("files.rename"),
                  icon: <Edit3 size={16} />,
                  onClick: () => {
                    const entry = mobileActionEntry;
                    setMobileActionEntry(null);
                    startRename(entry);
                  },
                },
                {
                  key: "move",
                  label: t("files.cutMove"),
                  icon: <Scissors size={16} />,
                  onClick: () => {
                    const entry = mobileActionEntry;
                    setMobileActionEntry(null);
                    handleCut(entry);
                  },
                },
                {
                  key: "copy",
                  label: t("files.copy"),
                  icon: <Copy size={16} />,
                  onClick: () => {
                    const entry = mobileActionEntry;
                    setMobileActionEntry(null);
                    handleCopy(entry);
                  },
                },
                ...(mobileActionEntry.kind === "file"
                  ? [
                      {
                        key: "download",
                        label: t("files.download"),
                        icon: <Download size={16} />,
                        onClick: () => {
                          const entry = mobileActionEntry;
                          setMobileActionEntry(null);
                          handleDownloadFile(entry.path);
                        },
                      },
                    ]
                  : []),
                {
                  key: "delete",
                  label: t("files.delete"),
                  icon: <Trash2 size={16} />,
                  tone: "danger" as const,
                  onClick: () => {
                    const entry = mobileActionEntry;
                    setMobileActionEntry(null);
                    handleDelete(entry);
                  },
                },
              ]
            : []
        }
      />
      {!isPagePresentation && isActionsMenuOpen && (
        <div
          data-ripple-files-compact-actions-menu
          className={`absolute top-[54px] right-3 z-40 w-[220px] text-[#2B2F36] ${TYPOGRAPHY_META_CLASS} ${WORKBENCH_MENU_CLASS}`}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              closeActionsMenu();
              loadDirectory(currentPath);
            }}
            disabled={loading}
            className={`${menuItemClass} disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {loading ? (
              <Loader2 size={13} className="shrink-0 animate-spin text-[#646A73]" />
            ) : (
              <RefreshCw size={13} className="shrink-0 text-[#646A73]" />
            )}
            {t("files.refreshWorkspace")}
          </button>
          <button
            type="button"
            disabled={!clipboard}
            onClick={() => {
              closeActionsMenu();
              handlePaste();
            }}
            className={`${menuItemClass} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            <Clipboard size={13} className="shrink-0 text-[#646A73]" />
            {clipboard ? (
              <>
                {clipboard.items.length === 1
                  ? t("files.pasteNamed", { name: clipboard.items[0]?.name || "" })
                  : t("files.pasteItems", { count: clipboard.items.length })}
              </>
            ) : (
              t("files.paste")
            )}
          </button>
          {clipboard ? (
            <button
              type="button"
              onClick={clearClipboard}
              className={`${menuItemClass} text-[#646A73]`}
            >
              <X size={13} className="shrink-0 text-[#646A73]" />
              {t("files.clearClipboard")}
            </button>
          ) : null}
          <div className="my-1 border-t border-[#DEE0E3]" />
          <button
            type="button"
            onClick={() => {
              setCreationModal({ visible: true, kind: "file" });
              closeActionsMenu();
            }}
            className={`${menuItemClass} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            <FilePlus size={13} className="shrink-0 text-[#646A73]" />
            {t("files.newFile")}
          </button>
          <button
            type="button"
            onClick={() => {
              setCreationModal({ visible: true, kind: "directory" });
              closeActionsMenu();
            }}
            className={`${menuItemClass} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            <FolderPlus size={13} className="shrink-0 text-[#646A73]" />
            {t("files.newFolder")}
          </button>
        </div>
      )}
      {contextMenuPortal}
    </>
  );
}
