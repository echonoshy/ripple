import React from "react";
import {
  AlertTriangle,
  ChevronDown,
  Edit3,
  FileText,
  Loader2,
  Maximize2,
  Save,
  Undo2,
  X,
} from "lucide-react";
import { IconTile } from "@/components/icons/IconTile";
import { PdfPreview } from "@/components/PdfPreview";
import {
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_META_MEDIUM_CLASS,
  TYPOGRAPHY_MICRO_MEDIUM_CLASS,
  WORKBENCH_ICON_BUTTON_CLASS,
  WORKBENCH_PRIMARY_BUTTON_CLASS,
  WORKBENCH_SECONDARY_BUTTON_CLASS,
} from "@/components/workbench/stylePrimitives";
import { useI18n } from "@/i18n";
import type { WorkspaceFilePreview } from "@/types";
import {
  MAX_SPLIT_PERCENT,
  MIN_SPLIT_PERCENT,
  formatBytes,
  formatModified,
} from "./workspaceExplorerUtils";

export interface WorkspaceDocumentPreview {
  blob: Blob;
  filename: string;
}

interface WorkspacePreviewPanelProps {
  preview: WorkspaceFilePreview | null;
  previewLoading: boolean;
  imagePreviewUrl: string | null;
  documentPreview: WorkspaceDocumentPreview | null;
  isPagePresentation: boolean;
  isEditing: boolean;
  isDirty: boolean;
  saving: boolean;
  saveError: string | null;
  draft: string;
  locale: string;
  highlightedLine: number | null;
  splitPercent: number;
  preContainerRef: React.RefObject<HTMLDivElement | null>;
  highlightedLineRef: React.RefObject<HTMLDivElement | null>;
  onToggleEditing: () => void;
  onOpenFullscreen: () => void;
  onCollapse: () => void;
  onRevert: () => void;
  onSave: () => void;
  onDraftChange: (value: string) => void;
  onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void;
  onResizeKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}

