//! Runtime path resolution. Ported from AstroEX-node src/runtimePaths.ts.
//!
//! Resolution order for every directory:
//!   * an explicit `--data-dir` / `--log-dir` / `--materials-dir` /
//!     `--profile-dir` flag resolves against the process working directory;
//!   * otherwise it resolves against the *application root*.
//!
//! The application root is discovered, in order:
//!   1. the compile-time `ASTROOM_BASE` override, when the build set it;
//!   2. the nearest ancestor of the running executable that contains
//!      `config/presets.json` (this is how the shipped
//!      `target/release/astroom` finds the tree it was distributed with);
//!   3. the nearest ancestor of the current working directory with the same
//!      marker, so running the binary from inside a checkout still works;
//!   4. the executable's own directory;
//!   5. the current working directory.
//!
//! Note on step 1: the root is deliberately *not* derived from
//! `CARGO_MANIFEST_DIR`. Baking an absolute build path into the binary both
//! breaks as soon as the tree is moved and leaks the builder's filesystem
//! layout into the distributed artifact. Discovery above keeps the release
//! binary relocatable and free of machine-specific paths.

use std::path::{Path, PathBuf};

/// Marker that identifies an AstroOM application root.
const ROOT_MARKER: &str = "config/presets.json";

fn is_root(candidate: &Path) -> bool {
    candidate.join(ROOT_MARKER).is_file()
}

/// Walk `start` and its parents, returning the first AstroOM application root.
fn discover_root_from(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|candidate| is_root(candidate))
        .map(Path::to_path_buf)
}

fn current_exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
}

fn current_dir() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

pub fn project_root() -> PathBuf {
    // 1. Explicit build-time override.
    if let Some(base) = option_env!("ASTROOM_BASE") {
        return PathBuf::from(base);
    }
    // 2. Relocatable: anchor on the running executable.
    if let Some(root) = current_exe_dir().as_deref().and_then(discover_root_from) {
        return root;
    }
    // 3. Running from inside a checkout.
    let cwd = current_dir();
    if let Some(root) = discover_root_from(&cwd) {
        return root;
    }
    // 4/5. Nothing recognisable: keep runtime output beside the binary.
    current_exe_dir().unwrap_or(cwd)
}

fn resolve_explicit_or(configured: Option<&Path>, fallback: &str) -> PathBuf {
    match configured {
        Some(p) => {
            if p.is_absolute() {
                p.to_path_buf()
            } else {
                current_dir().join(p)
            }
        }
        None => project_root().join(fallback),
    }
}

pub fn data_dir(configured: Option<&Path>) -> PathBuf {
    resolve_explicit_or(configured, "data")
}

pub fn log_dir(configured: Option<&Path>) -> PathBuf {
    resolve_explicit_or(configured, "logs")
}

pub fn materials_dir(configured: Option<&Path>) -> PathBuf {
    resolve_explicit_or(configured, "materials")
}

/// Default user-profile directory.
///
/// Users create this by copying the shipped `profile.example/` template:
/// `cp -r profile.example profile`. The template ships in the repository; the
/// live `profile/` holds the user's own personal data and is git-ignored.
pub fn profile_dir(configured: Option<&Path>) -> PathBuf {
    resolve_explicit_or(configured, "profile")
}

/// Validates a profile file name the same way as getProfileFile in
/// runtimePaths.ts: [a-zA-Z0-9_.-]+ .(txt|json), no "..".
pub fn validate_profile_file_name(file_name: &str) -> crate::error::Result<()> {
    let valid = !file_name.contains("..")
        && file_name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        && (file_name.ends_with(".txt") || file_name.ends_with(".json"));
    if valid {
        Ok(())
    } else {
        Err(crate::error::AppError::message(format!(
            "Invalid profile file name: {file_name}"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::create_dir_all(dir.path().join("config")).expect("config dir");
        std::fs::write(dir.path().join(ROOT_MARKER), "{}").expect("marker");
        dir
    }

    #[test]
    fn root_is_discovered_from_an_ancestor_containing_the_marker() {
        let dir = temp_root();
        let nested = dir.path().join("target/release/deps");
        std::fs::create_dir_all(&nested).expect("nested");
        assert_eq!(discover_root_from(&nested), Some(dir.path().to_path_buf()));
    }

    #[test]
    fn tree_without_the_marker_is_not_a_root() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert_eq!(discover_root_from(dir.path()), None);
    }

    #[test]
    fn explicit_relative_flags_resolve_against_the_working_directory() {
        let cwd = std::env::current_dir().expect("cwd");
        assert_eq!(
            data_dir(Some(Path::new("./elsewhere"))),
            cwd.join("./elsewhere")
        );
    }

    #[test]
    fn explicit_absolute_flags_pass_through() {
        let absolute = Path::new("/var/tmp/astroom-data");
        assert_eq!(data_dir(Some(absolute)), absolute);
    }

    #[test]
    fn defaults_live_under_the_application_root() {
        let root = project_root();
        assert_eq!(data_dir(None), root.join("data"));
        assert_eq!(log_dir(None), root.join("logs"));
        assert_eq!(materials_dir(None), root.join("materials"));
        // The default profile directory must be the user's own `profile/`,
        // never the shipped `profile.example/` template.
        assert_eq!(profile_dir(None), root.join("profile"));
    }

    #[test]
    fn default_profile_dir_is_never_the_template_directory() {
        assert_ne!(profile_dir(None), project_root().join("profile.example"));
    }

    #[test]
    fn profile_file_names_are_validated() {
        assert!(validate_profile_file_name("my_resume.txt").is_ok());
        assert!(validate_profile_file_name("my_resume.json").is_ok());
        assert!(validate_profile_file_name("../../etc/passwd").is_err());
        assert!(validate_profile_file_name("my resume.txt").is_err());
        assert!(validate_profile_file_name("resume.md").is_err());
    }
}
