use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::config::AppConfig;

const LOCK_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Debug)]
pub struct PythonEnvRequest {
    requirements: Vec<String>,
}

impl PythonEnvRequest {
    pub fn new(requirements: Vec<String>, max_packages: usize) -> Result<Self> {
        if requirements.is_empty() {
            anyhow::bail!("at least one --with requirement is required");
        }
        if requirements.len() > max_packages {
            anyhow::bail!(
                "too many Python requirements: got {}, max {}",
                requirements.len(),
                max_packages
            );
        }
        let mut normalized = BTreeSet::new();
        for requirement in requirements {
            let requirement = requirement.trim();
            validate_requirement(requirement)?;
            normalized.insert(requirement.to_string());
        }
        Ok(Self {
            requirements: normalized.into_iter().collect(),
        })
    }

    pub fn requirements(&self) -> &[String] {
        &self.requirements
    }
}

#[derive(Clone, Debug)]
pub struct PythonEnvKeyInput {
    pub python_tag: String,
    pub index_url: Option<String>,
    pub lock_content: String,
}

impl PythonEnvKeyInput {
    pub fn env_key(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(b"ripple-python-env-v1\n");
        hasher.update(self.python_tag.as_bytes());
        hasher.update(b"\n");
        hasher.update(self.index_url.as_deref().unwrap_or("").as_bytes());
        hasher.update(b"\n");
        hasher.update(self.lock_content.as_bytes());
        format!("py-{}", hex_digest(hasher.finalize().as_slice()))
    }
}

#[derive(Clone, Debug)]
pub struct PythonEnvManager {
    config: Arc<AppConfig>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PythonEnvInfo {
    pub env_key: String,
    pub env_path: PathBuf,
    pub python_executable: PathBuf,
    pub lock_path: PathBuf,
    pub requirements: Vec<String>,
}

impl PythonEnvManager {
    pub fn new(config: Arc<AppConfig>) -> Self {
        Self { config }
    }

    pub fn ensure(&self, request: &PythonEnvRequest) -> Result<PythonEnvInfo> {
        fs::create_dir_all(&self.config.sandbox.python_envs_root)?;
        fs::create_dir_all(self.lock_root())?;
        fs::create_dir_all(&self.config.sandbox.python_env_uv_cache)?;

        let python_tag = python_tag()?;
        let lock_content = self.compile_lock(request, &python_tag)?;
        let key_input = PythonEnvKeyInput {
            python_tag,
            index_url: self.config.sandbox.pypi_mirror_url.clone(),
            lock_content: canonical_lock_content(&lock_content),
        };
        let env_key = key_input.env_key();
        let env_path = self.config.sandbox.python_envs_root.join(&env_key);
        let python_executable = env_path.join("bin/python");
        let lock_path = self.lock_root().join(format!("{env_key}.requirements.txt"));
        if !lock_path.exists() {
            fs::write(&lock_path, &lock_content)?;
            set_file_readonly(&lock_path)?;
        }
        if python_executable.is_file() {
            return Ok(PythonEnvInfo {
                env_key,
                env_path,
                python_executable,
                lock_path,
                requirements: request.requirements.clone(),
            });
        }

        let _guard = EnvLockGuard::acquire(self.lock_root().join(format!("{env_key}.lock")))?;
        if python_executable.is_file() {
            return Ok(PythonEnvInfo {
                env_key,
                env_path,
                python_executable,
                lock_path,
                requirements: request.requirements.clone(),
            });
        }

        self.build_env(&env_path, &lock_path)?;
        make_tree_readonly(&env_path)?;

        Ok(PythonEnvInfo {
            env_key,
            env_path,
            python_executable,
            lock_path,
            requirements: request.requirements.clone(),
        })
    }

