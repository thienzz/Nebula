//! Vault allow-list choke point (NFR-SEC-003, T-002).
//! Every disk access in feature code MUST go through here. The full path-validation
//! logic + tests land in slice B3; this is the compiling stub the command layer calls.

use crate::NebulaError;
use std::path::{Path, PathBuf};

/// Resolve `requested` against the Vault root, rejecting any path that escapes it.
/// Stub: real `../`/absolute/symlink rejection (TC-SEC-002) is implemented in B3.
#[allow(dead_code)]
pub fn resolve_in_vault(_vault: &Path, _requested: &str) -> Result<PathBuf, NebulaError> {
    Err(NebulaError::Io("fs_scope not implemented (T-002)".into()))
}
