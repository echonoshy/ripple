use std::collections::HashSet;
use std::io::Read;
use std::path::Path;

use serde_json::{json, Value};
use walkdir::WalkDir;

use crate::context_scope::{resolve_context_scope, ContextScope};
use crate::workspace as ws;

const MAX_SCAN_FILES: usize = 2_000;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_MATCHES: usize = 8;
const MAX_SNIPPET_CHARS: usize = 320;
const MAX_PROMPT_CHARS: usize = 4_000;

const TEXT_EXTENSIONS: &[&str] = &[
    "cfg", "conf", "csv", "ini", "json", "jsonl", "log", "markdown", "md", "mdx", "rst", "toml",
    "txt", "xml", "yaml", "yml",
];

#[derive(Debug, Clone)]
pub(crate) struct FolderContext {
    pub prompt_section: String,
    pub runtime_event: Value,
    pub context_root_read_only: bool,
}

#[derive(Debug, Clone)]
struct FolderContextMatch {
    path: String,
    line: usize,
    snippet: String,
    score: usize,
}

#[derive(Debug, Clone)]
struct FolderContextSearchSummary {
    context_folder_path: String,
    query: String,
    scanned_files: usize,
    truncated: bool,
    matches: Vec<FolderContextMatch>,
    discovered_link_count: usize,
    direct_root_count: usize,
    linked_root_count: usize,
    rejected_link_count: usize,
}

pub(crate) fn collect_folder_context(
    workspace_root: &Path,
    context_folder_path: Option<&str>,
    query: &str,
) -> Option<FolderContext> {
    let context_folder_path = context_folder_path?.trim();
    if context_folder_path.is_empty() {
        return None;
    }
    let context_folder = ws::validate_existing_path(context_folder_path, workspace_root).ok()?;
    if !context_folder.is_dir() {
        return None;
    }
    let scope = resolve_context_scope(workspace_root, &context_folder).ok()?;

    let terms = query_terms(query);
    let summary = search_context_folder_files(&scope, context_folder_path, query, &terms);
    let prompt_section = render_prompt_section(&summary, &terms);
    let runtime_event = runtime_event(&summary);
    Some(FolderContext {
        prompt_section,
        runtime_event,
        context_root_read_only: scope.context_root_read_only(),
    })
}

fn search_context_folder_files(
    scope: &ContextScope,
    context_folder_path: &str,
    query: &str,
    terms: &[String],
) -> FolderContextSearchSummary {
    let mut scanned_files = 0_usize;
    let mut truncated = false;
    let mut matches = Vec::new();

    let mut roots = vec![(
        scope.context_root.as_path(),
        scope.context_root_workspace_path.as_str(),
    )];
    roots.extend(
        scope
            .linked_roots
            .iter()
            .map(|root| (root.canonical_path.as_path(), root.logical_path.as_str())),
    );

    'roots: for (physical_root, logical_root) in roots {
        for entry in WalkDir::new(physical_root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                entry.path() == physical_root || !is_hidden_path(physical_root, entry.path())
            })
            .filter_map(Result::ok)
        {
            let path = entry.path();
            if path == physical_root
                || !entry.file_type().is_file()
                || entry.file_type().is_symlink()
            {
                continue;
            }
            if !is_text_path(path) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.len() > MAX_FILE_BYTES {
                continue;
            }
            if scanned_files >= MAX_SCAN_FILES {
                truncated = true;
                break 'roots;
            }
            scanned_files += 1;

            let Some(workspace_path) = logical_workspace_path(logical_root, physical_root, path)
            else {
                continue;
            };
            let Some(text) = read_text_file(path) else {
                continue;
            };
            let path_score = score_text(&workspace_path.to_lowercase(), terms) * 5;
            let Some((line, snippet, content_score)) = best_snippet(&text, terms, path_score > 0)
            else {
                continue;
            };
            let score = path_score + content_score;
            if score == 0 {
                continue;
            }
            matches.push(FolderContextMatch {
                path: workspace_path,
                line,
                snippet,
                score,
            });
        }
    }

    matches.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    matches.truncate(MAX_MATCHES);

    FolderContextSearchSummary {
        context_folder_path: context_folder_path.to_string(),
        query: query.trim().to_string(),
        scanned_files,
        truncated,
        matches,
        discovered_link_count: scope.discovered_link_count,
        direct_root_count: scope.direct_roots.len(),
        linked_root_count: scope.linked_roots.len(),
        rejected_link_count: scope.rejected_link_count,
    }
}

fn logical_workspace_path(logical_root: &str, physical_root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(physical_root).ok()?;
    if relative.as_os_str().is_empty() {
        return Some(logical_root.to_string());
    }
    Some(format!(
        "{}/{}",
        logical_root.trim_end_matches('/'),
        relative.to_string_lossy().replace('\\', "/")
    ))
}

