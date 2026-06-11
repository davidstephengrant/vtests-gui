fn main() {
    let hash = git_short_hash();
    let dirty = git_is_dirty();
    let git_part = if dirty { format!("{}-dirty", hash) } else { hash };
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
    println!("cargo:rustc-env=BUILD_ID=Build: {} · {}", git_part, timestamp);

    // Re-run when the commit or staging area changes so incremental builds
    // pick up a fresh hash and dirty flag without a full rebuild.
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let git_dir = std::path::PathBuf::from(&manifest).join("../.git");
    for name in &["HEAD", "index"] {
        if let Ok(p) = git_dir.join(name).canonicalize() {
            println!("cargo:rerun-if-changed={}", p.display());
        }
    }

    tauri_build::build()
}

fn git_short_hash() -> String {
    std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

fn git_is_dirty() -> bool {
    std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.lines().any(|l| !l.starts_with("??")))
        .unwrap_or(false)
}
