use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use podcast_cli::podcast::{prepare_md_from_html, CliOptions};

fn temp_root(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_nanos();
    std::env::temp_dir().join(format!("podcast-cli-{label}-{nanos}"))
}

fn sample_xiaoyuzhou_html() -> String {
    let description = "本期聊 AI agent，也聊工具如何改变工作流。".repeat(80);
    let payload = serde_json::json!({
        "props": {
            "pageProps": {
                "episode": {
                    "title": "AI 的未来：Agent 与工具",
                    "description": description,
                    "shownotes": "<p>🎙️主播：湖水、山风</p><p><a data-timestamp=\"12\">00:00:12</a> 开场介绍</p><p><a data-timestamp=\"3661\">01:01:01</a> 工具落地</p><p>参考资料：https://example.com/report</p>",
                    "pubDate": "2026-05-20T08:00:00.000Z",
                    "duration": 3661,
                    "enclosure": { "url": "https://audio.example.com/ep.m4a" },
                    "podcast": {
                        "title": "未来播客",
                        "author": "Ripple"
                    }
                }
            }
        }
    });
    format!(
        r#"<html><body><script id="__NEXT_DATA__" type="application/json">{payload}</script></body></html>"#
    )
}

#[tokio::test]
async fn prepare_md_writes_xiaoyuzhou_meta_content_and_output_path() {
    let root = temp_root("xiaoyuzhou");
    let options = CliOptions {
        url: Some("https://www.xiaoyuzhoufm.com/episode/abc123?utm_source=test".to_string()),
        work_root: root.join("work"),
        output_root: root.join("outputs"),
        ..CliOptions::default()
    };

    let result = prepare_md_from_html(options, Some(&sample_xiaoyuzhou_html()))
        .await
        .expect("prepare md");

    assert_eq!(result["episode_id"], "abc123");
    assert_eq!(result["fetched"], true);
    assert_eq!(result["title"], "AI 的未来：Agent 与工具");
    assert_eq!(result["podcast_name"], "未来播客");
    assert_eq!(result["audio_url"], "https://audio.example.com/ep.m4a");
    assert_eq!(result["outline_sections"], 2);
    assert_eq!(result["has_outline"], true);
    assert_eq!(result["strategy"], "text_only");
    assert!(result["output_path"]
        .as_str()
        .expect("output path")
        .ends_with("/outputs/2026/05/2026-05-20-ai-的未来-agent-与工具.md"));

    let work_dir = PathBuf::from(result["work_dir"].as_str().expect("work_dir"));
    let meta: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(work_dir.join("meta.json")).unwrap())
            .unwrap();
    assert_eq!(
        meta["episode"]["hosts"],
        serde_json::json!(["湖水", "山风"])
    );
    assert_eq!(meta["episode"]["outline"][1]["timestamp"], "01:01:01");
    assert_eq!(
        meta["source"]["url"],
        "https://www.xiaoyuzhoufm.com/episode/abc123"
    );

    let content = std::fs::read_to_string(work_dir.join("content.txt")).unwrap();
    assert!(content.contains("开场介绍"));
    assert!(content.contains("参考资料：https://example.com/report"));
    assert!(!content.contains("<p>"));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn prepare_md_for_unsupported_provider_writes_fallback_meta() {
    let root = temp_root("fallback");
    let options = CliOptions {
        url: Some(
            "https://podcasts.apple.com/us/podcast/example/id123?i=456&utm_medium=share"
                .to_string(),
        ),
        work_root: root.join("work"),
        output_root: root.join("outputs"),
        ..CliOptions::default()
    };

    let result = prepare_md_from_html(options, None)
        .await
        .expect("prepare fallback");

    assert_eq!(result["fetched"], false);
    assert_eq!(result["episode_id"], "apple-456");
    assert_eq!(
        result["title"],
        "https://podcasts.apple.com/us/podcast/example/id123?i=456"
    );
    assert_eq!(result["provider"], "apple-podcasts");
    assert!(result["output_path"]
        .as_str()
        .expect("output path")
        .ends_with("/outputs/https-podcasts.apple.com-us-podcast-example-id123-i=456.md"));

    let work_dir = PathBuf::from(result["work_dir"].as_str().expect("work_dir"));
    let meta: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(work_dir.join("meta.json")).unwrap())
            .unwrap();
    assert_eq!(meta["matched"], false);
    assert_eq!(meta["source"]["provider"], "apple-podcasts");
    assert!(!work_dir.join("content.txt").exists());

    let _ = std::fs::remove_dir_all(root);
}
