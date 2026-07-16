use std::io;
use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

use crate::config::{resolve_path, AppConfig};
use crate::context_scope::resolve_context_scope;

pub const RIPPLE_CODEX_PERMISSION_PROFILE: &str = "ripple_workspace";

pub fn thread_permission_config(workspace: &Path, config: &AppConfig) -> Value {
    thread_permission_config_with_user(None, workspace, workspace, config)
}

pub fn thread_permission_config_for_user(
    user_id: &str,
    workspace_root: &Path,
    permission_root: &Path,
    config: &AppConfig,
) -> Value {
    thread_permission_config_with_user(Some(user_id), workspace_root, permission_root, config)
}

fn thread_permission_config_with_user(
    user_id: Option<&str>,
    workspace_root: &Path,
    permission_root: &Path,
    config: &AppConfig,
) -> Value {
    let mut filesystem = serde_json::Map::new();
    filesystem.insert(":minimal".to_string(), json!("read"));
    filesystem.insert(
        config.sandbox.sandboxes_root.to_string_lossy().to_string(),
        json!("none"),
    );
    let permission_root = normalized_permission_root(workspace_root, permission_root);
    let context_scope = if permission_root != normalize_path_for_permission(workspace_root) {
        resolve_context_scope(workspace_root, &permission_root).ok()
    } else {
        None
    };
    if permission_root != normalize_path_for_permission(workspace_root) {
        filesystem.insert(workspace_root.to_string_lossy().to_string(), json!("none"));
    }
    filesystem.insert(
        workspace_root.join(".tmp").to_string_lossy().to_string(),
        json!("write"),
    );
    for agents_file in ancestor_agent_files(workspace_root, &permission_root) {
        filesystem.insert(agents_file.to_string_lossy().to_string(), json!("read"));
    }
    let permission_root_access = if context_scope
        .as_ref()
        .is_some_and(|scope| scope.context_root_read_only())
    {
        "read"
    } else {
        "write"
    };
    filesystem.insert(
        permission_root.to_string_lossy().to_string(),
        Value::Object(permission_rules_for_root(
            &permission_root,
            permission_root_access,
        )),
    );
    if let Some(scope) = &context_scope {
        if scope.context_root_read_only() {
            for direct_root in &scope.direct_roots {
                filesystem.insert(
                    direct_root.to_string_lossy().to_string(),
                    Value::Object(permission_rules_for_root(direct_root, "write")),
                );
            }
        }
        for linked_root in &scope.linked_roots {
            filesystem.insert(
                linked_root.canonical_path.to_string_lossy().to_string(),
                Value::Object(permission_rules_for_root(
                    &linked_root.canonical_path,
                    "write",
                )),
            );
        }
    }
    for shared_skill_dir in shared_skill_permission_dirs(config) {
        if path_is_covered_by_parent(&shared_skill_dir, &config.sandbox.sandboxes_root) {
            continue;
        }
        filesystem.insert(
            shared_skill_dir.to_string_lossy().to_string(),
            json!("read"),
        );
    }
    for path in [
        config.sandbox.uv_bin_dir.as_deref(),
        config.sandbox.node_dir.as_deref(),
        config.sandbox.lark_cli_install_root.as_deref(),
        config.sandbox.notion_cli_install_root.as_deref(),
        config.sandbox.gogcli_cli_install_root.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        filesystem.insert(path.to_string_lossy().to_string(), json!("read"));
    }
    for tool in &config.sandbox.cli_tools {
        filesystem.insert(
            tool.install_root.to_string_lossy().to_string(),
            json!("read"),
        );
    }
    for path in [
        config.sandbox.caches_root.join("bin"),
        config.sandbox.python_envs_root.clone(),
        config.sandbox.caches_root.join("python-env-locks"),
    ] {
        filesystem.insert(path.to_string_lossy().to_string(), json!("read"));
    }
    for path in [
        config.sandbox.caches_root.join("pnpm-store"),
        config.sandbox.caches_root.join("corepack-cache"),
        config.sandbox.caches_root.join("npm-cache"),
        config.sandbox.caches_root.join("yarn-cache"),
    ] {
        filesystem.insert(path.to_string_lossy().to_string(), json!("write"));
    }
    let service_codex_home = config.codex_home_path();
    filesystem.insert(
        service_codex_home.to_string_lossy().to_string(),
        json!("none"),
    );
    let service_auth_file = service_codex_home.join("auth.json");
    if let Ok(resolved_service_auth_file) = std::fs::canonicalize(&service_auth_file) {
        if !path_is_covered_by_parent(&resolved_service_auth_file, &service_codex_home) {
            filesystem.insert(
                resolved_service_auth_file.to_string_lossy().to_string(),
                json!("none"),
            );
        }
    }
    if let Some(user_runtime_home) =
        current_user_codex_runtime_home(user_id, workspace_root, config)
    {
        filesystem.insert(
            user_runtime_home.to_string_lossy().to_string(),
            json!("write"),
        );
    }
    if let Some(user_codex_home) = current_user_codex_home(user_id, workspace_root, config) {
        filesystem.insert(user_codex_home.to_string_lossy().to_string(), json!("read"));
        let user_auth_file = user_codex_home.join("auth.json");
        match std::fs::symlink_metadata(&user_auth_file) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                if let Ok(resolved_user_auth_file) = std::fs::canonicalize(&user_auth_file) {
                    if !path_is_covered_by_parent(&resolved_user_auth_file, &service_codex_home) {
                        filesystem.insert(
                            resolved_user_auth_file.to_string_lossy().to_string(),
                            json!("none"),
                        );
                    }
                }
            }
            Ok(_) => {
                filesystem.insert(user_auth_file.to_string_lossy().to_string(), json!("none"));
            }
            Err(_) => {}
        }
    }
    if let Some(bilibili_credential) =
        current_user_bilibili_credential_file(user_id, workspace_root, config)
    {
        filesystem.insert(
            bilibili_credential.to_string_lossy().to_string(),
            json!("read"),
        );
    }
    if let Some(home) = std::env::var_os("HOME") {
        filesystem.insert(
            Path::new(&home)
                .join(".codex")
                .to_string_lossy()
                .to_string(),
            json!("none"),
        );
    }
    json!({
        "features.image_generation": false,
        "default_permissions": RIPPLE_CODEX_PERMISSION_PROFILE,
        "permissions": {
            RIPPLE_CODEX_PERMISSION_PROFILE: {
                "filesystem": filesystem,
                "network": {"enabled": config.codex.network_access}
            }
        },
        "shell_environment_policy": {"exclude": ["CODEX_HOME"]}
    })
}

