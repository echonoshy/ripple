use std::path::PathBuf;
use std::process::Output;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use serde_json::{json, Value};
use tokio::process::Command;
use tokio::time::timeout;
use uuid::Uuid;

use crate::config::AppConfig;
use crate::sandbox::SandboxManager;

const RUNTIME_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

pub fn resolve_executable(value: &str) -> Option<PathBuf> {
    let path = PathBuf::from(value);
    if path.components().count() > 1 || path.is_absolute() {
        return path.is_file().then_some(path);
    }
    let search_path = std::env::var_os("PATH")?;
    std::env::split_paths(&search_path)
        .map(|dir| dir.join(value))
        .find(|candidate| candidate.is_file())
}

pub async fn ensure_codex_linux_sandbox_prerequisites(config: &AppConfig) -> anyhow::Result<()> {
    if !config.codex.enabled || is_known_test_codex_executable(&config.codex.codex_executable) {
        return Ok(());
    }
    probe_codex_linux_sandbox(config).await.map(|_| ())
}

pub async fn probe_codex_linux_sandbox(config: &AppConfig) -> anyhow::Result<Value> {
    if !cfg!(target_os = "linux") {
        return Ok(json!({
            "target_os": std::env::consts::OS,
            "required": false
        }));
    }
    if !config.codex.enabled {
        return Ok(json!({
            "enabled": false,
            "required": false
        }));
    }
    if config.codex.sandbox_type != "workspace-write" {
        anyhow::bail!(
            "Codex sandbox_type must be workspace-write for Ripple managed permissions, got {:?}",
            config.codex.sandbox_type
        );
    }
    let codex_path = resolve_executable(&config.codex.codex_executable).with_context(|| {
        format!(
            "Codex executable {:?} was not found",
            config.codex.codex_executable
        )
    })?;
    let bwrap_path =
        resolve_executable("bwrap").context("bubblewrap executable bwrap was not found")?;

    probe_host_process_isolation(
        "if sh -c 'echo no > /etc/ripple-doctor-probe' 2>/dev/null; then exit 45; fi",
        |script| {
            let mut command = Command::new(&bwrap_path);
            command.args([
                "--new-session",
                "--die-with-parent",
                "--ro-bind",
                "/",
                "/",
                "--unshare-user",
                "--unshare-pid",
                "--proc",
                "/proc",
                "--",
                "/bin/sh",
                "-lc",
            ]);
            command.arg(script);
            Ok(command)
        },
    )
    .await
    .context("Codex Linux sandbox bubblewrap process isolation probe failed")?;

    Ok(json!({
        "configured_codex_executable": config.codex.codex_executable,
        "resolved_codex_executable": codex_path,
        "resolved_bwrap": bwrap_path,
        "sandbox_type": config.codex.sandbox_type,
        "pid_namespace": true,
        "fresh_proc": true,
        "host_pid_hidden_from_ps": true,
        "host_kill_blocked": true,
        "host_service_write_blocked": true,
        "fail_closed": true
    }))
}

pub fn ensure_nsjail_config_hardened(config_text: &str) -> anyhow::Result<()> {
    let details = nsjail_config_hardening_details(config_text);
    let required = [
        ("clone_newuser", "clone_newuser: true"),
        ("clone_newns", "clone_newns: true"),
        ("clone_newpid", "clone_newpid: true"),
        ("clone_newipc", "clone_newipc: true"),
        ("clone_newuts", "clone_newuts: true"),
        ("clone_newnet_shared", "clone_newnet: false"),
        ("no_new_privs", "disable_no_new_privs: false"),
        ("fresh_proc", "fresh proc mount"),
        ("workspace_rw", "rw /workspace bind"),
    ];
    let missing = required
        .iter()
        .filter_map(|(field, label)| {
            details
                .get(*field)
                .and_then(Value::as_bool)
                .filter(|value| *value)
                .map(|_| ())
                .is_none()
                .then_some(*label)
        })
        .collect::<Vec<_>>();
    if missing.is_empty() {
        Ok(())
    } else {
        anyhow::bail!(
            "nsjail config is missing required hardening: {}",
            missing.join(", ")
        )
    }
}

pub fn nsjail_config_hardening_details(config_text: &str) -> Value {
    json!({
        "clone_newuser": has_config_line(config_text, "clone_newuser: true"),
        "clone_newns": has_config_line(config_text, "clone_newns: true"),
        "clone_newpid": has_config_line(config_text, "clone_newpid: true"),
        "clone_newipc": has_config_line(config_text, "clone_newipc: true"),
        "clone_newuts": has_config_line(config_text, "clone_newuts: true"),
        "clone_newnet_shared": has_config_line(config_text, "clone_newnet: false"),
        "no_new_privs": has_config_line(config_text, "disable_no_new_privs: false"),
        "fresh_proc": has_mount_block_with_lines(
            config_text,
            &["dst: \"/proc\"", "fstype: \"proc\"", "rw: false"],
        ),
        "workspace_rw": has_mount_block_with_lines(
            config_text,
            &["dst: \"/workspace\"", "is_bind: true", "rw: true"],
        )
    })
}

