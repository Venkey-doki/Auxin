//! The workspace's `.auxin/` folder: flow files, environments and secrets.
//! Paths are always relative to the workspace root and confined to `.auxin/`.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

pub const DIR: &str = ".auxin";
const GITIGNORE_LINES: &[&str] = &[".auxin/env/*.secret.json", ".auxin/runs/"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuxinFile {
    /// Relative to `.auxin/`, e.g. `flows/model-end-to-end.flow.json`.
    pub path: String,
    pub text: String,
}

/// Resolves `rel` inside `<root>/.auxin`, refusing anything that escapes it.
pub fn resolve(root: &str, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() || rel_path.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("Invalid path: {rel}"));
    }
    // A cloned repo could commit `.auxin/…` as a symlink to somewhere else;
    // never read, write or delete through one.
    let mut cur = Path::new(root).join(DIR);
    let check = |p: &Path| match fs::symlink_metadata(p) {
        Ok(m) if m.file_type().is_symlink() => Err(format!("Refusing to follow a symlink inside .auxin: {}", p.display())),
        _ => Ok(()),
    };
    check(&cur)?;
    for c in rel_path.components() {
        cur.push(c);
        check(&cur)?;
    }
    Ok(cur)
}

/// Lists `flows/*.flow.json` and `env/*.json`.
pub fn list(root: &str) -> Vec<AuxinFile> {
    let mut out = Vec::new();
    for (sub, suffix) in [("flows", ".flow.json"), ("env", ".json")] {
        let Ok(dir) = resolve(root, sub) else { continue };
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        let mut names: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(suffix)).collect();
        names.sort();
        for n in names {
            let Ok(p) = resolve(root, &format!("{sub}/{n}")) else { continue };
            if let Ok(text) = fs::read_to_string(p) {
                out.push(AuxinFile { path: format!("{sub}/{n}"), text });
            }
        }
    }
    out
}