fn permission_rules_for_root(root: &Path, access: &str) -> serde_json::Map<String, Value> {
    let mut rules = serde_json::Map::new();
    rules.insert(".".to_string(), json!(access));
    rules.insert(".git".to_string(), json!(access));
    rules.insert(".agents".to_string(), json!("read"));
    rules.insert(".codex".to_string(), json!("read"));
    for native_skill_root in [".agents/skills", ".codex/skills"] {
        if path_exists_for_permission_rule(&root.join(native_skill_root)) {
            rules.insert(native_skill_root.to_string(), json!("none"));
        }
    }
    rules
}

fn current_user_codex_home(
    user_id: Option<&str>,
    workspace: &Path,
    config: &AppConfig,
) -> Option<std::path::PathBuf> {
    Some(current_user_codex_runtime_home(user_id, workspace, config)?.join("codex-home"))
}

fn current_user_codex_runtime_home(
    user_id: Option<&str>,
    workspace: &Path,
    config: &AppConfig,
) -> Option<std::path::PathBuf> {
    let user_id = current_user_id(user_id, workspace, config)?;
    let codex_home = config.codex_home_path();
    let runtime_root = codex_home
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| codex_home.clone())
        .join("codex-runtime");
    Some(runtime_root.join("users").join(user_id))
}

fn current_user_sandbox_dir(
    user_id: Option<&str>,
    workspace: &Path,
    config: &AppConfig,
) -> Option<std::path::PathBuf> {
    if let Some(user_id) = user_id {
        return crate::user::validate_user_id(user_id)
            .is_ok()
            .then(|| config.sandbox.sandboxes_root.join(user_id));
    }
    let sandbox_dir = workspace.parent()?;
    if sandbox_dir.parent()? != config.sandbox.sandboxes_root.as_path() {
        return None;
    }
    Some(sandbox_dir.to_path_buf())
}

