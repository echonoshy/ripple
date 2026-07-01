use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ripple_server::config::{
    AppConfig, CodexConfig, CorsConfig, FeishuConfig, GogcliOAuthConfig, LoggingConfig,
    SandboxConfig, SecurityConfig, SkillsConfig, UserAuthConfig,
};
use ripple_server::python_env::{
    ensure_ripple_py_wrapper, run_ripple_py_cli, PythonEnvKeyInput, PythonEnvManager,
    PythonEnvRequest,
};

#[test]
fn python_env_key_is_stable_for_requirement_order() {
    let left = PythonEnvKeyInput {
        python_tag: "cpython-3.11-x86_64-linux-gnu".to_string(),
        index_url: Some("https://pypi.example/simple".to_string()),
        lock_content: "a==1\nb==2\n".to_string(),
    };
    let right = PythonEnvKeyInput {
        python_tag: "cpython-3.11-x86_64-linux-gnu".to_string(),
        index_url: Some("https://pypi.example/simple".to_string()),
        lock_content: "a==1\nb==2\n".to_string(),
    };

    assert_eq!(left.env_key(), right.env_key());
}

#[test]
fn python_env_key_changes_for_python_tag_and_index() {
    let base = PythonEnvKeyInput {
        python_tag: "cpython-3.11-x86_64-linux-gnu".to_string(),
        index_url: Some("https://pypi.example/simple".to_string()),
        lock_content: "six==1.17.0\n".to_string(),
    };
    let different_python = PythonEnvKeyInput {
        python_tag: "cpython-3.12-x86_64-linux-gnu".to_string(),
        ..base.clone()
    };
    let different_index = PythonEnvKeyInput {
        index_url: Some("https://mirror.example/simple".to_string()),
        ..base.clone()
    };

    assert_ne!(base.env_key(), different_python.env_key());
    assert_ne!(base.env_key(), different_index.env_key());
}

#[test]
fn python_env_request_rejects_unsafe_requirement_specs() {
    for requirement in [
        "https://example.com/pkg.whl",
        "name @ https://example.com/pkg.whl",
        "-r requirements.txt",
        "--editable .",
        "../local-package",
        "./local-package",
        "/tmp/local-package",
    ] {
        assert!(
            PythonEnvRequest::new(vec![requirement.to_string()], 20).is_err(),
            "accepted unsafe requirement: {requirement}"
        );
    }
}

#[test]
fn python_env_request_normalizes_and_deduplicates_requirements() {
    let request = PythonEnvRequest::new(
        vec![
            "six==1.17.0".to_string(),
            "PyMuPDF==1.24.0".to_string(),
            "six==1.17.0".to_string(),
        ],
        20,
    )
    .expect("valid request");

    assert_eq!(
        request.requirements(),
        &["PyMuPDF==1.24.0".to_string(), "six==1.17.0".to_string()]
    );
}