/// Atomic write. Writing a secret first makes sure git will ignore it.
pub fn write(root: &str, rel: &str, text: &str) -> Result<(), String> {
    let path = resolve(root, rel)?;
    if rel.ends_with(".secret.json") || rel.starts_with("runs/") {
        ensure_gitignore(root)?;
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // A fresh, never-existing temp name opened with create_new: it can't be a
    // planted symlink (O_EXCL doesn't follow one), so the write stays here.
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.{}.{stamp}.tmp", std::process::id()));
    let result = (|| {
        let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        std::io::Write::write_all(&mut f, text.as_bytes())?;
        f.sync_all()?;
        fs::rename(&tmp, &path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|e| e.to_string())
}

pub fn delete(root: &str, rel: &str) -> Result<(), String> {
    let path = resolve(root, rel)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Appends any missing ignore lines to `<root>/.gitignore`, leaving the rest untouched.
pub fn ensure_gitignore(root: &str) -> Result<(), String> {
    let p = Path::new(root).join(".gitignore");
    let existing = fs::read_to_string(&p).unwrap_or_default();
    let have: Vec<&str> = existing.lines().map(str::trim).collect();
    let missing: Vec<&str> = GITIGNORE_LINES.iter().copied().filter(|l| !have.contains(l)).collect();
    if missing.is_empty() {
        return Ok(());
    }
    let mut text = existing.clone();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    if !existing.contains("# Auxin") {
        text.push_str("\n# Auxin: local secrets and run history\n");
    }
    for l in missing {
        text.push_str(l);
        text.push('\n');
    }
    fs::write(&p, text).map_err(|e| e.to_string())
}

/// File names directly inside `<root>/.auxin/<rel>` (empty if it doesn't exist).
pub fn list_dir(root: &str, rel: &str) -> Result<Vec<String>, String> {
    let dir = resolve(root, rel)?;
    let Ok(entries) = fs::read_dir(&dir) else { return Ok(Vec::new()) };
    let mut names: Vec<String> = entries.flatten().filter(|e| e.path().is_file()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    Ok(names)
}

pub fn read(root: &str, rel: &str) -> Result<String, String> {
    fs::read_to_string(resolve(root, rel)?).map_err(|e| e.to_string())
}

/// First `max` bytes of a file as text (for body-file previews).
pub fn preview(path: &str, max: usize) -> Result<(String, u64), String> {
    let meta = fs::metadata(path).map_err(|e| format!("Couldn't read {path}: {e}"))?;
    let mut bytes = fs::read(path).map_err(|e| e.to_string())?;
    bytes.truncate(max);
    Ok((String::from_utf8_lossy(&bytes).into_owned(), meta.len()))
}

/// Watches `<root>/.auxin` and emits `auxin://files-changed` (debounced by the UI).
#[derive(Default)]
pub struct FileWatch(Mutex<Option<(String, RecommendedWatcher)>>);

impl FileWatch {
    pub fn watch(&self, app: AppHandle, root: &str) -> Result<(), String> {
        let mut slot = self.0.lock().unwrap();
        if slot.as_ref().is_some_and(|(r, _)| r == root) {
            return Ok(());
        }
        let dir = Path::new(root).join(DIR);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let root_owned = root.to_string();
        let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res
                && ev.paths.iter().any(|p| !p.extension().is_some_and(|e| e == "tmp")) {
                    let _ = app.emit("auxin://files-changed", &root_owned);
                }
        })
        .map_err(|e| e.to_string())?;
        w.watch(&dir, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
        *slot = Some((root.to_string(), w));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_list_delete_round_trip() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().to_str().unwrap();
        write(root, "flows/a.flow.json", r#"{"name":"A"}"#).unwrap();
        write(root, "env/local.json", r#"{"vars":{}}"#).unwrap();
        fs::write(d.path().join(".auxin/flows/notes.txt"), "ignored").unwrap();
        let files = list(root);
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["flows/a.flow.json", "env/local.json"]);
        delete(root, "flows/a.flow.json").unwrap();
        delete(root, "flows/a.flow.json").unwrap();
        assert_eq!(list(root).len(), 1);
    }

    #[test]
    fn run_history_dir_listing_and_read() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().to_str().unwrap();
        assert!(list_dir(root, "runs/flow-a").unwrap().is_empty());
        write(root, "runs/flow-a/2026-01-02.json", "{\"b\":1}").unwrap();
        write(root, "runs/flow-a/2026-01-01.json", "{\"a\":1}").unwrap();
        assert_eq!(list_dir(root, "runs/flow-a").unwrap(), ["2026-01-01.json", "2026-01-02.json"]);
        assert_eq!(read(root, "runs/flow-a/2026-01-01.json").unwrap(), "{\"a\":1}");
        assert!(read(root, "../x").is_err());
        // Writing a run also git-ignores run history.
        assert!(fs::read_to_string(d.path().join(".gitignore")).unwrap().contains(".auxin/runs/"));
    }

    #[cfg(unix)]
    #[test]
    fn a_planted_tmp_symlink_is_never_written_through() {
        let d = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("bashrc");
        fs::write(&victim, "original").unwrap();
        let root = d.path().to_str().unwrap();
        fs::create_dir_all(d.path().join(".auxin/flows")).unwrap();
        // The old temp naming scheme, planted by a malicious repo.
        std::os::unix::fs::symlink(&victim, d.path().join(".auxin/flows/x.flow.tmp")).unwrap();
        write(root, "flows/x.flow.json", "{}").unwrap();
        assert_eq!(fs::read_to_string(&victim).unwrap(), "original");
        assert_eq!(fs::read_to_string(d.path().join(".auxin/flows/x.flow.json")).unwrap(), "{}");
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_inside_auxin_are_refused() {
        let d = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("precious.json"), "keep me").unwrap();
        let root = d.path().to_str().unwrap();
        fs::create_dir_all(d.path().join(".auxin/runs")).unwrap();
        std::os::unix::fs::symlink(outside.path(), d.path().join(".auxin/runs/flow-a")).unwrap();
        assert!(list_dir(root, "runs/flow-a").is_err());
        assert!(delete(root, "runs/flow-a/precious.json").is_err());
        assert!(write(root, "runs/flow-a/x.json", "{}").is_err());
        assert!(read(root, "runs/flow-a/precious.json").is_err());
        assert_eq!(fs::read_to_string(outside.path().join("precious.json")).unwrap(), "keep me");
    }

    #[test]
    fn paths_cannot_escape_auxin_dir() {
        assert!(resolve("/w", "../secret").is_err());
        assert!(resolve("/w", "/etc/passwd").is_err());
        assert!(resolve("/w", "flows/../../x").is_err());
        assert!(resolve("/w", "flows/ok.flow.json").is_ok());
    }

    #[test]
    fn writing_a_secret_updates_gitignore_once() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().to_str().unwrap();
        fs::write(d.path().join(".gitignore"), "node_modules\n.auxin/runs/\n").unwrap();
        write(root, "env/local.secret.json", "{}").unwrap();
        write(root, "env/staging.secret.json", "{}").unwrap();
        let gi = fs::read_to_string(d.path().join(".gitignore")).unwrap();
        assert!(gi.starts_with("node_modules\n.auxin/runs/\n"), "{gi}");
        assert_eq!(gi.matches(".auxin/env/*.secret.json").count(), 1, "{gi}");
        assert_eq!(gi.matches(".auxin/runs/").count(), 1, "{gi}");
    }
}