fn query_terms(query: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut seen = HashSet::new();
    let mut current = String::new();

    for ch in query.chars() {
        if ch.is_alphanumeric() {
            current.extend(ch.to_lowercase());
        } else {
            push_term(&mut terms, &mut seen, &current);
            current.clear();
        }
    }
    push_term(&mut terms, &mut seen, &current);

    let cjk_chars = query.chars().filter(|ch| is_cjk(*ch)).collect::<Vec<_>>();
    for width in 2..=4 {
        for window in cjk_chars.windows(width) {
            let gram = window.iter().collect::<String>();
            push_term(&mut terms, &mut seen, &gram);
            if terms.len() >= 48 {
                return terms;
            }
        }
    }

    terms
}

fn push_term(terms: &mut Vec<String>, seen: &mut HashSet<String>, raw: &str) {
    let term = raw.trim().to_lowercase();
    let char_count = term.chars().count();
    if !(2..=40).contains(&char_count) {
        return;
    }
    if seen.insert(term.clone()) {
        terms.push(term);
    }
}

fn is_cjk(ch: char) -> bool {
    matches!(
        ch as u32,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF
    )
}

fn is_hidden_path(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .any(|component| {
            let std::path::Component::Normal(name) = component else {
                return false;
            };
            name.to_string_lossy().starts_with('.')
        })
}

fn is_text_path(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    TEXT_EXTENSIONS.contains(&extension.as_str())
}

