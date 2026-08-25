use std::path::{Path, PathBuf};

pub fn validate_shared_folder_id(shared_folder_id: &str) -> Result<(), String> {
    if shared_folder_id.is_empty() || shared_folder_id.len() > 64 {
        return Err("shared_folder must be 1-64 characters".to_string());
    }
    if shared_folder_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        Ok(())
    } else {
        Err("shared_folder must match ^[a-zA-Z0-9_-]{1,64}$".to_string())
    }
}

pub fn resolve_shared_folder(
    shared_folders_root: &Path,
    shared_folder_id: &str,
) -> anyhow::Result<PathBuf> {
    validate_shared_folder_id(shared_folder_id).map_err(anyhow::Error::msg)?;
    let root = shared_folders_root.canonicalize()?;
    let candidate = root.join(shared_folder_id);
    let metadata = std::fs::symlink_metadata(&candidate)?;
    if metadata.file_type().is_symlink() {
        anyhow::bail!("shared folder root cannot be a symbolic link");
    }
    if !metadata.is_dir() {
        anyhow::bail!("shared folder is not a directory");
    }
    let resolved = candidate.canonicalize()?;
    if resolved.parent() != Some(root.as_path()) {
        anyhow::bail!("shared folder escaped the configured root");
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> anyhow::Result<Self> {
            let path = std::env::temp_dir().join(format!(
                "ripple-shared-folder-test-{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&path)?;
            Ok(Self(path))
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn resolves_first_level_folder_with_recursive_content() -> anyhow::Result<()> {
        let temp = TestDir::new()?;
        let folder = temp.path().join("a-folder/reports/2026");
        std::fs::create_dir_all(&folder)?;
        std::fs::write(folder.join("annual.md"), "ok")?;

        let resolved = resolve_shared_folder(temp.path(), "a-folder")?;

        assert_eq!(resolved, temp.path().join("a-folder").canonicalize()?);
        assert!(resolved.join("reports/2026/annual.md").is_file());
        Ok(())
    }

    #[test]
    fn rejects_path_syntax_and_non_directory_targets() -> anyhow::Result<()> {
        let temp = TestDir::new()?;
        std::fs::write(temp.path().join("file"), "no")?;

        assert!(resolve_shared_folder(temp.path(), "../other").is_err());
        assert!(resolve_shared_folder(temp.path(), "nested/folder").is_err());
        assert!(resolve_shared_folder(temp.path(), "file").is_err());
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_as_selected_root() -> anyhow::Result<()> {
        let temp = TestDir::new()?;
        std::fs::create_dir(temp.path().join("real"))?;
        std::os::unix::fs::symlink(temp.path().join("real"), temp.path().join("alias"))?;

        assert!(resolve_shared_folder(temp.path(), "alias").is_err());
        Ok(())
    }
}
