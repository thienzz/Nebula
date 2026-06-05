//! Model lifecycle: resumable download, SHA-256 verify, cache, selection
//! (FR-MDL-001..005, T-043/044/045/060).
//!
//! Implemented here: weight **hash verification** against `models.manifest.json`
//! (FR-MDL-002) — a tampered/truncated file is detected and rejected (`MODEL_HASH`).
//! The resumable download (FR-MDL-001) is network-gated and wired during the Phase-0
//! spike, which also produces the real manifest hashes.
#![allow(dead_code)]

use crate::NebulaError;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Deserialize)]
pub struct ModelManifest {
    pub models: HashMap<String, ModelEntry>,
}

#[derive(Debug, Deserialize)]
pub struct ModelEntry {
    pub sha256: String,
    #[serde(default)]
    pub size_bytes: Option<u64>,
}

/// Normalize a hash string: drop an optional `sha256:` prefix and lowercase.
fn normalize_hash(h: &str) -> String {
    h.strip_prefix("sha256:").unwrap_or(h).to_lowercase()
}

/// Stream a file through SHA-256 (bounded memory — weights are multi-GB).
pub fn compute_sha256(path: &Path) -> Result<String, NebulaError> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path).map_err(|e| NebulaError::Io(e.to_string()))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| NebulaError::Io(e.to_string()))?;
    let digest = hasher.finalize();
    Ok(digest.iter().map(|b| format!("{:02x}", b)).collect())
}

/// Verify a file against an expected SHA-256. `Err(MODEL_HASH)` on mismatch (FR-MDL-002).
pub fn verify_file(path: &Path, expected_sha256: &str) -> Result<(), NebulaError> {
    let actual = compute_sha256(path)?;
    if actual == normalize_hash(expected_sha256) {
        Ok(())
    } else {
        Err(NebulaError::ModelHash)
    }
}

/// Parse a manifest and verify `file_path` against the entry for `model_id`.
pub fn verify_against_manifest(
    manifest_json: &str,
    model_id: &str,
    file_path: &Path,
) -> Result<(), NebulaError> {
    let manifest: ModelManifest =
        serde_json::from_str(manifest_json).map_err(|e| NebulaError::Io(e.to_string()))?;
    let entry = manifest
        .models
        .get(model_id)
        .ok_or_else(|| NebulaError::Io(format!("model '{}' not in manifest", model_id)))?;
    verify_file(file_path, &entry.sha256)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_file(contents: &[u8]) -> std::path::PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("nebula_model_test_{}_{}", std::process::id(), n));
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(contents).unwrap();
        path
    }

    // Known: sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    const ABC_SHA: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    #[test]
    fn computes_known_sha256() {
        let p = temp_file(b"abc");
        assert_eq!(compute_sha256(&p).unwrap(), ABC_SHA);
    }

    #[test]
    fn verify_file_accepts_match_with_or_without_prefix() {
        let p = temp_file(b"abc");
        assert!(verify_file(&p, ABC_SHA).is_ok());
        assert!(verify_file(&p, &format!("sha256:{}", ABC_SHA.to_uppercase())).is_ok());
    }

    #[test]
    fn verify_file_rejects_tampered_or_truncated() {
        // FR-MDL-002: a tampered byte → MODEL_HASH.
        let p = temp_file(b"abc!");
        assert!(matches!(verify_file(&p, ABC_SHA).unwrap_err(), NebulaError::ModelHash));
    }

    #[test]
    fn verifies_against_manifest() {
        let p = temp_file(b"abc");
        let manifest = format!(
            r#"{{ "models": {{ "phi-3-mini": {{ "sha256": "sha256:{}", "size_bytes": 3 }} }} }}"#,
            ABC_SHA
        );
        assert!(verify_against_manifest(&manifest, "phi-3-mini", &p).is_ok());
        // unknown model id → error
        assert!(verify_against_manifest(&manifest, "nope", &p).is_err());
        // tampered file vs manifest → MODEL_HASH
        let bad = temp_file(b"xyz");
        assert!(matches!(
            verify_against_manifest(&manifest, "phi-3-mini", &bad).unwrap_err(),
            NebulaError::ModelHash
        ));
    }
}