    fn compile_lock(&self, request: &PythonEnvRequest, python_tag: &str) -> Result<String> {
        let request_root = self.lock_root().join("requests");
        fs::create_dir_all(&request_root)?;
        let request_hash = stable_hash(&[
            python_tag,
            self.config.sandbox.pypi_mirror_url.as_deref().unwrap_or(""),
            &request.requirements.join("\n"),
        ]);
        let input_path = request_root.join(format!("{request_hash}.in"));
        let output_path = request_root.join(format!(
            "{request_hash}.{}.requirements.txt",
            Uuid::new_v4().simple()
        ));
        fs::write(
            &input_path,
            format!("{}\n", request.requirements.join("\n")),
        )?;

        let output = self
            .uv_command()
            .arg("pip")
            .arg("compile")
            .arg(&input_path)
            .arg("--output-file")
            .arg(&output_path)
            .arg("--generate-hashes")
            .arg("--no-build")
            .arg("--only-binary")
            .arg(":all:")
            .arg("--cache-dir")
            .arg(&self.config.sandbox.python_env_uv_cache)
            .arg("--python")
            .arg("python3")
            .output()
            .context("failed to run uv pip compile")?;
        if !output.status.success() {
            anyhow::bail!(
                "uv pip compile failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        let lock_content = fs::read_to_string(&output_path)?;
        let _ = fs::remove_file(output_path);
        Ok(lock_content)
    }

    fn build_env(&self, env_path: &Path, lock_path: &Path) -> Result<()> {
        let tmp_env = self
            .config
            .sandbox
            .python_envs_root
            .join(format!(".tmp-{}", Uuid::new_v4().simple()));
        if tmp_env.exists() {
            fs::remove_dir_all(&tmp_env)?;
        }
        let venv_output = self
            .uv_command()
            .arg("venv")
            .arg("--python")
            .arg("python3")
            .arg(&tmp_env)
            .output()
            .context("failed to run uv venv")?;
        if !venv_output.status.success() {
            let _ = fs::remove_dir_all(&tmp_env);
            anyhow::bail!(
                "uv venv failed: {}",
                String::from_utf8_lossy(&venv_output.stderr).trim()
            );
        }

        let python = tmp_env.join("bin/python");
        let sync_output = self
            .uv_command()
            .arg("pip")
            .arg("sync")
            .arg("--python")
            .arg(&python)
            .arg(lock_path)
            .arg("--no-build")
            .arg("--only-binary")
            .arg(":all:")
            .arg("--cache-dir")
            .arg(&self.config.sandbox.python_env_uv_cache)
            .arg("--link-mode")
            .arg("copy")
            .output()
            .context("failed to run uv pip sync")?;
        if !sync_output.status.success() {
            let _ = fs::remove_dir_all(&tmp_env);
            anyhow::bail!(
                "uv pip sync failed: {}",
                String::from_utf8_lossy(&sync_output.stderr).trim()
            );
        }

        if env_path.exists() {
            fs::remove_dir_all(&tmp_env)?;
        } else {
            fs::rename(&tmp_env, env_path)?;
        }
        Ok(())
    }

    fn lock_root(&self) -> PathBuf {
        self.config.sandbox.caches_root.join("python-env-locks")
    }

    fn uv_command(&self) -> Command {
        let uv = self
            .config
            .sandbox
            .uv_bin_dir
            .as_ref()
            .map(|path| path.join("uv"))
            .unwrap_or_else(|| PathBuf::from("uv"));
        let mut command = Command::new(uv);
        command.env("UV_CACHE_DIR", &self.config.sandbox.python_env_uv_cache);
        command.env("UV_LINK_MODE", "copy");
        if let Some(url) = &self.config.sandbox.pypi_mirror_url {
            command.env("UV_INDEX_URL", url);
            command.env("UV_DEFAULT_INDEX", url);
            command.env("PIP_INDEX_URL", url);
        }
        command
    }
}

pub fn run_ripple_py_cli(config: AppConfig, args: &[String]) -> Result<i32> {
    let command = RipplePyCommand::parse(args, config.sandbox.python_env_max_packages)?;
    let manager = PythonEnvManager::new(Arc::new(config));
    match command {
        RipplePyCommand::Env { request, json } => {
            let info = manager.ensure(&request)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&info)?);
            } else {
                println!("{}", info.env_path.display());
            }
            Ok(0)
        }
        RipplePyCommand::Python {
            request,
            python_args,
        } => {
            let info = manager.ensure(&request)?;
            let status = Command::new(&info.python_executable)
                .args(python_args)
                .env("PYTHONDONTWRITEBYTECODE", "1")
                .env("VIRTUAL_ENV", &info.env_path)
                .status()
                .context("failed to run shared Python environment")?;
            Ok(status.code().unwrap_or(1))
        }
    }
}

pub fn ensure_ripple_py_wrapper(config: &AppConfig) -> Result<PathBuf> {
    let bin_dir = config.sandbox.caches_root.join("bin");
    fs::create_dir_all(&bin_dir)?;
    let wrapper = bin_dir.join("ripple-py");
    let executable =
        std::env::current_exe().context("failed to locate ripple-server executable")?;
    let content = format!(
        "#!/bin/sh\nexec {} ripple-py \"$@\"\n",
        sh_quote(&executable.to_string_lossy())
    );
    if fs::read_to_string(&wrapper).ok().as_deref() != Some(content.as_str()) {
        fs::write(&wrapper, content)?;
    }
    let mut permissions = fs::metadata(&wrapper)?.permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&wrapper, permissions)?;
    Ok(wrapper)
}

pub fn ripple_py_bin_dir(config: &AppConfig) -> PathBuf {
    config.sandbox.caches_root.join("bin")
}