pub async fn probe_nsjail_runtime(config: Arc<AppConfig>) -> anyhow::Result<Value> {
    let nsjail_path = resolve_executable(&config.sandbox.nsjail_path).with_context(|| {
        format!(
            "nsjail executable {:?} was not found",
            config.sandbox.nsjail_path
        )
    })?;
    let user_id = format!("doctorprobe_{}", Uuid::new_v4().simple());
    let other_user_id = format!("doctorother_{}", Uuid::new_v4().simple());
    let configured_nsjail = config.sandbox.nsjail_path.clone();
    let codex_auth_path = Some(config.codex_home_path().join("auth.json"));
    let manager = SandboxManager::new(config);
    let result = async {
        manager.ensure_sandbox(&user_id)?;
        manager.ensure_sandbox(&other_user_id)?;
        let other_secret = manager
            .workspace_dir(&other_user_id)?
            .join("doctor-secret.txt");
        std::fs::write(&other_secret, b"secret")?;
        let mut extra_script = format!(
            "if cat {} >/dev/null 2>&1; then exit 44; fi\n\
             if sh -c 'echo no > /etc/ripple-doctor-probe' 2>/dev/null; then exit 45; fi",
            shell_quote(other_secret.to_string_lossy().as_ref())
        );
        if let Some(path) = &codex_auth_path {
            extra_script.push_str(&format!(
                "\nif cat {} >/dev/null 2>&1; then exit 46; fi",
                shell_quote(path.to_string_lossy().as_ref())
            ));
        }
        probe_host_process_isolation(&extra_script, |script| {
            let argv = manager.nsjail_exec_argv(&user_id, "/bin/sh", &["-lc", script])?;
            let mut command = Command::new(&argv[0]);
            command.args(&argv[1..]);
            Ok(command)
        })
        .await
        .context("nsjail runtime probe failed")?;
        Ok::<_, anyhow::Error>(json!({
            "configured_nsjail": configured_nsjail,
            "resolved_nsjail": nsjail_path,
            "clone_newpid": true,
            "fresh_proc": true,
            "clone_newnet": false,
            "host_pid_hidden_from_ps": true,
            "host_kill_blocked": true,
            "other_user_file_read_blocked": true,
            "host_service_write_blocked": true,
            "codex_auth_read_blocked": codex_auth_path.is_some(),
            "fail_closed": true
        }))
    }
    .await;
    let cleanup_primary = manager.teardown_sandbox(&user_id, true);
    let cleanup_other = manager.teardown_sandbox(&other_user_id, true);
    match (result, cleanup_primary, cleanup_other) {
        (Ok(details), Ok(_), Ok(_)) => Ok(details),
        (Ok(_), Err(err), _) | (Ok(_), _, Err(err)) => {
            Err(err).context("failed to remove nsjail runtime probe sandbox")
        }
        (Err(err), _, _) => Err(err),
    }
}

async fn probe_host_process_isolation<F>(
    extra_script: &str,
    mut build_command: F,
) -> anyhow::Result<()>
where
    F: FnMut(&str) -> anyhow::Result<Command>,
{
    let mut sentinel = Command::new("/bin/sleep")
        .arg("60")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("failed to start host sentinel process for runtime probe")?;
    let sentinel_pid = sentinel
        .id()
        .context("host sentinel process did not expose a pid")?;
    let script = format!(
        r#"test -d /proc/self && test -r /proc/self/status || exit 40
ps_output="$(ps -ef)" || exit 41
if printf '%s\n' "$ps_output" | awk '{{print $2}}' | grep -qx '{sentinel_pid}'; then exit 42; fi
if kill -TERM {sentinel_pid} 2>/dev/null; then exit 43; fi
{extra_script}
"#
    );
    let result = async {
        let command = build_command(&script)?;
        let output = run_probe(command, RUNTIME_PROBE_TIMEOUT)
            .await
            .context("runtime process isolation probe failed")?;
        ensure_success(
            output,
            "runtime process isolation probe exited unsuccessfully",
        )
    }
    .await;
    let sentinel_alive = sentinel
        .try_wait()
        .context("failed to inspect host sentinel process")?
        .is_none();
    let _ = sentinel.start_kill();
    let _ = sentinel.wait().await;
    result?;
    if !sentinel_alive {
        anyhow::bail!("host sentinel process was terminated by sandbox probe");
    }
    Ok(())
}

async fn run_probe(mut command: Command, deadline: Duration) -> anyhow::Result<Output> {
    timeout(deadline, command.output())
        .await
        .context("runtime probe timed out")?
        .context("runtime probe process failed to start")
}

fn ensure_success(output: Output, message: &str) -> anyhow::Result<()> {
    if output.status.success() {
        return Ok(());
    }
    anyhow::bail!(
        "{message}: status={:?}, stdout_tail={:?}, stderr_tail={:?}",
        output.status.code(),
        tail_lossy(&output.stdout),
        tail_lossy(&output.stderr)
    )
}

fn tail_lossy(bytes: &[u8]) -> String {
    const MAX_TAIL_BYTES: usize = 4096;
    let start = bytes.len().saturating_sub(MAX_TAIL_BYTES);
    String::from_utf8_lossy(&bytes[start..]).to_string()
}

fn has_config_line(config_text: &str, needle: &str) -> bool {
    config_text.lines().any(|line| line.trim() == needle)
}

fn has_mount_block_with_lines(config_text: &str, required_lines: &[&str]) -> bool {
    config_text.split("\n\n").any(|block| {
        block.lines().any(|line| line.trim() == "mount {")
            && required_lines
                .iter()
                .all(|needle| block.lines().any(|line| line.trim() == *needle))
    })
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r#"'\''"#))
}

fn is_known_test_codex_executable(value: &str) -> bool {
    PathBuf::from(value)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("fake-codex-app-server"))
}
