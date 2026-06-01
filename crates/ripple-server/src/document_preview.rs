use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::Context;
use serde::Serialize;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::process::Command;
use uuid::Uuid;

use crate::config::AppConfig;
use crate::storage::sha256_hex;
use crate::workspace as ws;

const OFFICE_EXTENSIONS: &[&str] = &[
    "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
];

pub struct RenderedDocumentPreview {
    pub pdf_path: PathBuf,
    pub download_name: String,
}

#[derive(Serialize)]
struct PreviewCacheMeta<'a> {
    source_path: &'a str,
    source_size_bytes: u64,
    source_modified_nanos: u128,
    created_at: String,
}

pub fn is_pdf_preview_path(path: &Path) -> bool {
    extension(path).as_deref() == Some("pdf") || ws::mime_type_for_path(path) == "application/pdf"
}

pub fn is_office_preview_path(path: &Path) -> bool {
    extension(path)
        .as_deref()
        .is_some_and(|ext| OFFICE_EXTENSIONS.contains(&ext))
}

pub async fn render_document_preview(
    config: &AppConfig,
    workspace_root: &Path,
    user_id: &str,
    workspace_path: &str,
) -> anyhow::Result<RenderedDocumentPreview> {
    let source = ws::validate_existing_path(workspace_path, workspace_root)?;
    if !source.is_file() {
        anyhow::bail!("Path is not a file");
    }

    if is_pdf_preview_path(&source) {
        return Ok(RenderedDocumentPreview {
            pdf_path: source,
            download_name: preview_pdf_name(workspace_path),
        });
    }

    if !is_office_preview_path(&source) {
        anyhow::bail!("Unsupported preview format");
    }

    let metadata = tokio::fs::metadata(&source).await?;
    if metadata.len() > config.document_preview.max_source_bytes {
        anyhow::bail!("File is too large for document preview");
    }

    let modified_nanos = modified_nanos(&metadata);
    let cache_key = preview_cache_key(workspace_path, metadata.len(), modified_nanos);
    let cache_dir = config
        .document_preview
        .cache_root
        .join(user_id)
        .join(cache_key);
    let cached_pdf = cache_dir.join("preview.pdf");
    if cached_pdf.is_file() {
        return Ok(RenderedDocumentPreview {
            pdf_path: cached_pdf,
            download_name: preview_pdf_name(workspace_path),
        });
    }

    let tmp_dir = config
        .document_preview
        .cache_root
        .join("tmp")
        .join(format!("preview-{}", Uuid::new_v4().simple()));
    tokio::fs::create_dir_all(&tmp_dir).await?;

    let conversion_result = async {
        let converted_pdf = convert_office_to_pdf(config, &source, &tmp_dir).await?;
        tokio::fs::create_dir_all(&cache_dir).await?;
        tokio::fs::rename(&converted_pdf, &cached_pdf)
            .await
            .with_context(|| {
                format!(
                    "failed to move converted preview {} to {}",
                    converted_pdf.display(),
                    cached_pdf.display()
                )
            })?;
        write_preview_meta(&cache_dir, workspace_path, metadata.len(), modified_nanos).await?;
        Ok::<_, anyhow::Error>(())
    }
    .await;

    let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
    conversion_result?;

    Ok(RenderedDocumentPreview {
        pdf_path: cached_pdf,
        download_name: preview_pdf_name(workspace_path),
    })
}

async fn convert_office_to_pdf(
    config: &AppConfig,
    source: &Path,
    tmp_dir: &Path,
) -> anyhow::Result<PathBuf> {
    let mut command = Command::new(&config.document_preview.libreoffice_path);
    command
        .arg("--headless")
        .arg("--nologo")
        .arg("--nofirststartwizard")
        .arg("--norestore")
        .arg("--convert-to")
        .arg("pdf")
        .arg("--outdir")
        .arg(tmp_dir)
        .arg(source)
        .env("HOME", tmp_dir)
        .env("TMPDIR", tmp_dir);

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(config.document_preview.conversion_timeout_seconds),
        command.output(),
    )
    .await
    .context("document preview conversion timed out")?
    .context("failed to start LibreOffice converter")?;

    if !output.status.success() {
        anyhow::bail!(
            "LibreOffice conversion failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    find_pdf_in_dir(tmp_dir)
        .await?
        .ok_or_else(|| anyhow::anyhow!("LibreOffice did not produce a PDF preview"))
}

async fn find_pdf_in_dir(dir: &Path) -> anyhow::Result<Option<PathBuf>> {
    let mut entries = tokio::fs::read_dir(dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if entry.file_type().await?.is_file() && is_pdf_preview_path(&path) {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

async fn write_preview_meta(
    cache_dir: &Path,
    source_path: &str,
    source_size_bytes: u64,
    source_modified_nanos: u128,
) -> anyhow::Result<()> {
    let created_at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string());
    let meta = PreviewCacheMeta {
        source_path,
        source_size_bytes,
        source_modified_nanos,
        created_at,
    };
    let bytes = serde_json::to_vec_pretty(&meta)?;
    tokio::fs::write(cache_dir.join("meta.json"), bytes).await?;
    Ok(())
}

fn preview_cache_key(workspace_path: &str, size: u64, modified_nanos: u128) -> String {
    sha256_hex(format!("{workspace_path}\0{size}\0{modified_nanos}").as_bytes())
}

fn preview_pdf_name(workspace_path: &str) -> String {
    let name = workspace_path.rsplit('/').next().unwrap_or("preview.pdf");
    let stem = name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(name);
    if stem.is_empty() {
        "preview.pdf".to_string()
    } else {
        format!("{stem}.pdf")
    }
}

fn extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
}

fn modified_nanos(metadata: &std::fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}
