use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{header, Method, Request, StatusCode};
use ripple_server::api::{auth::AuthClaimRequest, router};
use ripple_server::config::{
    ApiDocsConfig, AppConfig, CodexConfig, CorsConfig, DocumentPreviewConfig, FeishuConfig,
    GogcliOAuthConfig, LoggingConfig, ModelFallback, SandboxConfig, SecurityConfig, SkillsConfig,
    UserAuthConfig,
};
use ripple_server::jobs::AgentRunCreateRequest;
use ripple_server::sessions::CreateSessionInput;
use ripple_server::state::AppState;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tower::ServiceExt;
use uuid::Uuid;

fn test_config(root: &Path) -> AppConfig {
    AppConfig {
        repo_root: root.to_path_buf(),
        host: "127.0.0.1".to_string(),
        port: 0,
        api_keys: vec!["test-key".to_string()],
        enabled_connectors: ripple_server::config::default_enabled_connectors(),
        security: SecurityConfig::default(),
        user_auth: UserAuthConfig::default(),
        api_docs: ApiDocsConfig::default(),
        cors: CorsConfig::default(),
        default_model: "codex-test".to_string(),
        model_presets: BTreeMap::new(),
        model_fallback_chain: Vec::new(),
        logging: LoggingConfig {
            level: "debug".to_string(),
        },
        storage: ripple_server::config::StorageConfig {
            sqlite_max_connections: 50,
            shared_folders_root: root.join("shared-folders"),
        },
        sandbox: SandboxConfig {
            sandboxes_root: root.join("sandboxes"),
            workspaces_root: None,
            caches_root: root.join("cache"),
            idle_suspend_seconds: 1800,
            retention_seconds: 604_800,
            max_workspace_mb: 2048,
            tmpfs_size_mb: 64,
            nsjail_path: "nsjail".to_string(),
            python_envs_root: root.join("cache/python-envs"),
            python_env_uv_cache: root.join("cache/uv-cache"),
            python_env_max_packages: 20,
            uv_bin_dir: None,
            node_dir: None,
            lark_cli_install_root: None,
            notion_cli_install_root: None,
            gogcli_cli_install_root: None,
            cli_tools: Vec::new(),
            pypi_mirror_url: None,
            npm_registry_url: None,
        },
        codex: CodexConfig {
            enabled: true,
            codex_executable: "codex".to_string(),
            app_server_args: Vec::new(),
            requires_service_auth: true,
            provider_env_keys: Vec::new(),
            codex_home: None,
            sqlite_root: None,
            approval_policy: serde_json::json!("never"),
            sandbox_type: "workspace-write".to_string(),
            network_access: true,
            idle_timeout_seconds: 1800,
            max_workers_per_pool: 8,
            max_total_pool_workers: 256,
            max_runtime_seconds: 3600,
            runtime_log_retention_seconds: 86_400,
            runtime_log_max_mb: 64,
            runtime_log_cleanup_interval_seconds: 3600,
        },
        task_trigger_extraction_max_runtime_seconds: 120,
        task_trigger_poll_interval_seconds: 15,
        document_preview: DocumentPreviewConfig {
            cache_root: root.join("cache/previews"),
            libreoffice_path: "soffice".to_string(),
            max_source_bytes: 64 * 1024 * 1024,
            conversion_timeout_seconds: 120,
        },
        skills: SkillsConfig {
            shared_dirs: Vec::new(),
            ..SkillsConfig::default()
        },
        public_base_url: None,
        feishu: FeishuConfig::default(),
        gogcli_oauth: GogcliOAuthConfig {
            auto_register_client: true,
            auto_from_request: true,
            callback_url: None,
            client_secret_json: None,
            client: None,
        },
    }
}

fn test_config_with_codex_executable(root: &Path, codex_executable: String) -> AppConfig {
    let mut config = test_config(root);
    config.codex.codex_executable = codex_executable;
    config
}

fn test_config_with_user_auth(root: &Path) -> AppConfig {
    let mut config = test_config(root);
    config.user_auth.enabled = true;
    config
}

fn test_config_with_fake_connector_cli(root: &Path) -> AppConfig {
    let mut config = test_config(root);
    config.sandbox.nsjail_path = write_fake_connector_cli(root);
    config.sandbox.gogcli_cli_install_root = Some(root.join("vendor/gogcli-cli"));
    config.sandbox.lark_cli_install_root = Some(root.join("vendor/lark-cli"));
    config
}

fn test_config_with_fake_libreoffice(root: &Path) -> AppConfig {
    let mut config = test_config(root);
    let fake_soffice = root.join("fake-soffice");
    let log_path = root.join("fake-soffice.log");
    write_executable(
        &fake_soffice,
        &format!(
            r#"#!/bin/sh
set -eu
outdir=""
source=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --outdir)
      outdir="$2"
      shift 2
      ;;
    *)
      source="$1"
      shift
      ;;
  esac
done
if [ -z "$outdir" ] || [ -z "$source" ]; then
  exit 2
fi
printf 'convert %s\n' "$source" >> "{}"
mkdir -p "$outdir"
name="$(basename "$source")"
stem="${{name%.*}}"
printf '%s' '%PDF fake office preview' > "$outdir/$stem.pdf"
"#,
            log_path.display()
        ),
    );
    config.document_preview.libreoffice_path = fake_soffice.display().to_string();
    config
}

fn write_executable(path: &Path, content: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, content).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms).unwrap();
    }
}

fn write_fake_connector_cli(root: &Path) -> String {
    fs::create_dir_all(root).unwrap();
    write_executable(
        &root.join("fake-nsjail"),
        r#"#!/bin/sh
set -eu
root="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
log="$root/fake-nsjail.log"
config=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--config" ]; then
    config="$2"
    shift 2
    continue
  fi
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  shift
done
program="$1"
shift
printf 'config=%s program=%s args=%s\n' "$config" "$program" "$*" >> "$log"
case "$program" in
  /opt/gogcli-cli/current/bin/gog)
    exec "$root/vendor/gogcli-cli/current/bin/gog" "$@"
    ;;
  /opt/lark-cli/current/bin/lark-cli)
    exec "$root/vendor/lark-cli/current/bin/lark-cli" "$@"
    ;;
  *)
    echo "unexpected fake nsjail program: $program" >&2
    exit 127
    ;;
esac
"#,
    );
    write_executable(
        &root.join("vendor/gogcli-cli/current/bin/gog"),
        r#"#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "list" ]; then
  printf '{"accounts":[{"email":"worker@example.com","alias":"work","valid":true}]}\n'
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "remove" ]; then
  printf '{"ok":true,"removed":"%s"}\n' "$3"
  exit 0
fi
echo "unexpected gog args: $*" >&2
exit 2
"#,
    );
    write_executable(
        &root.join("vendor/lark-cli/current/bin/lark-cli"),
        r#"#!/bin/sh
set -eu
if [ "$1" = "doctor" ]; then
  printf '{"checks":[{"name":"config_file","status":"pass"},{"name":"app_resolved","status":"pass"},{"name":"token_exists","status":"pass"}]}\n'
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  printf '{"identity":"user","open_id":"ou_fake","tenant_key":"tenant_fake"}\n'
  exit 0
fi
echo "unexpected lark-cli args: $*" >&2
exit 2
"#,
    );
    root.join("fake-nsjail").to_string_lossy().to_string()
}

fn write_fake_codex_app_server(_root: &Path) -> String {
    static FAKE_CODEX_APP_SERVER: OnceLock<String> = OnceLock::new();
    FAKE_CODEX_APP_SERVER
        .get_or_init(|| {
            let helper_root =
                std::env::temp_dir().join(format!("ripple-fake-codex-{}", Uuid::new_v4()));
            fs::create_dir_all(&helper_root).unwrap();
            let source = helper_root.join("fake-codex-app-server.rs");
            let executable = helper_root.join(if cfg!(windows) {
                "fake-codex-app-server.exe"
            } else {
                "fake-codex-app-server"
            });
            fs::write(
                &source,
                r###"
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::thread;
use std::time::Duration;

#[derive(Clone, Debug)]
enum RequestId {
    Number(String),
    String(String),
}

impl RequestId {
    fn raw_json(&self) -> String {
        match self {
            RequestId::Number(value) => value.clone(),
            RequestId::String(value) => json_string(value),
        }
    }

    fn as_string_key(&self) -> Option<&str> {
        match self {
            RequestId::String(value) => Some(value.as_str()),
            RequestId::Number(_) => None,
        }
    }
}

fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn send(payload: String) {
    println!("{payload}");
    io::stdout().flush().unwrap();
}

fn extract_string_field(line: &str, field: &str) -> Option<String> {
    let needle = format!("\"{field}\":\"");
    let start = line.find(&needle)? + needle.len();
    let rest = &line[start..];
    let mut value = String::new();
    let mut escaped = false;
    for ch in rest.chars() {
        if escaped {
            value.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            return Some(value);
        }
        value.push(ch);
    }
    None
}

fn extract_id(line: &str) -> Option<RequestId> {
    let needle = "\"id\":";
    let start = line.find(needle)? + needle.len();
    let rest = line[start..].trim_start();
    if let Some(after_quote) = rest.strip_prefix('"') {
        let mut value = String::new();
        let mut escaped = false;
        for ch in after_quote.chars() {
            if escaped {
                value.push(ch);
                escaped = false;
                continue;
            }
            if ch == '\\' {
                escaped = true;
                continue;
            }
            if ch == '"' {
                return Some(RequestId::String(value));
            }
            value.push(ch);
        }
        return None;
    }
    let value: String = rest
        .chars()
        .take_while(|ch| ch.is_ascii_digit() || *ch == '-')
        .collect();
    if value.is_empty() {
        None
    } else {
        Some(RequestId::Number(value))
    }
}

fn is_response(line: &str) -> bool {
    line.contains("\"result\":") || line.contains("\"error\":")
}

fn complete_pending_response(
    id: &RequestId,
    pending_approvals: &mut HashMap<String, (String, String, String, String)>,
    pending_dynamic_tools: &mut HashMap<String, (String, String, String, String)>,
    pending_user_inputs: &mut HashMap<String, (String, String, String, String)>,
) {
    let Some(key) = id.as_string_key() else {
        return;
    };
    if let Some((thread_id, turn_id, item_id, text)) = pending_approvals.remove(key) {
        complete_turn(&thread_id, &turn_id, &item_id, &text);
    } else if let Some((thread_id, turn_id, item_id, text)) = pending_dynamic_tools.remove(key) {
        if text.starts_with("[slow]") {
            thread::sleep(Duration::from_millis(500));
        }
        complete_turn(&thread_id, &turn_id, &item_id, &text);
    } else if let Some((thread_id, turn_id, item_id, text)) = pending_user_inputs.remove(key) {
        complete_turn(&thread_id, &turn_id, &item_id, &text);
    }
}

fn complete_turn(thread_id: &str, turn_id: &str, item_id: &str, text: &str) {
    let text_json = json_string(text);
    send(format!(
        "{{\"method\":\"item/started\",\"params\":{{\"threadId\":{},\"turnId\":{},\"item\":{{\"id\":{},\"type\":\"agentMessage\",\"phase\":\"final\"}}}}}}",
        json_string(thread_id),
        json_string(turn_id),
        json_string(item_id)
    ));
    send(format!(
        "{{\"method\":\"item/agentMessage/delta\",\"params\":{{\"threadId\":{},\"turnId\":{},\"itemId\":{},\"delta\":{}}}}}",
        json_string(thread_id),
        json_string(turn_id),
        json_string(item_id),
        text_json
    ));
    send(format!(
        "{{\"method\":\"item/completed\",\"params\":{{\"threadId\":{},\"turnId\":{},\"item\":{{\"id\":{},\"type\":\"agentMessage\",\"phase\":\"final\",\"text\":{}}}}}}}",
        json_string(thread_id),
        json_string(turn_id),
        json_string(item_id),
        text_json
    ));
    send(format!(
        "{{\"method\":\"thread/tokenUsage/updated\",\"params\":{{\"threadId\":{},\"turnId\":{},\"tokenUsage\":{{\"modelContextWindow\":200000,\"total\":{{\"inputTokens\":10,\"outputTokens\":5,\"totalTokens\":15}},\"last\":{{\"inputTokens\":10,\"outputTokens\":5,\"totalTokens\":15,\"cachedInputTokens\":1,\"reasoningOutputTokens\":2}}}}}}}}",
        json_string(thread_id),
        json_string(turn_id)
    ));
    send(format!(
        "{{\"method\":\"turn/completed\",\"params\":{{\"threadId\":{},\"turnId\":{},\"turn\":{{\"id\":{},\"status\":\"completed\"}}}}}}",
        json_string(thread_id),
        json_string(turn_id),
        json_string(turn_id)
    ));
}

fn fail_turn(thread_id: &str, turn_id: &str, item_id: &str, text: &str) {
    let text_json = json_string(text);
    send(format!(
        "{{\"method\":\"item/started\",\"params\":{{\"threadId\":{},\"turnId\":{},\"item\":{{\"id\":{},\"type\":\"agentMessage\",\"phase\":\"final\"}}}}}}",
        json_string(thread_id),
        json_string(turn_id),
        json_string(item_id)
    ));
    send(format!(
        "{{\"method\":\"item/agentMessage/delta\",\"params\":{{\"threadId\":{},\"turnId\":{},\"itemId\":{},\"delta\":{}}}}}",
        json_string(thread_id),
        json_string(turn_id),
        json_string(item_id),
        text_json
    ));
    send(format!(
        "{{\"method\":\"item/completed\",\"params\":{{\"threadId\":{},\"turnId\":{},\"item\":{{\"id\":{},\"type\":\"agentMessage\",\"phase\":\"final\",\"text\":{}}}}}}}",
        json_string(thread_id),
        json_string(turn_id),
        json_string(item_id),
        text_json
    ));
    send(format!(
        "{{\"method\":\"turn/completed\",\"params\":{{\"threadId\":{},\"turnId\":{},\"turn\":{{\"id\":{},\"status\":\"failed\"}}}}}}",
        json_string(thread_id),
        json_string(turn_id),
        json_string(turn_id)
    ));
}

fn fail_model_turn(thread_id: &str, turn_id: &str) {
    let error = "{\"message\":\"Selected model is at capacity. Please try a different model.\",\"codexErrorInfo\":{\"httpStatusCode\":503}}";
    send(format!(
        "{{\"method\":\"thread/status/changed\",\"params\":{{\"threadId\":{},\"status\":{{\"type\":\"systemError\"}}}}}}",
        json_string(thread_id)
    ));
    send(format!(
        "{{\"method\":\"error\",\"params\":{{\"threadId\":{},\"turnId\":{},\"error\":{}}}}}",
        json_string(thread_id),
        json_string(turn_id),
        error
    ));
    send(format!(
        "{{\"method\":\"turn/completed\",\"params\":{{\"threadId\":{},\"turnId\":{},\"turn\":{{\"id\":{},\"status\":\"failed\",\"error\":{}}}}}}}",
        json_string(thread_id),
        json_string(turn_id),
        json_string(turn_id),
        error
    ));
}

fn emit_runtime_events(thread_id: &str, turn_id: &str) {
    let thread_id = json_string(thread_id);
    let turn_id = json_string(turn_id);
    send(format!("{{\"method\":\"turn/plan/updated\",\"params\":{{\"threadId\":{thread_id},\"turnId\":{turn_id},\"explanation\":\"fake plan\",\"plan\":[{{\"step\":\"Inspect workspace\",\"status\":\"inProgress\"}},{{\"step\":\"Finish response\",\"status\":\"pending\"}}]}}}}"));
    send(format!("{{\"method\":\"item/started\",\"params\":{{\"threadId\":{thread_id},\"turnId\":{turn_id},\"item\":{{\"id\":\"cmd-1\",\"type\":\"commandExecution\",\"command\":\"printf hello\",\"cwd\":\"/workspace\",\"source\":\"test\"}}}}}}"));
    send(format!("{{\"method\":\"item/commandExecution/outputDelta\",\"params\":{{\"threadId\":{thread_id},\"turnId\":{turn_id},\"itemId\":\"cmd-1\",\"delta\":\"hello\\n\",\"stream\":\"stdout\"}}}}"));
    send(format!("{{\"method\":\"item/completed\",\"params\":{{\"threadId\":{thread_id},\"turnId\":{turn_id},\"item\":{{\"id\":\"cmd-1\",\"type\":\"commandExecution\",\"status\":\"completed\",\"exitCode\":0,\"durationMs\":12,\"aggregatedOutput\":\"hello\\n\"}}}}}}"));
    send(format!("{{\"method\":\"item/fileChange/patchUpdated\",\"params\":{{\"threadId\":{thread_id},\"turnId\":{turn_id},\"itemId\":\"patch-1\",\"patch\":\"diff --git a/a b/a\",\"status\":\"running\"}}}}"));
    send(format!("{{\"method\":\"item/completed\",\"params\":{{\"threadId\":{thread_id},\"turnId\":{turn_id},\"item\":{{\"id\":\"view-1\",\"type\":\"imageView\",\"path\":\"/workspace/images/source.png\"}}}}}}"));
    send(format!("{{\"method\":\"item/completed\",\"params\":{{\"threadId\":{thread_id},\"turnId\":{turn_id},\"item\":{{\"id\":\"img-1\",\"type\":\"imageGeneration\",\"status\":\"completed\",\"revisedPrompt\":\"tiny fake image\",\"result\":\"data:image/png;base64,SGVsbG8=\"}}}}}}"));
}

fn task_trigger_extraction_text() -> &'static str {
    "{\"is_task_trigger_request\":true,\"missing_fields\":[],\"clarification_question\":null,\"task_trigger\":{\"title\":\"Check build\",\"prompt\":\"Check the build status\",\"kind\":\"interval\",\"timezone\":\"UTC\",\"run_at\":null,\"interval_seconds\":3600,\"enabled\":false,\"cwd\":null,\"model\":null,\"effort\":null,\"summary\":null,\"output_schema\":null,\"max_runtime_seconds\":60,\"max_runs\":null,\"phases\":[]}}"
}

fn task_trigger_clarification_text() -> &'static str {
    "{\"is_task_trigger_request\":true,\"missing_fields\":[\"interval_seconds\"],\"clarification_question\":\"你希望多久监控一次？\",\"task_trigger\":null}"
}

fn news_feishu_task_trigger_extraction_text() -> &'static str {
    "{\"is_task_trigger_request\":true,\"missing_fields\":[],\"clarification_question\":null,\"task_trigger\":{\"title\":\"每日 AI 新闻飞书发送\",\"prompt\":\"每天早上9点搜集一下 ai 相关的新闻，并且在飞书上给胡胖发消息，把新闻发给他。\",\"kind\":\"interval\",\"timezone\":\"Asia/Shanghai\",\"run_at\":\"2026-06-08T01:00:00Z\",\"interval_seconds\":86400,\"enabled\":true,\"cwd\":null,\"model\":null,\"effort\":null,\"summary\":null,\"output_schema\":null,\"max_runtime_seconds\":60,\"max_runs\":null,\"phases\":[]}}"
}

fn weekly_price_task_trigger_extraction_text() -> &'static str {
    "{\"is_task_trigger_request\":true,\"missing_fields\":[],\"clarification_question\":null,\"task_trigger\":{\"title\":\"Monitor used MacBook Pro prices\",\"prompt\":\"监控二手 M4 Pro 和 M5 Pro MacBook Pro 的价格。\",\"kind\":\"interval\",\"timezone\":\"Asia/Shanghai\",\"run_at\":null,\"interval_seconds\":604800,\"enabled\":false,\"cwd\":null,\"model\":null,\"effort\":null,\"summary\":null,\"output_schema\":null,\"max_runtime_seconds\":60,\"max_runs\":null,\"phases\":[]}}"
}

fn title_generation_text() -> &'static str {
    "{\"title\":\"Chat Greeting\"}"
}