fn ancestor_agent_files(workspace_root: &Path, permission_root: &Path) -> Vec<PathBuf> {
    let workspace_root = normalize_path_for_permission(workspace_root);
    let permission_root = normalize_path_for_permission(permission_root);
    let Ok(relative) = permission_root.strip_prefix(&workspace_root) else {
        return Vec::new();
    };
    let mut dirs = vec![workspace_root.clone()];
    let mut current = workspace_root;
    for component in relative.components() {
        match component {
            Component::Normal(part) => {
                current.push(part);
                dirs.push(current.clone());
            }
            Component::CurDir => {}
            _ => break,
        }
    }
    dirs.into_iter()
        .map(|dir| dir.join("AGENTS.md"))
        .filter(|path| path_exists_for_permission_rule(path))
        .collect()
}

fn current_user_id(user_id: Option<&str>, workspace: &Path, config: &AppConfig) -> Option<String> {
    if let Some(user_id) = user_id {
        return crate::user::validate_user_id(user_id)
            .is_ok()
            .then(|| user_id.to_string());
    }
    current_user_sandbox_dir(None, workspace, config)?
        .file_name()?
        .to_str()
        .map(str::to_string)
}

fn normalized_permission_root(workspace_root: &Path, permission_root: &Path) -> PathBuf {
    let workspace_root = normalize_path_for_permission(workspace_root);
    let permission_root = normalize_path_for_permission(permission_root);
    if permission_root.starts_with(&workspace_root) {
        permission_root
    } else {
        workspace_root.join(".ripple-invalid-permission-root")
    }
}

fn normalize_path_for_permission(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    normalized
}

fn path_exists_for_permission_rule(path: &Path) -> bool {
    match std::fs::symlink_metadata(path) {
        Ok(_) => true,
        Err(err) if err.kind() == io::ErrorKind::NotFound => false,
        Err(_) => true,
    }
}

fn path_is_covered_by_parent(path: &Path, parent: &Path) -> bool {
    path.starts_with(parent)
        || std::fs::canonicalize(parent)
            .map(|canonical_parent| path.starts_with(canonical_parent))
            .unwrap_or(false)
}

fn shared_skill_permission_dirs(config: &AppConfig) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for pattern in &config.skills.shared_dirs {
        if pattern.contains('*') {
            let Some((prefix, suffix)) = pattern.split_once('*') else {
                continue;
            };
            let base = resolve_path(&config.repo_root, prefix.trim_end_matches('/'));
            let suffix = suffix.trim_start_matches('/');
            if let Ok(read_dir) = std::fs::read_dir(base) {
                for entry in read_dir.flatten() {
                    let path = if suffix.is_empty() {
                        entry.path()
                    } else {
                        entry.path().join(suffix)
                    };
                    if path.is_dir() {
                        dirs.push(path);
                    }
                }
            }
        } else {
            let path = resolve_path(&config.repo_root, pattern);
            if path.is_dir() {
                dirs.push(path);
            }
        }
    }
    dirs.sort();
    dirs.dedup();
    dirs
}

