use std::collections::HashSet;
use std::io::Read;
use std::path::Path;

use serde_json::{json, Value};
use walkdir::WalkDir;

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
pub(crate) struct ProjectFileContext {
    pub prompt_section: String,
    pub runtime_event: Value,
}

#[derive(Debug, Clone)]
struct ProjectFileMatch {
    path: String,
    line: usize,
    snippet: String,
    score: usize,
}

#[derive(Debug, Clone)]
struct ProjectSearchSummary {
    project_root: String,
    query: String,
    scanned_files: usize,
    truncated: bool,
    matches: Vec<ProjectFileMatch>,
}

pub(crate) fn collect_project_file_context(
    workspace_root: &Path,
    project_root: Option<&str>,
    query: &str,
) -> Option<ProjectFileContext> {
    let project_root = project_root?.trim();
    if project_root.is_empty() {
        return None;
    }
    let project_path = ws::validate_existing_path(project_root, workspace_root).ok()?;
    if !project_path.is_dir() {
        return None;
    }

    let terms = query_terms(query);
    let summary = search_project_files(workspace_root, &project_path, project_root, query, &terms);
    let prompt_section = render_prompt_section(&summary, &terms);
    let runtime_event = runtime_event(&summary);
    Some(ProjectFileContext {
        prompt_section,
        runtime_event,
    })
}

fn search_project_files(
    workspace_root: &Path,
    project_path: &Path,
    project_root: &str,
    query: &str,
    terms: &[String],
) -> ProjectSearchSummary {
    let mut scanned_files = 0_usize;
    let mut truncated = false;
    let mut matches = Vec::new();

    for entry in WalkDir::new(project_path)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            entry.path() == project_path || !is_hidden_path(project_path, entry.path())
        })
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if path == project_path || !entry.file_type().is_file() || entry.file_type().is_symlink() {
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
            break;
        }
        scanned_files += 1;

        let Ok(workspace_path) = ws::workspace_path(workspace_root, path) else {
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
        matches.push(ProjectFileMatch {
            path: workspace_path,
            line,
            snippet,
            score,
        });
    }

    matches.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    matches.truncate(MAX_MATCHES);

    ProjectSearchSummary {
        project_root: project_root.to_string(),
        query: query.trim().to_string(),
        scanned_files,
        truncated,
        matches,
    }
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

fn render_prompt_section(summary: &ProjectSearchSummary, terms: &[String]) -> String {
    let mut section = vec![
        "Project-local search completed before this turn.".to_string(),
        format!("- Scope: {}", summary.project_root),
        format!("- Query: {}", summary.query),
        format!("- Scanned text files: {}", summary.scanned_files),
        format!("- Matched files: {}", summary.matches.len()),
        format!(
            "- Search terms: {}",
            if terms.is_empty() {
                "(none)".to_string()
            } else {
                terms.iter().take(16).cloned().collect::<Vec<_>>().join(", ")
            }
        ),
        "- Guidance: Use these local matches as starting evidence. If they are incomplete, search or read more files under the project root before using web_search. Use web_search as a supplement only when the user asks for online/latest information or local evidence is insufficient.".to_string(),
    ];

    if summary.matches.is_empty() {
        section.push(
            "- Matches: none from the lightweight search. Inspect the project folder directly before using web_search unless the user explicitly asked for online information."
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

fn runtime_event(summary: &ProjectSearchSummary) -> Value {
    json!({
        "type": "project_file_search",
        "id": format!("project-file-search:{}", summary.project_root),
        "status": "completed",
        "project_root": summary.project_root,
        "query": summary.query,
        "match_count": summary.matches.len(),
        "scanned_files": summary.scanned_files,
        "truncated": summary.truncated,
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
    fn collects_project_file_context_only_from_selected_folder() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("ripple-project-context-{}", Uuid::new_v4()));
        let project = root.join("genius_club");
        std::fs::create_dir_all(&project)?;
        std::fs::write(
            project.join("001.txt"),
            "天才俱乐部成员名单\n林弦负责重新建立组织。",
        )?;
        std::fs::write(root.join("outside.txt"), "天才俱乐部外部资料不应命中")?;

        let context = collect_project_file_context(
            &root,
            Some("/workspace/genius_club"),
            "天才俱乐部成员分别是谁？",
        )
        .expect("project context");

        assert!(context
            .prompt_section
            .contains("/workspace/genius_club/001.txt"));
        assert!(!context.prompt_section.contains("outside.txt"));
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
    fn project_file_context_reports_no_matches_without_using_siblings() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("ripple-project-context-{}", Uuid::new_v4()));
        let project = root.join("notes");
        std::fs::create_dir_all(&project)?;
        std::fs::write(project.join("local.txt"), "unrelated local text")?;
        std::fs::write(root.join("answer.txt"), "needle only outside")?;

        let context = collect_project_file_context(&root, Some("/workspace/notes"), "needle")
            .expect("context");

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

    #[test]
    fn project_file_context_allows_hidden_runtime_parent_paths() -> anyhow::Result<()> {
        let root = std::env::temp_dir()
            .join(format!("ripple-project-context-{}", Uuid::new_v4()))
            .join(".ripple/sandboxes/lake/workspace");
        let project = root.join("genius_club");
        std::fs::create_dir_all(&project)?;
        std::fs::write(project.join("chapter.txt"), "天才俱乐部成员 林弦")?;

        let context =
            collect_project_file_context(&root, Some("/workspace/genius_club"), "天才俱乐部成员")
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