#[test]
fn python_env_manager_reuses_existing_environment() {
    let root = temp_root("manager-reuse");
    let fake_uv_bin = root.join("fake-bin");
    let log_path = root.join("fake-uv.log");
    write_fake_uv(&fake_uv_bin, &log_path);
    let mut config = test_config(&root);
    config.sandbox.uv_bin_dir = Some(fake_uv_bin);
    let manager = PythonEnvManager::new(Arc::new(config));
    let request =
        PythonEnvRequest::new(vec!["six==1.17.0".to_string()], 20).expect("valid request");

    let first = manager.ensure(&request).expect("create env");
    let second = manager.ensure(&request).expect("reuse env");

    assert_eq!(first.env_key, second.env_key);
    assert_eq!(first.env_path, second.env_path);
    assert!(first.python_executable.ends_with("bin/python"));
    let log = fs::read_to_string(&log_path).expect("fake uv log");
    assert_eq!(log.matches("pip sync").count(), 1, "{log}");
    assert_eq!(
        fs::metadata(&first.env_path)
            .expect("env metadata")
            .permissions()
            .mode()
            & 0o222,
        0,
        "shared env should be read-only"
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn ripple_py_python_runs_inside_shared_environment() {
    let root = temp_root("cli-python");
    let fake_uv_bin = root.join("fake-bin");
    let log_path = root.join("fake-uv.log");
    write_fake_uv(&fake_uv_bin, &log_path);
    let mut config = test_config(&root);
    config.sandbox.uv_bin_dir = Some(fake_uv_bin);
    let args = vec![
        "python".to_string(),
        "--with".to_string(),
        "six==1.17.0".to_string(),
        "--".to_string(),
        "-c".to_string(),
        "import six".to_string(),
    ];

    let exit_code = run_ripple_py_cli(config, &args).expect("run ripple-py python");

    assert_eq!(exit_code, 0);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn python_wrappers_route_plain_python_commands_through_ripple_py() {
    let root = temp_root("wrappers");
    let config = test_config(&root);

    let wrapper = ensure_ripple_py_wrapper(&config).expect("create wrappers");

    assert_eq!(wrapper, root.join("cache/bin/ripple-py"));
    let python = fs::read_to_string(root.join("cache/bin/python")).expect("python wrapper");
    let python3 = fs::read_to_string(root.join("cache/bin/python3")).expect("python3 wrapper");
    let pip = fs::read_to_string(root.join("cache/bin/pip")).expect("pip wrapper");
    assert!(python.contains("ripple-py python"));
    assert!(python3.contains("ripple-py python"));
    assert!(python.contains("RIPPLE_HOST_PYTHON3="));
    assert!(pip.contains("pip is disabled"));

    let _ = fs::remove_dir_all(root);
}

fn temp_root(name: &str) -> PathBuf {
    let root =
        std::env::temp_dir().join(format!("ripple-python-env-{name}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).expect("create temp root");
    root
}

fn write_fake_uv(bin_dir: &Path, log_path: &Path) {
    fs::create_dir_all(bin_dir).expect("create fake uv bin dir");
    let uv = bin_dir.join("uv");
    fs::write(
        &uv,
        format!(
            r#"#!/bin/sh
set -eu
printf '%s\n' "$*" >> {}

if [ "$1" = "pip" ] && [ "$2" = "compile" ]; then
  input="$3"
  output=""
  previous=""
  for arg in "$@"; do
    if [ "$previous" = "--output-file" ]; then
      output="$arg"
    fi
    previous="$arg"
  done
  mkdir -p "$(dirname "$output")"
  cp "$input" "$output"
  exit 0
fi

if [ "$1" = "venv" ]; then
  target=""
  for arg in "$@"; do
    target="$arg"
  done
  mkdir -p "$target/bin"
  cat > "$target/bin/python" <<'PY'
#!/bin/sh
env_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
export PYTHONPATH="$env_dir/lib/python-test/site-packages${{PYTHONPATH:+:$PYTHONPATH}}"
exec python3 "$@"
PY
  chmod +x "$target/bin/python"
  exit 0
fi

if [ "$1" = "pip" ] && [ "$2" = "sync" ]; then
  python=""
  previous=""
  for arg in "$@"; do
    if [ "$previous" = "--python" ]; then
      python="$arg"
    fi
    previous="$arg"
  done
  env_dir="$(dirname "$(dirname "$python")")"
  mkdir -p "$env_dir/lib/python-test/site-packages"
  echo "__version__ = '1.17.0'" > "$env_dir/lib/python-test/site-packages/six.py"
  echo synced > "$env_dir/synced.txt"
  exit 0
fi

echo "unexpected fake uv args: $*" >&2
exit 64
"#,
            shell_quote(&log_path.to_string_lossy())
        ),
    )
    .expect("write fake uv");
    let mut permissions = fs::metadata(&uv).expect("fake uv metadata").permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&uv, permissions).expect("chmod fake uv");
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn test_config(root: &Path) -> AppConfig {
    AppConfig {
        repo_root: root.to_path_buf(),
        host: "127.0.0.1".to_string(),
        port: 0,
        api_keys: Vec::new(),
        security: SecurityConfig::default(),
        user_auth: UserAuthConfig::default(),
        api_docs: ripple_server::config::ApiDocsConfig::default(),
        cors: CorsConfig::default(),
        default_model: "codex-test".to_string(),
        model_presets: BTreeMap::new(),
        logging: LoggingConfig {
            level: "debug".to_string(),
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
            codex_home: None,
            approval_policy: "never".to_string(),
            sandbox_type: "workspace-write".to_string(),
            network_access: true,
            idle_timeout_seconds: 1800,
            max_workers_per_pool: 8,
            max_total_pool_workers: 256,
            memory: ripple_server::config::CodexMemoryConfig::default(),
            max_runtime_seconds: 3600,
            runtime_log_retention_seconds: 86_400,
            runtime_log_max_mb: 64,
            runtime_log_cleanup_interval_seconds: 3600,
        },
        task_trigger_extraction_max_runtime_seconds: 120,
        task_trigger_poll_interval_seconds: 15,
        document_preview: ripple_server::config::DocumentPreviewConfig {
            cache_root: root.join("cache/previews"),
            libreoffice_path: "soffice".to_string(),
            max_source_bytes: 64 * 1024 * 1024,
            conversion_timeout_seconds: 120,
        },
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
