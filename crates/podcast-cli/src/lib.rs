pub mod podcast {
    use std::path::{Path, PathBuf};

    use anyhow::{anyhow, Context};
    use serde_json::{json, Map, Value};
    use sha2::{Digest, Sha256};
    use url::{form_urlencoded, Url};

    const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    const WORK_ROOT_DEFAULT: &str = "/workspace/.podcast-work";
    const OUTPUT_ROOT_DEFAULT: &str = "/workspace/outputs/podcast";

    #[derive(Debug, Clone)]
    pub struct CliOptions {
        pub url: Option<String>,
        pub work_root: PathBuf,
        pub output_root: PathBuf,
        pub output_dir: Option<PathBuf>,
    }

    impl Default for CliOptions {
        fn default() -> Self {
            Self {
                url: None,
                work_root: PathBuf::from(WORK_ROOT_DEFAULT),
                output_root: PathBuf::from(OUTPUT_ROOT_DEFAULT),
                output_dir: None,
            }
        }
    }

    pub async fn run_command(command: &[String], options: CliOptions) -> anyhow::Result<Value> {
        match command {
            [cmd] if cmd == "prepare-md" => prepare_md_command(options).await,
            [] => Err(anyhow!("missing command")),
            _ => Err(anyhow!("unknown command: {}", command.join(" "))),
        }
    }

    pub async fn prepare_md_command(options: CliOptions) -> anyhow::Result<Value> {
        prepare_md_from_html(options, None).await
    }

    pub async fn prepare_md_from_html(
        options: CliOptions,
        html_override: Option<&str>,
    ) -> anyhow::Result<Value> {
        let raw_url = options
            .url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("need --url"))?;
        let episode_url = clean_url(raw_url);
        let provider = guess_provider(&episode_url);
        let output_root = options
            .output_dir
            .clone()
            .unwrap_or_else(|| options.output_root.clone());
        tokio::fs::create_dir_all(&output_root).await?;

        let episode_id = compute_episode_id(&episode_url);
        let work_dir = options.work_root.join(&episode_id);
        tokio::fs::create_dir_all(&work_dir).await?;

        if provider != "xiaoyuzhou" {
            return write_fallback_result(
                &episode_id,
                &episode_url,
                provider,
                &work_dir,
                &output_root,
            )
            .await;
        }

        let raw_html = match html_override {
            Some(html) => html.to_string(),
            None => fetch_html(&episode_url).await?,
        };
        let meta = parse_xiaoyuzhou(&raw_html, &episode_url);
        write_json(work_dir.join("meta.json"), &meta).await?;

        let content = build_content(&meta);
        tokio::fs::write(work_dir.join("content.txt"), &content).await?;

        let strategy = decide_strategy(&meta, &content);
        let output_path = build_output_path(&meta, &output_root);
        if let Some(parent) = output_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let episode = meta.get("episode").and_then(Value::as_object);
        let outline_sections = episode
            .and_then(|episode| episode.get("outline"))
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        let title = episode
            .and_then(|episode| episode.get("title"))
            .cloned()
            .unwrap_or(Value::Null);
        let podcast_name = episode
            .and_then(|episode| episode.get("podcast_name"))
            .cloned()
            .unwrap_or(Value::Null);
        let audio_url = episode
            .and_then(|episode| episode.get("audio_url"))
            .cloned()
            .unwrap_or(Value::Null);

        Ok(json!({
            "episode_id": episode_id,
            "work_dir": work_dir.to_string_lossy(),
            "fetched": meta.get("matched").and_then(Value::as_bool).unwrap_or(false),
            "provider": "xiaoyuzhou",
            "audio_url": audio_url,
            "strategy": strategy["strategy"],
            "text_chars": strategy["text_chars"],
            "has_outline": strategy["has_outline"],
            "has_audio": strategy["has_audio"],
            "best_source_quality": strategy["best_source_quality"],
            "title": title,
            "podcast_name": podcast_name,
            "outline_sections": outline_sections,
            "output_path": output_path.to_string_lossy(),
            "slug": output_path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("untitled"),
        }))
    }

    async fn write_fallback_result(
        episode_id: &str,
        episode_url: &str,
        provider: &str,
        work_dir: &Path,
        output_root: &Path,
    ) -> anyhow::Result<Value> {
        let meta = json!({
            "matched": false,
            "episode": {
                "episode_url": episode_url,
                "title": episode_url,
            },
            "source": {
                "provider": provider,
                "url": episode_url,
            },
            "notes": "podcast CLI does not include a parser for this provider yet; fallback records URL only",
        });
        write_json(work_dir.join("meta.json"), &meta).await?;
        let output_path = build_output_path(&meta, output_root);
        if let Some(parent) = output_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        Ok(json!({
            "episode_id": episode_id,
            "work_dir": work_dir.to_string_lossy(),
            "fetched": false,
            "provider": provider,
            "audio_url": Value::Null,
            "strategy": "none",
            "text_chars": 0,
            "has_outline": false,
            "has_audio": false,
            "best_source_quality": "none",
            "title": episode_url,
            "podcast_name": Value::Null,
            "outline_sections": 0,
            "output_path": output_path.to_string_lossy(),
            "slug": output_path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("untitled"),
            "notes": "provider is not parsed yet; only URL metadata was written",
        }))
    }

    pub fn clean_url(url: &str) -> String {
        let Ok(mut parsed) = Url::parse(url.trim()) else {
            return url.trim().to_string();
        };
        let kept = parsed
            .query_pairs()
            .filter(|(key, _)| !key.to_ascii_lowercase().starts_with("utm_"))
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect::<Vec<_>>();
        if kept.is_empty() {
            parsed.set_query(None);
        } else {
            let query = form_urlencoded::Serializer::new(String::new())
                .extend_pairs(
                    kept.iter()
                        .map(|(key, value)| (key.as_str(), value.as_str())),
                )
                .finish();
            parsed.set_query(Some(&query));
        }
        parsed.to_string()
    }

    fn compute_episode_id(url: &str) -> String {
        if let Ok(parsed) = Url::parse(url) {
            let segments = parsed
                .path_segments()
                .map(|segments| segments.collect::<Vec<_>>());
            if parsed
                .domain()
                .is_some_and(|domain| domain.contains("xiaoyuzhoufm.com"))
            {
                if let Some(segments) = &segments {
                    if let Some(index) = segments.iter().position(|segment| *segment == "episode") {
                        if let Some(id) = segments.get(index + 1).filter(|id| !id.is_empty()) {
                            return (*id).to_string();
                        }
                    }
                }
            }
            if parsed
                .domain()
                .is_some_and(|domain| domain.contains("podcasts.apple.com"))
            {
                for (key, value) in parsed.query_pairs() {
                    if key == "i" && !value.is_empty() {
                        return format!("apple-{value}");
                    }
                }
            }
        }
        let mut hasher = Sha256::new();
        hasher.update(url.as_bytes());
        let digest = hasher.finalize();
        hex_digest(&digest)[..12].to_string()
    }

    fn guess_provider(url: &str) -> &'static str {
        let Ok(parsed) = Url::parse(url) else {
            return "page-extract";
        };
        let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
        if host.contains("xiaoyuzhoufm.com") {
            "xiaoyuzhou"
        } else if host.contains("podcasts.apple.com") {
            "apple-podcasts"
        } else {
            "page-extract"
        }
    }

    async fn fetch_html(url: &str) -> anyhow::Result<String> {
        let client = reqwest::Client::new();
        let response = client
            .get(url)
            .header(reqwest::header::USER_AGENT, UA)
            .header(reqwest::header::ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9")
            .send()
            .await
            .with_context(|| format!("fetch podcast page: {url}"))?
            .error_for_status()
            .with_context(|| format!("podcast page returned non-success status: {url}"))?;
        response
            .text()
            .await
            .with_context(|| format!("read podcast page body: {url}"))
    }

    fn parse_xiaoyuzhou(raw_html: &str, episode_url: &str) -> Value {
        let Some(script) = extract_next_data(raw_html) else {
            return json!({
                "matched": false,
                "confidence": 0.2,
                "episode": {"episode_url": episode_url},
                "source": {"provider": "xiaoyuzhou", "url": episode_url},
                "notes": "page did not include __NEXT_DATA__",
            });
        };
        let Ok(data) = serde_json::from_str::<Value>(script) else {
            return json!({
                "matched": false,
                "confidence": 0.2,
                "episode": {"episode_url": episode_url},
                "source": {"provider": "xiaoyuzhou", "url": episode_url},
                "notes": "failed to parse __NEXT_DATA__",
            });
        };
        let episode = data.pointer("/props/pageProps/episode");
        let podcast = episode.and_then(|episode| episode.get("podcast"));
        let shownotes = episode
            .and_then(|episode| episode.get("shownotes"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let enclosure_url = episode
            .and_then(|episode| episode.pointer("/enclosure/url"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let media_key = episode
            .and_then(|episode| episode.get("mediaKey"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let audio_url = enclosure_url.or(media_key);
        let duration = episode
            .and_then(|episode| episode.get("duration"))
            .cloned()
            .unwrap_or(Value::Null);

        json!({
            "matched": episode.is_some(),
            "confidence": if episode.is_some() { 0.97 } else { 0.2 },
            "episode": {
                "title": string_field(episode, "title"),
                "podcast_name": string_field(podcast, "title"),
                "podcast_author": string_field(podcast, "author"),
                "hosts": extract_hosts_from_shownotes(shownotes),
                "guests": [],
                "guest_profiles": [],
                "published_at": string_field(episode, "pubDate"),
                "duration": duration,
                "episode_url": episode_url,
                "audio_url": audio_url,
                "description": string_field(episode, "description"),
                "shownotes": shownotes,
                "outline": extract_outline(shownotes),
            },
            "source": {"provider": "xiaoyuzhou", "url": episode_url},
            "notes": "meta written by podcast CLI; hosts are inferred from shownotes labels",
        })
    }

    fn extract_next_data(raw_html: &str) -> Option<&str> {
        let marker = r#"<script id="__NEXT_DATA__" type="application/json">"#;
        let start = raw_html.find(marker)? + marker.len();
        let rest = &raw_html[start..];
        let end = rest.find("</script>")?;
        Some(&rest[..end])
    }

    fn string_field(value: Option<&Value>, key: &str) -> Option<String> {
        value
            .and_then(|value| value.get(key))
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    fn extract_outline(shownotes: &str) -> Vec<Value> {
        let mut outline = Vec::new();
        let mut rest = shownotes;
        let marker = "data-timestamp=\"";
        while let Some(marker_index) = rest.find(marker) {
            let after_marker = &rest[marker_index + marker.len()..];
            let Some(seconds_end) = after_marker.find('"') else {
                break;
            };
            let seconds = after_marker[..seconds_end].parse::<u64>().ok();
            let after_seconds = &after_marker[seconds_end + 1..];
            let Some(anchor_text_start) = after_seconds.find('>') else {
                break;
            };
            let after_gt = &after_seconds[anchor_text_start + 1..];
            let Some(anchor_text_end) = after_gt.find("</a>") else {
                break;
            };
            let timestamp = html_unescape(after_gt[..anchor_text_end].trim());
            let after_anchor = &after_gt[anchor_text_end + "</a>".len()..];
            let topic_end = after_anchor
                .find('<')
                .or_else(|| after_anchor.find('\n'))
                .unwrap_or(after_anchor.len());
            let topic = html_unescape(strip_html(&after_anchor[..topic_end]).trim());
            if let Some(seconds) = seconds {
                outline.push(json!({
                    "seconds": seconds,
                    "timestamp": timestamp,
                    "topic": topic,
                }));
            }
            rest = after_anchor;
        }
        outline
    }

    fn extract_hosts_from_shownotes(shownotes: &str) -> Vec<String> {
        let plain = strip_html(shownotes);
        let markers = [
            "主播：",
            "主播:",
            "主讲：",
            "主讲:",
            "嘉宾主持：",
            "嘉宾主持:",
        ];
        let Some((index, marker)) = markers
            .iter()
            .filter_map(|marker| plain.find(marker).map(|index| (index, *marker)))
            .min_by_key(|(index, _)| *index)
        else {
            return Vec::new();
        };
        let raw = &plain[index + marker.len()..];
        let first_line = raw
            .lines()
            .next()
            .unwrap_or("")
            .trim_matches(|ch: char| ch.is_whitespace() || ch == '｜' || ch == '|');
        first_line
            .split(['、', ',', '，', '/'])
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.chars().count() <= 12)
            .take(5)
            .map(str::to_string)
            .collect()
    }

    fn build_content(meta: &Value) -> String {
        let episode = meta.get("episode");
        let description = episode
            .and_then(|episode| episode.get("description"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let shownotes = episode
            .and_then(|episode| episode.get("shownotes"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let shownotes_text = collapse_blank_lines(strip_html(shownotes).trim());
        if description.is_empty() {
            return shownotes_text;
        }
        let prefix = description.chars().take(80).collect::<String>();
        if !prefix.is_empty() && shownotes_text.starts_with(&prefix) {
            shownotes_text
        } else if shownotes_text.contains(description) {
            shownotes_text
        } else if shownotes_text.is_empty() {
            description.to_string()
        } else {
            format!("{description}\n\n{shownotes_text}")
        }
    }

    fn decide_strategy(meta: &Value, content: &str) -> Value {
        let episode = meta.get("episode");
        let has_outline = episode
            .and_then(|episode| episode.get("outline"))
            .and_then(Value::as_array)
            .is_some_and(|outline| !outline.is_empty());
        let has_audio = episode
            .and_then(|episode| episode.get("audio_url"))
            .and_then(Value::as_str)
            .is_some_and(|audio| !audio.trim().is_empty());
        let text_chars = content.chars().count();
        let (strategy, quality) = if text_chars >= 2000 && has_outline {
            ("text_only", "high")
        } else if text_chars >= 1000 {
            ("prefer_text_then_audio", "medium")
        } else if has_audio {
            ("audio_only", "fallback")
        } else {
            ("none", "none")
        };
        json!({
            "strategy": strategy,
            "text_chars": text_chars,
            "has_outline": has_outline,
            "has_audio": has_audio,
            "best_source_quality": quality,
        })
    }

    fn build_output_path(meta: &Value, output_root: &Path) -> PathBuf {
        let episode = meta.get("episode");
        let title = episode
            .and_then(|episode| episode.get("title"))
            .and_then(Value::as_str)
            .unwrap_or("untitled");
        let date = episode
            .and_then(|episode| episode.get("published_at"))
            .and_then(Value::as_str)
            .and_then(date_prefix);
        let slug = slugify(title);
        let name = match &date {
            Some(date) => format!("{date}-{slug}.md"),
            None => format!("{slug}.md"),
        };
        match date {
            Some(date) => output_root.join(&date[..4]).join(&date[5..7]).join(name),
            None => output_root.join(name),
        }
    }

    fn date_prefix(raw: &str) -> Option<String> {
        let value = raw.get(..10)?;
        let bytes = value.as_bytes();
        if bytes.len() == 10
            && bytes[0..4].iter().all(u8::is_ascii_digit)
            && bytes[4] == b'-'
            && bytes[5..7].iter().all(u8::is_ascii_digit)
            && bytes[7] == b'-'
            && bytes[8..10].iter().all(u8::is_ascii_digit)
        {
            Some(value.to_string())
        } else {
            None
        }
    }

    fn slugify(title: &str) -> String {
        let mut out = String::new();
        let mut last_dash = false;
        for ch in title.trim().chars() {
            let replacement = if ch.is_ascii_alphanumeric()
                || matches!(ch, '\u{4e00}'..='\u{9fff}')
                || matches!(ch, '.' | '=' | '_')
            {
                Some(ch.to_ascii_lowercase())
            } else if ch == '-' {
                Some('-')
            } else if ch.is_whitespace()
                || r#"/\:*?"<>|、，。「」『』（）【】《》“”‘’：；！？·—…"#.contains(ch)
            {
                Some('-')
            } else {
                None
            };
            let Some(ch) = replacement else {
                continue;
            };
            if ch == '-' {
                if !last_dash && !out.is_empty() {
                    out.push('-');
                    last_dash = true;
                }
            } else {
                out.push(ch);
                last_dash = false;
            }
            if out.chars().count() >= 60 {
                break;
            }
        }
        while out.ends_with('-') {
            out.pop();
        }
        if out.is_empty() {
            "untitled".to_string()
        } else {
            out
        }
    }

    fn strip_html(input: &str) -> String {
        let mut out = String::new();
        let mut in_tag = false;
        for ch in input.chars() {
            match ch {
                '<' => {
                    in_tag = true;
                    if !out.ends_with('\n') {
                        out.push('\n');
                    }
                }
                '>' => {
                    in_tag = false;
                    if !out.ends_with('\n') {
                        out.push('\n');
                    }
                }
                _ if !in_tag => out.push(ch),
                _ => {}
            }
        }
        collapse_blank_lines(html_unescape(&out).trim())
    }

    fn html_unescape(input: &str) -> String {
        input
            .replace("&nbsp;", " ")
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace("&apos;", "'")
    }

    fn collapse_blank_lines(input: &str) -> String {
        let mut out = String::new();
        let mut blank_lines = 0usize;
        for line in input.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                blank_lines += 1;
                if blank_lines <= 1 && !out.is_empty() {
                    out.push('\n');
                }
            } else {
                if !out.is_empty() && !out.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str(trimmed);
                blank_lines = 0;
            }
        }
        out
    }

    async fn write_json(path: PathBuf, value: &Value) -> anyhow::Result<()> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let mut object = value.clone();
        if let Some(map) = object.as_object_mut() {
            sort_object(map);
        }
        let bytes = serde_json::to_vec_pretty(&object)?;
        tokio::fs::write(path, bytes).await?;
        Ok(())
    }

    fn sort_object(map: &mut Map<String, Value>) {
        for value in map.values_mut() {
            if let Some(child) = value.as_object_mut() {
                sort_object(child);
            } else if let Some(items) = value.as_array_mut() {
                for item in items {
                    if let Some(child) = item.as_object_mut() {
                        sort_object(child);
                    }
                }
            }
        }
    }

    fn hex_digest(bytes: &[u8]) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut output = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            output.push(HEX[(byte >> 4) as usize] as char);
            output.push(HEX[(byte & 0x0f) as usize] as char);
        }
        output
    }
}