enum RipplePyCommand {
    Env {
        request: PythonEnvRequest,
        json: bool,
    },
    Python {
        request: PythonEnvRequest,
        python_args: Vec<String>,
    },
}

impl RipplePyCommand {
    fn parse(args: &[String], max_packages: usize) -> Result<Self> {
        let Some(command) = args.first().map(String::as_str) else {
            anyhow::bail!("usage: ripple-py <python|env> --with <requirement>... [--] ...");
        };
        match command {
            "env" => {
                let (requirements, json) = parse_env_args(&args[1..])?;
                Ok(Self::Env {
                    request: PythonEnvRequest::new(requirements, max_packages)?,
                    json,
                })
            }
            "python" => {
                let (requirements, python_args) = parse_python_args(&args[1..])?;
                Ok(Self::Python {
                    request: PythonEnvRequest::new(requirements, max_packages)?,
                    python_args,
                })
            }
            other => anyhow::bail!("unknown ripple-py command: {other}"),
        }
    }
}

fn parse_env_args(args: &[String]) -> Result<(Vec<String>, bool)> {
    let mut requirements = Vec::new();
    let mut json = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--with" => {
                let Some(requirement) = args.get(index + 1) else {
                    anyhow::bail!("--with requires a package requirement");
                };
                requirements.push(requirement.clone());
                index += 2;
            }
            "--json" => {
                json = true;
                index += 1;
            }
            other => anyhow::bail!("unexpected ripple-py env argument: {other}"),
        }
    }
    Ok((requirements, json))
}

fn parse_python_args(args: &[String]) -> Result<(Vec<String>, Vec<String>)> {
    let mut requirements = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--with" => {
                let Some(requirement) = args.get(index + 1) else {
                    anyhow::bail!("--with requires a package requirement");
                };
                requirements.push(requirement.clone());
                index += 2;
            }
            "--" => return Ok((requirements, args[index + 1..].to_vec())),
            other => anyhow::bail!("unexpected ripple-py python argument before --: {other}"),
        }
    }
    anyhow::bail!("ripple-py python requires -- before Python arguments")
}

struct EnvLockGuard {
    path: PathBuf,
}

impl EnvLockGuard {
    fn acquire(path: PathBuf) -> Result<Self> {
        let start = Instant::now();
        loop {
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Self { path }),
                Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
                    if start.elapsed() > LOCK_TIMEOUT {
                        anyhow::bail!("timed out waiting for Python env lock {}", path.display());
                    }
                    thread::sleep(Duration::from_millis(100));
                }
                Err(err) => {
                    return Err(err).with_context(|| {
                        format!("failed to create Python env lock {}", path.display())
                    })
                }
            }
        }
    }
}

impl Drop for EnvLockGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.path);
    }
}

fn validate_requirement(requirement: &str) -> Result<()> {
    if requirement.is_empty() {
        anyhow::bail!("empty Python requirement");
    }
    let lower = requirement.to_ascii_lowercase();
    if lower.starts_with('-')
        || lower.starts_with("file:")
        || lower.contains("://")
        || lower.contains(" @ ")
        || lower.contains('/')
        || lower.contains('\\')
        || lower.starts_with('~')
    {
        anyhow::bail!("unsupported Python requirement: {requirement}");
    }
    if requirement.chars().any(char::is_whitespace) {
        anyhow::bail!("Python requirement must not contain whitespace: {requirement}");
    }
    Ok(())
}

fn canonical_lock_content(lock_content: &str) -> String {
    lock_content
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
}

fn python_tag() -> Result<String> {
    let output = Command::new("python3")
        .arg("-c")
        .arg(
            "import sys, sysconfig; print(f\"{sys.implementation.name}-{sys.version_info.major}.{sys.version_info.minor}-{sysconfig.get_config_var('SOABI') or 'abi'}-{sysconfig.get_platform()}\")",
        )
        .output()
        .context("failed to inspect python3")?;
    if !output.status.success() {
        anyhow::bail!(
            "python3 inspection failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn make_tree_readonly(path: &Path) -> Result<()> {
    for entry in walkdir::WalkDir::new(path)
        .contents_first(true)
        .into_iter()
        .filter_map(|entry| entry.ok())
    {
        let metadata = entry.metadata()?;
        let mut permissions = metadata.permissions();
        if metadata.is_dir() {
            permissions.set_mode(0o555);
        } else if permissions.mode() & 0o111 != 0 {
            permissions.set_mode(0o555);
        } else {
            permissions.set_mode(0o444);
        }
        fs::set_permissions(entry.path(), permissions)?;
    }
    Ok(())
}

fn set_file_readonly(path: &Path) -> Result<()> {
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_mode(0o444);
    fs::set_permissions(path, permissions)?;
    Ok(())
}

fn stable_hash(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update(b"\0");
    }
    hex_digest(hasher.finalize().as_slice())
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

fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