fn main() {
    let stdin = io::stdin();
    let mut thread_counter = 0_u64;
    let mut turn_counter = 0_u64;
    let mut thread_has_task_execution_tool: HashMap<String, bool> = HashMap::new();
    let mut pending_approvals: HashMap<String, (String, String, String, String)> = HashMap::new();
    let mut pending_dynamic_tools: HashMap<String, (String, String, String, String)> = HashMap::new();
    let mut pending_user_inputs: HashMap<String, (String, String, String, String)> = HashMap::new();

    for line_result in stdin.lock().lines() {
        let Ok(line) = line_result else {
            continue;
        };
        let request_id = extract_id(&line);
        if is_response(&line) {
            if let Some(id) = request_id.as_ref() {
                complete_pending_response(
                    id,
                    &mut pending_approvals,
                    &mut pending_dynamic_tools,
                    &mut pending_user_inputs,
                );
            }
            continue;
        }
        let method = extract_string_field(&line, "method");

        match (request_id.as_ref(), method.as_deref()) {
            (Some(id), Some("initialize")) => {
                send(format!("{{\"id\":{},\"result\":{{}}}}", id.raw_json()));
            }
            (_, Some("initialized")) => {}
            (Some(id), Some("model/list")) => {
                send(format!(
                    "{{\"id\":{},\"result\":{{\"data\":[{{\"id\":\"codex-test\",\"model\":\"codex-test\",\"displayName\":\"Codex Test Runtime\",\"description\":\"Fake runtime model for Ripple smoke tests\",\"hidden\":false,\"supportedReasoningEfforts\":[{{\"reasoningEffort\":\"medium\",\"description\":\"Balanced\"}}],\"defaultReasoningEffort\":\"medium\",\"inputModalities\":[\"text\"],\"supportsPersonality\":false,\"additionalSpeedTiers\":[],\"serviceTiers\":[],\"defaultServiceTier\":null,\"isDefault\":true,\"upgrade\":null,\"upgradeInfo\":null,\"availabilityNux\":null}}],\"nextCursor\":null}}}}",
                    id.raw_json()
                ));
            }
            (Some(id), Some("modelProvider/capabilities/read")) => {
                send(format!(
                    "{{\"id\":{},\"result\":{{\"namespaceTools\":true,\"imageGeneration\":true,\"webSearch\":true}}}}",
                    id.raw_json()
                ));
            }
            (Some(id), Some("account/rateLimits/read")) => {
                send(format!(
                    "{{\"id\":{},\"result\":{{\"rateLimits\":{{\"primary\":{{\"usedPercent\":12}}}},\"rateLimitsByLimitId\":null,\"rateLimitResetCredits\":null}}}}",
                    id.raw_json()
                ));
            }
            (Some(id), Some("account/usage/read")) => {
                send(format!(
                    "{{\"id\":{},\"result\":{{\"usage\":{{\"totalTokens\":1234,\"inputTokens\":900,\"outputTokens\":334}}}}}}",
                    id.raw_json()
                ));
            }
            (Some(id), Some("configRequirements/read")) => {
                send(format!(
                    "{{\"id\":{},\"result\":{{\"status\":\"ok\",\"requirements\":[]}}}}",
                    id.raw_json()
                ));
            }
            (Some(id), Some("thread/start")) => {
                thread_counter += 1;
                let thread_id = format!("thread-{thread_counter}");
                thread_has_task_execution_tool.insert(
                    thread_id.clone(),
                    line.contains("\"dynamicTools\"")
                        && line.contains("task_execution_confirmed"),
                );
                send(format!(
                    "{{\"id\":{},\"result\":{{\"thread\":{{\"id\":{}}}}}}}",
                    id.raw_json(),
                    json_string(&thread_id)
                ));
            }
            (Some(id), Some("thread/resume")) => {
                let thread_id = extract_string_field(&line, "threadId")
                    .unwrap_or_else(|| "thread-resumed".to_string());
                let response_thread_id = if line.contains("\"excludeTurns\":true") {
                    thread_id
                } else {
                    "thread-resume-missing-exclude-turns".to_string()
                };
                thread_has_task_execution_tool.insert(
                    response_thread_id.clone(),
                    line.contains("\"dynamicTools\"")
                        && line.contains("task_execution_confirmed"),
                );
                send(format!(
                    "{{\"id\":{},\"result\":{{\"thread\":{{\"id\":{}}}}}}}",
                    id.raw_json(),
                    json_string(&response_thread_id)
                ));
            }
            (Some(id), Some("thread/read")) => {
                let thread_id = extract_string_field(&line, "threadId")
                    .unwrap_or_else(|| "thread-read".to_string());
                send(format!(
                    "{{\"id\":{},\"result\":{{\"thread\":{{\"id\":{},\"status\":\"notLoaded\"}}}}}}",
                    id.raw_json(),
                    json_string(&thread_id)
                ));
            }
            (Some(id), Some("thread/compact/start")) => {
                let thread_id = extract_string_field(&line, "threadId")
                    .unwrap_or_else(|| "thread-unknown".to_string());
                send(format!("{{\"id\":{},\"result\":{{}}}}", id.raw_json()));
                let thread_json = json_string(&thread_id);
                send(format!("{{\"method\":\"item/started\",\"params\":{{\"threadId\":{thread_json},\"turnId\":\"compact-turn\",\"item\":{{\"id\":\"compact-1\",\"type\":\"contextCompaction\"}}}}}}"));
                send(format!("{{\"method\":\"item/completed\",\"params\":{{\"threadId\":{thread_json},\"turnId\":\"compact-turn\",\"item\":{{\"id\":\"compact-1\",\"type\":\"contextCompaction\"}}}}}}"));
            }
            (Some(id), Some("thread/archive")) => {
                send(format!("{{\"id\":{},\"result\":{{}}}}", id.raw_json()));
            }
            (Some(id), Some("thread/rollback")) => {
                send(format!(
                    "{{\"id\":{},\"error\":{{\"code\":-32600,\"message\":\"thread rollback requires persisted thread history\"}}}}",
                    id.raw_json()
                ));
            }
            (Some(id), Some("turn/start")) => {
                turn_counter += 1;
                let thread_id = extract_string_field(&line, "threadId")
                    .unwrap_or_else(|| "thread-unknown".to_string());
                let turn_id = format!("turn-{turn_counter}");
                let item_id = format!("item-{turn_counter}");
                send(format!(
                    "{{\"id\":{},\"result\":{{\"turn\":{{\"id\":{}}}}}}}",
                    id.raw_json(),
                    json_string(&turn_id)
                ));

                let model = extract_string_field(&line, "model").unwrap_or_default();
                if line.contains("[model-fallback-side-effect]") && model == "gpt-5.6-luna" {
                    send(format!(
                        "{{\"method\":\"item/started\",\"params\":{{\"threadId\":{},\"turnId\":{},\"item\":{{\"id\":\"cmd-fallback\",\"type\":\"commandExecution\",\"command\":\"echo changed\"}}}}}}",
                        json_string(&thread_id),
                        json_string(&turn_id)
                    ));
                    fail_model_turn(&thread_id, &turn_id);
                    continue;
                }
                if line.contains("[model-fallback]")
                    && (model == "gpt-5.6-luna"
                        || (line.contains("[model-fallback-to-5.5]")
                            && model == "gpt-5.6-terra"))
                {
                    fail_model_turn(&thread_id, &turn_id);
                    continue;
                }

                let text = if line.contains("[provider-env-check]") {
                    if std::env::var("RIPPLE_TEST_PROVIDER_API_KEY").ok().as_deref()
                        == Some("provider-secret")
                    {
                        "provider env present".to_string()
                    } else {
                        "provider env missing".to_string()
                    }
                } else if line.contains("[env-check]") {
                    if std::env::var("RIPPLE_SECRET_SHOULD_NOT_LEAK").is_ok() {
                        "env leaked".to_string()
                    } else if std::env::var("HTTP_PROXY").ok().as_deref()
                        == Some("http://proxy.example:8080")
                    {
                        "env clean proxy present".to_string()
                    } else {
                        "env clean proxy missing".to_string()
                    }
                } else if line.contains("[model-fallback]") {
                    format!("fallback completed {model}")
                } else if line.contains("strict chat-title generator") {
                    title_generation_text().to_string()
                } else if line.contains("\"outputSchema\"") {
                    if line.contains("[clarify-interval]") && !line.contains("一周一次") {
                        task_trigger_clarification_text().to_string()
                    } else if line.contains("[news-feishu]") {
                        news_feishu_task_trigger_extraction_text().to_string()
                    } else if line.contains("[clarify-interval]") && line.contains("一周一次") {
                        weekly_price_task_trigger_extraction_text().to_string()
                    } else {
                        task_trigger_extraction_text().to_string()
                    }
                } else if line.contains("[model-auth-alpha]") {
                    "<ripple_connector_auth_request>{\"connector\":\"google_workspace\",\"force_reauth\":false,\"reason\":\"needs Gmail access\"}</ripple_connector_auth_request>".to_string()
                } else if line.contains("[history-watermark-check]") {
                    let history_state = if line.contains("[history-watermark-old]") {
                        "history replayed"
                    } else {
                        "history delta clean"
                    };
                    format!("{history_state} {thread_id} {turn_id}")
                } else if line.contains("## Context Folder")
                    && line.contains("Context folder: /workspace/demo")
                {
                    "context folder prompt present".to_string()
                } else if line.contains("[ids]") {
                    format!("fake codex completed {thread_id} {turn_id}")
                } else {
                    "fake codex completed".to_string()
                };

                if line.contains("[approval]") {
                    let approval_id = format!("approval-{turn_counter}");
                    pending_approvals.insert(
                        approval_id.clone(),
                        (
                            thread_id.clone(),
                            turn_id.clone(),
                            item_id.clone(),
                            "fake approval completed".to_string(),
                        ),
                    );
                    send(format!(
                        "{{\"id\":{},\"method\":\"item/commandExecution/requestApproval\",\"params\":{{\"threadId\":{},\"turnId\":{},\"command\":[\"echo\",\"approval\"],\"reason\":\"fake command approval\"}}}}",
                        json_string(&approval_id),
                        json_string(&thread_id),
                        json_string(&turn_id)
                    ));
                    continue;
                }

                if line.contains("[fail]") {
                    fail_turn(&thread_id, &turn_id, &item_id, "fake codex failed");
                    continue;
                }

                if line.contains("[request-user-input]") {
                    let user_input_request_id = format!("user-input-{turn_counter}");
                    pending_user_inputs.insert(
                        user_input_request_id.clone(),
                        (
                            thread_id.clone(),
                            turn_id.clone(),
                            item_id.clone(),
                            "user input skipped".to_string(),
                        ),
                    );
                    send(format!(
                        "{{\"method\":\"thread/status/changed\",\"params\":{{\"threadId\":{},\"status\":\"waitingOnUserInput\",\"runtime\":{{\"pendingUserInputRequests\":1}}}}}}",
                        json_string(&thread_id)
                    ));
                    send(format!(
                        "{{\"id\":{},\"method\":\"item/tool/requestUserInput\",\"params\":{{\"threadId\":{},\"turnId\":{},\"itemId\":\"input-item\",\"questions\":[{{\"id\":\"budget\",\"header\":\"预算\",\"question\":\"客户预算是多少？\",\"options\":[{{\"label\":\"10 万以内\",\"description\":\"按低预算方案继续\"}}]}}],\"autoResolutionMs\":null}}}}",
                        json_string(&user_input_request_id),
                        json_string(&thread_id),
                        json_string(&turn_id)
                    ));
                    continue;
                }

                if line.contains("[task-confirm-execute]") {
                    if !thread_has_task_execution_tool
                        .get(&thread_id)
                        .copied()
                        .unwrap_or(false)
                    {
                        complete_turn(
                            &thread_id,
                            &turn_id,
                            &item_id,
                            "task_execution_confirmed dynamic tool missing",
                        );
                        continue;
                    }
                    let dynamic_request_id = format!("dynamic-task-confirm-{turn_counter}");
                    let call_id = format!("call-task-confirm-{turn_counter}");
                    let completion_text = if line.contains("[task-confirm-auth]") {
                        "<ripple_connector_auth_request>{\"connector\":\"google_workspace\",\"force_reauth\":false,\"reason\":\"needs Gmail access\"}</ripple_connector_auth_request>"
                    } else if line.contains("[task-confirm-slow]") {
                        "[slow] task execution completed"
                    } else {
                        "task execution completed"
                    };
                    pending_dynamic_tools.insert(
                        dynamic_request_id.clone(),
                        (
                            thread_id.clone(),
                            turn_id.clone(),
                            item_id.clone(),
                            completion_text.to_string(),
                        ),
                    );
                    send(format!(
                        "{{\"method\":\"item/started\",\"params\":{{\"threadId\":{},\"turnId\":{},\"item\":{{\"id\":{},\"type\":\"dynamicToolCall\",\"namespace\":\"codex_app\",\"tool\":\"task_execution_confirmed\",\"arguments\":{{}}}}}}}}",
                        json_string(&thread_id),
                        json_string(&turn_id),
                        json_string(&call_id)
                    ));
                    send(format!(
                        "{{\"id\":{},\"method\":\"item/tool/call\",\"params\":{{\"threadId\":{},\"turnId\":{},\"callId\":{},\"namespace\":\"codex_app\",\"tool\":\"task_execution_confirmed\",\"arguments\":{{}}}}}}",
                        json_string(&dynamic_request_id),
                        json_string(&thread_id),
                        json_string(&turn_id),
                        json_string(&call_id)
                    ));
                    continue;
                }

                if line.contains("[plain-user-question]") {
                    complete_turn(
                        &thread_id,
                        &turn_id,
                        &item_id,
                        "请补充参会人和具体会议时间。",
                    );
                    continue;
                }


                if line.contains("[slow-delete]") {
                    thread::sleep(Duration::from_millis(2_000));
                } else if line.contains("[slow]") {
                    thread::sleep(Duration::from_millis(500));
                }
                if line.contains("[runtime-events]") {
                    emit_runtime_events(&thread_id, &turn_id);
                }
                complete_turn(&thread_id, &turn_id, &item_id, &text);
            }
            (Some(id), None) => {
                complete_pending_response(
                    id,
                    &mut pending_approvals,
                    &mut pending_dynamic_tools,
                    &mut pending_user_inputs,
                );
            }
            (Some(id), Some("turn/interrupt" | "turn/steer")) => {
                send(format!("{{\"id\":{},\"result\":{{}}}}", id.raw_json()));
            }
            (Some(id), Some(other)) => {
                send(format!(
                    "{{\"id\":{},\"error\":{{\"code\":-32601,\"message\":{}}}}}",
                    id.raw_json(),
                    json_string(&format!("unsupported {other}"))
                ));
            }
            _ => {}
        }
    }
}
"###,
            )
            .unwrap();
            let output = Command::new("rustc")
                .arg("--edition=2021")
                .arg(&source)
                .arg("-o")
                .arg(&executable)
                .output()
                .unwrap_or_else(|err| panic!("failed to run rustc for fake Codex app-server: {err}"));
            assert!(
                output.status.success(),
                "failed to compile fake Codex app-server:\nstdout:\n{}\nstderr:\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            executable.to_string_lossy().to_string()
        })
        .clone()
}

fn request(method: Method, uri: &str, body: Value, authorized: bool) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(uri);
    if authorized {
        builder = builder
            .header("authorization", "Bearer test-key")
            .header("x-ripple-user-id", "smoke-user");
    }
    if body.is_null() {
        builder.body(Body::empty()).unwrap()
    } else {
        builder
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap()
    }
}

fn request_as_user(method: Method, uri: &str, body: Value, user_id: &str) -> Request<Body> {
    let builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", "Bearer test-key")
        .header("x-ripple-user-id", user_id);
    if body.is_null() {
        builder.body(Body::empty()).unwrap()
    } else {
        builder
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap()
    }
}

fn request_with_bearer(
    method: Method,
    uri: &str,
    body: Value,
    bearer: &str,
    user_id: Option<&str>,
) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {bearer}"));
    if let Some(user_id) = user_id {
        builder = builder.header("x-ripple-user-id", user_id);
    }
    if body.is_null() {
        builder.body(Body::empty()).unwrap()
    } else {
        builder
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap()
    }
}

async fn response_json(response: axum::response::Response) -> Value {
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
}

async fn response_text(response: axum::response::Response) -> String {
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    String::from_utf8_lossy(&bytes).into_owned()
}

fn openapi_operation_pointer(path: &str, method: &str) -> String {
    let escaped_path = path.replace('~', "~0").replace('/', "~1");
    format!("/paths/{escaped_path}/{method}")
}

async fn response_bytes(response: axum::response::Response) -> Vec<u8> {
    to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec()
}

fn multipart_request(uri: &str, boundary: &str, body: Vec<u8>) -> Request<Body> {
    Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header("authorization", "Bearer test-key")
        .header("x-ripple-user-id", "smoke-user")
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(body))
        .unwrap()
}

async fn call(app: axum::Router, method: Method, uri: &str, body: Value) -> (StatusCode, Value) {
    let response = app.oneshot(request(method, uri, body, true)).await.unwrap();
    let status = response.status();
    let body = response_json(response).await;
    (status, body)
}