fn current_user_bilibili_credential_file(
    user_id: Option<&str>,
    workspace: &Path,
    config: &AppConfig,
) -> Option<std::path::PathBuf> {
    let sandbox_dir = current_user_sandbox_dir(user_id, workspace, config)?;
    let credential = sandbox_dir.join("credentials/bilibili.json");
    path_exists_for_permission_rule(&credential).then_some(credential)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::{json, Value};

    use super::{thread_permission_config, thread_permission_config_for_user};
    use crate::config::{
        AppConfig, CodexConfig, CorsConfig, FeishuConfig, GogcliOAuthConfig, LoggingConfig,
        SandboxConfig, SecurityConfig, SkillsConfig,
    };

    #[test]
    fn omits_missing_native_skill_deny_paths_from_workspace_rules() {
        let workspace =
            std::env::temp_dir().join(format!("ripple-permissions-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).expect("create workspace");
        let config = test_config();

        let permissions = thread_permission_config(&workspace, &config);

        let workspace_rules = permissions
            .pointer("/permissions/ripple_workspace/filesystem")
            .and_then(|filesystem| filesystem.get(workspace.to_string_lossy().as_ref()))
            .and_then(|rules| rules.as_object())
            .expect("workspace filesystem rules");
        assert_eq!(workspace_rules.get(".agents"), Some(&json!("read")));
        assert_eq!(workspace_rules.get(".codex"), Some(&json!("read")));
        assert!(!workspace_rules.contains_key(".agents/skills"));
        assert!(!workspace_rules.contains_key(".codex/skills"));

        let _ = std::fs::remove_dir_all(workspace);
    }

    #[test]
    fn shared_uv_cache_is_not_writable_by_codex_turns() {
        let workspace =
            std::env::temp_dir().join(format!("ripple-permissions-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).expect("create workspace");
        let config = test_config();

        let permissions = thread_permission_config(&workspace, &config);
        let filesystem = permissions
            .pointer("/permissions/ripple_workspace/filesystem")
            .and_then(|filesystem| filesystem.as_object())
            .expect("filesystem rules");
        let uv_cache = config.sandbox.caches_root.join("uv-cache");

        assert_ne!(
            filesystem.get(uv_cache.to_string_lossy().as_ref()),
            Some(&json!("write"))
        );

        let _ = std::fs::remove_dir_all(workspace);
    }

    #[test]
    fn image_generation_is_disabled_by_default_for_threads() {
        let workspace =
            std::env::temp_dir().join(format!("ripple-permissions-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).expect("create workspace");
        let config = test_config();

        let permissions = thread_permission_config(&workspace, &config);

        assert_eq!(
            permissions.get("features.image_generation"),
            Some(&json!(false))
        );

        let _ = std::fs::remove_dir_all(workspace);
    }

    #[test]
    fn profile_denies_other_sandboxes_and_codex_home_while_workspace_is_writable() {
        let workspace =
            std::env::temp_dir().join(format!("ripple-permissions-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).expect("create workspace");
        let mut config = test_config();
        config.codex.codex_home = Some(config.repo_root.join(".ripple/codex-service-home"));

        let permissions = thread_permission_config(&workspace, &config);
        let filesystem = permissions
            .pointer("/permissions/ripple_workspace/filesystem")
            .and_then(|filesystem| filesystem.as_object())
            .expect("filesystem rules");
        let workspace_rules = filesystem
            .get(workspace.to_string_lossy().as_ref())
            .and_then(|rules| rules.as_object())
            .expect("workspace rules");

        assert_eq!(
            filesystem.get(config.sandbox.sandboxes_root.to_string_lossy().as_ref()),
            Some(&json!("none"))
        );
        assert_eq!(
            filesystem.get(config.codex_home_path().to_string_lossy().as_ref()),
            Some(&json!("none"))
        );
        assert_eq!(workspace_rules.get("."), Some(&json!("write")));
        assert_eq!(
            permissions.pointer("/shell_environment_policy/exclude"),
            Some(&json!(["CODEX_HOME"]))
        );

        let _ = std::fs::remove_dir_all(workspace);
    }

    #[test]
    fn profile_scopes_record_session_to_permission_root() {
        let mut config = test_config();
        config.codex.codex_home = Some(config.repo_root.join(".ripple/codex-service-home"));
        let workspace = config.sandbox.sandboxes_root.join("alice/workspace");
        let record = workspace.join("spaces/a/records/r1");
        let sibling = workspace.join("spaces/a/records/r2");
        std::fs::create_dir_all(&record).expect("create record");
        std::fs::create_dir_all(&sibling).expect("create sibling");
        std::fs::write(workspace.join("AGENTS.md"), "# workspace\n")
            .expect("write workspace agents");
        std::fs::create_dir_all(workspace.join("spaces/a")).expect("create space");
        std::fs::write(workspace.join("spaces/a/AGENTS.md"), "# space\n")
            .expect("write space agents");

        let permissions = thread_permission_config_for_user("alice", &workspace, &record, &config);
        let filesystem = permissions
            .pointer("/permissions/ripple_workspace/filesystem")
            .and_then(|filesystem| filesystem.as_object())
            .expect("filesystem rules");
        let record_rules = filesystem
            .get(record.to_string_lossy().as_ref())
            .and_then(|rules| rules.as_object())
            .expect("record rules");

        assert_eq!(
            filesystem.get(workspace.to_string_lossy().as_ref()),
            Some(&json!("none"))
        );
        assert_eq!(record_rules.get("."), Some(&json!("write")));
        assert_eq!(
            filesystem.get(workspace.join(".tmp").to_string_lossy().as_ref()),
            Some(&json!("write"))
        );
        assert_eq!(
            filesystem.get(workspace.join("AGENTS.md").to_string_lossy().as_ref()),
            Some(&json!("read"))
        );
        assert_eq!(
            filesystem.get(
                workspace
                    .join("spaces/a/AGENTS.md")
                    .to_string_lossy()
                    .as_ref()
            ),
            Some(&json!("read"))
        );
        assert!(!filesystem.contains_key(sibling.to_string_lossy().as_ref()));

        let _ = std::fs::remove_dir_all(&config.repo_root);
    }

    #[cfg(unix)]
    #[test]
    fn profile_allows_mixed_direct_and_linked_roots_without_opening_workspace_siblings() {
        let mut config = test_config();
        config.codex.codex_home = Some(config.repo_root.join(".ripple/codex-service-home"));
        let workspace = config.sandbox.sandboxes_root.join("alice/workspace");
        let space = workspace.join("研发周会");
        let direct_record = space.join("Solomon测试报告");
        let record = workspace.join("07-07 14:01");
        let unrelated = workspace.join("private-record");
        std::fs::create_dir_all(&space).expect("create space");
        std::fs::create_dir_all(&direct_record).expect("create direct record");
        std::fs::create_dir_all(&record).expect("create record");
        std::fs::create_dir_all(record.join(".agents/skills"))
            .expect("create linked record native skills");
        std::fs::create_dir_all(&unrelated).expect("create unrelated record");
        std::os::unix::fs::symlink(&record, space.join("07-07 14:01"))
            .expect("link record into space");

        let permissions = thread_permission_config_for_user("alice", &workspace, &space, &config);
        let filesystem = permissions
            .pointer("/permissions/ripple_workspace/filesystem")
            .and_then(|filesystem| filesystem.as_object())
            .expect("filesystem rules");
        let space_rules = filesystem
            .get(space.to_string_lossy().as_ref())
            .and_then(Value::as_object)
            .expect("space rules");
        let record_rules = filesystem
            .get(record.to_string_lossy().as_ref())
            .and_then(Value::as_object)
            .expect("linked record rules");
        let direct_record_rules = filesystem
            .get(direct_record.to_string_lossy().as_ref())
            .and_then(Value::as_object)
            .expect("direct record rules");

        assert_eq!(space_rules.get("."), Some(&json!("read")));
        assert_eq!(direct_record_rules.get("."), Some(&json!("write")));
        assert_eq!(record_rules.get("."), Some(&json!("write")));
        assert_eq!(record_rules.get(".agents/skills"), Some(&json!("none")));
        assert!(!filesystem.contains_key(unrelated.to_string_lossy().as_ref()));

        let _ = std::fs::remove_dir_all(&config.repo_root);
    }

    #[test]
    fn profile_allows_user_codex_home_but_denies_auth_link() {
        let mut config = test_config();
        config.codex.codex_home = Some(config.repo_root.join(".ripple/codex-service-home"));
        let workspace = config.sandbox.sandboxes_root.join("alice/workspace");
        let user_codex_home = config
            .repo_root
            .join(".ripple/codex-runtime/users/alice/codex-home");
        let user_auth = user_codex_home.join("auth.json");
        let service_auth = config.codex_home_path().join("auth.json");
        std::fs::create_dir_all(&workspace).expect("create workspace");
        std::fs::create_dir_all(service_auth.parent().unwrap()).expect("create service codex home");
        std::fs::write(&service_auth, r#"{"OPENAI_API_KEY":"test"}"#).expect("write service auth");
        std::fs::create_dir_all(&user_codex_home).expect("create user codex home");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&service_auth, &user_auth).expect("link user auth");

        let permissions = thread_permission_config(&workspace, &config);
        let filesystem = permissions
            .pointer("/permissions/ripple_workspace/filesystem")
            .and_then(|filesystem| filesystem.as_object())
            .expect("filesystem rules");

        assert_eq!(
            filesystem.get(user_codex_home.to_string_lossy().as_ref()),
            Some(&json!("read"))
        );
        assert!(
            !filesystem.contains_key(user_auth.to_string_lossy().as_ref()),
            "user auth symlink path should not be denied directly because bwrap cannot enforce deny-read across writable symlinks"
        );
        assert_eq!(
            filesystem.get(config.codex_home_path().to_string_lossy().as_ref()),
            Some(&json!("none"))
        );
        assert!(
            !filesystem.contains_key(service_auth.to_string_lossy().as_ref()),
            "service auth child should be covered by the denied service Codex home"
        );

        let _ = std::fs::remove_dir_all(&config.repo_root);
    }

    #[test]
    fn profile_omits_service_auth_child_when_service_codex_home_is_denied() {
        let mut config = test_config();
        config.codex.codex_home = Some(config.repo_root.join(".ripple/codex-service-home"));
        let workspace = config.sandbox.sandboxes_root.join("alice/workspace");
        let service_auth = config.codex_home_path().join("auth.json");
        std::fs::create_dir_all(&workspace).expect("create workspace");
        std::fs::create_dir_all(service_auth.parent().unwrap()).expect("create service codex home");
        std::fs::write(&service_auth, r#"{"OPENAI_API_KEY":"test"}"#).expect("write service auth");

        let permissions = thread_permission_config(&workspace, &config);
        let filesystem = permissions
            .pointer("/permissions/ripple_workspace/filesystem")
            .and_then(|filesystem| filesystem.as_object())
            .expect("filesystem rules");

        assert_eq!(
            filesystem.get(config.codex_home_path().to_string_lossy().as_ref()),
            Some(&json!("none"))
        );
        assert!(
            !filesystem.contains_key(service_auth.to_string_lossy().as_ref()),
            "service auth child should be covered by the denied service Codex home"
        );

        let _ = std::fs::remove_dir_all(&config.repo_root);
    }

    #[test]
    fn profile_allows_current_user_runtime_and_node_caches() {
        let mut config = test_config();
        config.codex.codex_home = Some(config.repo_root.join(".ripple/codex-service-home"));
        let workspace = config.sandbox.sandboxes_root.join("alice/workspace");
        std::fs::create_dir_all(&workspace).expect("create workspace");
        let user_runtime = config.repo_root.join(".ripple/codex-runtime/users/alice");

        let permissions = thread_permission_config(&workspace, &config);
        let filesystem = permissions
            .pointer("/permissions/ripple_workspace/filesystem")
            .and_then(|filesystem| filesystem.as_object())
            .expect("filesystem rules");

        assert_eq!(
            filesystem.get(user_runtime.to_string_lossy().as_ref()),
            Some(&json!("write"))
        );
        for path in [
            config.sandbox.caches_root.join("pnpm-store"),
            config.sandbox.caches_root.join("corepack-cache"),
            config.sandbox.caches_root.join("npm-cache"),
            config.sandbox.caches_root.join("yarn-cache"),
        ] {
            assert_eq!(
                filesystem.get(path.to_string_lossy().as_ref()),
                Some(&json!("write")),
                "{} should be writable",
                path.display()
            );
        }

        let _ = std::fs::remove_dir_all(&config.repo_root);
    }

    #[test]
    fn profile_allows_reading_configured_shared_skill_roots() {
        let mut config = test_config();
        let workspace = config.sandbox.sandboxes_root.join("alice/workspace");
        let viaim_skill_root = config.repo_root.join("skills/viaim-product-support");
        std::fs::create_dir_all(&workspace).expect("create workspace");
        std::fs::create_dir_all(viaim_skill_root.join("references")).expect("create shared skill");
        std::fs::write(viaim_skill_root.join("SKILL.md"), "# viaim\n").expect("write skill");
        std::fs::write(
            viaim_skill_root.join("references/viaim-about.md"),
            "客服电话：400-110-9926\n",
        )
        .expect("write reference");
        config.skills.shared_dirs = vec!["skills/*".to_string()];

        let permissions = thread_permission_config(&workspace, &config);
        let filesystem = permissions
            .pointer("/permissions/ripple_workspace/filesystem")
            .and_then(|filesystem| filesystem.as_object())
            .expect("filesystem rules");

        assert_eq!(
            filesystem.get(viaim_skill_root.to_string_lossy().as_ref()),
            Some(&json!("read"))
        );

        let _ = std::fs::remove_dir_all(&config.repo_root);
    }

    #[test]
    fn profile_allows_reading_current_users_bilibili_credential_file() {
        let config = test_config();
        let workspace = config.sandbox.sandboxes_root.join("alice/workspace");
        let bilibili_credential = config
            .sandbox
            .sandboxes_root
            .join("alice/credentials/bilibili.json");
        std::fs::create_dir_all(workspace.parent().unwrap()).expect("create sandbox dir");
        std::fs::create_dir_all(bilibili_credential.parent().unwrap())
            .expect("create credentials dir");
        std::fs::create_dir_all(&workspace).expect("create workspace");
        std::fs::write(&bilibili_credential, r#"{"sessdata":"secret"}"#)
            .expect("write bilibili credential");

        let permissions = thread_permission_config(&workspace, &config);
        let filesystem = permissions
            .pointer("/permissions/ripple_workspace/filesystem")
            .and_then(|filesystem| filesystem.as_object())
            .expect("filesystem rules");

        assert_eq!(
            filesystem.get(bilibili_credential.to_string_lossy().as_ref()),
            Some(&json!("read"))
        );

        let _ = std::fs::remove_dir_all(&config.repo_root);
    }

    #[test]
    fn profile_resolves_current_user_paths_with_configured_workspace_root() {
        let mut config = test_config();
        config.codex.codex_home = Some(config.repo_root.join(".ripple/codex-service-home"));
        config.sandbox.workspaces_root = Some(config.repo_root.join("nas-workspaces"));
        let workspace = config
            .sandbox
            .workspaces_root
            .as_ref()
            .unwrap()
            .join("alice/workspace");
        let user_runtime = config.repo_root.join(".ripple/codex-runtime/users/alice");
        let bilibili_credential = config
            .sandbox
            .sandboxes_root
            .join("alice/credentials/bilibili.json");
        std::fs::create_dir_all(&workspace).expect("create workspace");
        std::fs::create_dir_all(bilibili_credential.parent().unwrap())
            .expect("create credentials dir");
        std::fs::write(&bilibili_credential, r#"{"sessdata":"secret"}"#)
            .expect("write bilibili credential");

        let permissions =
            thread_permission_config_for_user("alice", &workspace, &workspace, &config);
        let filesystem = permissions
            .pointer("/permissions/ripple_workspace/filesystem")
            .and_then(|filesystem| filesystem.as_object())
            .expect("filesystem rules");

        assert_eq!(
            filesystem.get(user_runtime.to_string_lossy().as_ref()),
            Some(&json!("write"))
        );
        assert_eq!(
            filesystem.get(bilibili_credential.to_string_lossy().as_ref()),
            Some(&json!("read"))
        );
        assert_eq!(
            filesystem.get(workspace.to_string_lossy().as_ref()),
            Some(&json!({
                ".": "write",
                ".git": "write",
                ".agents": "read",
                ".codex": "read"
            }))
        );

        let _ = std::fs::remove_dir_all(&config.repo_root);
    }

    fn test_config() -> AppConfig {
        let root = std::env::temp_dir().join(format!(
            "ripple-permissions-config-{}",
            uuid::Uuid::new_v4()
        ));
        AppConfig {
            repo_root: root.clone(),
            host: "127.0.0.1".to_string(),
            port: 8810,
            api_keys: Vec::new(),
            enabled_connectors: crate::config::default_enabled_connectors(),
            security: SecurityConfig::default(),
            user_auth: crate::config::UserAuthConfig::default(),
            api_docs: crate::config::ApiDocsConfig::default(),
            cors: CorsConfig::default(),
            default_model: "codex-medium".to_string(),
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
                tmpfs_size_mb: 512,
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
                app_server_args: vec![
                    "app-server".to_string(),
                    "--listen".to_string(),
                    "stdio://".to_string(),
                ],
                codex_home: None,
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
            document_preview: crate::config::DocumentPreviewConfig {
                cache_root: root.join("cache/previews"),
                libreoffice_path: "soffice".to_string(),
                max_source_bytes: 64 * 1024 * 1024,
                conversion_timeout_seconds: 120,
            },
            skills: SkillsConfig {
                shared_dirs: vec!["skills/*".to_string()],
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
}
