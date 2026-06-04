//! Vault allow-list choke point (NFR-SEC-003, T-002, TC-SEC-002).
//! Every disk access in feature code MUST go through here — no direct `std::fs`
//! in feature code (CODING-STANDARDS §4). Rejects path traversal (`../`), absolute
//! paths, and symlinks that escape the Vault, all with `OUTSIDE_VAULT`.
//!
//! `resolve_in_vault`/`read`/`write` are wired into the Tauri command layer in the
//! Vault-state slice (T-002); until then they are exercised by the tests below.
#![allow(dead_code)]

use crate::NebulaError;
use std::path::{Component, Path, PathBuf};

/// Resolve `requested` (a Vault-relative path) to an absolute path proven to live
/// inside `vault`. Returns `OUTSIDE_VAULT` for any path that escapes the Vault.
pub fn resolve_in_vault(vault: &Path, requested: &str) -> Result<PathBuf, NebulaError> {
    let req = Path::new(requested);

    // 1. Reject absolute paths, drive prefixes (C:\), UNC, and root-relative (\foo).
    for comp in req.components() {
        match comp {
            Component::Prefix(_) | Component::RootDir => return Err(NebulaError::OutsideVault),
            _ => {}
        }
    }

    // 2. Lexically normalize vault.join(requested), resolving `.`/`..` without touching disk.
    let joined = vault.join(req);
    let normalized = normalize_lexical(&joined).ok_or(NebulaError::OutsideVault)?;
    let vault_norm = normalize_lexical(vault).ok_or(NebulaError::OutsideVault)?;

    // 3. The normalized path must stay within the Vault (component-wise prefix).
    if !normalized.starts_with(&vault_norm) {
        return Err(NebulaError::OutsideVault);
    }

    // 4. Symlink safety: canonicalize the deepest existing ancestor (resolves any
    //    symlink components) and confirm it is still inside the canonical Vault.
    //    The non-existent tail (e.g. a new note) is lexically safe from step 3.
    if let Ok(vault_canon) = vault.canonicalize() {
        if let Some(anchor) = canonicalize_existing_ancestor(&normalized) {
            if !anchor.starts_with(&vault_canon) {
                return Err(NebulaError::OutsideVault);
            }
        }
    }

    Ok(normalized)
}

/// Resolve + read a Vault-scoped file (NFR-SEC-003).
pub fn read(vault: &Path, requested: &str) -> Result<Vec<u8>, NebulaError> {
    let path = resolve_in_vault(vault, requested)?;
    std::fs::read(&path).map_err(|e| NebulaError::Io(e.to_string()))
}

/// Resolve + write a Vault-scoped note, creating parent dirs inside the Vault.
pub fn write(vault: &Path, requested: &str, content: &str) -> Result<(), NebulaError> {
    let path = resolve_in_vault(vault, requested)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| NebulaError::Io(e.to_string()))?;
    }
    std::fs::write(&path, content).map_err(|e| NebulaError::Io(e.to_string()))
}

/// Pure lexical normalization. Returns `None` if `..` escapes above the root.
fn normalize_lexical(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::Prefix(p) => out.push(p.as_os_str()),
            Component::RootDir => out.push(comp.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            Component::Normal(c) => out.push(c),
        }
    }
    Some(out)
}

/// Canonicalize the deepest ancestor of `path` that exists on disk.
fn canonicalize_existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut cur = Some(path);
    while let Some(p) = cur {
        if let Ok(c) = p.canonicalize() {
            return Some(c);
        }
        cur = p.parent();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    // Unique temp Vault dir without external crates.
    fn temp_vault() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("nebula_vault_test_{}_{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn accepts_paths_inside_the_vault() {
        let vault = temp_vault();
        let p = resolve_in_vault(&vault, "notes/today.md").expect("inside-vault path allowed");
        assert!(p.starts_with(&vault));
        assert!(p.ends_with("today.md"));
    }

    #[test]
    fn rejects_parent_traversal() {
        // TC-SEC-002: ../../etc/passwd must be OUTSIDE_VAULT.
        let vault = temp_vault();
        let err = resolve_in_vault(&vault, "../../etc/passwd").unwrap_err();
        assert!(matches!(err, NebulaError::OutsideVault));
    }

    #[test]
    fn rejects_traversal_that_climbs_then_descends() {
        let vault = temp_vault();
        assert!(matches!(
            resolve_in_vault(&vault, "notes/../../escape.md").unwrap_err(),
            NebulaError::OutsideVault
        ));
    }

    #[test]
    fn rejects_absolute_paths() {
        // TC-SEC-002: absolute paths rejected (both unix-style and Windows drive).
        let vault = temp_vault();
        assert!(matches!(
            resolve_in_vault(&vault, "/etc/passwd").unwrap_err(),
            NebulaError::OutsideVault
        ));
        assert!(matches!(
            resolve_in_vault(&vault, "C:\\Windows\\System32\\drivers\\etc\\hosts").unwrap_err(),
            NebulaError::OutsideVault
        ));
    }

    #[test]
    fn rejects_sibling_prefix_directory() {
        // A sibling dir sharing a name prefix must not be treated as inside.
        let vault = std::env::temp_dir().join("nebula_vault_xyz");
        let escape = resolve_in_vault(&vault, "../nebula_vault_xyz_evil/secret.md");
        assert!(matches!(escape.unwrap_err(), NebulaError::OutsideVault));
    }

    #[test]
    fn read_write_round_trip_inside_vault() {
        let vault = temp_vault();
        write(&vault, "notes/a.md", "# hello").expect("write inside vault");
        let bytes = read(&vault, "notes/a.md").expect("read inside vault");
        assert_eq!(bytes, b"# hello");
    }

    #[test]
    fn write_outside_vault_is_blocked() {
        let vault = temp_vault();
        assert!(matches!(
            write(&vault, "../escaped.md", "x").unwrap_err(),
            NebulaError::OutsideVault
        ));
    }

    #[test]
    #[cfg(windows)]
    fn rejects_symlink_escaping_vault_when_supported() {
        // Symlink creation on Windows needs Developer Mode / admin. If unavailable,
        // skip rather than fail — the lexical guards above are the primary defense.
        let vault = temp_vault();
        let outside = std::env::temp_dir().join(format!("nebula_outside_{}", std::process::id()));
        std::fs::create_dir_all(&outside).unwrap();
        let link = vault.join("link");
        if std::os::windows::fs::symlink_dir(&outside, &link).is_err() {
            return; // privilege not granted — skip
        }
        assert!(matches!(
            resolve_in_vault(&vault, "link/secret.md").unwrap_err(),
            NebulaError::OutsideVault
        ));
    }
}