#[tokio::test]
async fn task_session_responses_reuses_chat_session_without_pre_execution_status() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (_state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let (callback_url, mut callbacks) = callback_collector().await;

    let response = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/task-sessions/responses",
            json!({
                "task_id": "caller-task-1",
                "input": "请总结这段文字",
                "req_id": "via-task-response-1",
                "callback_url": callback_url
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("text/event-stream")
    );
    assert!(response.headers().get("x-ripple-session-id").is_none());
    let first = response_text(response).await;
    assert!(!first.contains("event: task.status"), "{first}");
    assert!(!first.contains("response.created"), "{first}");
    assert!(!first.contains("response.completed"), "{first}");
    assert!(!first.contains("ripple_session_id"), "{first}");
    assert!(!first.contains("task_session_id"), "{first}");
    assert!(
        tokio::time::timeout(Duration::from_millis(200), callbacks.recv())
            .await
            .is_err(),
        "dialogue turns must not send callbacks"
    );

    let continued = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/task-sessions/responses",
            json!({
                "task_id": "caller-task-1",
                "req_id": "via-task-response-2",
                "input": "继续"
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(continued.status(), StatusCode::OK);
    let continued = response_text(continued).await;
    assert!(!continued.contains("event: task.status"), "{continued}");

    let without_req_id = app
        .oneshot(request(
            Method::POST,
            "/v1/task-sessions/responses",
            json!({"task_id": "caller-task-1", "input": "再继续"}),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(without_req_id.status(), StatusCode::OK);
    let without_req_id = response_text(without_req_id).await;
    assert!(!without_req_id.contains("\"req_id\""), "{without_req_id}");
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn task_session_context_folder_is_turn_scoped_without_persisting_to_session() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let workspace = state.sandboxes.ensure_sandbox("smoke-user").unwrap();
    fs::create_dir_all(workspace.join("task-context")).unwrap();

    let response = app
        .oneshot(request(
            Method::POST,
            "/v1/task-sessions/responses",
            json!({
                "task_id": "caller-task-context-folder-1",
                "input": "inspect the selected folder",
                "callback_url": "http://127.0.0.1:9/task-status",
                "context_folder_path": "/workspace/task-context"
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let _ = response_text(response).await;

    let runs = state.jobs.list_user("smoke-user").await.unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(
        runs[0].sandbox_cwd.as_deref(),
        Some("/workspace/task-context")
    );

    let session = state
        .sessions
        .list_sessions("smoke-user")
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(session.context_folder_path, None);
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn task_session_responses_streams_dialogue_without_status_or_callback() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (_state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let (callback_url, mut callbacks) = callback_collector().await;

    let response = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/task-sessions/responses",
            json!({
                "task_id": "caller-task-stream-1",
                "input": "stream task response",
                "req_id": "via-task-stream-1",
                "callback_url": callback_url
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("text/event-stream")
    );
    let body = response_text(response).await;
    assert!(body.contains("event: response.output_text.delta"), "{body}");
    assert!(!body.contains("event: task.status"), "{body}");
    assert!(!body.contains("required_action"), "{body}");
    assert!(!body.contains("response_id"), "{body}");
    assert!(!body.contains("item_id"), "{body}");
    assert!(!body.contains("event: response.completed"), "{body}");
    assert!(body.contains("data: [DONE]"), "{body}");

    assert!(
        tokio::time::timeout(Duration::from_millis(200), callbacks.recv())
            .await
            .is_err(),
        "dialogue turns must not send callbacks"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn task_session_explicit_confirmation_starts_callback_only_execution_status() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (_state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let (callback_url, mut callbacks) = callback_collector().await;

    let response = app
        .oneshot(request(
            Method::POST,
            "/v1/task-sessions/responses",
            json!({
                "task_id": "caller-task-confirm-1",
                "input": "[task-confirm-execute] 确认开始执行",
                "req_id": "via-task-confirm-1",
                "callback_url": callback_url
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_text(response).await;
    assert!(
        !body.contains("event: response.output_text.delta"),
        "{body}"
    );
    assert!(!body.contains("event: task.status"), "{body}");
    assert!(body.contains("data: [DONE]"), "{body}");

    let first = tokio::time::timeout(Duration::from_secs(2), callbacks.recv())
        .await
        .expect("first callback timeout")
        .expect("first callback payload");
    let second = tokio::time::timeout(Duration::from_secs(2), callbacks.recv())
        .await
        .expect("second callback timeout")
        .expect("second callback payload");
    let statuses = [first, second]
        .into_iter()
        .map(|callback| {
            assert_eq!(
                callback.get("event").and_then(Value::as_str),
                Some("task.status")
            );
            assert_eq!(
                callback.get("task_id").and_then(Value::as_str),
                Some("caller-task-confirm-1")
            );
            assert_eq!(
                callback.get("req_id").and_then(Value::as_str),
                Some("via-task-confirm-1")
            );
            assert!(callback.get("content").is_some());
            assert!(callback.get("output_text").is_none());
            callback
                .get("status")
                .and_then(Value::as_str)
                .unwrap()
                .to_string()
        })
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(
        statuses,
        std::collections::HashSet::from(["running".to_string(), "completed".to_string()])
    );
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn task_session_execution_connector_auth_posts_waiting_user_callback() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let (callback_url, mut callbacks) = callback_collector().await;

    let response = app
        .oneshot(request(
            Method::POST,
            "/v1/task-sessions/responses",
            json!({
                "task_id": "caller-task-confirm-auth-1",
                "input": "[task-confirm-execute] [task-confirm-auth] 确认开始执行",
                "req_id": "via-task-confirm-auth-1",
                "callback_url": callback_url
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response_text(response).await, "data: [DONE]\n\n");

    let mut received = Vec::new();
    for _ in 0..2 {
        received.push(
            tokio::time::timeout(Duration::from_secs(2), callbacks.recv())
                .await
                .expect("callback timeout")
                .expect("callback payload"),
        );
    }
    assert_eq!(
        received
            .iter()
            .filter_map(|callback| callback.get("status").and_then(Value::as_str))
            .collect::<std::collections::HashSet<_>>(),
        std::collections::HashSet::from(["running", "waiting_user"])
    );
    let waiting = received
        .iter()
        .find(|callback| callback.get("status").and_then(Value::as_str) == Some("waiting_user"))
        .expect("waiting_user callback");
    assert_eq!(
        waiting
            .pointer("/required_action/type")
            .and_then(Value::as_str),
        Some("connector_auth")
    );
    assert_eq!(
        waiting
            .pointer("/required_action/connector")
            .and_then(Value::as_str),
        Some("google_workspace")
    );
    assert!(!waiting
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .contains("<ripple_connector_auth_request>"));

    let session_id = state.sessions.list_sessions("smoke-user").await.unwrap()[0]
        .session_id
        .clone();
    let session = state
        .sessions
        .load("smoke-user", &session_id)
        .await
        .unwrap()
        .expect("task session");
    assert_eq!(session.status, "awaiting_user_input");
    assert!(session.pending_connector_auth.is_some());
    assert!(session.pending_control_request.is_some());
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn task_session_confirmation_closes_sse_before_a_slow_background_run_finishes() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (_state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let (callback_url, mut callbacks) = callback_collector().await;

    let response = app
        .oneshot(request(
            Method::POST,
            "/v1/task-sessions/responses",
            json!({
                "task_id": "caller-task-confirm-close-1",
                "input": "[task-confirm-execute] [task-confirm-slow] 确认开始执行",
                "req_id": "via-task-confirm-close-1",
                "callback_url": callback_url
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = tokio::time::timeout(Duration::from_millis(250), response_text(response))
        .await
        .expect("confirmation SSE must close without waiting for the run");
    assert_eq!(body, "data: [DONE]\n\n");

    let mut statuses = std::collections::HashSet::new();
    for _ in 0..2 {
        let callback = tokio::time::timeout(Duration::from_secs(2), callbacks.recv())
            .await
            .expect("callback timeout")
            .expect("callback payload");
        statuses.insert(
            callback
                .get("status")
                .and_then(Value::as_str)
                .expect("callback status")
                .to_string(),
        );
    }
    assert_eq!(
        statuses,
        std::collections::HashSet::from(["running".to_string(), "completed".to_string()])
    );
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn task_session_responses_streams_structured_user_question_and_persists_timeline() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));

    let response = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/task-sessions/responses",
            json!({
                "task_id": "caller-task-question-1",
                "input": "[request-user-input] collect budget",
                "req_id": "via-task-stream-question-1",
                "callback_url": "http://127.0.0.1:9/task-status"
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_text(response).await;
    assert!(!body.contains("ripple.user_input_required"));
    assert!(!body.contains("event: task.status"), "{body}");
    assert!(body.contains("客户预算是多少？"), "{body}");
    assert!(!body.contains("\"options\""), "{body}");
    assert!(!body.contains("event_id"), "{body}");
    assert!(!body.contains("event: response.completed"), "{body}");

    let session_id = state.sessions.list_sessions("smoke-user").await.unwrap()[0]
        .session_id
        .clone();
    let session = state
        .sessions
        .load("smoke-user", &session_id)
        .await
        .unwrap()
        .expect("task session");
    assert_eq!(session.status, "awaiting_user_input");
    assert_eq!(session.message_count, 2);
    assert_eq!(
        session.pending_question.as_deref(),
        Some("客户预算是多少？")
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn task_session_plain_text_question_remains_dialogue_only() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));

    let response = app
        .oneshot(request(
            Method::POST,
            "/v1/task-sessions/responses",
            json!({
                "task_id": "caller-task-plain-question-1",
                "input": "[plain-user-question] arrange meeting",
                "req_id": "via-task-plain-question-1",
                "callback_url": "http://127.0.0.1:9/task-status"
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_text(response).await;
    assert!(body.contains("event: response.output_text.delta"), "{body}");
    assert!(!body.contains("event: task.status"), "{body}");
    assert!(body.contains("请补充参会人和具体会议时间。"), "{body}");
    assert!(!body.contains("\"options\""), "{body}");

    let session_id = state.sessions.list_sessions("smoke-user").await.unwrap()[0]
        .session_id
        .clone();
    let session = state
        .sessions
        .load("smoke-user", &session_id)
        .await
        .unwrap()
        .expect("task session");
    assert_eq!(session.status, "idle");
    assert!(session.pending_question.is_none());
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn task_session_callback_does_not_block_the_primary_response() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (_state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let callback_url = slow_callback_url().await;

    let response = tokio::time::timeout(
        Duration::from_secs(2),
        app.oneshot(request(
            Method::POST,
            "/v1/task-sessions/responses",
            json!({
                "task_id": "caller-task-callback-1",
                "input": "[task-confirm-execute] non-blocking callback",
                "req_id": "via-task-callback-fast-1",
                "callback_url": callback_url
            }),
            true,
        )),
    )
    .await
    .expect("primary response headers must not wait for callback")
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn task_session_callback_retries_once_after_failure() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (_state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let (callback_url, mut callbacks) = callback_retry_collector().await;

    let response = app
        .oneshot(request(
            Method::POST,
            "/v1/task-sessions/responses",
            json!({
                "task_id": "caller-task-retry-1",
                "input": "[task-confirm-execute] retry callback",
                "req_id": "via-task-retry-1",
                "callback_url": callback_url
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_text(response).await;
    assert!(
        !body.contains("event: response.output_text.delta"),
        "{body}"
    );

    let mut statuses = Vec::new();
    for _ in 0..3 {
        let callback = tokio::time::timeout(Duration::from_secs(2), callbacks.recv())
            .await
            .expect("callback retry timeout")
            .expect("callback retry payload");
        statuses.push(
            callback
                .get("status")
                .and_then(Value::as_str)
                .unwrap()
                .to_string(),
        );
    }
    let counts = statuses
        .into_iter()
        .fold(BTreeMap::new(), |mut counts, status| {
            *counts.entry(status).or_insert(0_usize) += 1;
            counts
        });
    assert_eq!(
        counts.keys().cloned().collect::<Vec<_>>(),
        ["completed", "running"]
    );
    assert_eq!(counts.values().sum::<usize>(), 3);
    assert!(counts.values().any(|count| *count == 2));
    assert!(
        tokio::time::timeout(Duration::from_millis(200), callbacks.recv())
            .await
            .is_err(),
        "callback must be attempted at most twice"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn task_session_text_approval_resumes_the_pending_run_and_posts_completion() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let (callback_url, mut callbacks) = callback_collector().await;

    let waiting = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/task-sessions/responses",
            json!({
                "task_id": "caller-task-resume-approval-1",
                "input": "[approval] run a fake command",
                "req_id": "via-task-approval-1",
                "callback_url": callback_url
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(waiting.status(), StatusCode::OK);
    let _ = response_text(waiting).await;

    let session_id = state.sessions.list_sessions("smoke-user").await.unwrap()[0]
        .session_id
        .clone();
    let mut session = state
        .sessions
        .load("smoke-user", &session_id)
        .await
        .unwrap()
        .expect("task session");
    assert!(session.pending_permission_request.is_some());
    session.pending_control_request = Some(json!({
        "type": "task_execution",
        "active": true,
        "task_id": "caller-task-resume-approval-1",
        "req_id": "via-task-approval-1"
    }));
    state.sessions.save_record(session).await.unwrap();

    let resumed = app
        .oneshot(request(
            Method::POST,
            "/v1/task-sessions/responses",
            json!({
                "task_id": "caller-task-resume-approval-1",
                "input": "允许发送",
                "req_id": "via-task-approval-2"
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(resumed.status(), StatusCode::OK);
    assert_eq!(response_text(resumed).await, "data: [DONE]\n\n");

    let callback = tokio::time::timeout(Duration::from_secs(2), callbacks.recv())
        .await
        .expect("completion callback timeout")
        .expect("completion callback payload");
    assert_eq!(
        callback.get("status").and_then(Value::as_str),
        Some("completed")
    );
    assert_eq!(
        callback.get("req_id").and_then(Value::as_str),
        Some("via-task-approval-2")
    );
    assert_eq!(
        callback.get("content").and_then(Value::as_str),
        Some("fake approval completed")
    );
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn task_session_text_reply_resumes_pending_user_input_and_posts_completion() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let (callback_url, mut callbacks) = callback_collector().await;

    let waiting = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/task-sessions/responses",
            json!({
                "task_id": "caller-task-resume-input-1",
                "input": "[request-user-input] collect budget",
                "req_id": "via-task-input-1",
                "callback_url": callback_url
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(waiting.status(), StatusCode::OK);
    let _ = response_text(waiting).await;

    let session_id = state.sessions.list_sessions("smoke-user").await.unwrap()[0]
        .session_id
        .clone();
    let mut session = state
        .sessions
        .load("smoke-user", &session_id)
        .await
        .unwrap()
        .expect("task session");
    session.pending_control_request = Some(json!({
        "type": "task_execution",
        "active": true,
        "task_id": "caller-task-resume-input-1",
        "req_id": "via-task-input-1"
    }));
    state.sessions.save_record(session).await.unwrap();

    let resumed = app
        .oneshot(request(
            Method::POST,
            "/v1/task-sessions/responses",
            json!({
                "task_id": "caller-task-resume-input-1",
                "input": "客户预算十万元以内",
                "req_id": "via-task-input-2"
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(resumed.status(), StatusCode::OK);
    assert_eq!(response_text(resumed).await, "data: [DONE]\n\n");

    let callback = tokio::time::timeout(Duration::from_secs(2), callbacks.recv())
        .await
        .expect("completion callback timeout")
        .expect("completion callback payload");
    assert_eq!(
        callback.get("status").and_then(Value::as_str),
        Some("completed")
    );
    assert_eq!(
        callback.get("req_id").and_then(Value::as_str),
        Some("via-task-input-2")
    );
    assert_eq!(
        callback.get("content").and_then(Value::as_str),
        Some("user input skipped")
    );
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn task_session_stream_disconnect_still_finalizes_and_posts_callback() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let (callback_url, mut callbacks) = callback_collector().await;

    let response = app
        .oneshot(request(
            Method::POST,
            "/v1/task-sessions/responses",
            json!({
                "task_id": "caller-task-disconnect-1",
                "input": "[task-confirm-execute] finish after stream disconnect",
                "req_id": "via-task-disconnect-1",
                "callback_url": callback_url
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    drop(response);

    let mut completed = None;
    for _ in 0..2 {
        let callback = tokio::time::timeout(Duration::from_secs(2), callbacks.recv())
            .await
            .expect("callback must not depend on the SSE consumer")
            .expect("callback payload");
        if callback.get("status").and_then(Value::as_str) == Some("completed") {
            completed = Some(callback);
        }
    }
    let completed = completed.expect("completed callback");
    assert_eq!(
        completed.get("task_id").and_then(Value::as_str),
        Some("caller-task-disconnect-1")
    );
    let session_id = state.sessions.list_sessions("smoke-user").await.unwrap()[0]
        .session_id
        .clone();
    let session = state
        .sessions
        .load("smoke-user", &session_id)
        .await
        .unwrap()
        .expect("task session");
    assert_eq!(session.status, "idle");
    assert_eq!(session.message_count, 2);
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn task_session_responses_requires_nonempty_task_id_and_input() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (_state, app) = test_state_and_app(&root);

    let missing_input = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/task-sessions/responses",
            json!({"task_id": "caller-task-invalid-1", "req_id": "missing-input"}),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(missing_input.status(), StatusCode::BAD_REQUEST);
    let missing_input = response_json(missing_input).await;
    assert_eq!(
        missing_input.pointer("/error/code").and_then(Value::as_str),
        Some("bad_request")
    );

    let missing_task_id = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/task-sessions/responses",
            json!({"input": "继续"}),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(missing_task_id.status(), StatusCode::BAD_REQUEST);
    let missing_task_id = response_json(missing_task_id).await;
    assert_eq!(
        missing_task_id
            .pointer("/error/code")
            .and_then(Value::as_str),
        Some("bad_request")
    );

    let empty_task_id = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/task-sessions/responses",
            json!({"task_id": "  ", "input": "继续"}),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(empty_task_id.status(), StatusCode::BAD_REQUEST);

    let missing_callback = app
        .oneshot(request(
            Method::POST,
            "/v1/task-sessions/responses",
            json!({
                "task_id": "caller-task-missing-callback",
                "input": "创建一个任务"
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(missing_callback.status(), StatusCode::BAD_REQUEST);
    let missing_callback = response_json(missing_callback).await;
    assert_eq!(
        missing_callback
            .pointer("/error/message")
            .and_then(Value::as_str),
        Some("callback_url is required for a new task session")
    );

    let _ = std::fs::remove_dir_all(root);
}

async fn callback_collector() -> (String, tokio::sync::mpsc::Receiver<Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (tx, rx) = tokio::sync::mpsc::channel::<Value>(32);
    let app = axum::Router::new()
        .route("/", axum::routing::post(callback_collect_handler))
        .with_state(tx);
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}/"), rx)
}

async fn callback_retry_collector() -> (String, tokio::sync::mpsc::Receiver<Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (tx, rx) = tokio::sync::mpsc::channel::<Value>(32);
    let attempts = Arc::new(AtomicUsize::new(0));
    let app = axum::Router::new()
        .route(
            "/",
            axum::routing::post(
                |axum::extract::State((tx, attempts)): axum::extract::State<(
                    tokio::sync::mpsc::Sender<Value>,
                    Arc<AtomicUsize>,
                )>,
                 axum::Json(payload): axum::Json<Value>| async move {
                    let attempt = attempts.fetch_add(1, Ordering::SeqCst);
                    let _ = tx.send(payload).await;
                    if attempt == 0 {
                        StatusCode::INTERNAL_SERVER_ERROR
                    } else {
                        StatusCode::OK
                    }
                },
            ),
        )
        .with_state((tx, attempts));
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}/"), rx)
}

async fn slow_callback_url() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = axum::Router::new().route(
        "/",
        axum::routing::post(|| async {
            tokio::time::sleep(Duration::from_secs(10)).await;
            "ok"
        }),
    );
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{addr}/")
}

async fn callback_collect_handler(
    axum::extract::State(tx): axum::extract::State<tokio::sync::mpsc::Sender<Value>>,
    axum::Json(payload): axum::Json<Value>,
) -> &'static str {
    let _ = tx.send(payload).await;
    "ok"
}

fn response_body_from_chat_intent(mut body: Value) -> Value {
    let Some(object) = body.as_object_mut() else {
        return body;
    };
    if let Some(messages) = object.remove("messages") {
        object.insert("input".to_string(), messages);
    }
    if let Some(session_id) = object
        .remove("session_id")
        .and_then(|value| value.as_str().map(str::to_string))
        .filter(|value| !value.is_empty())
    {
        object.insert(
            "previous_response_id".to_string(),
            json!(format!("resp_{session_id}")),
        );
        let metadata = object.entry("metadata").or_insert_with(|| json!({}));
        if let Some(metadata) = metadata.as_object_mut() {
            metadata.insert("ripple_session_id".to_string(), json!(session_id));
        }
    }
    if let Some(output_schema) = object.remove("outputSchema") {
        object.insert(
            "text".to_string(),
            json!({"format": {"type": "json_schema", "schema": output_schema}}),
        );
    }
    body
}

async fn call_response(app: axum::Router, body: Value) -> (StatusCode, Value) {
    call(
        app,
        Method::POST,
        "/v1/responses",
        response_body_from_chat_intent(body),
    )
    .await
}

fn response_request(body: Value, authorized: bool) -> Request<Body> {
    request(
        Method::POST,
        "/v1/responses",
        response_body_from_chat_intent(body),
        authorized,
    )
}

fn response_output_text(response: &Value) -> &str {
    response
        .get("output_text")
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn response_session_id(response: &Value) -> Option<&str> {
    response
        .pointer("/metadata/ripple_session_id")
        .and_then(Value::as_str)
}

fn test_state_and_app(root: &Path) -> (AppState, axum::Router) {
    let state = AppState::new(test_config(root));
    let app = router(state.clone());
    (state, app)
}

fn seed_shared_file_parser_env(root: &Path) {
    let env_path = root.join("cache/python-envs/shared-file-parser-test");
    let python_executable = env_path.join("bin/python");
    let lock_path = root
        .join("cache/python-env-locks")
        .join("shared-file-parser-test.requirements.txt");
    let marker_path = root
        .join("cache/python-env-locks")
        .join("shared-file-parser-v1.json");
    fs::create_dir_all(python_executable.parent().unwrap()).unwrap();
    fs::create_dir_all(lock_path.parent().unwrap()).unwrap();
    fs::write(&python_executable, "#!/bin/sh\nexit 0\n").unwrap();
    fs::write(&lock_path, "test lock").unwrap();
    fs::write(
        &marker_path,
        serde_json::to_vec_pretty(&json!({
            "env_key": "shared-file-parser-test",
            "env_path": env_path,
            "base_python_executable": "/usr/bin/python3",
            "python_executable": python_executable,
            "lock_path": lock_path,
            "requirements": [
                "openpyxl==3.1.5",
                "pypdf==5.0.0",
                "python-docx==1.1.2",
                "python-pptx==1.0.2"
            ]
        }))
        .unwrap(),
    )
    .unwrap();
}

fn test_state_and_app_with_config(config: AppConfig) -> (AppState, axum::Router) {
    let state = AppState::new(config);
    let app = router(state.clone());
    (state, app)
}

#[tokio::test]
async fn app_state_initializes_sqlite_control_plane() {
    let root = std::env::temp_dir().join(format!("ripple-api-test-{}", Uuid::new_v4()));
    let _state = AppState::new(test_config(&root));

    assert!(root.join(".ripple/ripple.sqlite").is_file());

    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn invite_auth_claim_login_and_user_token_isolate_user_id() {
    let root = std::env::temp_dir().join(format!("ripple-api-auth-{}", Uuid::new_v4()));
    let (state, app) = test_state_and_app_with_config(test_config_with_user_auth(&root));

    let invite = state
        .storage
        .create_user_auth_invite(1, Some(14), Some("test-admin"))
        .await
        .expect("invite");
    let claim_response = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/auth/invite/claim",
            serde_json::to_value(AuthClaimRequest {
                invite_code: invite.code,
                login: "alice@example.com".to_string(),
                password: "correct-password".to_string(),
                display_name: Some("Alice".to_string()),
            })
            .unwrap(),
            false,
        ))
        .await
        .unwrap();
    assert_eq!(claim_response.status(), StatusCode::OK);
    let claim_body = response_json(claim_response).await;
    let token = claim_body
        .get("token")
        .and_then(Value::as_str)
        .expect("token")
        .to_string();
    let user_id = claim_body
        .get("user_id")
        .and_then(Value::as_str)
        .expect("user_id")
        .to_string();
    assert!(user_id.starts_with("usr_"));

    let login_response = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/auth/login",
            json!({"login": "alice@example.com", "password": "correct-password"}),
            false,
        ))
        .await
        .unwrap();
    assert_eq!(login_response.status(), StatusCode::OK);
    let login_body = response_json(login_response).await;
    assert_eq!(
        login_body.get("user_id").and_then(Value::as_str),
        Some(user_id.as_str())
    );

    let profile_response = app
        .clone()
        .oneshot(request_with_bearer(
            Method::GET,
            "/v1/users/me",
            Value::Null,
            &token,
            Some("forged-user"),
        ))
        .await
        .unwrap();
    assert_eq!(profile_response.status(), StatusCode::OK);
    let profile = response_json(profile_response).await;
    assert_eq!(
        profile.get("user_id").and_then(Value::as_str),
        Some(user_id.as_str())
    );
    assert_eq!(
        profile.pointer("/auth/kind").and_then(Value::as_str),
        Some("user")
    );

    let service_profile = app
        .clone()
        .oneshot(request_with_bearer(
            Method::GET,
            "/v1/users/me",
            Value::Null,
            "test-key",
            Some("service-user"),
        ))
        .await
        .unwrap();
    assert_eq!(service_profile.status(), StatusCode::OK);
    let service_body = response_json(service_profile).await;
    assert_eq!(
        service_body.get("user_id").and_then(Value::as_str),
        Some("service-user")
    );
    assert_eq!(
        service_body.pointer("/auth/kind").and_then(Value::as_str),
        Some("service")
    );

    let logout_response = app
        .clone()
        .oneshot(request_with_bearer(
            Method::POST,
            "/v1/auth/logout",
            Value::Null,
            &token,
            Some("forged-user"),
        ))
        .await
        .unwrap();
    assert_eq!(logout_response.status(), StatusCode::OK);

    let revoked_response = app
        .oneshot(request_with_bearer(
            Method::GET,
            "/v1/users/me",
            Value::Null,
            &token,
            Some("forged-user"),
        ))
        .await
        .unwrap();
    assert_eq!(revoked_response.status(), StatusCode::UNAUTHORIZED);

    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn router_serves_core_control_plane_routes() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (_state, app) = test_state_and_app(&root);

    let health = app
        .clone()
        .oneshot(request(Method::GET, "/health", Value::Null, false))
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);

    let unauthorized = app
        .clone()
        .oneshot(request(Method::GET, "/v1/models", Value::Null, false))
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let session = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/sessions",
            json!({"model": "codex-test"}),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(session.status(), StatusCode::OK);
    let session_json = response_json(session).await;
    let session_id = session_json
        .get("session_id")
        .and_then(Value::as_str)
        .expect("session id");
    assert!(session_id.starts_with("srv-"));

    let session_tasks = app
        .clone()
        .oneshot(request(
            Method::GET,
            &format!("/v1/sessions/{session_id}/tasks"),
            Value::Null,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(session_tasks.status(), StatusCode::OK);

    let (status, sandbox) = call(app.clone(), Method::GET, "/v1/sandboxes", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        sandbox.get("session_count").and_then(Value::as_u64),
        Some(1)
    );

    let saved = app
        .clone()
        .oneshot(request(
            Method::PUT,
            "/v1/workspace/file",
            json!({"path": "/workspace/notes.txt", "content": "hello rust backend"}),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(saved.status(), StatusCode::OK);

    let search = app
        .clone()
        .oneshot(request(
            Method::GET,
            "/v1/workspace/search?q=hello&scope=content&file_type=text",
            Value::Null,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(search.status(), StatusCode::OK);
    let search_json = response_json(search).await;
    assert_eq!(search_json.get("count").and_then(Value::as_u64), Some(1));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn shared_folder_responses_enforces_request_and_session_scope_before_execution() {
    let root = std::env::temp_dir().join(format!("ripple-shared-response-api-{}", Uuid::new_v4()));
    fs::create_dir_all(root.join("shared-folders/a-folder/nested")).unwrap();
    fs::create_dir_all(root.join("shared-folders/b-folder")).unwrap();
    fs::write(
        root.join("shared-folders/a-folder/nested/report.txt"),
        "shared content",
    )
    .unwrap();
    let (state, app) = test_state_and_app(&root);

    let unknown_field = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/shared-folders/responses",
            json!({
                "req_id": "req-unknown",
                "session_id": "shared-unknown",
                "shared_folder": "a-folder",
                "input": "summarize",
                "stream": true
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(unknown_field.status(), StatusCode::BAD_REQUEST);

    let missing_folder = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/shared-folders/responses",
            json!({
                "req_id": "req-missing",
                "session_id": "shared-missing",
                "shared_folder": "missing-folder",
                "input": "summarize"
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(missing_folder.status(), StatusCode::NOT_FOUND);

    state
        .sessions
        .create_session_with_id(
            "smoke-user",
            CreateSessionInput {
                model: None,
                max_turns: None,
                system_prompt: None,
                context_folder_path: None,
            },
            Some("workspace-session"),
        )
        .await
        .unwrap();
    let workspace_session = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/shared-folders/responses",
            json!({
                "req_id": "req-workspace",
                "session_id": "workspace-session",
                "shared_folder": "a-folder",
                "input": "summarize"
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(workspace_session.status(), StatusCode::CONFLICT);

    state
        .sessions
        .create_shared_folder_session_with_id("smoke-user", "shared-bound-a", "a-folder", None)
        .await
        .unwrap();
    let changed_folder = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/shared-folders/responses",
            json!({
                "req_id": "req-folder-change",
                "session_id": "shared-bound-a",
                "shared_folder": "b-folder",
                "input": "summarize"
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(changed_folder.status(), StatusCode::CONFLICT);

    let (workspace_response_status, _) = call_response(
        app,
        json!({
            "session_id": "shared-bound-a",
            "messages": [{"role": "user", "content": "use workspace mode"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(workspace_response_status, StatusCode::CONFLICT);

    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn shared_folder_responses_streams_and_persists_bound_codex_thread() {
    let root =
        std::env::temp_dir().join(format!("ripple-shared-response-stream-{}", Uuid::new_v4()));
    fs::create_dir_all(root.join("shared-folders/a-folder/nested")).unwrap();
    fs::write(
        root.join("shared-folders/a-folder/nested/report.txt"),
        "shared content",
    )
    .unwrap();
    seed_shared_file_parser_env(&root);
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));

    let response = app
        .oneshot(request(
            Method::POST,
            "/v1/shared-folders/responses",
            json!({
                "req_id": " req-shared-1 ",
                "session_id": "shared-session-1",
                "shared_folder": "a-folder",
                "input": "summarize recursively",
                "model": "codex-test"
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("text/event-stream")
    );
    assert_eq!(
        response
            .headers()
            .get("x-ripple-req-id")
            .and_then(|value| value.to_str().ok()),
        Some("req-shared-1")
    );
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body = String::from_utf8(body.to_vec()).unwrap();
    assert!(body.contains("event: response.created"), "{body}");
    assert!(body.contains("event: response.completed"), "{body}");
    assert!(body.contains("fake codex completed"), "{body}");
    assert!(body.contains("\"shared_folder\":\"a-folder\""), "{body}");
    assert!(!body.contains(root.to_string_lossy().as_ref()), "{body}");

    let session = state
        .sessions
        .load("smoke-user", "shared-session-1")
        .await
        .unwrap()
        .expect("shared session");
    assert_eq!(session.session_kind, "shared_folder");
    assert_eq!(session.shared_folder_id.as_deref(), Some("a-folder"));
    assert_eq!(session.codex_thread_id.as_deref(), Some("thread-1"));
    assert_eq!(session.status, "idle");
    assert_eq!(session.message_count, 2);

    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn openapi_docs_are_public_and_keep_v1_auth_unchanged() {
    let root = std::env::temp_dir().join(format!("ripple-openapi-docs-{}", Uuid::new_v4()));
    let (_state, app) = test_state_and_app(&root);

    let openapi = app
        .clone()
        .oneshot(request(Method::GET, "/openapi.json", Value::Null, false))
        .await
        .unwrap();
    assert_eq!(openapi.status(), StatusCode::OK);
    let spec = response_json(openapi).await;
    assert_eq!(spec.get("openapi").and_then(Value::as_str), Some("3.1.0"));
    assert_eq!(
        spec.pointer("/info/title").and_then(Value::as_str),
        Some("Ripple Server API")
    );
    let documented_operations = [
        ("/health", "get"),
        ("/v1/bilibili/qrcode.png", "get"),
        ("/v1/sandboxes/gogcli/oauth/callback", "get"),
        ("/v1/auth/config", "get"),
        ("/v1/auth/invite/claim", "post"),
        ("/v1/auth/login", "post"),
        ("/v1/auth/logout", "post"),
        ("/v1/auth/password", "post"),
        ("/v1/models", "get"),
        ("/v1/runtime/codex", "get"),
        ("/v1/info", "get"),
        ("/v1/responses", "post"),
        ("/v1/shared-folders/responses", "post"),
        ("/v1/health/ready", "get"),
        ("/v1/diagnostics/doctor", "get"),
        ("/v1/users/me", "get"),
        ("/v1/users/me/profile", "patch"),
        ("/v1/users/me/avatar", "post"),
        ("/v1/users/me/avatar", "delete"),
        ("/v1/users/me/avatar/{file_name}", "get"),
        ("/v1/sessions", "get"),
        ("/v1/sessions", "post"),
        ("/v1/sessions/overview", "get"),
        ("/v1/sessions/suspended", "get"),
        ("/v1/sessions/{session_id}", "get"),
        ("/v1/sessions/{session_id}", "patch"),
        ("/v1/sessions/{session_id}", "delete"),
        ("/v1/sessions/{session_id}/tasks", "get"),
        ("/v1/sessions/{session_id}/stop", "post"),
        ("/v1/sessions/{session_id}/context/clear", "post"),
        ("/v1/sessions/{session_id}/context/compact", "post"),
        ("/v1/sessions/{session_id}/codex-thread", "get"),
        ("/v1/sessions/{session_id}/suspend", "post"),
        ("/v1/sessions/{session_id}/resume", "post"),
        ("/v1/sessions/{session_id}/permissions/resolve", "post"),
        ("/v1/sessions/{session_id}/user-input/resolve", "post"),
        ("/v1/sessions/{session_id}/connector-auth/poll", "post"),
        ("/v1/sessions/{session_id}/connector-auth/cancel", "post"),
        ("/v1/sessions/{session_id}/usage", "get"),
        ("/v1/task-sessions/responses", "post"),
        ("/v1/sandboxes", "get"),
        ("/v1/sandboxes", "post"),
        ("/v1/sandboxes", "delete"),
        ("/v1/sandbox/info", "get"),
        ("/v1/workspace", "get"),
        ("/v1/workspace/search", "get"),
        ("/v1/workspace/file", "get"),
        ("/v1/workspace/file", "put"),
        ("/v1/workspace/rename", "post"),
        ("/v1/workspace/delete", "post"),
        ("/v1/workspace/create", "post"),
        ("/v1/workspace/paste", "post"),
        ("/v1/workspace/upload", "post"),
        ("/v1/workspace/attachments", "post"),
        ("/v1/workspace/download", "get"),
        ("/v1/workspace/preview", "get"),
        ("/v1/capabilities", "get"),
        ("/v1/skills", "get"),
        ("/v1/skills", "post"),
        ("/v1/skills/{skill_id}", "get"),
        ("/v1/skills/{skill_id}", "patch"),
        ("/v1/skills/{skill_id}", "delete"),
        ("/v1/skills/{skill_id}/validate", "post"),
        ("/v1/connectors", "get"),
        ("/v1/connectors/{connector_name}/status", "get"),
        ("/v1/connectors/{connector_name}/auth/start", "post"),
        ("/v1/connectors/{connector_name}/auth/complete", "post"),
        ("/v1/connectors/{connector_name}/auth/cancel", "post"),
        ("/v1/connectors/{connector_name}/disconnect", "post"),
        ("/v1/connectors/{connector_name}/accounts", "get"),
        ("/v1/sandboxes/gogcli-accounts", "get"),
        ("/v1/runs", "get"),
        ("/v1/runs", "post"),
        ("/v1/runs/{job_id}", "get"),
        ("/v1/runs/{job_id}/events", "get"),
        ("/v1/runs/{job_id}/output", "get"),
        ("/v1/runs/{job_id}/steer", "post"),
        ("/v1/runs/{job_id}/cancel", "post"),
        ("/v1/documents", "get"),
        ("/v1/documents", "post"),
        ("/v1/documents/{document_id}", "get"),
        ("/v1/documents/{document_id}", "patch"),
        ("/v1/documents/{document_id}", "delete"),
    ];
    for (path, method) in documented_operations {
        let pointer = openapi_operation_pointer(path, method);
        assert!(
            spec.pointer(&pointer).is_some(),
            "missing OpenAPI operation {method} {path}"
        );
    }
    assert!(spec
        .pointer("/paths/~1v1~1chat~1completions/post")
        .is_none());
    assert!(spec.pointer("/paths/~1v1~1tasks/get").is_none());
    assert!(spec.pointer("/paths/~1v1~1tasks/post").is_none());
    assert!(spec.pointer("/paths/~1v1~1task-triggers/get").is_none());
    assert!(spec.pointer("/paths/~1v1~1runs/get").is_some());
    assert!(spec.pointer("/paths/~1v1~1runs/post").is_some());
    assert!(spec
        .pointer("/paths/~1v1~1runs~1{job_id}~1events/get")
        .is_some());
    assert!(spec
        .pointer("/paths/~1v1~1sessions~1{session_id}~1connector-auth~1poll/post")
        .is_some());
    assert!(spec
        .pointer("/paths/~1v1~1sessions~1{session_id}~1connector-auth~1cancel/post")
        .is_some());
    assert!(spec
        .pointer("/components/securitySchemes/bearerAuth")
        .is_some());
    assert!(spec
        .pointer("/components/securitySchemes/apiKeyAuth")
        .is_some());
    assert!(spec
        .pointer("/components/schemas/ResponsesCreateRequest/properties/text")
        .is_some());
    assert!(spec
        .pointer("/components/schemas/TaskSessionResponsesCreateRequest/properties/input")
        .is_some());
    assert!(spec
        .pointer("/components/schemas/TaskSessionResponsesCreateRequest/properties/task_id")
        .is_some());
    assert!(spec
        .pointer(
            "/components/schemas/TaskSessionResponsesCreateRequest/properties/context_folder_path"
        )
        .is_some());
    assert!(spec
        .pointer("/components/schemas/TaskSessionResponsesCreateRequest/properties/task_session_id")
        .is_none());
    assert!(spec
        .pointer("/components/schemas/TaskSessionResponsesCreateRequest/properties/stream")
        .is_none());
    assert!(spec
        .pointer(
            "/paths/~1v1~1task-sessions~1responses/post/responses/200/content/text~1event-stream"
        )
        .is_some());
    assert!(spec
        .pointer(
            "/paths/~1v1~1task-sessions~1responses/post/responses/200/content/application~1json"
        )
        .is_none());

    let docs = app
        .clone()
        .oneshot(request(Method::GET, "/docs", Value::Null, false))
        .await
        .unwrap();
    assert_eq!(docs.status(), StatusCode::SEE_OTHER);
    assert_eq!(
        docs.headers()
            .get(header::LOCATION)
            .and_then(|value| value.to_str().ok()),
        Some("/docs/")
    );

    let docs = app
        .clone()
        .oneshot(request(Method::GET, "/docs/", Value::Null, false))
        .await
        .unwrap();
    assert_eq!(docs.status(), StatusCode::OK);
    let docs_html = response_text(docs).await;
    assert!(docs_html.contains("Swagger UI"));

    let bundle = app
        .clone()
        .oneshot(request(
            Method::GET,
            "/docs/swagger-ui-bundle.js",
            Value::Null,
            false,
        ))
        .await
        .unwrap();
    assert_eq!(bundle.status(), StatusCode::OK);

    let initializer = app
        .clone()
        .oneshot(request(
            Method::GET,
            "/docs/swagger-initializer.js",
            Value::Null,
            false,
        ))
        .await
        .unwrap();
    assert_eq!(initializer.status(), StatusCode::OK);
    let initializer_js = response_text(initializer).await;
    assert!(initializer_js.contains("/openapi.json"));

    let unauthorized_v1 = app
        .clone()
        .oneshot(request(Method::GET, "/v1/models", Value::Null, false))
        .await
        .unwrap();
    assert_eq!(unauthorized_v1.status(), StatusCode::UNAUTHORIZED);

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn readiness_returns_503_when_required_check_fails() {
    let root = std::env::temp_dir().join(format!("ripple-ready-fails-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let blocked_sandbox_root = root.join("sandboxes-file");
    fs::write(&blocked_sandbox_root, "not a directory").unwrap();
    let mut config = test_config(&root);
    config.sandbox.sandboxes_root = blocked_sandbox_root;
    let (_state, app) = test_state_and_app_with_config(config);

    let response = app
        .oneshot(request(Method::GET, "/v1/health/ready", Value::Null, true))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = response_json(response).await;
    assert_eq!(
        body.get("status").and_then(Value::as_str),
        Some("not_ready")
    );
    assert_eq!(
        body.pointer("/checks/sandboxes_root/status")
            .and_then(Value::as_str),
        Some("fail")
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn connector_unsupported_operation_uses_method_not_allowed_code() {
    let root = std::env::temp_dir().join(format!("ripple-connector-405-{}", Uuid::new_v4()));
    let (_state, app) = test_state_and_app(&root);

    let (status, body) = call(
        app,
        Method::POST,
        "/v1/connectors/notion/auth/complete",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED, "{body}");
    assert_eq!(
        body.pointer("/error/code").and_then(Value::as_str),
        Some("method_not_allowed"),
        "{body}"
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn skills_and_capabilities_redact_shared_skill_host_paths() {
    let root = std::env::temp_dir().join(format!("ripple-shared-skill-paths-{}", Uuid::new_v4()));
    let shared_root = root.join("shared-skills-root");
    let shared_skill = shared_root.join("shared-demo/SKILL.md");
    fs::create_dir_all(shared_skill.parent().unwrap()).unwrap();
    fs::write(
        &shared_skill,
        "---\nname: shared-demo\ndescription: Shared demo\n---\n# Shared demo\n",
    )
    .unwrap();
    let mut config = test_config(&root);
    config.skills.shared_dirs = vec![shared_root.to_string_lossy().to_string()];
    let (_state, app) = test_state_and_app_with_config(config);

    let (status, skills) = call(app.clone(), Method::GET, "/v1/skills", Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{skills}");
    let skill = skills
        .get("skills")
        .and_then(Value::as_array)
        .and_then(|skills| {
            skills
                .iter()
                .find(|skill| skill.get("id").and_then(Value::as_str) == Some("ripple:shared-demo"))
        })
        .expect("shared skill");
    let skill_path = skill.get("path").and_then(Value::as_str).expect("path");
    assert!(
        skill_path.starts_with("/shared-skills/"),
        "shared skill path should be virtual: {skill_path}"
    );
    assert!(
        !skill_path.contains(shared_root.to_string_lossy().as_ref()),
        "shared skill path leaked host path: {skill_path}"
    );

    let (status, capabilities) = call(app, Method::GET, "/v1/capabilities", Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{capabilities}");
    let capability = capabilities
        .get("capabilities")
        .and_then(Value::as_array)
        .and_then(|capabilities| {
            capabilities.iter().find(|capability| {
                capability.get("id").and_then(Value::as_str) == Some("ripple:shared-demo")
            })
        })
        .expect("shared skill capability");
    let capability_path = capability
        .pointer("/skill/path")
        .and_then(Value::as_str)
        .expect("capability skill path");
    assert!(
        capability_path.starts_with("/shared-skills/"),
        "shared capability path should be virtual: {capability_path}"
    );
    assert!(
        !capability_path.contains(shared_root.to_string_lossy().as_ref()),
        "shared capability path leaked host path: {capability_path}"
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn openapi_docs_can_be_disabled() {
    let root = std::env::temp_dir().join(format!("ripple-openapi-disabled-{}", Uuid::new_v4()));
    let mut config = test_config(&root);
    config.api_docs.enabled = false;
    let (_state, app) = test_state_and_app_with_config(config);

    let openapi = app
        .clone()
        .oneshot(request(Method::GET, "/openapi.json", Value::Null, false))
        .await
        .unwrap();
    assert_eq!(openapi.status(), StatusCode::NOT_FOUND);

    let docs = app
        .oneshot(request(Method::GET, "/docs", Value::Null, false))
        .await
        .unwrap();
    assert_eq!(docs.status(), StatusCode::NOT_FOUND);

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn sessions_accept_update_and_clear_context_folder_path() {
    let root = std::env::temp_dir().join(format!("ripple-api-context-folder-{}", Uuid::new_v4()));
    let (state, app) = test_state_and_app(&root);
    let workspace = state.sandboxes.ensure_sandbox("smoke-user").unwrap();
    fs::create_dir_all(workspace.join("demo")).unwrap();
    fs::create_dir_all(workspace.join("other")).unwrap();
    fs::write(workspace.join("notes.txt"), "not a folder").unwrap();

    let (status, invalid_file) = call(
        app.clone(),
        Method::POST,
        "/v1/sessions",
        json!({"model": "codex-test", "context_folder_path": "/workspace/notes.txt"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{invalid_file}");

    let (status, invalid_outside) = call(
        app.clone(),
        Method::POST,
        "/v1/sessions",
        json!({"model": "codex-test", "context_folder_path": "/tmp/outside"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{invalid_outside}");

    let (status, session) = call(
        app.clone(),
        Method::POST,
        "/v1/sessions",
        json!({"model": "codex-test", "context_folder_path": "/workspace/demo"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{session}");
    assert_eq!(
        session.get("context_folder_path").and_then(Value::as_str),
        Some("/workspace/demo")
    );
    assert!(
        session.get("project_id").is_none(),
        "session response should not expose legacy project_id: {session}"
    );
    assert!(
        session.get("project_name").is_none(),
        "session response should not expose legacy project_name: {session}"
    );
    assert!(
        session.get("project_root").is_none(),
        "session response should not expose legacy project_root: {session}"
    );
    let session_id = session
        .get("session_id")
        .and_then(Value::as_str)
        .expect("session id")
        .to_string();

    let (status, updated) = call(
        app.clone(),
        Method::PATCH,
        &format!("/v1/sessions/{session_id}"),
        json!({"context_folder_path": "/workspace/other"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(
        updated.get("context_folder_path").and_then(Value::as_str),
        Some("/workspace/other")
    );

    let (status, title_only) = call(
        app.clone(),
        Method::PATCH,
        &format!("/v1/sessions/{session_id}"),
        json!({"title": "Renamed context session"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{title_only}");
    assert_eq!(
        title_only
            .get("context_folder_path")
            .and_then(Value::as_str),
        Some("/workspace/other")
    );

    let (status, cleared) = call(
        app.clone(),
        Method::PATCH,
        &format!("/v1/sessions/{session_id}"),
        json!({"context_folder_path": null}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert!(cleared
        .get("context_folder_path")
        .is_some_and(Value::is_null));

    let (status, detail) = call(
        app,
        Method::GET,
        &format!("/v1/sessions/{session_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert!(detail
        .get("context_folder_path")
        .is_some_and(Value::is_null));
    assert!(
        detail.get("project_root").is_none(),
        "session detail should not expose legacy project_root: {detail}"
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn session_overview_groups_sessions_and_enriches_linked_runs() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let codex_executable = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, codex_executable));

    let (status, session) = call(
        app.clone(),
        Method::POST,
        "/v1/sessions",
        json!({"model": "codex-test"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let session_id = session
        .get("session_id")
        .and_then(Value::as_str)
        .expect("session id")
        .to_string();

    let mut record = state
        .sessions
        .load("smoke-user", &session_id)
        .await
        .unwrap()
        .expect("session record");
    record.title = "Plan the weekly review".to_string();
    record.pinned = true;
    record.status = "awaiting_user_input".to_string();
    record.pending_question = Some("Send the draft?".to_string());
    record.pending_options = Some(vec!["Send".to_string(), "Revise".to_string()]);
    record.messages = vec![
        json!({"role": "user", "content": "Prepare my weekly review"}),
        json!({"role": "assistant", "content": "I drafted the review and need your confirmation."}),
    ];
    record.plan_steps = vec![
        json!({"id": "step-1", "subject": "Read the notes", "status": "completed"}),
        json!({"id": "step-2", "subject": "Wait for confirmation", "status": "in_progress"}),
    ];
    record.plan_progress = Some(json!({"completed": 1, "total": 2}));
    state.sessions.save_record(record).await.unwrap();

    let workspace_root = state.sandboxes.ensure_sandbox("smoke-user").unwrap();
    let runtime_dir = state
        .sandboxes
        .sandbox_dir("smoke-user")
        .unwrap()
        .join("agent-runs");
    let linked_run = state
        .jobs
        .start(
            AgentRunCreateRequest {
                prompt: "Linked session run".to_string(),
                provider: "codex".to_string(),
                base_instructions: None,
                turn_context: None,
                client_context: None,
                cwd: None,
                input_items: Vec::new(),
                model: Some("codex-test".to_string()),
                effort: None,
                summary: None,
                output_schema: None,
                max_runtime_seconds: 5,
                task_trigger_id: None,
                task_trigger_title: None,
                task_trigger_reason: None,
                codex_thread_id: None,
                codex_persistent_thread: false,
                client_request_id: None,
                chat_user_input: None,
                chat_user_content: None,
                request_base_url: None,
                task_response: false,
            },
            "smoke-user".to_string(),
            Some(session_id.clone()),
            workspace_root.clone(),
            runtime_dir.clone(),
        )
        .await
        .unwrap();
    let standalone_run = state
        .jobs
        .start(
            AgentRunCreateRequest {
                prompt: "Standalone run".to_string(),
                provider: "codex".to_string(),
                base_instructions: None,
                turn_context: None,
                client_context: None,
                cwd: None,
                input_items: Vec::new(),
                model: Some("codex-test".to_string()),
                effort: None,
                summary: None,
                output_schema: None,
                max_runtime_seconds: 5,
                task_trigger_id: None,
                task_trigger_title: None,
                task_trigger_reason: None,
                codex_thread_id: None,
                codex_persistent_thread: false,
                client_request_id: None,
                chat_user_input: None,
                chat_user_content: None,
                request_base_url: None,
                task_response: false,
            },
            "smoke-user".to_string(),
            None,
            workspace_root,
            runtime_dir,
        )
        .await
        .unwrap();

    let (status, overview) = call(
        app.clone(),
        Method::GET,
        "/v1/sessions/overview",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(overview.get("count").and_then(Value::as_u64), Some(1));
    assert_eq!(
        overview
            .pointer("/sessions/0/session_id")
            .and_then(Value::as_str),
        Some(session_id.as_str())
    );
    assert_eq!(
        overview
            .pointer("/sessions/0/pending_kind")
            .and_then(Value::as_str),
        Some("question")
    );
    assert_eq!(
        overview
            .pointer("/sessions/0/current_step")
            .and_then(Value::as_str),
        Some("Wait for confirmation")
    );
    assert_eq!(
        overview
            .pointer("/sessions/0/last_message_preview")
            .and_then(Value::as_str),
        Some("I drafted the review and need your confirmation.")
    );
    assert_eq!(
        overview
            .pointer("/sessions/0/last_run/job_id")
            .and_then(Value::as_str),
        Some(linked_run.job_id.as_str())
    );
    assert_ne!(
        overview
            .pointer("/sessions/0/last_run/job_id")
            .and_then(Value::as_str),
        Some(standalone_run.job_id.as_str())
    );
    assert_eq!(
        overview
            .pointer("/sections/needs_input/0")
            .and_then(Value::as_str),
        Some(session_id.as_str())
    );
    assert_eq!(
        overview
            .pointer("/sections/pinned/0")
            .and_then(Value::as_str),
        Some(session_id.as_str())
    );
    assert_eq!(
        overview
            .pointer("/sections/recent_sessions/0")
            .and_then(Value::as_str),
        Some(session_id.as_str())
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn session_overview_respects_user_id_isolation() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (state, app) = test_state_and_app(&root);

    let first = app
        .clone()
        .oneshot(request_as_user(
            Method::POST,
            "/v1/sessions",
            json!({"model": "codex-test"}),
            "alice",
        ))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let first = response_json(first).await;
    let alice_session_id = first
        .get("session_id")
        .and_then(Value::as_str)
        .expect("alice session")
        .to_string();

    let second = app
        .clone()
        .oneshot(request_as_user(
            Method::POST,
            "/v1/sessions",
            json!({"model": "codex-test"}),
            "bob",
        ))
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::OK);
    let second = response_json(second).await;
    let bob_session_id = second
        .get("session_id")
        .and_then(Value::as_str)
        .expect("bob session")
        .to_string();

    let response = app
        .clone()
        .oneshot(request_as_user(
            Method::GET,
            "/v1/sessions/overview",
            Value::Null,
            "alice",
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let overview = response_json(response).await;
    let ids = overview
        .get("sessions")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .filter_map(|session| session.get("session_id").and_then(Value::as_str))
        .collect::<Vec<_>>();
    assert!(ids.is_empty());

    let mut alice_session = state
        .sessions
        .load("alice", &alice_session_id)
        .await
        .unwrap()
        .expect("alice session should exist");
    alice_session.messages.push(json!({
        "role": "user",
        "content": "hello"
    }));
    state.sessions.save_record(alice_session).await.unwrap();

    let response = app
        .oneshot(request_as_user(
            Method::GET,
            "/v1/sessions/overview",
            Value::Null,
            "alice",
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let overview = response_json(response).await;
    let ids = overview
        .get("sessions")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .filter_map(|session| session.get("session_id").and_then(Value::as_str))
        .collect::<Vec<_>>();
    assert_eq!(ids, vec![alice_session_id.as_str()]);
    assert!(!ids.contains(&bob_session_id.as_str()));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn maturity_contract_routes_report_limits_security_and_diagnostics() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (_state, app) = test_state_and_app(&root);

    let (status, profile) = call(app.clone(), Method::GET, "/v1/users/me", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        profile
            .pointer("/limits/max_workspace_bytes")
            .and_then(Value::as_u64),
        Some(2048 * 1024 * 1024)
    );
    assert_eq!(
        profile
            .pointer("/limits/max_sessions")
            .and_then(Value::as_u64),
        Some(200)
    );
    assert_eq!(
        profile
            .pointer("/limits/max_runs_per_day")
            .and_then(Value::as_u64),
        Some(200)
    );

    let (status, sandbox) = call(app.clone(), Method::GET, "/v1/sandbox/info", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        sandbox.get("deployment_mode").and_then(Value::as_str),
        Some("trusted-proxy")
    );
    assert_eq!(
        sandbox
            .pointer("/execution/codex/runtime_boundary")
            .and_then(Value::as_str),
        Some("managed_permissions")
    );
    assert_eq!(
        sandbox
            .pointer("/execution/connectors/runtime_boundary")
            .and_then(Value::as_str),
        Some("nsjail")
    );
    assert_eq!(sandbox.get("mode").and_then(Value::as_str), None);

    let (status, ready) = call(app.clone(), Method::GET, "/v1/health/ready", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert!(ready.pointer("/checks/sqlite/status").is_some());
    assert!(ready.pointer("/checks/sandboxes_root/status").is_some());

    let (status, doctor) = call(app, Method::GET, "/v1/diagnostics/doctor", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        doctor.get("deployment_mode").and_then(Value::as_str),
        Some("trusted-proxy")
    );
    assert!(doctor
        .get("checks")
        .and_then(Value::as_array)
        .is_some_and(|checks| checks.iter().any(|check| {
            check.get("name").and_then(Value::as_str) == Some("config.security")
        })));
    assert!(doctor
        .get("checks")
        .and_then(Value::as_array)
        .is_some_and(|checks| checks.iter().any(|check| {
            check.get("name").and_then(Value::as_str) == Some("codex_app_server_runtime")
        })));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn api_errors_keep_detail_and_include_structured_error_envelope() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (_state, app) = test_state_and_app(&root);

    let response = app
        .oneshot(request(Method::GET, "/v1/models", Value::Null, false))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = response_json(response).await;

    assert_eq!(
        body.get("detail").and_then(Value::as_str),
        Some("Invalid or missing API key")
    );
    assert_eq!(
        body.pointer("/error/code").and_then(Value::as_str),
        Some("unauthorized")
    );
    assert_eq!(
        body.pointer("/error/message").and_then(Value::as_str),
        Some("Invalid or missing API key")
    );
    assert!(body
        .pointer("/error/request_id")
        .and_then(Value::as_str)
        .is_some());
    assert_eq!(
        body.pointer("/error/details").and_then(Value::as_str),
        Some("Invalid or missing API key")
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn project_routes_are_removed_from_the_public_api() {
    let root = std::env::temp_dir().join(format!("ripple-api-projects-{}", Uuid::new_v4()));
    let (_state, app) = test_state_and_app(&root);

    let (status, listed) = call(app.clone(), Method::GET, "/v1/projects", Value::Null).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{listed}");

    let (status, created) = call(
        app,
        Method::POST,
        "/v1/projects",
        json!({"name": "Demo", "root_path": "/workspace/demo"}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{created}");

    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn workspace_routes_cover_web_upload_attachment_rename_and_download() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (_state, app) = test_state_and_app(&root);

    let boundary = "ripple-upload-boundary";
    let upload_body = format!(
        "--{boundary}\r\n\
Content-Disposition: form-data; name=\"path\"\r\n\r\n\
/workspace\r\n\
--{boundary}\r\n\
Content-Disposition: form-data; name=\"files\"; filename=\"hello.txt\"\r\n\
Content-Type: text/plain\r\n\r\n\
hello upload\r\n\
--{boundary}--\r\n"
    )
    .into_bytes();
    let response = app
        .clone()
        .oneshot(multipart_request(
            "/v1/workspace/upload",
            boundary,
            upload_body.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let uploaded = response_json(response).await;
    assert_eq!(
        uploaded.pointer("/entries/0/path").and_then(Value::as_str),
        Some("/workspace/hello.txt")
    );

    let response = app
        .clone()
        .oneshot(multipart_request(
            "/v1/workspace/upload",
            boundary,
            upload_body.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let conflict = response_json(response).await;
    assert_eq!(
        conflict.pointer("/detail/code").and_then(Value::as_str),
        Some("workspace_upload_conflict")
    );

    let overwrite_body = format!(
        "--{boundary}\r\n\
Content-Disposition: form-data; name=\"path\"\r\n\r\n\
/workspace\r\n\
--{boundary}\r\n\
Content-Disposition: form-data; name=\"overwrite\"\r\n\r\n\
true\r\n\
--{boundary}\r\n\
Content-Disposition: form-data; name=\"files\"; filename=\"hello.txt\"\r\n\
Content-Type: text/plain\r\n\r\n\
hello overwrite\r\n\
--{boundary}--\r\n"
    )
    .into_bytes();
    let response = app
        .clone()
        .oneshot(multipart_request(
            "/v1/workspace/upload",
            boundary,
            overwrite_body,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let (status, preview) = call(
        app.clone(),
        Method::GET,
        "/v1/workspace/file?path=%2Fworkspace%2Fhello.txt",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        preview.get("content").and_then(Value::as_str),
        Some("hello overwrite")
    );

    let (status, renamed) = call(
        app.clone(),
        Method::POST,
        "/v1/workspace/rename",
        json!({"path": "/workspace/hello.txt", "name": "renamed.txt"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        renamed.get("path").and_then(Value::as_str),
        Some("/workspace/renamed.txt")
    );

    let response = app
        .clone()
        .oneshot(request(
            Method::GET,
            "/v1/workspace/download?path=%2Fworkspace%2Frenamed.txt",
            Value::Null,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response
        .headers()
        .get("content-disposition")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("renamed.txt")));
    let etag = response
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .expect("workspace download should expose an etag")
        .to_string();
    assert_eq!(
        response
            .headers()
            .get("cache-control")
            .and_then(|value| value.to_str().ok()),
        Some("private, no-cache")
    );
    assert_eq!(response_bytes(response).await, b"hello overwrite");

    let conditional = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/v1/workspace/download?path=%2Fworkspace%2Frenamed.txt")
                .header("authorization", "Bearer test-key")
                .header("x-ripple-user-id", "smoke-user")
                .header("if-none-match", etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(conditional.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(response_bytes(conditional).await, b"");

    let attachment_boundary = "ripple-attachment-boundary";
    let attachment_body = format!(
        "--{attachment_boundary}\r\n\
Content-Disposition: form-data; name=\"kind\"\r\n\r\n\
image\r\n\
--{attachment_boundary}\r\n\
Content-Disposition: form-data; name=\"file\"; filename=\"pixel.png\"\r\n\
Content-Type: image/png\r\n\r\n"
    )
    .into_bytes()
    .into_iter()
    .chain(vec![137, 80, 78, 71])
    .chain(format!("\r\n--{attachment_boundary}--\r\n").into_bytes())
    .collect::<Vec<u8>>();
    let response = app
        .oneshot(multipart_request(
            "/v1/workspace/attachments",
            attachment_boundary,
            attachment_body,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let attachment = response_json(response).await;
    assert_eq!(
        attachment.get("kind").and_then(Value::as_str),
        Some("image")
    );
    assert_eq!(
        attachment.get("mime_type").and_then(Value::as_str),
        Some("image/png")
    );
    assert!(attachment
        .get("path")
        .and_then(Value::as_str)
        .is_some_and(|path| path.starts_with("/workspace/uploads/")));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn workspace_preview_streams_pdf_inline_without_office_converter() {
    let root = std::env::temp_dir().join(format!("ripple-api-preview-{}", Uuid::new_v4()));
    let (state, app) = test_state_and_app(&root);
    let workspace = state.sandboxes.ensure_sandbox("smoke-user").unwrap();
    fs::write(workspace.join("report.pdf"), b"%PDF direct preview").unwrap();

    let response = app
        .oneshot(request(
            Method::GET,
            "/v1/workspace/preview?path=%2Fworkspace%2Freport.pdf",
            Value::Null,
            true,
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("application/pdf")
    );
    assert!(response
        .headers()
        .get("content-disposition")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("inline;") && value.contains("report.pdf")));
    assert_eq!(response_bytes(response).await, b"%PDF direct preview");

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn workspace_preview_converts_office_documents_to_cached_pdf() {
    let root = std::env::temp_dir().join(format!("ripple-api-preview-{}", Uuid::new_v4()));
    let (state, app) = test_state_and_app_with_config(test_config_with_fake_libreoffice(&root));
    let workspace = state.sandboxes.ensure_sandbox("smoke-user").unwrap();
    fs::write(workspace.join("report.docx"), b"fake docx bytes").unwrap();

    for _ in 0..2 {
        let response = app
            .clone()
            .oneshot(request(
                Method::GET,
                "/v1/workspace/preview?path=%2Fworkspace%2Freport.docx",
                Value::Null,
                true,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get("content-type")
                .and_then(|value| value.to_str().ok()),
            Some("application/pdf")
        );
        assert!(response
            .headers()
            .get("content-disposition")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("inline;") && value.contains("report.pdf")));
        assert_eq!(response_bytes(response).await, b"%PDF fake office preview");
    }

    let log = fs::read_to_string(root.join("fake-soffice.log")).unwrap();
    assert_eq!(
        log.lines().count(),
        1,
        "second preview should reuse cached PDF"
    );
    assert!(root
        .join("cache/previews/smoke-user")
        .read_dir()
        .unwrap()
        .any(|entry| entry.unwrap().path().join("preview.pdf").is_file()));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn workspace_attachment_upload_accepts_common_phone_photo_size() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (_state, app) = test_state_and_app(&root);

    let boundary = "ripple-large-attachment-boundary";
    let mut body = format!(
        "--{boundary}\r\n\
Content-Disposition: form-data; name=\"kind\"\r\n\r\n\
image\r\n\
--{boundary}\r\n\
Content-Disposition: form-data; name=\"file\"; filename=\"phone-photo.jpg\"\r\n\
Content-Type: image/jpeg\r\n\r\n"
    )
    .into_bytes();
    body.extend(vec![0x42; 3 * 1024 * 1024]);
    body.extend(format!("\r\n--{boundary}--\r\n").into_bytes());

    let response = app
        .oneshot(multipart_request(
            "/v1/workspace/attachments",
            boundary,
            body,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let attachment = response_json(response).await;
    assert_eq!(
        attachment.get("size").and_then(Value::as_u64),
        Some(3 * 1024 * 1024)
    );

    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn workspace_attachment_upload_rejects_symlinked_uploads_directory() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (state, app) = test_state_and_app(&root);
    let workspace = state.sandboxes.ensure_sandbox("smoke-user").unwrap();
    let outside = root.join("outside-uploads");
    fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, workspace.join("uploads")).unwrap();

    let boundary = "ripple-symlink-attachment-boundary";
    let body = format!(
        "--{boundary}\r\n\
Content-Disposition: form-data; name=\"kind\"\r\n\r\n\
image\r\n\
--{boundary}\r\n\
Content-Disposition: form-data; name=\"file\"; filename=\"escape.jpg\"\r\n\
Content-Type: image/jpeg\r\n\r\n\
small image\r\n\
--{boundary}--\r\n"
    )
    .into_bytes();

    let response = app
        .oneshot(multipart_request(
            "/v1/workspace/attachments",
            boundary,
            body,
        ))
        .await
        .unwrap();
    assert!(
        matches!(
            response.status(),
            StatusCode::BAD_REQUEST | StatusCode::FORBIDDEN
        ),
        "unexpected status {}",
        response.status()
    );
    let body = response_json(response).await;
    assert!(
        body.to_string().contains("Access denied")
            || body.to_string().contains("symlink")
            || body.to_string().contains("Invalid"),
        "{body}"
    );
    assert!(outside.read_dir().unwrap().next().is_none());

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn list_sessions_rejects_invalid_cursor() {
    let root = std::env::temp_dir().join(format!("ripple-invalid-cursor-{}", Uuid::new_v4()));
    let (_state, app) = test_state_and_app(&root);

    let (status, body) = call(
        app,
        Method::GET,
        "/v1/sessions?cursor=not-a-number",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(
        body.pointer("/error/code").and_then(Value::as_str),
        Some("bad_request"),
        "{body}"
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn documents_can_clear_linked_session_id_and_paginate() {
    let root = std::env::temp_dir().join(format!("ripple-documents-page-{}", Uuid::new_v4()));
    let (state, app) = test_state_and_app(&root);
    let workspace = state.sandboxes.ensure_sandbox("smoke-user").unwrap();
    fs::write(workspace.join("a.md"), "# A").unwrap();
    fs::write(workspace.join("b.md"), "# B").unwrap();
    fs::write(workspace.join("c.md"), "# C").unwrap();

    let (status, session) = call(
        app.clone(),
        Method::POST,
        "/v1/sessions",
        json!({"model": "codex-test"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{session}");
    let session_id = session
        .get("session_id")
        .and_then(Value::as_str)
        .expect("session id");

    let mut created_ids = Vec::new();
    for (title, path) in [
        ("Doc A", "/workspace/a.md"),
        ("Doc B", "/workspace/b.md"),
        ("Doc C", "/workspace/c.md"),
    ] {
        let (status, doc) = call(
            app.clone(),
            Method::POST,
            "/v1/documents",
            json!({
                "title": title,
                "path": path,
                "linked_session_id": session_id,
                "summary": title
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{doc}");
        created_ids.push(
            doc.get("document_id")
                .and_then(Value::as_str)
                .expect("document id")
                .to_string(),
        );
    }

    let (status, updated) = call(
        app.clone(),
        Method::PATCH,
        &format!("/v1/documents/{}", created_ids[0]),
        json!({"linked_session_id": null}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert!(updated
        .get("linked_session_id")
        .map_or(true, Value::is_null));

    let (status, page) = call(app, Method::GET, "/v1/documents?limit=2", Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page.get("count").and_then(Value::as_u64), Some(2), "{page}");
    assert_eq!(page.get("total").and_then(Value::as_u64), Some(3), "{page}");
    assert!(
        page.get("next_cursor").and_then(Value::as_str).is_some(),
        "{page}"
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn workspace_search_rejects_invalid_filters() {
    let root = std::env::temp_dir().join(format!("ripple-search-filter-{}", Uuid::new_v4()));
    let (state, app) = test_state_and_app(&root);
    let workspace = state.sandboxes.ensure_sandbox("smoke-user").unwrap();
    fs::write(workspace.join("hello.txt"), "hello").unwrap();

    let (status, body) = call(
        app,
        Method::GET,
        "/v1/workspace/search?q=hello&scope=sideways",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn workspace_quota_serializes_concurrent_saves() {
    let root = std::env::temp_dir().join(format!("ripple-quota-concurrent-{}", Uuid::new_v4()));
    let mut config = test_config(&root);
    config.sandbox.max_workspace_mb = 1;
    let (state, app) = test_state_and_app_with_config(config);
    state.sandboxes.ensure_sandbox("smoke-user").unwrap();
    let content = "x".repeat(700 * 1024);

    let first_app = app.clone();
    let first_content = content.clone();
    let first = tokio::spawn(async move {
        call(
            first_app,
            Method::PUT,
            "/v1/workspace/file",
            json!({"path": "/workspace/a.txt", "content": first_content}),
        )
        .await
    });
    let second = tokio::spawn(async move {
        call(
            app,
            Method::PUT,
            "/v1/workspace/file",
            json!({"path": "/workspace/b.txt", "content": content}),
        )
        .await
    });

    let (first, second) = tokio::join!(first, second);
    let results = [first.unwrap(), second.unwrap()];
    let success_count = results
        .iter()
        .filter(|(status, _)| *status == StatusCode::OK)
        .count();
    let quota_count = results
        .iter()
        .filter(|(status, body)| {
            *status == StatusCode::FORBIDDEN
                && body.pointer("/error/code").and_then(Value::as_str) == Some("quota_exceeded")
        })
        .count();
    assert_eq!(success_count, 1, "{results:?}");
    assert_eq!(quota_count, 1, "{results:?}");

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn router_serves_session_lifecycle_routes() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (_state, app) = test_state_and_app(&root);

    let (status, session) = call(
        app.clone(),
        Method::POST,
        "/v1/sessions",
        json!({"model": "codex-test"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let session_id = session
        .get("session_id")
        .and_then(Value::as_str)
        .expect("session id")
        .to_string();

    let (status, detail) = call(
        app.clone(),
        Method::GET,
        &format!("/v1/sessions/{session_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        detail.get("session_id").and_then(Value::as_str),
        Some(session_id.as_str())
    );

    let (status, stopped) = call(
        app.clone(),
        Method::POST,
        &format!("/v1/sessions/{session_id}/stop"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stopped.get("stopped").and_then(Value::as_bool), Some(false));

    let (status, suspended) = call(
        app.clone(),
        Method::POST,
        &format!("/v1/sessions/{session_id}/suspend"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        suspended.get("status").and_then(Value::as_str),
        Some("suspended")
    );

    let (status, suspended_list) = call(
        app.clone(),
        Method::GET,
        "/v1/sessions/suspended",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(suspended_list.get("count").and_then(Value::as_u64), Some(1));

    let (status, auto_resumed) = call(
        app.clone(),
        Method::GET,
        &format!("/v1/sessions/{session_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        auto_resumed.get("status").and_then(Value::as_str),
        Some("idle")
    );

    let (status, suspended_list) = call(
        app.clone(),
        Method::GET,
        "/v1/sessions/suspended",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(suspended_list.get("count").and_then(Value::as_u64), Some(0));

    let (status, suspended) = call(
        app.clone(),
        Method::POST,
        &format!("/v1/sessions/{session_id}/suspend"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        suspended.get("status").and_then(Value::as_str),
        Some("suspended")
    );

    let (status, resumed) = call(
        app.clone(),
        Method::POST,
        &format!("/v1/sessions/{session_id}/resume"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(resumed.get("status").and_then(Value::as_str), Some("idle"));

    let (status, cleared) = call(
        app,
        Method::POST,
        &format!("/v1/sessions/{session_id}/context/clear"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        cleared.get("message_count").and_then(Value::as_u64),
        Some(0)
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn session_clear_and_delete_archive_codex_threads() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let user_id = "smoke-user";

    let (status, first) = call(
        app.clone(),
        Method::POST,
        "/v1/sessions",
        json!({"model": "codex-test"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let first_id = first
        .get("session_id")
        .and_then(Value::as_str)
        .expect("session id")
        .to_string();
    let mut first_record = state
        .sessions
        .load(user_id, &first_id)
        .await
        .unwrap()
        .expect("session");
    first_record.codex_thread_id = Some("thread-clear-archive".to_string());
    state.sessions.save_record(first_record).await.unwrap();

    let (status, cleared) = call(
        app.clone(),
        Method::POST,
        &format!("/v1/sessions/{first_id}/context/clear"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert_eq!(
        cleared
            .get("codex_thread_archived")
            .and_then(Value::as_bool),
        Some(true),
        "{cleared}"
    );

    let (status, second) = call(
        app.clone(),
        Method::POST,
        "/v1/sessions",
        json!({"model": "codex-test"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{second}");
    let second_id = second
        .get("session_id")
        .and_then(Value::as_str)
        .expect("session id")
        .to_string();
    let mut second_record = state
        .sessions
        .load(user_id, &second_id)
        .await
        .unwrap()
        .expect("session");
    second_record.codex_thread_id = Some("thread-delete-archive".to_string());
    state.sessions.save_record(second_record).await.unwrap();

    let (status, deleted) = call(
        app,
        Method::DELETE,
        &format!("/v1/sessions/{second_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{deleted}");
    assert_eq!(
        deleted
            .get("codex_thread_archived")
            .and_then(Value::as_bool),
        Some(true),
        "{deleted}"
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn compact_session_context_triggers_codex_thread_compaction() {
    let root = std::env::temp_dir().join(format!("ripple-api-compact-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let config = test_config_with_codex_executable(&root, fake_codex);
    let (state, app) = test_state_and_app_with_config(config);
    let user_id = "smoke-user";
    let mut session = state
        .sessions
        .create_session(
            user_id,
            CreateSessionInput {
                model: None,
                max_turns: None,
                system_prompt: None,
                context_folder_path: None,
            },
        )
        .await
        .unwrap();
    session.codex_thread_id = Some("thread-compact".to_string());
    state.sessions.save_record(session.clone()).await.unwrap();

    let (status, compact) = call(
        app,
        Method::POST,
        &format!("/v1/sessions/{}/context/compact", session.session_id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        compact.get("status").and_then(Value::as_str),
        Some("compacting")
    );
    assert_eq!(
        compact.get("codex_thread_id").and_then(Value::as_str),
        Some("thread-compact")
    );

    for _ in 0..40 {
        let current = state
            .sessions
            .load(user_id, &session.session_id)
            .await
            .unwrap()
            .expect("session should exist");
        if current.status == "idle" {
            assert_eq!(current.codex_thread_id.as_deref(), Some("thread-compact"));
            let _ = std::fs::remove_dir_all(root);
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("session did not finish compacting");
}

#[tokio::test]
async fn session_codex_thread_route_reads_thread_metadata_without_turns() {
    let root = std::env::temp_dir().join(format!("ripple-api-thread-read-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let config = test_config_with_codex_executable(&root, fake_codex);
    let (state, app) = test_state_and_app_with_config(config);
    let user_id = "smoke-user";
    let mut session = state
        .sessions
        .create_session(
            user_id,
            CreateSessionInput {
                model: None,
                max_turns: None,
                system_prompt: None,
                context_folder_path: None,
            },
        )
        .await
        .unwrap();
    session.codex_thread_id = Some("thread-read".to_string());
    state.sessions.save_record(session.clone()).await.unwrap();

    let (status, thread) = call(
        app,
        Method::GET,
        &format!("/v1/sessions/{}/codex-thread", session.session_id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        thread.get("codex_thread_id").and_then(Value::as_str),
        Some("thread-read")
    );
    assert_eq!(
        thread.pointer("/thread/status").and_then(Value::as_str),
        Some("notLoaded")
    );
    assert!(thread.pointer("/thread/turns").is_none());

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn stopping_stale_running_session_clears_running_status() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (state, app) = test_state_and_app(&root);
    let user_id = "smoke-user";
    let mut session = state
        .sessions
        .create_session(
            user_id,
            CreateSessionInput {
                model: Some("codex-test".to_string()),
                max_turns: None,
                system_prompt: None,
                context_folder_path: None,
            },
        )
        .await
        .unwrap();
    session.status = "running".to_string();
    state.sessions.save_record(session.clone()).await.unwrap();

    let (status, stopped) = call(
        app.clone(),
        Method::POST,
        &format!("/v1/sessions/{}/stop", session.session_id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stopped.get("stopped").and_then(Value::as_bool), Some(false));
    assert_eq!(
        stopped.get("status").and_then(Value::as_str),
        Some("cancelled")
    );

    let (status, detail) = call(
        app.clone(),
        Method::GET,
        &format!("/v1/sessions/{}", session.session_id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        detail.get("status").and_then(Value::as_str),
        Some("cancelled")
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn runs_route_completes_with_fake_codex_app_server() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (_state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));

    let (status, created) = call(
        app.clone(),
        Method::POST,
        "/v1/runs",
        json!({
            "prompt": "Say hello from the fake app-server",
            "model": "codex-test",
            "max_runtime_seconds": 5
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let job_id = created
        .get("job_id")
        .and_then(Value::as_str)
        .expect("job id")
        .to_string();

    let mut final_run = None;
    for _ in 0..40 {
        let (status, run) = call(
            app.clone(),
            Method::GET,
            &format!("/v1/runs/{job_id}"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        if run.get("status").and_then(Value::as_str) == Some("completed") {
            final_run = Some(run);
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let final_run = final_run.expect("fake Codex run should complete");
    assert_eq!(
        final_run.get("stdout_tail").and_then(Value::as_str),
        Some("fake codex completed")
    );
    assert_eq!(final_run.get("output_file"), Some(&Value::Null));
    assert_eq!(
        final_run.get("output_available").and_then(Value::as_bool),
        Some(true)
    );

    let response = app
        .clone()
        .oneshot(request(
            Method::GET,
            &format!("/v1/runs/{job_id}/output"),
            Value::Null,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response_text(response).await, "fake codex completed");

    let response = app
        .oneshot(request(
            Method::GET,
            &format!("/v1/runs/{job_id}/events?from_start=true&follow=false"),
            Value::Null,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let events = response_text(response).await;
    assert!(events.contains("\"type\":\"runner.started\""));
    assert!(events.contains("\"event_version\":1"));
    assert!(events.contains("\"type\":\"codex.notification\""));
    assert!(events.contains("\"type\":\"runner.completed\""));
    assert!(events.contains("data: [DONE]"));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn model_fallback_retries_capacity_failure_without_exposing_intermediate_error() {
    let root = std::env::temp_dir().join(format!("ripple-model-fallback-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let mut config = test_config_with_codex_executable(&root, fake_codex);
    config.model_fallback_chain = vec![
        ModelFallback {
            model: "gpt-5.6-luna".to_string(),
            reasoning_effort: Some("low".to_string()),
        },
        ModelFallback {
            model: "gpt-5.6-terra".to_string(),
            reasoning_effort: Some("low".to_string()),
        },
        ModelFallback {
            model: "gpt-5.5".to_string(),
            reasoning_effort: Some("low".to_string()),
        },
    ];
    let (_state, app) = test_state_and_app_with_config(config);

    let (status, created) = call(
        app.clone(),
        Method::POST,
        "/v1/runs",
        json!({
            "prompt": "[model-fallback] finish on terra",
            "model": "gpt-5.6-luna",
            "max_runtime_seconds": 5
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let job_id = created.get("job_id").and_then(Value::as_str).unwrap();
    let final_run = wait_for_completed_run(app.clone(), job_id).await;
    assert_eq!(
        final_run.get("stdout_tail").and_then(Value::as_str),
        Some("fallback completed gpt-5.6-terra")
    );

    let response = app
        .oneshot(request(
            Method::GET,
            &format!("/v1/runs/{job_id}/events?from_start=true&follow=false"),
            Value::Null,
            true,
        ))
        .await
        .unwrap();
    let events = response_text(response).await;
    assert!(!events.contains("codex.model_fallback"));
    assert!(!events.contains("Selected model is at capacity"));
    assert!(!events.contains("systemError"));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn model_fallback_continues_to_last_configured_model() {
    let root = std::env::temp_dir().join(format!("ripple-model-fallback-last-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let mut config = test_config_with_codex_executable(&root, fake_codex);
    config.model_fallback_chain = vec![
        ModelFallback {
            model: "gpt-5.6-luna".to_string(),
            reasoning_effort: Some("low".to_string()),
        },
        ModelFallback {
            model: "gpt-5.6-terra".to_string(),
            reasoning_effort: Some("low".to_string()),
        },
        ModelFallback {
            model: "gpt-5.5".to_string(),
            reasoning_effort: Some("low".to_string()),
        },
    ];
    let (_state, app) = test_state_and_app_with_config(config);

    let (status, created) = call(
        app.clone(),
        Method::POST,
        "/v1/runs",
        json!({
            "prompt": "[model-fallback] [model-fallback-to-5.5] finish last",
            "model": "gpt-5.6-luna",
            "max_runtime_seconds": 5
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let job_id = created.get("job_id").and_then(Value::as_str).unwrap();
    let final_run = wait_for_completed_run(app, job_id).await;
    assert_eq!(
        final_run.get("stdout_tail").and_then(Value::as_str),
        Some("fallback completed gpt-5.5")
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn model_fallback_stops_after_turn_side_effect() {
    let root = std::env::temp_dir().join(format!(
        "ripple-model-fallback-side-effect-{}",
        Uuid::new_v4()
    ));
    let fake_codex = write_fake_codex_app_server(&root);
    let mut config = test_config_with_codex_executable(&root, fake_codex);
    config.model_fallback_chain = vec![
        ModelFallback {
            model: "gpt-5.6-luna".to_string(),
            reasoning_effort: Some("low".to_string()),
        },
        ModelFallback {
            model: "gpt-5.6-terra".to_string(),
            reasoning_effort: Some("low".to_string()),
        },
    ];
    let (_state, app) = test_state_and_app_with_config(config);

    let (status, created) = call(
        app.clone(),
        Method::POST,
        "/v1/runs",
        json!({
            "prompt": "[model-fallback] [model-fallback-side-effect] do not retry",
            "model": "gpt-5.6-luna",
            "max_runtime_seconds": 5
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let job_id = created.get("job_id").and_then(Value::as_str).unwrap();
    let final_run = wait_for_terminal_run(app.clone(), job_id).await;
    assert_eq!(
        final_run.get("status").and_then(Value::as_str),
        Some("failed")
    );

    let response = app
        .oneshot(request(
            Method::GET,
            &format!("/v1/runs/{job_id}/events?from_start=true&follow=false"),
            Value::Null,
            true,
        ))
        .await
        .unwrap();
    let events = response_text(response).await;
    assert!(!events.contains("codex.model_fallback"));
    assert!(events.contains("Selected model is at capacity"));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn draining_keeps_new_runs_queued_until_dispatch_resumes() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));

    state.jobs.begin_drain();
    let (status, created) = call(
        app.clone(),
        Method::POST,
        "/v1/runs",
        json!({
            "prompt": "wait for the replacement process",
            "model": "codex-test",
            "max_runtime_seconds": 5
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let job_id = created
        .get("job_id")
        .and_then(Value::as_str)
        .expect("job id")
        .to_string();

    tokio::time::sleep(Duration::from_millis(100)).await;
    let queued = state.jobs.info(&job_id).await.unwrap().expect("queued run");
    assert_eq!(queued.status, "queued");
    assert_eq!(state.jobs.active_count().await, 0);

    state.jobs.end_drain();
    assert_eq!(state.jobs.dispatch_queued().await.unwrap(), 1);
    let final_run = wait_for_completed_run(app, &job_id).await;
    assert_eq!(
        final_run.get("status").and_then(Value::as_str),
        Some("completed")
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn internal_drain_marks_readiness_unavailable() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (state, app) = test_state_and_app(&root);

    let (status, drain) = call(app.clone(), Method::POST, "/v1/internal/drain", Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{drain}");
    assert_eq!(drain.get("draining").and_then(Value::as_bool), Some(true));
    assert!(state.jobs.is_draining());

    let (status, drain_status) = call(
        app.clone(),
        Method::GET,
        "/v1/internal/drain/status",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{drain_status}");
    assert_eq!(
        drain_status.get("draining").and_then(Value::as_bool),
        Some(true)
    );

    let (status, ready) = call(app, Method::GET, "/v1/health/ready", Value::Null).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{ready}");
    assert_eq!(ready.get("draining").and_then(Value::as_bool), Some(true));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn queued_run_is_recovered_and_dispatched_after_restart() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let config = test_config_with_codex_executable(&root, fake_codex);
    let (old_state, old_app) = test_state_and_app_with_config(config.clone());
    old_state.jobs.begin_drain();

    let (status, created) = call(
        old_app,
        Method::POST,
        "/v1/runs",
        json!({
            "prompt": "recover me after restart",
            "model": "codex-test",
            "max_runtime_seconds": 5
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let job_id = created
        .get("job_id")
        .and_then(Value::as_str)
        .expect("job id")
        .to_string();
    drop(old_state);

    let (new_state, new_app) = test_state_and_app_with_config(config);
    assert_eq!(
        new_state
            .jobs
            .recover_interrupted_stored_runs()
            .await
            .unwrap(),
        1
    );
    assert_eq!(new_state.jobs.dispatch_queued().await.unwrap(), 1);
    let final_run = wait_for_completed_run(new_app, &job_id).await;
    assert_eq!(
        final_run.get("status").and_then(Value::as_str),
        Some("completed"),
        "{final_run}"
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn runs_route_usage_counts_toward_user_token_usage() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (_state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));

    let job_id = start_fake_ids_run(app.clone(), "[ids] count this run usage").await;
    let final_run = wait_for_completed_run(app.clone(), &job_id).await;
    assert_eq!(
        final_run.get("status").and_then(Value::as_str),
        Some("completed")
    );

    let (status, profile) = call(app, Method::GET, "/v1/users/me", Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{profile}");
    assert_eq!(
        profile
            .pointer("/usage/total_input_tokens")
            .and_then(Value::as_u64),
        Some(10)
    );
    assert_eq!(
        profile
            .pointer("/usage/total_output_tokens")
            .and_then(Value::as_u64),
        Some(5)
    );
    assert_eq!(
        profile
            .pointer("/usage/total_tokens")
            .and_then(Value::as_u64),
        Some(15)
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn codex_runtime_route_reads_catalog_capabilities_and_limits() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (_state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));

    let (status, runtime) = call(app, Method::GET, "/v1/runtime/codex", Value::Null).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        runtime.get("available").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        runtime.pointer("/models/data/0/id").and_then(Value::as_str),
        Some("codex-test")
    );
    assert_eq!(
        runtime
            .pointer("/model_provider_capabilities/webSearch")
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        runtime
            .pointer("/rate_limits/rateLimits/primary/usedPercent")
            .and_then(Value::as_u64),
        Some(12)
    );
    assert_eq!(
        runtime
            .pointer("/usage/usage/totalTokens")
            .and_then(Value::as_u64),
        Some(1234)
    );
    assert_eq!(
        runtime
            .pointer("/config_requirements/status")
            .and_then(Value::as_str),
        Some("ok")
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn runs_route_surfaces_codex_user_input_requests() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (_state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));

    let job_id = start_fake_ids_run(app.clone(), "[request-user-input] collect budget").await;
    let final_run = wait_for_completed_run(app.clone(), &job_id).await;
    assert_eq!(
        final_run.get("stdout_tail").and_then(Value::as_str),
        Some("user input skipped")
    );

    let response = app
        .oneshot(request(
            Method::GET,
            &format!("/v1/runs/{job_id}/events?from_start=true&follow=false"),
            Value::Null,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let events = response_text(response).await;
    assert!(events.contains("\"type\":\"user_input_requested\""));
    assert!(events.contains("客户预算是多少？"));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_user_input_request_waits_and_resolves_session() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let user_id = "smoke-user";

    let (status, pending) = call_response(
        app.clone(),
        json!({
            "model": "codex-test",
            "messages": [{"role": "user", "content": "[request-user-input] 整理报价"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{pending}");
    assert_eq!(
        pending.pointer("/detail/message").and_then(Value::as_str),
        Some("Codex user input required")
    );
    let session_id = pending
        .pointer("/detail/user_input/session_id")
        .and_then(Value::as_str)
        .expect("session id")
        .to_string();
    assert_eq!(
        pending
            .pointer("/detail/user_input/questions/0/question")
            .and_then(Value::as_str),
        Some("客户预算是多少？")
    );

    let waiting = state
        .sessions
        .load(user_id, &session_id)
        .await
        .unwrap()
        .expect("session");
    assert_eq!(waiting.status, "awaiting_user_input");
    assert_eq!(
        waiting.pending_question.as_deref(),
        Some("客户预算是多少？")
    );

    let (status, resolved) = call(
        app.clone(),
        Method::POST,
        &format!("/v1/sessions/{session_id}/user-input/resolve"),
        json!({"answers": {"budget": ["10 万以内"]}}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{resolved}");
    assert_eq!(resolved.get("ok").and_then(Value::as_bool), Some(true));

    let mut idle = None;
    for _ in 0..80 {
        let session = state
            .sessions
            .load(user_id, &session_id)
            .await
            .unwrap()
            .expect("session");
        if session.status == "idle" && session.pending_question.is_none() {
            idle = Some(session);
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let idle = idle.expect("session should be finalized after user input answer");
    assert!(idle
        .messages
        .iter()
        .any(|message| format!("{message}").contains("user input skipped")));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn sequential_runs_for_same_user_reuse_idle_fake_codex_app_server() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (_state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));

    let first_job_id = start_fake_ids_run(app.clone(), "[ids] first fake run").await;
    let first = wait_for_completed_run(app.clone(), &first_job_id).await;
    assert_eq!(
        first.get("stdout_tail").and_then(Value::as_str),
        Some("fake codex completed thread-1 turn-1")
    );

    let second_job_id = start_fake_ids_run(app.clone(), "[ids] second fake run").await;
    let second = wait_for_completed_run(app.clone(), &second_job_id).await;
    assert_eq!(
        second.get("stdout_tail").and_then(Value::as_str),
        Some("fake codex completed thread-2 turn-2"),
        "the second same-user run should borrow the first run's idle pooled worker"
    );

    let _ = std::fs::remove_dir_all(root);
}

async fn start_fake_ids_run(app: axum::Router, prompt: &str) -> String {
    let (status, run) = call(
        app,
        Method::POST,
        "/v1/runs",
        json!({
            "prompt": prompt,
            "model": "codex-test",
            "max_runtime_seconds": 5
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    run.get("job_id")
        .and_then(Value::as_str)
        .expect("job id")
        .to_string()
}

async fn wait_for_completed_run(app: axum::Router, job_id: &str) -> Value {
    for _ in 0..80 {
        let (status, run) = call(
            app.clone(),
            Method::GET,
            &format!("/v1/runs/{job_id}"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        if run.get("status").and_then(Value::as_str) == Some("completed") {
            return run;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("run {job_id} should complete");
}

async fn wait_for_terminal_run(app: axum::Router, job_id: &str) -> Value {
    for _ in 0..80 {
        let (status, run) = call(
            app.clone(),
            Method::GET,
            &format!("/v1/runs/{job_id}"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        if matches!(
            run.get("status").and_then(Value::as_str),
            Some("completed" | "failed" | "cancelled")
        ) {
            return run;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("run {job_id} should reach a terminal status");
}

#[tokio::test]
async fn run_public_apis_hide_host_paths_from_metadata_output_and_events() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (state, app) = test_state_and_app(&root);
    let user_id = "smoke-user";
    let workspace = state.sandboxes.ensure_sandbox(user_id).unwrap();
    let sandbox = state.sandboxes.sandbox_dir(user_id).unwrap();
    let workspace_report = workspace.join("outputs/report.md");
    fs::create_dir_all(workspace_report.parent().unwrap()).unwrap();
    fs::write(&workspace_report, "report").unwrap();
    let job_dir = sandbox.join("agent-runs/external-agents/agent-paths");
    fs::create_dir_all(&job_dir).unwrap();
    let output_file = job_dir.join("output.txt");
    let events_file = job_dir.join("events.jsonl");
    let workspace_report_text = workspace_report.to_string_lossy();
    fs::write(
        &output_file,
        format!("Saved [report]({workspace_report_text})\n"),
    )
    .unwrap();
    fs::write(
        &events_file,
        format!(
            concat!(
                "{{\"type\":\"runner.completed\",\"path\":\"{}\",\"cwd\":\"{}\"}}\n",
                "{{\"type\":\"codex.notification\",\"data\":{{\"message\":{{\"method\":\"item/agentMessage/delta\",\"params\":{{\"delta\":\"]({}\"}}}}}}}}\n",
                "{{\"type\":\"codex.notification\",\"data\":{{\"message\":{{\"method\":\"turn/diff/updated\",\"params\":{{\"diff\":\"diff --git a/.ripple/sandboxes/{}/workspace/outputs/report.md b/{}/.ripple/sandboxes/{}/workspace/outputs/report.md\"}}}}}}}}\n"
            ),
            workspace_report_text,
            workspace.to_string_lossy(),
            root.join("sandboxes").to_string_lossy(),
            user_id,
            root.file_name().and_then(|name| name.to_str()).unwrap_or("ripple"),
            user_id
        ),
    )
    .unwrap();

    state
        .storage
        .upsert_job(&json!({
            "version": 1,
            "job_id": "agent-paths",
            "provider": "codex",
            "user_id": user_id,
            "session_id": null,
            "task_trigger_id": "trg-paths",
            "task_trigger_reason": "manual",
            "prompt_preview": "write report",
            "cwd": workspace,
            "sandbox_cwd": "/workspace",
            "status": "completed",
            "created_at": "2026-05-30T00:00:00Z",
            "updated_at": "2026-05-30T00:00:10Z",
            "events_file": events_file,
            "output_file": output_file,
            "exit_code": 0,
            "stdout_tail": format!("Saved [report]({workspace_report_text})"),
            "stderr_tail": "",
            "error": null
        }))
        .await
        .unwrap();

    let (status, run) = call(
        app.clone(),
        Method::GET,
        "/v1/runs/agent-paths",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(run.get("output_file"), Some(&Value::Null));
    assert_eq!(run.get("events_file"), Some(&Value::Null));
    assert_eq!(
        run.get("output_available").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        run.get("events_available").and_then(Value::as_bool),
        Some(true)
    );
    let run_text = serde_json::to_string(&run).unwrap();
    assert!(
        !run_text.contains(root.to_string_lossy().as_ref()),
        "run metadata leaked host path: {run_text}"
    );
    assert!(run_text.contains("outputs/report.md"));

    let response = app
        .clone()
        .oneshot(request(
            Method::GET,
            "/v1/runs/agent-paths/output",
            Value::Null,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let output_text = response_text(response).await;
    assert!(
        !output_text.contains(root.to_string_lossy().as_ref()),
        "run output leaked host path: {output_text}"
    );
    assert!(output_text.contains("[report](outputs/report.md)"));

    let response = app
        .clone()
        .oneshot(request(
            Method::GET,
            "/v1/runs/agent-paths/events?from_start=true&follow=false",
            Value::Null,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let events_text = response_text(response).await;
    assert!(
        !events_text.contains(root.to_string_lossy().as_ref()),
        "run events leaked host path: {events_text}"
    );
    assert!(
        !events_text.contains(".ripple/sandboxes"),
        "run events leaked runtime path: {events_text}"
    );
    assert!(events_text.contains("outputs/report.md"));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn codex_disabled_rejects_runs_chat_and_task_trigger_extraction_before_starting_runtime() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let mut config = test_config_with_codex_executable(&root, fake_codex);
    config.codex.enabled = false;
    let (_state, app) = test_state_and_app_with_config(config);

    let (status, run) = call(
        app.clone(),
        Method::POST,
        "/v1/runs",
        json!({
            "prompt": "this should not start",
            "model": "codex-test",
            "max_runtime_seconds": 5
        }),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        run.pointer("/detail/code").and_then(Value::as_str),
        Some("codex_disabled")
    );

    let (status, chat) = call_response(
        app.clone(),
        json!({
            "model": "codex-test",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        chat.pointer("/detail/code").and_then(Value::as_str),
        Some("codex_disabled")
    );

    let (status, task_trigger_chat) = call_response(
        app,
        json!({
            "model": "codex-test",
            "messages": [{"role": "user", "content": "请 1 分钟后提醒我测试"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        task_trigger_chat
            .pointer("/detail/code")
            .and_then(Value::as_str),
        Some("codex_disabled")
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn runs_for_same_user_execute_in_parallel_with_isolated_fake_codex_app_servers() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (_state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));

    let (status, first) = call(
        app.clone(),
        Method::POST,
        "/v1/runs",
        json!({
            "prompt": "[slow] [ids] first fake run",
            "model": "codex-test",
            "max_runtime_seconds": 5
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let first_job_id = first
        .get("job_id")
        .and_then(Value::as_str)
        .expect("first job id")
        .to_string();

    let mut first_running = false;
    for _ in 0..40 {
        let (status, run) = call(
            app.clone(),
            Method::GET,
            &format!("/v1/runs/{first_job_id}"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        if run.get("status").and_then(Value::as_str) == Some("running") {
            first_running = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(first_running, "first run should enter running state");

    let (status, second) = call(
        app.clone(),
        Method::POST,
        "/v1/runs",
        json!({
            "prompt": "[ids] second fake run",
            "model": "codex-test",
            "max_runtime_seconds": 5
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let second_job_id = second
        .get("job_id")
        .and_then(Value::as_str)
        .expect("second job id")
        .to_string();

    let mut second_completed_while_first_running = false;
    for _ in 0..40 {
        let (status, first_run) = call(
            app.clone(),
            Method::GET,
            &format!("/v1/runs/{first_job_id}"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, second_run) = call(
            app.clone(),
            Method::GET,
            &format!("/v1/runs/{second_job_id}"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        if first_run.get("status").and_then(Value::as_str) == Some("running")
            && second_run.get("status").and_then(Value::as_str) == Some("completed")
        {
            second_completed_while_first_running = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        second_completed_while_first_running,
        "second run should complete while the first run is still active"
    );

    for job_id in [&first_job_id, &second_job_id] {
        let mut completed = false;
        for _ in 0..80 {
            let (status, run) = call(
                app.clone(),
                Method::GET,
                &format!("/v1/runs/{job_id}"),
                Value::Null,
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            if run.get("status").and_then(Value::as_str) == Some("completed") {
                completed = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(completed, "run {job_id} should complete");
    }

    for job_id in [&first_job_id, &second_job_id] {
        let (status, run) = call(
            app.clone(),
            Method::GET,
            &format!("/v1/runs/{job_id}"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            run.get("stdout_tail").and_then(Value::as_str),
            Some("fake codex completed thread-1 turn-1"),
            "each job should have its own app-server counters"
        );
    }

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn queued_run_can_be_cancelled_before_it_executes() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let mut config = test_config_with_codex_executable(&root, fake_codex);
    // This test verifies queue cancellation, so it must not use the default
    // multi-worker configuration that correctly starts both runs in parallel.
    config.codex.max_workers_per_pool = 1;
    config.codex.max_total_pool_workers = 1;
    let (_state, app) = test_state_and_app_with_config(config);

    let (status, first) = call(
        app.clone(),
        Method::POST,
        "/v1/runs",
        json!({
            "prompt": "[slow] first fake run",
            "model": "codex-test",
            "max_runtime_seconds": 5
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let first_job_id = first
        .get("job_id")
        .and_then(Value::as_str)
        .expect("first job id")
        .to_string();

    for _ in 0..40 {
        let (status, run) = call(
            app.clone(),
            Method::GET,
            &format!("/v1/runs/{first_job_id}"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        if run.get("status").and_then(Value::as_str) == Some("running") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let (status, second) = call(
        app.clone(),
        Method::POST,
        "/v1/runs",
        json!({
            "prompt": "second fake run should not execute",
            "model": "codex-test",
            "max_runtime_seconds": 5
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // A dispatched job is public as `running` while it waits for the only
    // worker. It has not executed the fake turn yet and remains cancellable.
    assert_eq!(
        second.get("status").and_then(Value::as_str),
        Some("running")
    );
    let second_job_id = second
        .get("job_id")
        .and_then(Value::as_str)
        .expect("second job id")
        .to_string();

    let (status, cancelled) = call(
        app.clone(),
        Method::POST,
        &format!("/v1/runs/{second_job_id}/cancel"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        cancelled.get("status").and_then(Value::as_str),
        Some("cancelled")
    );

    let mut first_completed = false;
    for _ in 0..80 {
        let (status, run) = call(
            app.clone(),
            Method::GET,
            &format!("/v1/runs/{first_job_id}"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        if run.get("status").and_then(Value::as_str) == Some("completed") {
            first_completed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(first_completed, "first run should complete");

    let (status, second_after_first_done) = call(
        app.clone(),
        Method::GET,
        &format!("/v1/runs/{second_job_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        second_after_first_done
            .get("status")
            .and_then(Value::as_str),
        Some("cancelled")
    );
    assert_eq!(
        second_after_first_done
            .get("stdout_tail")
            .and_then(Value::as_str),
        Some("")
    );

    let response = app
        .oneshot(request(
            Method::GET,
            &format!("/v1/runs/{second_job_id}/events?from_start=true&follow=false"),
            Value::Null,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let events = response_text(response).await;
    assert!(!events.contains("\"type\":\"runner.started\""));
    assert!(events.contains("data: [DONE]"));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn connector_status_and_accounts_require_existing_sandbox() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (_state, app) = test_state_and_app(&root);

    let response = app
        .clone()
        .oneshot(request(
            Method::GET,
            "/v1/connectors/notion/status",
            Value::Null,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let response = app
        .clone()
        .oneshot(request(
            Method::GET,
            "/v1/connectors/google_workspace/accounts",
            Value::Null,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let response = app
        .clone()
        .oneshot(request(
            Method::GET,
            "/v1/sandboxes/gogcli-accounts",
            Value::Null,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let (status, sandbox) = call(app.clone(), Method::POST, "/v1/sandboxes", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        sandbox.get("user_id").and_then(Value::as_str),
        Some("smoke-user")
    );

    let (status, status_body) = call(
        app.clone(),
        Method::GET,
        "/v1/connectors/notion/status",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        status_body.get("name").and_then(Value::as_str),
        Some("notion")
    );

    let (status, accounts) = call(
        app,
        Method::GET,
        "/v1/connectors/google_workspace/accounts",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(accounts.get("count").and_then(Value::as_u64), Some(0));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn connector_status_does_not_mutate_pending_connector_auth() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (state, app) = test_state_and_app(&root);
    let user_id = "smoke-user";
    state.sandboxes.ensure_sandbox(user_id).unwrap();
    let credentials = state.sandboxes.credentials_dir(user_id).unwrap();
    fs::write(
        credentials.join("notion.json"),
        r#"{"api_token":"test-token"}"#,
    )
    .unwrap();

    let mut session = state
        .sessions
        .create_session(
            user_id,
            CreateSessionInput {
                model: Some("codex-test".to_string()),
                max_turns: None,
                system_prompt: None,
                context_folder_path: None,
            },
        )
        .await
        .unwrap();
    session.status = "waiting_for_user".to_string();
    session.pending_connector_auth = Some(json!({
        "connector": "notion",
        "stage": "awaiting_user_auth",
        "resume_user_input": "继续读取 Notion"
    }));
    state.sessions.save_record(session.clone()).await.unwrap();

    let (status, body) = call(
        app,
        Method::GET,
        "/v1/connectors/notion/status",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.get("connected").and_then(Value::as_bool), Some(true));

    let reloaded = state
        .sessions
        .load(user_id, &session.session_id)
        .await
        .unwrap()
        .expect("session");
    assert_eq!(reloaded.status, "waiting_for_user");
    assert_eq!(
        reloaded
            .pending_connector_auth
            .as_ref()
            .and_then(|value| value.get("stage"))
            .and_then(Value::as_str),
        Some("awaiting_user_auth")
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn connector_manifest_exposes_management_paths_for_user_connectors() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (_state, app) = test_state_and_app(&root);

    let (status, body) = call(app, Method::GET, "/v1/connectors", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    let connectors = body
        .get("connectors")
        .and_then(Value::as_array)
        .expect("connectors array");

    let user_connector = connectors
        .iter()
        .find(|connector| connector.get("name").and_then(Value::as_str) == Some("notion"))
        .expect("notion connector");
    assert_eq!(
        user_connector
            .pointer("/auth_surfaces/web")
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        user_connector
            .get("auth_start_path")
            .and_then(Value::as_str),
        Some("/v1/connectors/notion/auth/start")
    );
    assert_eq!(
        user_connector
            .get("auth_cancel_path")
            .and_then(Value::as_str),
        Some("/v1/connectors/notion/auth/cancel")
    );
    assert_eq!(
        user_connector
            .get("disconnect_path")
            .and_then(Value::as_str),
        Some("/v1/connectors/notion/disconnect")
    );
    assert!(user_connector.get("revoke_path").is_none());
    assert!(user_connector.get("supports_guided_revoke").is_none());

    let runtime_connector = connectors
        .iter()
        .find(|connector| connector.get("name").and_then(Value::as_str) == Some("openai_codex"))
        .expect("runtime connector");
    assert_eq!(
        runtime_connector
            .pointer("/auth_surfaces/web")
            .and_then(Value::as_bool),
        Some(false)
    );
    assert!(runtime_connector.get("auth_start_path").unwrap().is_null());
    assert!(runtime_connector.get("disconnect_path").unwrap().is_null());
    assert!(runtime_connector.get("revoke_path").is_none());

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn connector_routes_run_short_cli_commands_through_nsjail() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (state, app) = test_state_and_app_with_config(test_config_with_fake_connector_cli(&root));
    let user_id = "smoke-user";

    state.sandboxes.ensure_sandbox(user_id).unwrap();
    let workspace = state.sandboxes.workspace_dir(user_id).unwrap();
    fs::create_dir_all(workspace.join(".lark-cli")).unwrap();
    fs::write(workspace.join(".lark-cli/config.json"), "{}").unwrap();

    let (status, accounts) = call(
        app.clone(),
        Method::GET,
        "/v1/connectors/google_workspace/accounts?check=true",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(accounts.get("checked").and_then(Value::as_bool), Some(true));
    assert_eq!(accounts.get("count").and_then(Value::as_u64), Some(1));
    assert_eq!(
        accounts
            .pointer("/accounts/0/email")
            .and_then(Value::as_str),
        Some("worker@example.com")
    );
    assert_eq!(
        accounts
            .pointer("/accounts/0/valid")
            .and_then(Value::as_bool),
        Some(true)
    );

    let (status, feishu) = call(
        app,
        Method::GET,
        "/v1/connectors/feishu/status",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(feishu.get("connected").and_then(Value::as_bool), Some(true));
    assert_eq!(
        feishu.pointer("/metadata/open_id").and_then(Value::as_str),
        Some("ou_fake")
    );
    assert_eq!(
        feishu
            .pointer("/metadata/doctor_checks/config_file")
            .and_then(Value::as_str),
        Some("pass")
    );

    let log = fs::read_to_string(root.join("fake-nsjail.log")).unwrap();
    assert!(log.contains("program=/opt/gogcli-cli/current/bin/gog args=auth list --json --check"));
    assert!(log.contains("program=/opt/lark-cli/current/bin/lark-cli args=doctor"));
    assert!(log.contains("program=/opt/lark-cli/current/bin/lark-cli args=auth status"));
    assert!(log.contains("/sandboxes/smoke-user/nsjail.cfg"));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn google_disconnect_supports_account_and_all_local_removal() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (state, app) = test_state_and_app_with_config(test_config_with_fake_connector_cli(&root));
    let user_id = "smoke-user";

    state.sandboxes.ensure_sandbox(user_id).unwrap();
    let workspace = state.sandboxes.workspace_dir(user_id).unwrap();
    fs::create_dir_all(workspace.join(".config/gogcli/keyring")).unwrap();
    fs::write(
        workspace.join(".config/gogcli/keyring/worker@example.com"),
        "refresh-token",
    )
    .unwrap();

    let (status, removed) = call(
        app.clone(),
        Method::POST,
        "/v1/connectors/google_workspace/disconnect",
        json!({"email": "worker@example.com"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(removed.get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(
        removed.get("stage").and_then(Value::as_str),
        Some("disconnected")
    );
    assert_eq!(
        removed.pointer("/data/email").and_then(Value::as_str),
        Some("worker@example.com")
    );

    let (status, cleared) = call(
        app.clone(),
        Method::POST,
        "/v1/connectors/google_workspace/disconnect",
        json!({"all": true}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cleared.get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(
        cleared.get("stage").and_then(Value::as_str),
        Some("disconnected")
    );
    assert_eq!(
        cleared.pointer("/data/all").and_then(Value::as_bool),
        Some(true)
    );

    let log = fs::read_to_string(root.join("fake-nsjail.log")).unwrap();
    assert!(log.contains(
        "program=/opt/gogcli-cli/current/bin/gog args=auth remove worker@example.com --force"
    ));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn connector_auth_cancel_route_is_idempotent_and_clears_pending_sessions() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (state, app) = test_state_and_app(&root);
    let user_id = "smoke-user";
    state.sandboxes.ensure_sandbox(user_id).unwrap();

    let mut session = state
        .sessions
        .create_session(
            user_id,
            CreateSessionInput {
                model: Some("codex-test".to_string()),
                max_turns: None,
                system_prompt: None,
                context_folder_path: None,
            },
        )
        .await
        .unwrap();
    session.status = "awaiting_user_input".to_string();
    session.pending_connector_auth = Some(json!({
        "connector": "google_workspace",
        "stage": "awaiting_browser_callback",
        "resume_user_input": "读取 Gmail"
    }));
    state.sessions.save_record(session.clone()).await.unwrap();

    let (status, cancelled) = call(
        app.clone(),
        Method::POST,
        "/v1/connectors/google_workspace/auth/cancel",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cancelled.get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(
        cancelled.get("connector").and_then(Value::as_str),
        Some("google_workspace")
    );
    assert_eq!(
        cancelled.get("cancelled").and_then(Value::as_bool),
        Some(true)
    );

    let reloaded = state
        .sessions
        .load(user_id, &session.session_id)
        .await
        .unwrap()
        .expect("session");
    assert_eq!(reloaded.status, "idle");
    assert!(reloaded.pending_connector_auth.is_none());

    let (status, second) = call(
        app,
        Method::POST,
        "/v1/connectors/google_workspace/auth/cancel",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        second.get("cancelled").and_then(Value::as_bool),
        Some(false)
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn connector_revoke_route_is_not_registered() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (state, app) = test_state_and_app(&root);
    state.sandboxes.ensure_sandbox("smoke-user").unwrap();

    let response = app
        .oneshot(request(
            Method::POST,
            "/v1/connectors/google_workspace/revoke",
            json!({"confirm": true, "email": "worker@example.com"}),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn connector_auth_route_clears_matching_pending_session_auth() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (state, app) = test_state_and_app(&root);
    let user_id = "smoke-user";
    let mut session = state
        .sessions
        .create_session(
            user_id,
            CreateSessionInput {
                model: Some("codex-test".to_string()),
                max_turns: None,
                system_prompt: None,
                context_folder_path: None,
            },
        )
        .await
        .unwrap();
    session.status = "awaiting_user_input".to_string();
    session.pending_connector_auth = Some(json!({
        "connector": "notion",
        "stage": "awaiting_user",
        "resume_user_input": "继续读取 Notion"
    }));
    state.sessions.save_record(session.clone()).await.unwrap();

    let (status, auth) = call(
        app,
        Method::POST,
        "/v1/connectors/notion/auth/start",
        json!({"api_token": "secret_abcdefghijklmnopqrstuvwxyz"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        auth.get("stage").and_then(Value::as_str),
        Some("authorized")
    );

    let reloaded = state
        .sessions
        .load(user_id, &session.session_id)
        .await
        .unwrap()
        .expect("session");
    assert_eq!(reloaded.status, "idle");
    assert_eq!(
        reloaded
            .pending_connector_auth
            .as_ref()
            .and_then(|value| value.get("stage"))
            .and_then(Value::as_str),
        Some("authorized")
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn connector_disconnect_clears_matching_pending_session_auth() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (state, app) = test_state_and_app(&root);
    let user_id = "smoke-user";
    let mut session = state
        .sessions
        .create_session(
            user_id,
            CreateSessionInput {
                model: Some("codex-test".to_string()),
                max_turns: None,
                system_prompt: None,
                context_folder_path: None,
            },
        )
        .await
        .unwrap();
    session.status = "awaiting_user_input".to_string();
    session.pending_connector_auth = Some(json!({
        "connector": "notion",
        "stage": "awaiting_token",
        "resume_user_input": "继续读取 Notion"
    }));
    state.sessions.save_record(session.clone()).await.unwrap();

    let (status, disconnected) = call(
        app,
        Method::POST,
        "/v1/connectors/notion/disconnect",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        disconnected.get("stage").and_then(Value::as_str),
        Some("disconnected")
    );

    let reloaded = state
        .sessions
        .load(user_id, &session.session_id)
        .await
        .unwrap()
        .expect("session");
    assert_eq!(reloaded.status, "idle");
    assert!(reloaded.pending_connector_auth.is_none());

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn stop_session_clears_pending_connector_auth_without_running_job() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (state, app) = test_state_and_app(&root);
    let user_id = "smoke-user";
    let mut session = state
        .sessions
        .create_session(
            user_id,
            CreateSessionInput {
                model: Some("codex-test".to_string()),
                max_turns: None,
                system_prompt: None,
                context_folder_path: None,
            },
        )
        .await
        .unwrap();
    session.status = "awaiting_user_input".to_string();
    session.pending_connector_auth = Some(json!({
        "connector": "feishu",
        "stage": "awaiting_setup",
        "resume_user_input": "发一条飞书消息"
    }));
    state.sessions.save_record(session.clone()).await.unwrap();

    let (status, body) = call(
        app,
        Method::POST,
        &format!("/v1/sessions/{}/stop", session.session_id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body.get("connector_auth_cancelled")
            .and_then(Value::as_bool),
        Some(true)
    );

    let reloaded = state
        .sessions
        .load(user_id, &session.session_id)
        .await
        .unwrap()
        .expect("session");
    assert_eq!(reloaded.status, "cancelled");
    assert!(reloaded.pending_connector_auth.is_none());

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn cancel_connector_auth_route_clears_only_target_session() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (state, app) = test_state_and_app(&root);
    let user_id = "smoke-user";
    let mut first = state
        .sessions
        .create_session(
            user_id,
            CreateSessionInput {
                model: Some("codex-test".to_string()),
                max_turns: None,
                system_prompt: None,
                context_folder_path: None,
            },
        )
        .await
        .unwrap();
    first.status = "awaiting_user_input".to_string();
    first.pending_connector_auth = Some(json!({
        "connector": "feishu",
        "stage": "awaiting_setup"
    }));
    state.sessions.save_record(first.clone()).await.unwrap();

    let mut second = state
        .sessions
        .create_session(
            user_id,
            CreateSessionInput {
                model: Some("codex-test".to_string()),
                max_turns: None,
                system_prompt: None,
                context_folder_path: None,
            },
        )
        .await
        .unwrap();
    second.status = "awaiting_user_input".to_string();
    second.pending_connector_auth = Some(json!({
        "connector": "google_workspace",
        "stage": "awaiting_browser_callback"
    }));
    state.sessions.save_record(second.clone()).await.unwrap();

    let (status, body) = call(
        app,
        Method::POST,
        &format!("/v1/sessions/{}/connector-auth/cancel", first.session_id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body.get("connector_auth_cancelled")
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        body.get("connector").and_then(Value::as_str),
        Some("feishu")
    );

    let first = state
        .sessions
        .load(user_id, &first.session_id)
        .await
        .unwrap()
        .expect("first");
    assert_eq!(first.status, "cancelled");
    assert!(first.pending_connector_auth.is_none());

    let second = state
        .sessions
        .load(user_id, &second.session_id)
        .await
        .unwrap()
        .expect("second");
    assert_eq!(second.status, "awaiting_user_input");
    assert!(second.pending_connector_auth.is_some());

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_route_proposes_task_trigger_with_fake_codex_extraction() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let user_id = "smoke-user";

    let (status, chat) = call_response(
        app,
        json!({
            "model": "codex-test",
            "messages": [{"role": "user", "content": "schedule this every hour: Check build"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        chat.pointer("/ripple_event/type").and_then(Value::as_str),
        Some("task_trigger_proposed")
    );
    assert_eq!(
        chat.pointer("/ripple_event/task_trigger/title")
            .and_then(Value::as_str),
        Some("Check build")
    );
    assert_eq!(
        chat.pointer("/ripple_event/task_trigger/interval_seconds")
            .and_then(Value::as_u64),
        Some(3600)
    );
    assert_eq!(
        chat.pointer("/ripple_event/task_trigger/enabled")
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        Some(response_output_text(&chat)),
        chat.pointer("/ripple_event/message")
            .and_then(Value::as_str)
    );

    let session_id = response_session_id(&chat).expect("session id");
    let reloaded = state
        .sessions
        .load(user_id, session_id)
        .await
        .unwrap()
        .expect("session");
    assert_eq!(reloaded.status, "awaiting_user_input");
    assert_eq!(reloaded.message_count, 2);
    assert_eq!(
        reloaded
            .pending_control_request
            .as_ref()
            .and_then(|value| value.get("title"))
            .and_then(Value::as_str),
        Some("Check build")
    );
    assert_eq!(
        reloaded
            .pending_options
            .as_ref()
            .and_then(|options| options.first())
            .map(String::as_str),
        Some("确认创建")
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_route_asks_details_before_complex_external_task_trigger_proposal() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let user_id = "smoke-user";

    let (status, chat) = call_response(
        app,
        json!({
            "model": "codex-test",
            "messages": [{
                "role": "user",
                "content": "[news-feishu] 每天早上9点搜集一下 ai 相关的新闻，并且在飞书上给胡胖发消息，把新闻发给他"
            }],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        chat.pointer("/ripple_event/type").and_then(Value::as_str),
        Some("task_trigger_clarification_required")
    );
    let message = chat
        .pointer("/ripple_event/message")
        .and_then(Value::as_str)
        .expect("clarification message");
    assert!(message.contains("新闻来源"), "{message}");
    assert!(message.contains("飞书"), "{message}");
    assert!(message.contains("失败"), "{message}");

    let session_id = response_session_id(&chat).expect("session id");
    let reloaded = state
        .sessions
        .load(user_id, session_id)
        .await
        .unwrap()
        .expect("session");
    assert_eq!(reloaded.status, "awaiting_user_input");
    let pending = reloaded
        .pending_control_request
        .as_ref()
        .expect("pending control draft");
    assert_eq!(
        pending.get("type").and_then(Value::as_str),
        Some("task_trigger_draft")
    );
    assert_eq!(
        pending
            .get("missing_fields")
            .and_then(Value::as_array)
            .and_then(|fields| fields.first())
            .and_then(Value::as_str),
        Some("trigger_details")
    );
    assert_eq!(
        pending
            .pointer("/partial_task_trigger/title")
            .and_then(Value::as_str),
        Some("每日 AI 新闻飞书发送")
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_route_continues_task_trigger_clarification_with_user_followup() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let user_id = "smoke-user";
    let mut session = state
        .sessions
        .create_session(
            user_id,
            CreateSessionInput {
                model: Some("codex-test".to_string()),
                max_turns: None,
                system_prompt: None,
                context_folder_path: None,
            },
        )
        .await
        .unwrap();
    session.status = "awaiting_user_input".to_string();
    session.pending_question = Some("你希望多久监控一次？".to_string());
    session.pending_control_request = Some(json!({
        "type": "task_trigger_draft",
        "original_user_input": "[clarify-interval] 做个定时任务监控二手 M4 Pro 和 M5 Pro MacBook Pro 的价格",
        "missing_fields": ["interval_seconds"],
        "clarification_question": "你希望多久监控一次？",
        "partial_task_trigger": null
    }));
    state.sessions.save_record(session.clone()).await.unwrap();

    let (status, proposal) = call_response(
        app,
        json!({
            "model": "codex-test",
            "session_id": session.session_id,
            "messages": [{"role": "user", "content": "一周一次"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{proposal}");
    assert_eq!(
        proposal
            .pointer("/ripple_event/type")
            .and_then(Value::as_str),
        Some("task_trigger_proposed")
    );
    assert_eq!(
        proposal
            .pointer("/ripple_event/task_trigger/interval_seconds")
            .and_then(Value::as_u64),
        Some(604_800)
    );
    assert!(
        proposal
            .pointer("/ripple_event/task_trigger/prompt")
            .and_then(Value::as_str)
            .is_some_and(|prompt| prompt.contains("M4 Pro") && prompt.contains("M5 Pro")),
        "{proposal}"
    );
}

#[tokio::test]
async fn chat_route_completes_non_streaming_with_fake_codex_app_server() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let user_id = "smoke-user";

    let (status, chat) = call_response(
        app.clone(),
        json!({
            "model": "codex-test",
            "messages": [
                {"role": "system", "content": "Use the test system prompt."},
                {"role": "user", "content": "hello from chat"}
            ],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        Some(response_output_text(&chat)),
        Some("fake codex completed")
    );
    assert_eq!(
        chat.pointer("/usage/input_tokens").and_then(Value::as_u64),
        Some(10)
    );
    let session_id = chat
        .pointer("/metadata/ripple_session_id")
        .and_then(Value::as_str)
        .expect("session id")
        .to_string();
    let reloaded = state
        .sessions
        .load(user_id, &session_id)
        .await
        .unwrap()
        .expect("session");
    assert_eq!(reloaded.status, "idle");
    assert_eq!(reloaded.message_count, 2);
    assert_eq!(reloaded.title, "hello from chat");
    assert_eq!(
        reloaded.caller_system_prompt.as_deref(),
        Some("Use the test system prompt.")
    );
    assert_eq!(reloaded.total_input_tokens, 10);
    assert_eq!(reloaded.total_output_tokens, 5);
    assert_eq!(reloaded.last_input_tokens, 10);
    assert_eq!(reloaded.codex_thread_id.as_deref(), Some("thread-1"));

    let (status, follow_up) = call_response(
        app.clone(),
        json!({
            "model": "codex-test",
            "session_id": session_id,
            "messages": [{"role": "user", "content": "continue the chat"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        Some(response_output_text(&follow_up)),
        Some("fake codex completed")
    );
    let reloaded = state
        .sessions
        .load(user_id, response_session_id(&follow_up).unwrap())
        .await
        .unwrap()
        .expect("session");
    assert_eq!(reloaded.status, "idle");
    assert_eq!(reloaded.message_count, 4);
    assert_eq!(
        reloaded.caller_system_prompt.as_deref(),
        Some("Use the test system prompt.")
    );
    assert_eq!(reloaded.total_input_tokens, 20);
    assert_eq!(reloaded.total_output_tokens, 10);
    assert_eq!(reloaded.codex_thread_id.as_deref(), Some("thread-1"));

    let (status, usage) = call(
        app,
        Method::GET,
        &format!("/v1/sessions/{}/usage", reloaded.session_id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        usage.get("total_input_tokens").and_then(Value::as_u64),
        Some(20)
    );
    assert_eq!(
        usage.get("total_output_tokens").and_then(Value::as_u64),
        Some(10)
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_route_starts_connector_auth_from_session_control_action() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (state, app) = test_state_and_app(&root);

    let (status, chat) = call_response(
        app,
        json!({
            "model": "codex-test",
            "messages": [{
                "role": "user",
                "content": [{
                    "type": "ripple_control_action",
                    "label": "Connect Notion",
                    "action": {
                        "type": "connector.auth.start",
                        "connector": "notion",
                        "source": "connectors_page"
                    }
                }]
            }],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        chat.pointer("/ripple_event/type").and_then(Value::as_str),
        Some("connector_auth_required")
    );
    assert_eq!(
        chat.pointer("/ripple_event/connector")
            .and_then(Value::as_str),
        Some("notion")
    );

    let session_id = response_session_id(&chat).expect("session id");
    let reloaded = state
        .sessions
        .load("smoke-user", session_id)
        .await
        .unwrap()
        .expect("session");
    assert_eq!(reloaded.status, "awaiting_user_input");
    assert_eq!(
        reloaded
            .pending_connector_auth
            .as_ref()
            .and_then(|pending| pending.get("connector"))
            .and_then(Value::as_str),
        Some("notion")
    );
    assert!(state.jobs.list_user("smoke-user").await.unwrap().is_empty());

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_route_converts_model_connector_auth_request_to_event() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));

    let (status, chat) = call_response(
        app,
        json!({
            "model": "codex-test",
            "messages": [{"role": "user", "content": "[model-auth-alpha] summarize my inbox"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        chat.pointer("/ripple_event/type").and_then(Value::as_str),
        Some("connector_auth_required")
    );
    assert_eq!(
        chat.pointer("/ripple_event/connector")
            .and_then(Value::as_str),
        Some("google_workspace")
    );
    let assistant_text = response_output_text(&chat);
    assert!(!assistant_text.contains("<ripple_connector_auth_request>"));

    let session_id = response_session_id(&chat).expect("session id");
    let reloaded = state
        .sessions
        .load("smoke-user", session_id)
        .await
        .unwrap()
        .expect("session");
    assert_eq!(reloaded.status, "awaiting_user_input");
    assert!(reloaded.pending_connector_auth.is_some());

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_route_does_not_start_connector_auth_from_user_keywords_before_codex() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));

    let (status, chat) = call_response(
        app,
        json!({
            "model": "codex-test",
            "messages": [{"role": "user", "content": "请读取 Google Drive 里的会议纪要"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(chat.get("ripple_event").is_none());
    assert_eq!(
        Some(response_output_text(&chat)),
        Some("fake codex completed")
    );

    let session_id = response_session_id(&chat).expect("session id");
    let reloaded = state
        .sessions
        .load("smoke-user", session_id)
        .await
        .unwrap()
        .expect("session");
    assert_eq!(reloaded.status, "idle");
    assert!(reloaded.pending_connector_auth.is_none());

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_route_reads_local_workspace_pdf_without_connector_auth() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let workspace = state.sandboxes.ensure_sandbox("smoke-user").unwrap();
    fs::write(workspace.join("动效plan.pdf"), b"%PDF fake").unwrap();

    let (status, chat) = call_response(
        app,
        json!({
            "model": "codex-test",
            "messages": [{"role": "user", "content": "/workspace/动效plan.pdf\n\n这个讲了什么内容"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(chat.get("ripple_event").is_none());
    assert_eq!(
        Some(response_output_text(&chat)),
        Some("fake codex completed")
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_generates_async_summary_title_without_public_run() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let user_id = "smoke-user";

    let (status, chat) = call_response(
        app.clone(),
        json!({
            "model": "codex-test",
            "messages": [{"role": "user", "content": "hello from chat"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let session_id = response_session_id(&chat).expect("session id").to_string();

    let mut title = String::new();
    for _ in 0..40 {
        title = state
            .sessions
            .load(user_id, &session_id)
            .await
            .unwrap()
            .expect("session")
            .title;
        if title == "Chat Greeting" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(title, "Chat Greeting");

    let (status, runs) = call(app.clone(), Method::GET, "/v1/runs", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(runs.get("count").and_then(Value::as_u64), Some(1));

    let (status, overview) = call(app, Method::GET, "/v1/sessions/overview", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    let last_run_prompt = overview
        .pointer("/sessions/0/last_run/prompt_preview")
        .and_then(Value::as_str)
        .unwrap_or("");
    assert!(!last_run_prompt.contains("strict chat-title generator"));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn deleting_running_chat_session_does_not_recreate_session() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let user_id = "smoke-user";

    let (status, session) = call(
        app.clone(),
        Method::POST,
        "/v1/sessions",
        json!({"model": "codex-test"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let session_id = session
        .get("session_id")
        .and_then(Value::as_str)
        .expect("session id")
        .to_string();

    let chat_app = app.clone();
    let chat_session_id = session_id.clone();
    let chat_task = tokio::spawn(async move {
        chat_app
            .oneshot(response_request(
                json!({
                    "model": "codex-test",
                    "session_id": chat_session_id,
                    "messages": [{"role": "user", "content": "[slow-delete] delete me while running"}],
                    "stream": false
                }),
                true,
            ))
            .await
            .unwrap()
    });

    let mut saw_running = false;
    for _ in 0..40 {
        let (status, detail) = call(
            app.clone(),
            Method::GET,
            &format!("/v1/sessions/{session_id}"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        if detail.get("status").and_then(Value::as_str) == Some("running") {
            saw_running = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(saw_running, "chat session should enter running state");

    let (status, deleted) = call(
        app.clone(),
        Method::DELETE,
        &format!("/v1/sessions/{session_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "delete response: {deleted}");
    assert_eq!(deleted.get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(deleted.get("stopped").and_then(Value::as_bool), Some(true));

    let chat_response = chat_task.await.unwrap();
    assert_ne!(chat_response.status(), StatusCode::OK);
    let _ = response_text(chat_response).await;

    assert!(state
        .sessions
        .load(user_id, &session_id)
        .await
        .unwrap()
        .is_none());
    let response = app
        .oneshot(request(
            Method::GET,
            &format!("/v1/sessions/{session_id}"),
            Value::Null,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_sessions_for_same_user_execute_in_parallel_with_isolated_fake_codex_app_servers() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (_state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));

    let (status, first_session) = call(
        app.clone(),
        Method::POST,
        "/v1/sessions",
        json!({"model": "codex-test"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let first_session_id = first_session
        .get("session_id")
        .and_then(Value::as_str)
        .expect("first session id")
        .to_string();

    let (status, second_session) = call(
        app.clone(),
        Method::POST,
        "/v1/sessions",
        json!({"model": "codex-test"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let second_session_id = second_session
        .get("session_id")
        .and_then(Value::as_str)
        .expect("second session id")
        .to_string();

    let first_app = app.clone();
    let first_session_for_task = first_session_id.clone();
    let first_chat_task = tokio::spawn(async move {
        first_app
            .oneshot(response_request(
                json!({
                    "model": "codex-test",
                    "session_id": first_session_for_task,
                    "messages": [{"role": "user", "content": "[slow] [ids] first chat"}],
                    "stream": false
                }),
                true,
            ))
            .await
            .unwrap()
    });

    let mut first_running = false;
    for _ in 0..40 {
        let (status, detail) = call(
            app.clone(),
            Method::GET,
            &format!("/v1/sessions/{first_session_id}"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        if detail.get("status").and_then(Value::as_str) == Some("running") {
            first_running = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        first_running,
        "first chat session should enter running state"
    );

    let (status, second_chat) = call_response(
        app.clone(),
        json!({
            "model": "codex-test",
            "session_id": second_session_id,
            "messages": [{"role": "user", "content": "[ids] second chat"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        Some(response_output_text(&second_chat)),
        Some("fake codex completed thread-1 turn-1")
    );

    let (status, first_detail) = call(
        app.clone(),
        Method::GET,
        &format!("/v1/sessions/{first_session_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        first_detail.get("status").and_then(Value::as_str),
        Some("running"),
        "first chat should still be running after second chat completed"
    );

    let first_response = first_chat_task.await.unwrap();
    assert_eq!(first_response.status(), StatusCode::OK);
    let first_chat = response_json(first_response).await;
    assert_eq!(
        Some(response_output_text(&first_chat)),
        Some("fake codex completed thread-1 turn-1")
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn concurrent_chat_requests_for_same_session_start_single_run() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let user_id = "smoke-user";

    let (status, session) = call(
        app.clone(),
        Method::POST,
        "/v1/sessions",
        json!({"model": "codex-test"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let session_id = session
        .get("session_id")
        .and_then(Value::as_str)
        .expect("session id")
        .to_string();

    let first_app = app.clone();
    let first_session_id = session_id.clone();
    let first = tokio::spawn(async move {
        call_response(
        first_app,
        json!({
                "model": "codex-test",
                "session_id": first_session_id,
                "messages": [{"role": "user", "content": "schedule this every hour: [slow] Check build"}],
                "stream": false
            }),
        )
        .await
    });
    let second_app = app.clone();
    let second_session_id = session_id.clone();
    let second = tokio::spawn(async move {
        call_response(
        second_app,
        json!({
                "model": "codex-test",
                "session_id": second_session_id,
                "messages": [{"role": "user", "content": "schedule this every hour: [slow] Check build"}],
                "stream": false
            }),
        )
        .await
    });

    let (first_status, first_body) = first.await.unwrap();
    let (second_status, second_body) = second.await.unwrap();
    assert_eq!(first_status, StatusCode::OK, "first response: {first_body}");
    assert_eq!(
        second_status,
        StatusCode::OK,
        "second response: {second_body}"
    );
    let proposed = [first_body.clone(), second_body.clone()]
        .into_iter()
        .filter(|body| {
            body.pointer("/ripple_event/type").and_then(Value::as_str)
                == Some("task_trigger_proposed")
        })
        .count();
    assert_eq!(proposed, 1, "only one request should start extraction");

    let jobs = state.jobs.list_user(user_id).await.unwrap();
    assert_eq!(jobs.len(), 1, "only one Codex job should be created");

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn codex_app_server_does_not_inherit_server_secret_env() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (_state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));

    let old_http_proxy = std::env::var_os("HTTP_PROXY");
    std::env::set_var("RIPPLE_SECRET_SHOULD_NOT_LEAK", "secret-from-server-env");
    std::env::set_var("HTTP_PROXY", "http://proxy.example:8080");
    let (status, chat) = call_response(
        app,
        json!({
            "model": "codex-test",
            "messages": [{"role": "user", "content": "[env-check] inspect environment"}],
            "stream": false
        }),
    )
    .await;
    std::env::remove_var("RIPPLE_SECRET_SHOULD_NOT_LEAK");
    match old_http_proxy {
        Some(value) => std::env::set_var("HTTP_PROXY", value),
        None => std::env::remove_var("HTTP_PROXY"),
    }

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        Some(response_output_text(&chat)),
        Some("env clean proxy present")
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn codex_app_server_inherits_only_configured_provider_env() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let mut config = test_config_with_codex_executable(&root, fake_codex);
    config.codex.requires_service_auth = false;
    config.codex.provider_env_keys = vec!["RIPPLE_TEST_PROVIDER_API_KEY".to_string()];
    let (_state, app) = test_state_and_app_with_config(config);

    std::env::set_var("RIPPLE_TEST_PROVIDER_API_KEY", "provider-secret");
    let (status, chat) = call_response(
        app,
        json!({
            "model": "codex-test",
            "messages": [{"role": "user", "content": "[provider-env-check] inspect environment"}],
            "stream": false
        }),
    )
    .await;
    std::env::remove_var("RIPPLE_TEST_PROVIDER_API_KEY");

    assert_eq!(status, StatusCode::OK);
    assert_eq!(response_output_text(&chat), "provider env present");

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_session_bound_to_context_folder_runs_from_that_folder() {
    let root = std::env::temp_dir().join(format!("ripple-api-folder-chat-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let user_id = "smoke-user";
    let workspace = state.sandboxes.ensure_sandbox(user_id).unwrap();
    fs::create_dir_all(workspace.join("demo")).unwrap();

    let (status, session) = call(
        app.clone(),
        Method::POST,
        "/v1/sessions",
        json!({"model": "codex-test", "context_folder_path": "/workspace/demo"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{session}");
    let session_id = session
        .get("session_id")
        .and_then(Value::as_str)
        .expect("session id")
        .to_string();
    assert!(
        session.get("project_id").is_none(),
        "session response should not expose legacy project_id: {session}"
    );
    assert!(
        session.get("project_name").is_none(),
        "session response should not expose legacy project_name: {session}"
    );
    assert!(
        session.get("project_root").is_none(),
        "session response should not expose legacy project_root: {session}"
    );
    assert_eq!(
        session.get("context_folder_path").and_then(Value::as_str),
        Some("/workspace/demo")
    );

    let (status, chat) = call_response(
        app.clone(),
        json!({
            "model": "codex-test",
            "session_id": session_id,
            "messages": [{"role": "user", "content": "hello from project"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{chat}");
    assert_eq!(
        Some(response_output_text(&chat)),
        Some("context folder prompt present")
    );

    let jobs = state.jobs.list_user(user_id).await.unwrap();
    let chat_job = jobs
        .iter()
        .find(|job| {
            job.metadata.get("session_id").and_then(Value::as_str) == Some(session_id.as_str())
        })
        .expect("chat job");
    assert_eq!(chat_job.sandbox_cwd.as_deref(), Some("/workspace/demo"));

    let (status, detail) = call(
        app,
        Method::GET,
        &format!("/v1/sessions/{session_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert!(
        detail.get("project_id").is_none(),
        "session detail should not expose legacy project_id: {detail}"
    );
    assert!(
        detail.get("project_name").is_none(),
        "session detail should not expose legacy project_name: {detail}"
    );
    assert!(
        detail.get("project_root").is_none(),
        "session detail should not expose legacy project_root: {detail}"
    );
    assert_eq!(
        detail.get("context_folder_path").and_then(Value::as_str),
        Some("/workspace/demo")
    );

    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn changing_context_folder_starts_a_new_codex_thread() {
    let root = std::env::temp_dir().join(format!("ripple-api-folder-rotation-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let user_id = "smoke-user";
    let workspace = state.sandboxes.ensure_sandbox(user_id).unwrap();
    fs::create_dir_all(workspace.join("alpha")).unwrap();
    fs::create_dir_all(workspace.join("other")).unwrap();

    let (status, session) = call(
        app.clone(),
        Method::POST,
        "/v1/sessions",
        json!({"model": "codex-test", "context_folder_path": "/workspace/alpha"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{session}");
    let session_id = session
        .get("session_id")
        .and_then(Value::as_str)
        .expect("session id")
        .to_string();

    let (status, first) = call_response(
        app.clone(),
        json!({
            "model": "codex-test",
            "session_id": session_id,
            "messages": [{"role": "user", "content": "[ids] first context"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(
        Some(response_output_text(&first)),
        Some("fake codex completed thread-1 turn-1")
    );

    let (status, unchanged) = call(
        app.clone(),
        Method::PATCH,
        &format!("/v1/sessions/{session_id}"),
        json!({"context_folder_path": "/workspace/alpha"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{unchanged}");
    assert_eq!(
        state
            .sessions
            .load(user_id, &session_id)
            .await
            .unwrap()
            .expect("session")
            .codex_thread_id
            .as_deref(),
        Some("thread-1")
    );

    let (status, changed) = call(
        app.clone(),
        Method::PATCH,
        &format!("/v1/sessions/{session_id}"),
        json!({"context_folder_path": "/workspace/other"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    let detached = state
        .sessions
        .load(user_id, &session_id)
        .await
        .unwrap()
        .expect("session");
    assert!(detached.codex_thread_id.is_none());
    assert!(detached
        .messages
        .iter()
        .any(|message| format!("{message}").contains("first context")));

    let (status, second) = call_response(
        app,
        json!({
            "model": "codex-test",
            "session_id": session_id,
            "messages": [{"role": "user", "content": "[ids] switched context"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{second}");
    let second_output = response_output_text(&second);
    assert!(
        second_output.starts_with("fake codex completed thread-"),
        "unexpected response: {second_output}"
    );

    let reloaded = state
        .sessions
        .load(user_id, &session_id)
        .await
        .unwrap()
        .expect("session");
    assert!(reloaded.codex_thread_id.is_some());
    let jobs = state.jobs.list_user(user_id).await.unwrap();
    let switched_job = jobs
        .iter()
        .find(|job| {
            job.metadata.get("chat_user_input").and_then(Value::as_str)
                == Some("[ids] switched context")
        })
        .expect("switched context job");
    assert_eq!(
        switched_job
            .metadata
            .get("codex_thread_resumed")
            .and_then(Value::as_bool),
        Some(false),
        "context switch must start a fresh Codex thread"
    );
    assert_eq!(
        switched_job.sandbox_cwd.as_deref(),
        Some("/workspace/other")
    );

    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_follow_up_resumes_codex_thread_without_replaying_turns() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));

    let (status, first) = call_response(
        app.clone(),
        json!({
            "model": "codex-test",
            "messages": [{"role": "user", "content": "[history-watermark-old] start a persistent thread"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let session_id = response_session_id(&first).expect("session id").to_string();
    let first_session = state
        .sessions
        .load("smoke-user", &session_id)
        .await
        .unwrap()
        .expect("session");
    assert_eq!(
        first_session.codex_synced_message_count,
        first_session.messages.len()
    );

    let (status, follow_up) = call_response(
        app,
        json!({
            "model": "codex-test",
            "session_id": session_id,
            "messages": [{"role": "user", "content": "[history-watermark-check] continue the persistent thread"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "follow-up response: {follow_up}");
    let content = response_output_text(&follow_up);
    assert!(
        content.starts_with("history delta clean thread-1 turn-"),
        "follow-up should resume the original thread without replaying synced history, got {content:?}"
    );
    let follow_up_session = state
        .sessions
        .load("smoke-user", &session_id)
        .await
        .unwrap()
        .expect("session");
    assert_eq!(
        follow_up_session.codex_synced_message_count,
        follow_up_session.messages.len()
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_recovers_restart_stale_running_job_before_starting_follow_up() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let user_id = "smoke-user";
    let mut session = state
        .sessions
        .create_session(
            user_id,
            CreateSessionInput {
                model: Some("codex-test".to_string()),
                max_turns: None,
                system_prompt: None,
                context_folder_path: None,
            },
        )
        .await
        .unwrap();
    session.status = "running".to_string();
    state.sessions.save_record(session.clone()).await.unwrap();
    state
        .storage
        .upsert_job(&json!({
            "version": 1,
            "job_id": "agent-stale",
            "provider": "codex",
            "user_id": user_id,
            "session_id": session.session_id,
            "prompt_preview": "stale run before restart",
            "cwd": state.sandboxes.workspace_dir(user_id).unwrap(),
            "sandbox_cwd": "/workspace",
            "status": "running",
            "created_at": "2026-05-24T00:00:00Z",
            "updated_at": "2026-05-24T00:00:00Z",
            "events_file": null,
            "output_file": null,
            "exit_code": null,
            "stdout_tail": "",
            "stderr_tail": "",
            "error": null
        }))
        .await
        .unwrap();

    let (status, follow_up) = call_response(
        app.clone(),
        json!({
            "model": "codex-test",
            "session_id": session.session_id,
            "messages": [{"role": "user", "content": "follow up after restart"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "follow-up response: {follow_up}");

    let stale = state
        .jobs
        .info_for_user("agent-stale", user_id)
        .await
        .unwrap()
        .expect("stale job");
    assert_eq!(stale.status, "failed");
    assert!(stale
        .error
        .as_deref()
        .is_some_and(|value| value.contains("restarted")));
    let reloaded = state
        .sessions
        .load(user_id, response_session_id(&follow_up).unwrap())
        .await
        .unwrap()
        .expect("session");
    assert_eq!(reloaded.status, "idle");

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn dropped_chat_stream_does_not_block_follow_up_after_job_completes() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let user_id = "smoke-user";

    let response = app
        .clone()
        .oneshot(response_request(
            json!({
                "model": "codex-test",
                "messages": [{"role": "user", "content": "[slow] stream that will disconnect"}],
                "stream": true
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let session_id = response
        .headers()
        .get("x-ripple-session-id")
        .and_then(|value| value.to_str().ok())
        .expect("session header")
        .to_string();
    drop(response);

    let mut job_completed = false;
    let mut last_jobs = Vec::new();
    for _ in 0..80 {
        let jobs = state.jobs.list_user(user_id).await.unwrap();
        last_jobs = jobs.clone();
        if jobs.iter().any(|info| info.status == "completed") {
            job_completed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        job_completed,
        "background Codex job should complete, jobs: {last_jobs:?}"
    );

    let (status, follow_up) = call_response(
        app.clone(),
        json!({
            "model": "codex-test",
            "session_id": session_id,
            "messages": [{"role": "user", "content": "follow up after disconnect"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "follow-up response: {follow_up}");
    assert_eq!(
        Some(response_output_text(&follow_up)),
        Some("fake codex completed")
    );

    let reloaded = state
        .sessions
        .load(user_id, response_session_id(&follow_up).unwrap())
        .await
        .unwrap()
        .expect("session");
    assert_eq!(reloaded.status, "idle");
    assert_eq!(
        reloaded.message_count, 4,
        "dropped stream turn and follow-up turn should both be persisted"
    );
    assert_eq!(reloaded.total_input_tokens, 20);
    assert_eq!(reloaded.total_output_tokens, 10);
    assert_eq!(reloaded.codex_thread_id.as_deref(), Some("thread-1"));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_creates_new_session_with_caller_supplied_session_id() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let user_id = "smoke-user";
    let caller_session_id = "CallerSession123";

    let (status, first) = call_response(
        app.clone(),
        json!({
            "model": "codex-test",
            "session_id": caller_session_id,
            "messages": [{"role": "user", "content": "first caller-owned session turn"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(response_session_id(&first), Some(caller_session_id));

    let first_reloaded = state
        .sessions
        .load(user_id, caller_session_id)
        .await
        .unwrap()
        .expect("caller session should be persisted");
    assert_eq!(first_reloaded.session_id, caller_session_id);
    assert_eq!(first_reloaded.message_count, 2);

    let (status, second) = call_response(
        app.clone(),
        json!({
            "model": "codex-test",
            "session_id": caller_session_id,
            "messages": [{"role": "user", "content": "second caller-owned session turn"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{second}");
    assert_eq!(response_session_id(&second), Some(caller_session_id));

    let second_reloaded = state
        .sessions
        .load(user_id, caller_session_id)
        .await
        .unwrap()
        .expect("caller session should be reused");
    assert_eq!(second_reloaded.message_count, 4);

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_stream_completes_with_fake_codex_app_server() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let user_id = "smoke-user";

    let response = app
        .oneshot(response_request(
            json!({
                "model": "codex-test",
                "messages": [{"role": "user", "content": "stream hello from chat"}],
                "stream": true
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("text/event-stream")
    );
    let session_id = response
        .headers()
        .get("x-ripple-session-id")
        .and_then(|value| value.to_str().ok())
        .expect("session header")
        .to_string();
    let body = response_text(response).await;
    assert!(body.contains("\"role\":\"assistant\""));
    assert!(body.contains("\"delta\":\"fake codex completed\""));
    assert!(body.contains("data: [DONE]"));

    let reloaded = state
        .sessions
        .load(user_id, &session_id)
        .await
        .unwrap()
        .expect("session");
    assert_eq!(reloaded.status, "idle");
    assert_eq!(reloaded.message_count, 2);
    assert_eq!(reloaded.codex_thread_id.as_deref(), Some("thread-1"));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_stream_converts_model_connector_auth_request_to_event_without_leaking_protocol() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));

    let response = app
        .oneshot(response_request(
            json!({
                "model": "codex-test",
                "messages": [{"role": "user", "content": "[model-auth-alpha] summarize my inbox"}],
                "stream": true
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let session_id = response
        .headers()
        .get("x-ripple-session-id")
        .and_then(|value| value.to_str().ok())
        .expect("session header")
        .to_string();
    let body = response_text(response).await;
    assert!(body.contains("\"ripple_event_type\":\"connector_auth_required\""));
    assert!(body.contains("\"connector\":\"google_workspace\""));
    assert!(!body.contains("<ripple_connector_auth_request>"));
    assert_eq!(body.matches("data: [DONE]").count(), 1);
    assert!(body.contains("data: [DONE]"));

    let reloaded = state
        .sessions
        .load("smoke-user", &session_id)
        .await
        .unwrap()
        .expect("session");
    assert_eq!(reloaded.status, "awaiting_user_input");
    assert!(reloaded.pending_connector_auth.is_some());

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_stream_approval_waiting_state_emits_response_completed() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (_state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));

    let response = app
        .oneshot(response_request(
            json!({
                "model": "codex-test",
                "messages": [{"role": "user", "content": "[approval] run a fake command"}],
                "stream": true
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_text(response).await;

    assert!(body.contains("\"ripple_event_type\":\"approval_required\""));
    assert!(body.contains("\"type\":\"response.completed\""));
    assert_eq!(body.matches("data: [DONE]").count(), 1);

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_stream_user_input_waiting_state_emits_response_completed() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (_state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));

    let response = app
        .oneshot(response_request(
            json!({
                "model": "codex-test",
                "messages": [{"role": "user", "content": "[request-user-input] collect budget"}],
                "stream": true
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_text(response).await;

    assert!(body.contains("\"ripple_event_type\":\"user_input_required\""));
    assert!(body.contains("\"type\":\"response.completed\""));
    assert_eq!(body.matches("data: [DONE]").count(), 1);

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_stream_forwards_codex_runtime_tool_plan_and_image_events() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let user_id = "smoke-user";

    let response = app
        .oneshot(response_request(
                json!({
                "model": "codex-test",
                "messages": [{"role": "user", "content": "[runtime-events] stream rich codex events"}],
                "stream": true
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let session_id = response
        .headers()
        .get("x-ripple-session-id")
        .and_then(|value| value.to_str().ok())
        .expect("session header")
        .to_string();
    let body = response_text(response).await;

    assert!(body.contains("\"ripple_event_type\":\"task_plan_updated\""));
    assert!(body.contains("\"currentTask\":\"Inspect workspace\""));
    assert!(body.contains("\"ripple_event_type\":\"tool_call\""));
    assert!(body.contains("\"name\":\"command_execution\""));
    assert!(body.contains("\"ripple_event_type\":\"tool_output_delta\""));
    assert!(body.contains("\"delta\":\"hello\\n\""));
    assert!(body.contains("\"ripple_event_type\":\"tool_result\""));
    assert!(body.contains("\"ripple_event_type\":\"file_change_patch_updated\""));
    assert!(body.contains("\"ripple_event_type\":\"image_view\""));
    assert!(body.contains("\"workspace_path\":\"/workspace/images/source.png\""));
    assert!(body.contains("\"ripple_event_type\":\"image_generation\""));
    assert!(body.contains("\"workspace_path\":\"/workspace/outputs/images/"));
    assert!(body.contains("/img-1.png\""));
    assert!(body.contains("\"ripple_event_type\":\"usage\""));
    assert!(body.contains("\"delta\":\"fake codex completed\""));
    assert!(body.contains("data: [DONE]"));

    let image_workspace_path = state
        .storage
        .list_file_refs(user_id)
        .await
        .unwrap()
        .into_iter()
        .find_map(|record| {
            record.workspace_path.filter(|path| {
                path.starts_with("/workspace/outputs/images/") && path.ends_with("/img-1.png")
            })
        })
        .expect("generated image file ref");
    let imported = state.sandboxes.workspace_dir(user_id).unwrap().join(
        image_workspace_path
            .strip_prefix("/workspace/")
            .expect("workspace path prefix"),
    );
    assert_eq!(fs::read(imported).unwrap(), b"Hello");
    let reloaded = state
        .sessions
        .load(user_id, &session_id)
        .await
        .unwrap()
        .expect("session");
    let assistant_content = reloaded
        .messages
        .get(1)
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
        .expect("assistant content");
    assert!(assistant_content.iter().any(|item| {
        item.get("type").and_then(Value::as_str) == Some("image")
            && item.get("workspace_path").and_then(Value::as_str)
                == Some(image_workspace_path.as_str())
            && item.get("mime_type").and_then(Value::as_str) == Some("image/png")
            && item.get("size").and_then(Value::as_u64) == Some(5)
            && item.get("revised_prompt").and_then(Value::as_str) == Some("tiny fake image")
    }));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn session_detail_backfills_generated_images_from_run_events() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let user_id = "smoke-user";

    let response = app
        .clone()
        .oneshot(response_request(
                json!({
                "model": "codex-test",
                "messages": [{"role": "user", "content": "[runtime-events] stream rich codex events"}],
                "stream": true
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let session_id = response
        .headers()
        .get("x-ripple-session-id")
        .and_then(|value| value.to_str().ok())
        .expect("session header")
        .to_string();
    let _ = response_text(response).await;

    let mut legacy = state
        .sessions
        .load(user_id, &session_id)
        .await
        .unwrap()
        .expect("session");
    for message in &mut legacy.messages {
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        if let Some(content) = message.get_mut("content").and_then(Value::as_array_mut) {
            content.retain(|item| item.get("type").and_then(Value::as_str) != Some("image"));
        }
    }
    state.sessions.save_record_if_exists(legacy).await.unwrap();
    for mut record in state.storage.list_jobs_for_user(user_id).await.unwrap() {
        if record.get("session_id").and_then(Value::as_str) == Some(session_id.as_str()) {
            record.as_object_mut().unwrap().remove("session_id");
            state.storage.upsert_job(&record).await.unwrap();
        }
    }
    state.jobs.clear_user_cache(user_id).await;

    let (status, detail) = call(
        app.clone(),
        Method::GET,
        &format!("/v1/sessions/{session_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "session detail: {detail}");
    let assistant_content = detail
        .get("messages")
        .and_then(Value::as_array)
        .and_then(|messages| messages.get(1))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
        .expect("assistant content");
    assert!(assistant_content.iter().any(|item| {
        item.get("type").and_then(Value::as_str) == Some("image")
            && item
                .get("workspace_path")
                .and_then(Value::as_str)
                .is_some_and(|path| {
                    path.starts_with("/workspace/outputs/images/") && path.ends_with("/img-1.png")
                })
    }));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_approval_bridge_resolves_fake_codex_request() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let user_id = "smoke-user";

    let (status, pending) = call_response(
        app.clone(),
        json!({
            "model": "codex-test",
            "messages": [{"role": "user", "content": "[approval] run a fake command"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        pending.pointer("/detail/message").and_then(Value::as_str),
        Some("Codex approval required")
    );
    let approval = pending
        .pointer("/detail/approval")
        .and_then(Value::as_object)
        .expect("approval");
    let session_id = approval
        .get("session_id")
        .and_then(Value::as_str)
        .expect("session id")
        .to_string();
    let job_id = approval
        .get("job_id")
        .and_then(Value::as_str)
        .expect("job id")
        .to_string();
    assert_eq!(
        approval.get("description").and_then(Value::as_str),
        Some("echo approval")
    );

    let reloaded = state
        .sessions
        .load(user_id, &session_id)
        .await
        .unwrap()
        .expect("session");
    assert_eq!(reloaded.status, "awaiting_permission");
    assert!(reloaded.pending_permission_request.is_some());

    let (status, resolved) = call(
        app.clone(),
        Method::POST,
        &format!("/v1/sessions/{session_id}/permissions/resolve"),
        json!({"action": "allow"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(resolved.get("ok").and_then(Value::as_bool), Some(true));

    let mut completed = None;
    for _ in 0..80 {
        let (status, run) = call(
            app.clone(),
            Method::GET,
            &format!("/v1/runs/{job_id}"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        if run.get("status").and_then(Value::as_str) == Some("completed") {
            completed = Some(run);
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let completed = completed.expect("approval run should complete");
    assert_eq!(
        completed.get("stdout_tail").and_then(Value::as_str),
        Some("fake approval completed")
    );

    let mut session_idle = false;
    for _ in 0..40 {
        let reloaded = state
            .sessions
            .load(user_id, &session_id)
            .await
            .unwrap()
            .expect("session");
        if reloaded.status == "idle" && reloaded.pending_permission_request.is_none() {
            session_idle = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        session_idle,
        "session should be finalized after approval run"
    );
    let finalized = state
        .sessions
        .load(user_id, &session_id)
        .await
        .unwrap()
        .expect("finalized session");
    assert!(
        finalized
            .messages
            .iter()
            .any(|message| format!("{message}").contains("fake approval completed")),
        "approval output should be persisted to session messages: {finalized:?}"
    );
    assert_eq!(finalized.total_input_tokens, 10);
    assert_eq!(finalized.total_output_tokens, 5);

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn cancelling_approval_run_clears_pending_approval() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));

    let (status, pending) = call_response(
        app.clone(),
        json!({
            "model": "codex-test",
            "messages": [{"role": "user", "content": "[approval] run a fake command"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let job_id = pending
        .pointer("/detail/approval/job_id")
        .and_then(Value::as_str)
        .expect("job id")
        .to_string();
    let session_id = pending
        .pointer("/detail/approval/session_id")
        .and_then(Value::as_str)
        .expect("session id")
        .to_string();

    let (status, cancelled) = call(
        app.clone(),
        Method::POST,
        &format!("/v1/runs/{job_id}/cancel"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        cancelled.get("status").and_then(Value::as_str),
        Some("cancelled")
    );
    assert!(matches!(
        cancelled.get("pending_approval"),
        None | Some(Value::Null)
    ));

    let (status, reloaded) = call(
        app.clone(),
        Method::GET,
        &format!("/v1/runs/{job_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(matches!(
        reloaded.get("pending_approval"),
        None | Some(Value::Null)
    ));
    let session = state
        .sessions
        .load("smoke-user", &session_id)
        .await
        .unwrap()
        .expect("session");
    assert_eq!(session.status, "cancelled");
    assert!(
        session.pending_permission_request.is_none(),
        "cancelled approval run should clear session pending approval: {session:?}"
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn session_detail_recovers_restart_stale_awaiting_permission_job() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let config = test_config_with_codex_executable(&root, fake_codex);
    let (_state, app) = test_state_and_app_with_config(config.clone());

    let (status, pending) = call_response(
        app,
        json!({
            "model": "codex-test",
            "messages": [{"role": "user", "content": "[approval] run a fake command"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{pending}");
    let session_id = pending
        .pointer("/detail/approval/session_id")
        .and_then(Value::as_str)
        .expect("session id")
        .to_string();

    let (_restarted_state, restarted_app) = test_state_and_app_with_config(config);
    let (status, detail) = call(
        restarted_app,
        Method::GET,
        &format!("/v1/sessions/{session_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail.get("status").and_then(Value::as_str), Some("failed"));
    assert!(matches!(
        detail.get("pending_permission_request"),
        None | Some(Value::Null)
    ));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_stream_does_not_start_connector_auth_from_user_keywords_before_codex() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (_state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));

    let response = app
        .oneshot(response_request(
            json!({
                "model": "codex-test",
                "messages": [{"role": "user", "content": "请连接 Notion"}],
                "stream": true
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("text/event-stream")
    );
    let body = response_text(response).await;
    assert!(!body.contains("\"ripple_event_type\":\"connector_auth_required\""));
    assert!(!body.contains("\"connector\":\"notion\""));
    assert!(body.contains("\"delta\":\"fake codex completed\""));
    assert!(body.contains("data: [DONE]"));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_stream_cancels_pending_task_trigger_without_codex() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (state, app) = test_state_and_app(&root);
    let user_id = "smoke-user";
    let mut session = state
        .sessions
        .create_session(
            user_id,
            CreateSessionInput {
                model: Some("codex-test".to_string()),
                max_turns: None,
                system_prompt: None,
                context_folder_path: None,
            },
        )
        .await
        .unwrap();
    session.status = "awaiting_user_input".to_string();
    session.pending_control_request = Some(json!({
        "title": "Check build",
        "prompt": "Check the build status",
        "kind": "interval",
        "interval_seconds": 3600,
        "enabled": false,
        "max_runtime_seconds": 60
    }));
    state.sessions.save_record(session.clone()).await.unwrap();

    let response = app
        .oneshot(response_request(
            json!({
                "model": "codex-test",
                "session_id": session.session_id,
                "messages": [{"role": "user", "content": "取消"}],
                "stream": true
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_text(response).await;
    assert!(body.contains("\"ripple_event_type\":\"task_trigger_cancelled\""));
    assert!(body.contains("data: [DONE]"));

    let reloaded = state
        .sessions
        .load(user_id, &session.session_id)
        .await
        .unwrap()
        .expect("session");
    assert!(reloaded.pending_control_request.is_none());
    assert_eq!(reloaded.status, "idle");

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn rust_server_starts_and_serves_health_over_tcp() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let listener = match TcpListener::bind("127.0.0.1:0").await {
        Ok(listener) => listener,
        Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => return,
        Err(err) => panic!("failed to bind test listener: {err}"),
    };
    let addr = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(ripple_server::serve_with_listener(
        listener,
        test_config(&root),
        async {
            let _ = shutdown_rx.await;
        },
    ));

    let url = format!("http://{addr}/health");
    let mut response = None;
    for _ in 0..20 {
        match reqwest::get(&url).await {
            Ok(value) => {
                response = Some(value);
                break;
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(25)).await,
        }
    }
    let response = response.expect("server should answer /health");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body.get("status").and_then(Value::as_str), Some("ok"));

    let _ = shutdown_tx.send(());
    tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .expect("server should stop")
        .expect("server join")
        .expect("server result");

    let _ = std::fs::remove_dir_all(root);
}