fn read_text_file(path: &Path) -> Option<String> {
    let mut bytes = Vec::new();
    let mut file = std::fs::File::open(path).ok()?.take(MAX_FILE_BYTES + 1);
    file.read_to_end(&mut bytes).ok()?;
    if bytes.iter().any(|byte| *byte == 0) {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn best_snippet(
    text: &str,
    terms: &[String],
    allow_path_only_match: bool,
) -> Option<(usize, String, usize)> {
    let mut fallback = None;
    let mut best = None::<(usize, String, usize)>;

    for (index, line) in text.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if fallback.is_none() {
            fallback = Some((index + 1, truncate_chars(trimmed, MAX_SNIPPET_CHARS), 0));
        }
        let score = score_text(&trimmed.to_lowercase(), terms) * 10;
        if score > best.as_ref().map(|item| item.2).unwrap_or(0) {
            best = Some((index + 1, truncate_chars(trimmed, MAX_SNIPPET_CHARS), score));
        }
    }

    best.filter(|item| item.2 > 0)
        .or_else(|| allow_path_only_match.then(|| fallback).flatten())
}

fn score_text(text: &str, terms: &[String]) -> usize {
    terms
        .iter()
        .map(|term| text.matches(term).count().min(5))
        .sum()
}

fn render_prompt_section(summary: &FolderContextSearchSummary, terms: &[String]) -> String {
    let mut section = vec![
        "Folder context search completed before this turn.".to_string(),
        format!("- Scope: {}", summary.context_folder_path),
        format!("- Query: {}", summary.query),
        format!("- Scanned text files: {}", summary.scanned_files),
        format!("- Matched files: {}", summary.matches.len()),
        format!("- Discovered direct links: {}", summary.discovered_link_count),
        format!("- Authorized direct roots: {}", summary.direct_root_count),
        format!("- Authorized linked roots: {}", summary.linked_root_count),
        format!("- Rejected links: {}", summary.rejected_link_count),
        format!(
            "- Search terms: {}",
            if terms.is_empty() {
                "(none)".to_string()
            } else {
                terms.iter().take(16).cloned().collect::<Vec<_>>().join(", ")
            }
        ),
        "- Guidance: Use these local matches as starting evidence. If they are incomplete, search or read more files under the context folder before using web_search. Use web_search as a supplement only when the user asks for online/latest information or local evidence is insufficient.".to_string(),
        "- Record evidence priority: Read the record's AGENTS.md and use its designated original-text source. Extracted content.md or transcript.md takes priority over summary.md for questions about original record contents.".to_string(),
    ];

    if summary.linked_root_count > 0 {
        section.push("- Collection context guidance: Direct and linked record directories are part of this context. The collection root is structural and read-only; read or write content through the individual record directories.".to_string());
    }

    if summary.matches.is_empty() {
        section.push(
            "- Matches: none from the lightweight search. Inspect the context folder directly before using web_search unless the user explicitly asked for online information."
                .to_string(),
        );
    } else {
        section.push("Matches:".to_string());
        for (index, item) in summary.matches.iter().enumerate() {
            section.push(format!(
                "{}. {}:{}\n   {}",
                index + 1,
                item.path,
                item.line,
                item.snippet
            ));
        }
    }

    truncate_chars(&section.join("\n"), MAX_PROMPT_CHARS)
}

fn runtime_event(summary: &FolderContextSearchSummary) -> Value {
    json!({
        "type": "folder_context_search",
        "id": format!("folder-context-search:{}", summary.context_folder_path),
        "status": "completed",
        "context_folder_path": summary.context_folder_path,
        "query": summary.query,
        "match_count": summary.matches.len(),
        "scanned_files": summary.scanned_files,
        "truncated": summary.truncated,
        "discovered_link_count": summary.discovered_link_count,
        "direct_root_count": summary.direct_root_count,
        "linked_root_count": summary.linked_root_count,
        "rejected_link_count": summary.rejected_link_count,
        "matches": summary.matches.iter().map(|item| json!({
            "path": item.path,
            "line": item.line,
            "snippet": item.snippet,
        })).collect::<Vec<_>>(),
    })
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut truncated = value
        .chars()
        .take(max_chars.saturating_sub(3))
        .collect::<String>();
    truncated.push_str("...");
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn collects_folder_context_only_from_selected_folder() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("ripple-folder-context-{}", Uuid::new_v4()));
        let folder = root.join("genius_club");
        std::fs::create_dir_all(&folder)?;
        std::fs::write(
            folder.join("001.txt"),
            "天才俱乐部成员名单\n林弦负责重新建立组织。",
        )?;
        std::fs::write(root.join("outside.txt"), "天才俱乐部外部资料不应命中")?;

        let context = collect_folder_context(
            &root,
            Some("/workspace/genius_club"),
            "天才俱乐部成员分别是谁？",
        )
        .expect("folder context");

        assert!(context.prompt_section.contains("Folder context search"));
        assert!(context
            .prompt_section
            .contains("/workspace/genius_club/001.txt"));
        assert!(!context.prompt_section.contains("outside.txt"));
        assert_eq!(
            context.runtime_event.get("type").and_then(Value::as_str),
            Some("folder_context_search")
        );
        assert_eq!(
            context
                .runtime_event
                .get("context_folder_path")
                .and_then(Value::as_str),
            Some("/workspace/genius_club")
        );
        assert_eq!(
            context
                .runtime_event
                .get("match_count")
                .and_then(Value::as_u64),
            Some(1)
        );

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn folder_context_reports_no_matches_without_using_siblings() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("ripple-folder-context-{}", Uuid::new_v4()));
        let folder = root.join("notes");
        std::fs::create_dir_all(&folder)?;
        std::fs::write(folder.join("local.txt"), "unrelated local text")?;
        std::fs::write(root.join("answer.txt"), "needle only outside")?;

        let context =
            collect_folder_context(&root, Some("/workspace/notes"), "needle").expect("context");

        assert!(context.prompt_section.contains("Matches: none"));
        assert!(!context.prompt_section.contains("answer.txt"));
        assert_eq!(
            context
                .runtime_event
                .get("match_count")
                .and_then(Value::as_u64),
            Some(0)
        );

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn folder_context_reads_direct_linked_directory_inside_workspace() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("ripple-folder-context-{}", Uuid::new_v4()));
        let space = root.join("研发周会");
        let record = root.join("07-07 14:01");
        std::fs::create_dir_all(&space)?;
        std::fs::create_dir_all(&record)?;
        std::fs::write(record.join("transcript.md"), "本周已完成登录链路改造。")?;
        std::os::unix::fs::symlink(&record, space.join("07-07 14:01"))?;

        let context =
            collect_folder_context(&root, Some("/workspace/研发周会"), "本周完成了什么？")
                .expect("folder context");

        assert!(context
            .prompt_section
            .contains("/workspace/研发周会/07-07 14:01/transcript.md"));
        assert_eq!(
            context
                .runtime_event
                .get("linked_root_count")
                .and_then(Value::as_u64),
            Some(1)
        );

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn folder_context_does_not_follow_nested_links_from_linked_root() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("ripple-folder-context-{}", Uuid::new_v4()));
        let space = root.join("space");
        let record = root.join("record");
        let unrelated = root.join("unrelated");
        std::fs::create_dir_all(&space)?;
        std::fs::create_dir_all(&record)?;
        std::fs::create_dir_all(&unrelated)?;
        std::fs::write(record.join("transcript.md"), "ordinary record content")?;
        std::fs::write(unrelated.join("secret.md"), "nested-link-secret")?;
        std::os::unix::fs::symlink(&record, space.join("record"))?;
        std::os::unix::fs::symlink(&unrelated, record.join("nested"))?;

        let context = collect_folder_context(&root, Some("/workspace/space"), "nested-link-secret")
            .expect("folder context");

        assert!(context.prompt_section.contains("Matches: none"));
        assert!(!context.prompt_section.contains("secret.md"));
        assert_eq!(
            context
                .runtime_event
                .get("linked_root_count")
                .and_then(Value::as_u64),
            Some(1)
        );

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn folder_context_allows_hidden_runtime_parent_paths() -> anyhow::Result<()> {
        let root = std::env::temp_dir()
            .join(format!("ripple-folder-context-{}", Uuid::new_v4()))
            .join(".ripple/sandboxes/lake/workspace");
        let folder = root.join("genius_club");
        std::fs::create_dir_all(&folder)?;
        std::fs::write(folder.join("chapter.txt"), "天才俱乐部成员 林弦")?;

        let context =
            collect_folder_context(&root, Some("/workspace/genius_club"), "天才俱乐部成员")
                .expect("context");

        assert!(context
            .prompt_section
            .contains("/workspace/genius_club/chapter.txt"));

        let cleanup_root = root
            .ancestors()
            .nth(4)
            .map(Path::to_path_buf)
            .unwrap_or(root);
        let _ = std::fs::remove_dir_all(cleanup_root);
        Ok(())
    }
}