export function WorkspacePreviewPanel({
  preview,
  previewLoading,
  imagePreviewUrl,
  documentPreview,
  isPagePresentation,
  isEditing,
  isDirty,
  saving,
  saveError,
  draft,
  locale,
  highlightedLine,
  splitPercent,
  preContainerRef,
  highlightedLineRef,
  onToggleEditing,
  onOpenFullscreen,
  onCollapse,
  onRevert,
  onSave,
  onDraftChange,
  onResizeStart,
  onResizeKeyDown,
}: WorkspacePreviewPanelProps) {
  const { t } = useI18n();

  return (
    <section
      data-ripple-workspace-preview="preview"
      className={
        isPagePresentation
          ? "flex min-h-0 flex-col overflow-hidden bg-white"
          : "relative flex min-h-0 flex-col overflow-hidden bg-white"
      }
    >
      <div
        role="separator"
        aria-label={t("files.resizePreviewPanel")}
        aria-orientation="horizontal"
        aria-valuemin={MIN_SPLIT_PERCENT}
        aria-valuemax={MAX_SPLIT_PERCENT}
        aria-valuenow={splitPercent}
        data-ripple-workspace-preview-resize
        tabIndex={0}
        onPointerDown={onResizeStart}
        onKeyDown={onResizeKeyDown}
        className={
          isPagePresentation
            ? "group absolute top-0 right-0 left-0 z-20 flex h-3 -translate-y-1/2 cursor-row-resize items-center justify-center bg-transparent transition-colors outline-none hover:bg-[#E8F0FF]/70 focus:bg-[#E8F0FF]/70 lg:hidden"
            : "group absolute top-0 right-0 left-0 z-20 flex h-3 -translate-y-1/2 cursor-row-resize items-center justify-center bg-transparent transition-colors outline-none hover:bg-[#E8F0FF]/70 focus:bg-[#E8F0FF]/70"
        }
      >
        <span className="h-0.5 w-12 rounded-full bg-[#1456F0] opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100" />
      </div>
      <div
        className={
          isPagePresentation
            ? "flex min-h-[40px] shrink-0 items-center gap-2 border-b border-[#DEE0E3]/60 px-2 py-1 text-[#646A73] sm:min-h-[68px] sm:gap-3 sm:px-4 sm:py-3"
            : "flex shrink-0 items-center gap-2 border-b border-[#EFF0F1] bg-white px-3 py-2 text-[#646A73]"
        }
      >
        <IconTile
          tone={isPagePresentation ? "accent" : "neutral"}
          size={isPagePresentation ? "sm" : "md"}
        >
          <FileText size={isPagePresentation ? 13 : 15} />
        </IconTile>
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-[#1F2329] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>
            {isPagePresentation
              ? preview?.name || t("files.selectFile")
              : preview?.path || t("files.selectFile")}
          </span>
          {isPagePresentation && (
            <span
              data-ripple-workspace-preview-title-path
              className={`hidden truncate font-[family-name:var(--font-mono)] text-[#646A73] sm:mt-1 sm:block ${TYPOGRAPHY_META_CLASS}`}
            >
              {preview?.path || t("files.selectFile")}
            </span>
          )}
        </span>
        {previewLoading && <Loader2 size={12} className="animate-spin" />}
        {preview && (
          <div className="flex shrink-0 items-center gap-1">
            {!imagePreviewUrl && !documentPreview && (
              <button
                type="button"
                disabled={preview.truncated}
                onClick={onToggleEditing}
                className={`inline-flex h-8 items-center gap-1 rounded-full border px-2 ${TYPOGRAPHY_META_MEDIUM_CLASS} ${
                  isEditing
                    ? "border-[#1456F0] bg-[#F0F5FF] text-[#2B2F36]"
                    : isPagePresentation
                      ? "border-[#DEE0E3] bg-white text-[#646A73] hover:bg-[#F8F9FA] disabled:cursor-not-allowed disabled:text-[#8F959E]"
                      : "border-[#DEE0E3] bg-white text-[#646A73] hover:bg-[#F8F9FA] disabled:cursor-not-allowed disabled:text-[#8F959E]"
                }`}
                title={preview.truncated ? t("files.truncatedCannotEdit") : t("files.edit")}
              >
                <Edit3 size={12} />
                {t("files.edit")}
              </button>
            )}
            <button
              type="button"
              aria-label={t("files.openFullscreenPreview")}
              title={t("files.fullscreenPreview")}
              onClick={onOpenFullscreen}
              className={
                isPagePresentation
                  ? `${WORKBENCH_ICON_BUTTON_CLASS} !h-8 !w-8 text-[#646A73] hover:text-[#1F2329] sm:!h-7 sm:!w-7`
                  : "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[#DEE0E3] bg-white text-[#646A73] hover:bg-[#F8F9FA] hover:text-[#1F2329]"
              }
            >
              <Maximize2 size={isPagePresentation ? 12 : 13} />
            </button>
          </div>
        )}
        <button
          type="button"
          aria-label={t("files.collapsePreviewPanel")}
          title={t("files.collapsePanel")}
          onClick={onCollapse}
          className={
            isPagePresentation
              ? `${WORKBENCH_ICON_BUTTON_CLASS} !h-8 !w-8 text-[#646A73] hover:text-[#1F2329] sm:!h-7 sm:!w-7`
              : "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[#DEE0E3] bg-white text-[#646A73] hover:bg-[#F8F9FA] hover:text-[#1F2329]"
          }
        >
          <ChevronDown size={isPagePresentation ? 12 : 13} />
        </button>
      </div>
      <div
        className={
          isPagePresentation
            ? "min-h-0 flex-1 overflow-hidden"
            : "min-h-0 flex-1 overflow-hidden bg-white"
        }
      >
        {preview ? (
          <div className="flex h-full min-h-0 flex-col">
            <div
              data-ripple-workspace-preview-metadata
              className={
                isPagePresentation
                  ? `hidden flex-wrap items-center gap-2 border-b border-[#DEE0E3]/60 px-4 py-2 font-[family-name:var(--font-mono)] text-[#646A73] sm:flex ${TYPOGRAPHY_META_MEDIUM_CLASS}`
                  : `flex flex-wrap items-center gap-2 border-b border-[#DEE0E3] px-3 py-2 font-[family-name:var(--font-mono)] text-[#646A73] ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`
              }
            >
              <span>{formatBytes(preview.size_bytes)}</span>
              <span>{preview.mime_type}</span>
              <span>{formatModified(preview.modified_at, locale)}</span>
              {isDirty && (
                <span
                  className={`rounded-full border border-[#1456F0]/25 bg-[#F0F5FF] px-1.5 py-0.5 text-[#0F4BD8] uppercase ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`}
                >
                  {t("files.unsaved")}
                </span>
              )}
              {preview.truncated && (
                <span
                  className={`rounded-full border border-[#1456F0]/35 bg-[#F0F5FF] px-1.5 py-0.5 text-[#0F4BD8] uppercase ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`}
                >
                  {t("files.truncated")}
                </span>
              )}
              {isEditing && (
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={onRevert}
                    disabled={!isDirty || saving}
                    className={
                      isPagePresentation
                        ? `${WORKBENCH_SECONDARY_BUTTON_CLASS} h-8 px-2 text-[#646A73] disabled:text-[#8F959E] ${TYPOGRAPHY_META_MEDIUM_CLASS}`
                        : `inline-flex h-7 items-center gap-1 rounded-md border border-[#DEE0E3] bg-white px-2 text-[#646A73] hover:bg-[#F8F9FA] disabled:cursor-not-allowed disabled:text-[#8F959E] ${TYPOGRAPHY_META_MEDIUM_CLASS}`
                    }
                  >
                    <Undo2 size={12} />
                    {t("files.revert")}
                  </button>
                  <button
                    type="button"
                    onClick={onSave}
                    disabled={!isDirty || saving || preview.truncated}
                    className={
                      isPagePresentation
                        ? `${WORKBENCH_PRIMARY_BUTTON_CLASS} h-8 px-2 disabled:border-[#DEE0E3] ${TYPOGRAPHY_META_MEDIUM_CLASS}`
                        : `inline-flex h-7 items-center gap-1 rounded-md border border-[#1F2329] bg-[#1F2329] px-2 text-white hover:bg-[#2a2f37] disabled:cursor-not-allowed disabled:border-[#DEE0E3] disabled:bg-[#F8F9FA] disabled:text-[#8F959E] ${TYPOGRAPHY_META_MEDIUM_CLASS}`
                    }
                  >
                    {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                    {t("files.save")}
                  </button>
                </div>
              )}
            </div>
            {saveError && (
              <div
                className={`m-3 mb-0 flex items-start gap-2 rounded-xl border border-[#B42318]/25 bg-[#FFF1F0] p-3 text-[#B42318] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
              >
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>{saveError}</span>
              </div>
            )}
            <WorkspacePreviewBody
              preview={preview}
              draft={draft}
              imagePreviewUrl={imagePreviewUrl}
              documentPreview={documentPreview}
              isPagePresentation={isPagePresentation}
              isEditing={isEditing}
              highlightedLine={highlightedLine}
              preContainerRef={preContainerRef}
              highlightedLineRef={highlightedLineRef}
              onDraftChange={onDraftChange}
            />
          </div>
        ) : (
          <div
            className={`flex h-full items-center justify-center px-4 text-center text-[#646A73] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
          >
            {t("files.selectFile")}
          </div>
        )}
      </div>
    </section>
  );
}

interface WorkspacePreviewBodyProps {
  preview: WorkspaceFilePreview;
  draft: string;
  imagePreviewUrl: string | null;
  documentPreview: WorkspaceDocumentPreview | null;
  isPagePresentation: boolean;
  isEditing: boolean;
  highlightedLine: number | null;
  preContainerRef: React.RefObject<HTMLDivElement | null>;
  highlightedLineRef: React.RefObject<HTMLDivElement | null>;
  onDraftChange: (value: string) => void;
}

function WorkspacePreviewBody({
  preview,
  draft,
  imagePreviewUrl,
  documentPreview,
  isPagePresentation,
  isEditing,
  highlightedLine,
  preContainerRef,
  highlightedLineRef,
  onDraftChange,
}: WorkspacePreviewBodyProps) {
  if (documentPreview) {
    return (
      <div
        data-ripple-workspace-document-preview
        className={
          isPagePresentation
            ? "min-h-0 flex-1 overflow-hidden bg-[#f4f7fb]"
            : "min-h-0 flex-1 overflow-hidden bg-[#F8F9FA]"
        }
      >
        <PdfPreview
          blob={documentPreview.blob}
          filename={documentPreview.filename}
          className="h-full min-h-0"
        />
      </div>
    );
  }

  if (imagePreviewUrl) {
    return (
      <div className="flex min-h-[300px] flex-1 items-center justify-center overflow-auto bg-[#F8F9FA] p-6">
        <img
          src={imagePreviewUrl}
          alt={preview.name}
          className={
            isPagePresentation
              ? "max-h-[480px] max-w-full rounded-xl border border-[#DEE0E3] bg-white object-contain p-1.5 shadow-[0_1px_2px_rgba(31,35,41,0.04)]"
              : "max-h-[480px] max-w-full rounded-md border border-[#e2e8f0] bg-white object-contain p-1.5 shadow-sm transition-all hover:shadow"
          }
        />
      </div>
    );
  }

  if (isEditing) {
    return (
      <textarea
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        spellCheck={false}
        className={
          isPagePresentation
            ? "min-h-0 flex-1 resize-none overflow-auto border-0 bg-[#FFFFFF] p-4 font-[family-name:var(--font-mono)] text-[13px] leading-relaxed text-[#1F2329] outline-none"
            : "min-h-0 flex-1 resize-none overflow-auto border-0 bg-white p-3 font-[family-name:var(--font-mono)] text-[12px] leading-relaxed text-[#1F2329] outline-none"
        }
      />
    );
  }

  return (
    <div
      ref={preContainerRef}
      className={
        isPagePresentation
          ? "min-h-0 flex-1 overflow-auto bg-[#FFFFFF] p-4"
          : "min-h-0 flex-1 overflow-auto bg-white"
      }
    >
      <WorkspaceTextPreviewLines
        content={preview.content}
        highlightedLine={highlightedLine}
        highlightedLineRef={highlightedLineRef}
        isPagePresentation={isPagePresentation}
      />
    </div>
  );
}

interface WorkspaceTextPreviewLinesProps {
  content: string;
  highlightedLine?: number | null;
  highlightedLineRef?: React.RefObject<HTMLDivElement | null>;
  isPagePresentation: boolean;
}

function WorkspaceTextPreviewLines({
  content,
  highlightedLine,
  highlightedLineRef,
  isPagePresentation,
}: WorkspaceTextPreviewLinesProps) {
  return (
    <div
      className={
        isPagePresentation
          ? "rounded-xl border border-[#DEE0E3] bg-white py-3 shadow-[0_1px_2px_rgba(31,35,41,0.04)]"
          : "py-2"
      }
    >
      {content.split("\n").map((line, idx) => {
        const lineNum = idx + 1;
        const isLineHighlighted = highlightedLine === lineNum;
        return (
          <div
            key={lineNum}
            ref={isLineHighlighted ? highlightedLineRef : undefined}
            className={`flex min-w-0 items-start font-[family-name:var(--font-mono)] text-[13px] leading-relaxed transition-colors ${
              isLineHighlighted
                ? isPagePresentation
                  ? "border-l-4 border-[#1456F0] bg-[#F0F5FF] pl-2"
                  : "border-l-2 border-[#1456F0] bg-[#F0F5FF] pl-[10px]"
                : isPagePresentation
                  ? "pl-3 hover:bg-[#F8F9FA]"
                  : "pl-3 hover:bg-[#F8F9FA]"
            }`}
          >
            <span className="w-9 shrink-0 pr-3 text-right text-[#8F959E] select-none">
              {lineNum}
            </span>
            <span className="flex-1 break-all whitespace-pre-wrap text-[#1F2329]">
              {line || " "}
            </span>
          </div>
        );
      })}
    </div>
  );
}

interface WorkspacePreviewFullscreenProps {
  open: boolean;
  preview: WorkspaceFilePreview | null;
  documentPreview: WorkspaceDocumentPreview | null;
  imagePreviewUrl: string | null;
  isEditing: boolean;
  draft: string;
  locale: string;
  onClose: () => void;
}

export function WorkspacePreviewFullscreen({
  open,
  preview,
  documentPreview,
  imagePreviewUrl,
  isEditing,
  draft,
  locale,
  onClose,
}: WorkspacePreviewFullscreenProps) {
  const { t } = useI18n();
  if (!open || !preview) return null;

  return (
    <div
      data-ripple-workspace-preview-fullscreen
      className="fixed inset-0 z-[70] flex min-h-0 flex-col bg-white pt-[max(env(safe-area-inset-top),0px)] pb-[max(env(safe-area-inset-bottom),0px)] text-[#1F2329]"
    >
      <div className="flex min-h-[56px] shrink-0 items-center gap-2 border-b border-[#DEE0E3] bg-white px-3 py-1.5 sm:min-h-[60px] sm:gap-3 sm:px-4">
        <IconTile tone="accent" size="sm">
          <FileText size={13} />
        </IconTile>
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-[#1F2329] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>
            {preview.name}
          </span>
          <span
            className={`mt-0.5 hidden truncate font-[family-name:var(--font-mono)] text-[#646A73] sm:block ${TYPOGRAPHY_META_CLASS}`}
          >
            {preview.path}
          </span>
        </span>
        <div
          className={`hidden shrink-0 items-center gap-2 font-[family-name:var(--font-mono)] text-[#646A73] md:flex ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
        >
          <span>{formatBytes(preview.size_bytes)}</span>
          <span>{preview.mime_type}</span>
          <span>{formatModified(preview.modified_at, locale)}</span>
        </div>
        <button
          type="button"
          aria-label={t("files.closeFullscreenPreview")}
          title={t("files.closeFullscreenPreview")}
          onClick={onClose}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#DEE0E3] bg-white text-[#646A73] hover:bg-[#F8F9FA] hover:text-[#1F2329]"
        >
          <X size={15} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden bg-[#f4f7fb]">
        {documentPreview ? (
          <PdfPreview
            blob={documentPreview.blob}
            filename={documentPreview.filename}
            fullscreen
            className="h-full min-h-0"
          />
        ) : imagePreviewUrl ? (
          <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-[#F8F9FA] p-4 sm:p-8">
            <img
              src={imagePreviewUrl}
              alt={preview.name}
              className="max-h-full max-w-full rounded-lg border border-[#DEE0E3] bg-white object-contain p-1.5 shadow-[0_1px_2px_rgba(31,35,41,0.04)]"
            />
          </div>
        ) : (
          <div className="h-full min-h-0 overflow-auto bg-white p-4 sm:p-6">
            <div className="mx-auto max-w-6xl rounded-lg border border-[#DEE0E3] bg-white py-3 shadow-[0_1px_2px_rgba(31,35,41,0.04)]">
              <WorkspaceTextPreviewLines
                content={isEditing ? draft : preview.content}
                isPagePresentation={false}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
