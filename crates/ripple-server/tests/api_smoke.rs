use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{Method, Request, StatusCode};
use ripple_server::api::{router, schedules::trigger_due_schedules};
use ripple_server::config::{
    AppConfig, CodexConfig, FeishuConfig, GogcliOAuthConfig, LoggingConfig, SandboxConfig,
    SkillsConfig,
};
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
        default_model: "codex-test".to_string(),
        model_presets: BTreeMap::new(),
        logging: LoggingConfig {
            level: "debug".to_string(),
        },
        sandbox: SandboxConfig {
            sandboxes_root: root.join("sandboxes"),
            caches_root: root.join("cache"),
            idle_suspend_seconds: 1800,
            retention_seconds: 604_800,
            max_workspace_mb: 2048,
            tmpfs_size_mb: 64,
            nsjail_path: "nsjail".to_string(),
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
            codex_home: None,
            approval_policy: "never".to_string(),
            sandbox_type: "workspace-write".to_string(),
            network_access: true,
            idle_timeout_seconds: 1800,
            max_runtime_seconds: 3600,
        },
        schedule_extraction_max_runtime_seconds: 120,
        schedule_poll_interval_seconds: 15,
        skills: SkillsConfig {
            shared_dirs: Vec::new(),
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

fn test_config_with_fake_connector_cli(root: &Path) -> AppConfig {
    let mut config = test_config(root);
    config.sandbox.nsjail_path = write_fake_connector_cli(root);
    config.sandbox.gogcli_cli_install_root = Some(root.join("vendor/gogcli-cli"));
    config.sandbox.lark_cli_install_root = Some(root.join("vendor/lark-cli"));
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

fn schedule_extraction_text() -> &'static str {
    "{\"is_schedule_request\":true,\"missing_fields\":[],\"clarification_question\":null,\"schedule\":{\"title\":\"Check build\",\"prompt\":\"Check the build status\",\"kind\":\"interval\",\"timezone\":\"UTC\",\"run_at\":null,\"interval_seconds\":3600,\"enabled\":false,\"cwd\":null,\"model\":null,\"effort\":null,\"summary\":null,\"output_schema\":null,\"max_runtime_seconds\":60,\"max_runs\":null}}"
}

fn main() {
    let stdin = io::stdin();
    let mut thread_counter = 0_u64;
    let mut turn_counter = 0_u64;
    let mut pending_approvals: HashMap<String, (String, String, String, String)> = HashMap::new();

    for line_result in stdin.lock().lines() {
        let Ok(line) = line_result else {
            continue;
        };
        let method = extract_string_field(&line, "method");
        let request_id = extract_id(&line);

        match (request_id.as_ref(), method.as_deref()) {
            (Some(id), Some("initialize")) => {
                send(format!("{{\"id\":{},\"result\":{{}}}}", id.raw_json()));
            }
            (_, Some("initialized")) => {}
            (Some(id), Some("thread/start")) => {
                thread_counter += 1;
                send(format!(
                    "{{\"id\":{},\"result\":{{\"thread\":{{\"id\":\"thread-{thread_counter}\"}}}}}}",
                    id.raw_json()
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

                let text = if line.contains("[env-check]") {
                    if std::env::var("RIPPLE_SECRET_SHOULD_NOT_LEAK").is_ok() {
                        "env leaked".to_string()
                    } else if std::env::var("HTTP_PROXY").ok().as_deref()
                        == Some("http://proxy.example:8080")
                    {
                        "env clean proxy present".to_string()
                    } else {
                        "env clean proxy missing".to_string()
                    }
                } else if line.contains("\"outputSchema\"") {
                    schedule_extraction_text().to_string()
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

                if line.contains("[slow]") {
                    thread::sleep(Duration::from_millis(500));
                }
                if line.contains("[runtime-events]") {
                    emit_runtime_events(&thread_id, &turn_id);
                }
                complete_turn(&thread_id, &turn_id, &item_id, &text);
            }
            (Some(id), None) => {
                if let Some(key) = id.as_string_key() {
                    if let Some((thread_id, turn_id, item_id, text)) = pending_approvals.remove(key)
                    {
                        complete_turn(&thread_id, &turn_id, &item_id, &text);
                    }
                }
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

async fn response_json(response: axum::response::Response) -> Value {
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
}

async fn response_text(response: axum::response::Response) -> String {
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    String::from_utf8_lossy(&bytes).into_owned()
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

fn test_state_and_app(root: &Path) -> (AppState, axum::Router) {
    let state = AppState::new(test_config(root));
    let app = router(state.clone());
    (state, app)
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
    assert!(session_json
        .get("session_id")
        .and_then(Value::as_str)
        .is_some_and(|value| value.starts_with("srv-")));

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

    let tasks = app
        .oneshot(request(Method::GET, "/v1/tasks", Value::Null, true))
        .await
        .unwrap();
    assert_eq!(tasks.status(), StatusCode::GONE);

    let _ = std::fs::remove_dir_all(root);
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
async fn router_serves_schedule_crud_routes_without_starting_codex() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (_state, app) = test_state_and_app(&root);

    let (status, created) = call(
        app.clone(),
        Method::POST,
        "/v1/schedules",
        json!({
            "title": "Check build",
            "prompt": "Check the build status",
            "kind": "interval",
            "interval_seconds": 3600,
            "enabled": true,
            "max_runtime_seconds": 60
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let schedule_id = created
        .get("schedule_id")
        .and_then(Value::as_str)
        .expect("schedule id")
        .to_string();
    assert_eq!(
        created.get("status").and_then(Value::as_str),
        Some("active")
    );

    let (status, list) = call(app.clone(), Method::GET, "/v1/schedules", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list.get("count").and_then(Value::as_u64), Some(1));

    let (status, runs) = call(
        app.clone(),
        Method::GET,
        &format!("/v1/schedules/{schedule_id}/runs"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(runs.get("count").and_then(Value::as_u64), Some(0));

    let (status, updated) = call(
        app.clone(),
        Method::PATCH,
        &format!("/v1/schedules/{schedule_id}"),
        json!({
            "title": "Paused build check",
            "enabled": false,
            "cwd": "/workspace",
            "model": "codex-test",
            "max_runs": 5
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        updated.get("title").and_then(Value::as_str),
        Some("Paused build check")
    );
    assert_eq!(
        updated.get("status").and_then(Value::as_str),
        Some("paused")
    );
    assert_eq!(
        updated.get("cwd").and_then(Value::as_str),
        Some("/workspace")
    );
    assert_eq!(updated.get("max_runs").and_then(Value::as_u64), Some(5));

    let (status, cleared) = call(
        app.clone(),
        Method::PATCH,
        &format!("/v1/schedules/{schedule_id}"),
        json!({"cwd": null, "model": null, "max_runs": null, "run_at": null}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(cleared.get("cwd").is_some_and(Value::is_null));
    assert!(cleared.get("model").is_some_and(Value::is_null));
    assert!(cleared.get("max_runs").is_some_and(Value::is_null));

    let (status, deleted) = call(
        app.clone(),
        Method::DELETE,
        &format!("/v1/schedules/{schedule_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(deleted.get("ok").and_then(Value::as_bool), Some(true));

    let (status, list) = call(app, Method::GET, "/v1/schedules", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list.get("count").and_then(Value::as_u64), Some(0));

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
    let output_file = final_run
        .get("output_file")
        .and_then(Value::as_str)
        .expect("output file");
    assert_eq!(
        fs::read_to_string(output_file).unwrap(),
        "fake codex completed"
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
    assert!(events.contains("\"type\":\"runner.started\""));
    assert!(events.contains("\"type\":\"codex.notification\""));
    assert!(events.contains("\"type\":\"runner.completed\""));
    assert!(events.contains("data: [DONE]"));

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
    let (_state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));

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
    assert_eq!(second.get("status").and_then(Value::as_str), Some("queued"));
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
async fn delete_sandbox_cancels_live_user_runs_before_teardown() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (_state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));

    let (status, run) = call(
        app.clone(),
        Method::POST,
        "/v1/runs",
        json!({
            "prompt": "[slow] run that should be cancelled by sandbox teardown",
            "model": "codex-test",
            "max_runtime_seconds": 5
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(run.get("job_id").and_then(Value::as_str).is_some());
    let (status, _session) = call(
        app.clone(),
        Method::POST,
        "/v1/sessions",
        json!({"model": "codex-test"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, deleted) = call(app.clone(), Method::DELETE, "/v1/sandboxes", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(deleted.get("ok").and_then(Value::as_bool), Some(true));
    assert!(
        deleted
            .get("cancelled_run_count")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            >= 1
    );

    let response = app
        .clone()
        .oneshot(request(Method::GET, "/v1/sandboxes", Value::Null, true))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let (status, sessions) = call(app.clone(), Method::GET, "/v1/sessions", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(sessions.get("count").and_then(Value::as_u64), Some(0));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn schedule_run_now_completes_with_fake_codex_app_server() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (_state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));

    let (status, schedule) = call(
        app.clone(),
        Method::POST,
        "/v1/schedules",
        json!({
            "title": "Manual check",
            "prompt": "Run the manual check",
            "kind": "interval",
            "interval_seconds": 3600,
            "enabled": true,
            "max_runtime_seconds": 5
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let schedule_id = schedule
        .get("schedule_id")
        .and_then(Value::as_str)
        .expect("schedule id")
        .to_string();

    let (status, run) = call(
        app.clone(),
        Method::POST,
        &format!("/v1/schedules/{schedule_id}/run-now"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let job_id = run
        .get("job_id")
        .and_then(Value::as_str)
        .expect("job id")
        .to_string();

    let mut completed = false;
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
            completed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(completed, "manual schedule run should complete");

    let (status, runs) = call(
        app,
        Method::GET,
        &format!("/v1/schedules/{schedule_id}/runs"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(runs.get("count").and_then(Value::as_u64), Some(1));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn schedule_run_now_records_error_when_start_fails() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (_state, app) = test_state_and_app(&root);

    let (status, schedule) = call(
        app.clone(),
        Method::POST,
        "/v1/schedules",
        json!({
            "title": "Bad cwd",
            "prompt": "This should not start",
            "kind": "once",
            "run_at": "2099-01-01T00:00:00Z",
            "cwd": "/etc",
            "max_runtime_seconds": 60
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let schedule_id = schedule
        .get("schedule_id")
        .and_then(Value::as_str)
        .expect("schedule id")
        .to_string();

    let (status, failed) = call(
        app.clone(),
        Method::POST,
        &format!("/v1/schedules/{schedule_id}/run-now"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(failed
        .get("detail")
        .and_then(Value::as_str)
        .is_some_and(|detail| detail.contains("cwd must stay inside")));

    let (status, reloaded) = call(
        app,
        Method::GET,
        &format!("/v1/schedules/{schedule_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        reloaded.get("status").and_then(Value::as_str),
        Some("error")
    );
    assert!(reloaded
        .get("last_error")
        .and_then(Value::as_str)
        .is_some_and(|detail| detail.contains("cwd must stay inside")));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn schedule_due_trigger_starts_fake_codex_app_server_run() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));

    let (status, schedule) = call(
        app.clone(),
        Method::POST,
        "/v1/schedules",
        json!({
            "title": "Due check",
            "prompt": "Run the due check",
            "kind": "interval",
            "interval_seconds": 3600,
            "enabled": true,
            "max_runtime_seconds": 5
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let schedule_id = schedule
        .get("schedule_id")
        .and_then(Value::as_str)
        .expect("schedule id")
        .to_string();

    let mut schedule_records = state.storage.list_schedules("smoke-user").await.unwrap();
    for record in &mut schedule_records {
        if record.get("schedule_id").and_then(Value::as_str) == Some(schedule_id.as_str()) {
            record["next_run_at"] = json!("2000-01-01T00:00:00Z");
        }
    }
    state
        .storage
        .replace_schedules("smoke-user", &schedule_records)
        .await
        .unwrap();

    let triggered = trigger_due_schedules(&state)
        .await
        .expect("trigger due schedules");
    assert_eq!(
        triggered
            .get("smoke-user")
            .and_then(|ids| ids.first())
            .map(String::as_str),
        Some(schedule_id.as_str())
    );

    let (status, schedule) = call(
        app.clone(),
        Method::GET,
        &format!("/v1/schedules/{schedule_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(schedule.get("run_count").and_then(Value::as_u64), Some(1));
    let job_id = schedule
        .get("last_run_id")
        .and_then(Value::as_str)
        .expect("last run id")
        .to_string();

    let mut completed = false;
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
            completed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(completed, "due schedule run should complete");

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
async fn chat_route_confirms_pending_schedule_without_starting_codex() {
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
            },
        )
        .await
        .unwrap();
    session.status = "awaiting_user_input".to_string();
    session.pending_schedule_request = Some(json!({
        "title": "Check build",
        "prompt": "Check the build status",
        "kind": "interval",
        "interval_seconds": 3600,
        "enabled": false,
        "max_runtime_seconds": 60
    }));
    state.sessions.save_record(session.clone()).await.unwrap();

    let (status, chat) = call(
        app.clone(),
        Method::POST,
        "/v1/chat/completions",
        json!({
            "model": "codex-test",
            "session_id": session.session_id,
            "messages": [{"role": "user", "content": "确认创建"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        chat.pointer("/event/type").and_then(Value::as_str),
        Some("schedule_created")
    );
    assert_eq!(
        chat.pointer("/event/schedule/title")
            .and_then(Value::as_str),
        Some("Check build")
    );

    let reloaded = state
        .sessions
        .load(
            user_id,
            chat.get("session_id").and_then(Value::as_str).unwrap(),
        )
        .await
        .unwrap()
        .expect("session");
    assert_eq!(reloaded.status, "idle");
    assert!(reloaded.pending_schedule_request.is_none());
    assert_eq!(reloaded.message_count, 2);

    let (status, schedules) = call(app, Method::GET, "/v1/schedules", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(schedules.get("count").and_then(Value::as_u64), Some(1));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_route_proposes_schedule_with_fake_codex_extraction() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let user_id = "smoke-user";

    let (status, chat) = call(
        app,
        Method::POST,
        "/v1/chat/completions",
        json!({
            "model": "codex-test",
            "messages": [{"role": "user", "content": "schedule this every hour: Check build"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        chat.pointer("/event/type").and_then(Value::as_str),
        Some("schedule_proposed")
    );
    assert_eq!(
        chat.pointer("/event/schedule/title")
            .and_then(Value::as_str),
        Some("Check build")
    );
    assert_eq!(
        chat.pointer("/event/schedule/interval_seconds")
            .and_then(Value::as_u64),
        Some(3600)
    );
    assert_eq!(
        chat.pointer("/choices/0/message/content")
            .and_then(Value::as_str),
        chat.pointer("/event/message").and_then(Value::as_str)
    );

    let session_id = chat
        .get("session_id")
        .and_then(Value::as_str)
        .expect("session id");
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
            .pending_schedule_request
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
async fn chat_route_completes_non_streaming_with_fake_codex_app_server() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let user_id = "smoke-user";

    let (status, chat) = call(
        app.clone(),
        Method::POST,
        "/v1/chat/completions",
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
        chat.pointer("/choices/0/message/content")
            .and_then(Value::as_str),
        Some("fake codex completed")
    );
    assert_eq!(
        chat.pointer("/usage/prompt_tokens").and_then(Value::as_u64),
        Some(10)
    );
    let session_id = chat
        .get("session_id")
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

    let (status, follow_up) = call(
        app.clone(),
        Method::POST,
        "/v1/chat/completions",
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
        follow_up
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str),
        Some("fake codex completed")
    );
    let reloaded = state
        .sessions
        .load(
            user_id,
            follow_up.get("session_id").and_then(Value::as_str).unwrap(),
        )
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
            .oneshot(request(
                Method::POST,
                "/v1/chat/completions",
                json!({
                    "model": "codex-test",
                    "session_id": chat_session_id,
                    "messages": [{"role": "user", "content": "[slow] delete me while running"}],
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
            .oneshot(request(
                Method::POST,
                "/v1/chat/completions",
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

    let (status, second_chat) = call(
        app.clone(),
        Method::POST,
        "/v1/chat/completions",
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
        second_chat
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str),
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
        first_chat
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str),
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
        call(
            first_app,
            Method::POST,
            "/v1/chat/completions",
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
        call(
            second_app,
            Method::POST,
            "/v1/chat/completions",
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
            body.pointer("/event/type").and_then(Value::as_str) == Some("schedule_proposed")
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
    let (status, chat) = call(
        app,
        Method::POST,
        "/v1/chat/completions",
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
        chat.pointer("/choices/0/message/content")
            .and_then(Value::as_str),
        Some("env clean proxy present")
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_follow_up_resumes_codex_thread_without_replaying_turns() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (_state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));

    let (status, first) = call(
        app.clone(),
        Method::POST,
        "/v1/chat/completions",
        json!({
            "model": "codex-test",
            "messages": [{"role": "user", "content": "start a persistent thread"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let session_id = first
        .get("session_id")
        .and_then(Value::as_str)
        .expect("session id")
        .to_string();

    let (status, follow_up) = call(
        app,
        Method::POST,
        "/v1/chat/completions",
        json!({
            "model": "codex-test",
            "session_id": session_id,
            "messages": [{"role": "user", "content": "[ids] continue the persistent thread"}],
            "stream": false
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "follow-up response: {follow_up}");
    assert_eq!(
        follow_up
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str),
        Some("fake codex completed thread-1 turn-1")
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

    let (status, follow_up) = call(
        app.clone(),
        Method::POST,
        "/v1/chat/completions",
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
        .load(
            user_id,
            follow_up.get("session_id").and_then(Value::as_str).unwrap(),
        )
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
        .oneshot(request(
            Method::POST,
            "/v1/chat/completions",
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

    let (status, follow_up) = call(
        app.clone(),
        Method::POST,
        "/v1/chat/completions",
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
        follow_up
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str),
        Some("fake codex completed")
    );

    let reloaded = state
        .sessions
        .load(
            user_id,
            follow_up.get("session_id").and_then(Value::as_str).unwrap(),
        )
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
async fn chat_stream_completes_with_fake_codex_app_server() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let user_id = "smoke-user";

    let response = app
        .oneshot(request(
            Method::POST,
            "/v1/chat/completions",
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
    assert!(body.contains("\"content\":\"fake codex completed\""));
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
async fn chat_stream_forwards_codex_runtime_tool_plan_and_image_events() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let fake_codex = write_fake_codex_app_server(&root);
    let (state, app) =
        test_state_and_app_with_config(test_config_with_codex_executable(&root, fake_codex));
    let user_id = "smoke-user";

    let response = app
        .oneshot(request(
            Method::POST,
            "/v1/chat/completions",
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

    assert!(body.contains("\"type\":\"task_plan_updated\""));
    assert!(body.contains("\"currentTask\":\"Inspect workspace\""));
    assert!(body.contains("\"type\":\"tool_call\""));
    assert!(body.contains("\"name\":\"command_execution\""));
    assert!(body.contains("\"type\":\"tool_output_delta\""));
    assert!(body.contains("\"delta\":\"hello\\n\""));
    assert!(body.contains("\"type\":\"tool_result\""));
    assert!(body.contains("\"type\":\"file_change_patch_updated\""));
    assert!(body.contains("\"type\":\"image_view\""));
    assert!(body.contains("\"workspace_path\":\"/workspace/images/source.png\""));
    assert!(body.contains("\"type\":\"image_generation\""));
    assert!(body.contains("\"workspace_path\":\"/workspace/outputs/images/"));
    assert!(body.contains("/img-1.png\""));
    assert!(body.contains("\"type\":\"usage\""));
    assert!(body.contains("\"content\":\"fake codex completed\""));
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
        .oneshot(request(
            Method::POST,
            "/v1/chat/completions",
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

    let (status, pending) = call(
        app.clone(),
        Method::POST,
        "/v1/chat/completions",
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

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_stream_returns_connector_auth_required_event_without_codex() {
    let root = std::env::temp_dir().join(format!("ripple-api-smoke-{}", Uuid::new_v4()));
    let (_state, app) = test_state_and_app(&root);

    let response = app
        .oneshot(request(
            Method::POST,
            "/v1/chat/completions",
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
    assert!(body.contains("\"type\":\"connector_auth_required\""));
    assert!(body.contains("\"connector\":\"notion\""));
    assert!(body.contains("https://www.notion.so/profile/integrations"));
    assert!(body.contains("Internal Integration"));
    assert!(body.contains("Share"));
    assert!(body.contains("ntn_"));
    assert!(body.contains("secret_"));
    assert!(body.contains("data: [DONE]"));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn chat_stream_cancels_pending_schedule_without_codex() {
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
            },
        )
        .await
        .unwrap();
    session.status = "awaiting_user_input".to_string();
    session.pending_schedule_request = Some(json!({
        "title": "Check build",
        "prompt": "Check the build status",
        "kind": "interval",
        "interval_seconds": 3600,
        "enabled": false,
        "max_runtime_seconds": 60
    }));
    state.sessions.save_record(session.clone()).await.unwrap();

    let response = app
        .oneshot(request(
            Method::POST,
            "/v1/chat/completions",
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
    assert!(body.contains("\"type\":\"schedule_cancelled\""));
    assert!(body.contains("data: [DONE]"));

    let reloaded = state
        .sessions
        .load(user_id, &session.session_id)
        .await
        .unwrap()
        .expect("session");
    assert!(reloaded.pending_schedule_request.is_none());
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
