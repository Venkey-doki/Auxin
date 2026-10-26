//! Static dependency scan: reads each service's folder for URL-ish references
//! (`localhost:8000`, `http://api:3000`, `FOO_HOST` + `FOO_PORT`) that point at another
//! service, and turns them into "from calls to" edges with file:line evidence.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    pub alias: String,
    /// Absolute service folder.
    pub path: String,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedEdge {
    /// Alias of the calling service.
    pub from: String,
    /// Alias of the called service.
    pub to: String,
    /// "env" | "config" | "code"
    pub source: String,
    /// Up to 3 entries: `<path relative to the workspace root>:<line>  <snippet>`.
    pub evidence: Vec<String>,
}

pub(crate) const SKIP_DIRS: &[&str] =
    &["node_modules", ".git", "venv", ".venv", "dist", "build", "target", "coverage", "__pycache__", ".next", ".turbo", "out", "vendor"];

/// Lockfiles are big, noisy, and never describe a runtime dependency.
const SKIP_FILES: &[&str] = &["package-lock.json", "pnpm-lock.yaml", "composer.lock"];

const CODE_EXTS: &[&str] = &["js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "go", "rs", "java", "kt", "rb", "php", "cs"];
const CONFIG_EXTS: &[&str] = &["toml", "ini", "json", "yml", "yaml"];

/// Hosts that mean "this machine", so the port alone identifies the callee.
pub(crate) const LOCAL_HOSTS: &[&str] = &["localhost", "127.0.0.1", "0.0.0.0", "host.docker.internal"];

pub(crate) const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_FILES: usize = 5_000;
const MAX_TOTAL_BYTES: u64 = 50 * 1024 * 1024;
pub(crate) const BINARY_PROBE: usize = 8 * 1024;
const MAX_EVIDENCE: usize = 3;
const MAX_SNIPPET: usize = 160;

/// Where a hit was found. Declaration order is the precedence order (env wins).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Source {
    Env,
    Config,
    Code,
}

impl Source {
    fn as_str(self) -> &'static str {
        match self {
            Source::Env => "env",
            Source::Config => "config",
            Source::Code => "code",
        }
    }
}

/// Lookup tables shared by every file scan.
struct Tables {
    /// Lowercase alias / folder name → service index.
    names: Vec<(String, usize)>,
    /// Listening port → service index (first service wins on duplicates).
    ports: HashMap<u16, usize>,
}

impl Tables {
    fn new(services: &[ServiceInfo]) -> Self {
        let mut names = Vec::new();
        let mut ports = HashMap::new();
        for (i, s) in services.iter().enumerate() {
            names.push((s.alias.to_lowercase(), i));
            if let Some(folder) = Path::new(&s.path).file_name().and_then(|n| n.to_str()) {
                names.push((folder.to_lowercase(), i));
            }
            if let Some(p) = s.port {
                ports.entry(p).or_insert(i);
            }
        }
        names.retain(|(n, _)| !n.is_empty());
        Tables { names, ports }
    }

    /// Resolves `host:port` to a service index. A service name wins over the port
    /// (docker-compose style `api:3000` uses the container port, not the host one).
    fn resolve(&self, host: &str, port: u16) -> Option<usize> {
        if let Some((_, i)) = self.names.iter().find(|(n, _)| n.eq_ignore_ascii_case(host)) {
            return Some(*i);
        }
        if LOCAL_HOSTS.iter().any(|h| h.eq_ignore_ascii_case(host)) {
            return self.ports.get(&port).copied();
        }
        None
    }
}

/// Per-service accumulator for one (from, to) pair.
struct EdgeAcc {
    to: usize,
    source: Source,
    evidence: Vec<String>,
}

/// Everything one service walk needs.
struct Walk<'a> {
    root: &'a Path,
    from: usize,
    tables: &'a Tables,
    /// False skips `Source::Code` files without reading them.
    include_code: bool,
    /// Other services' folders; nested ones are not ours to scan.
    other_roots: Vec<PathBuf>,
    files: usize,
    bytes: u64,
    edges: Vec<EdgeAcc>,
}

pub fn scan_dependencies(root: &Path, services: &[ServiceInfo], include_code: bool) -> Vec<DetectedEdge> {
    let tables = Tables::new(services);
    let mut out = Vec::new();
    for (from, svc) in services.iter().enumerate() {
        let svc_root = PathBuf::from(&svc.path);
        let mut walk = Walk {
            root,
            from,
            tables: &tables,
            include_code,
            other_roots: services.iter().enumerate().filter(|(i, _)| *i != from).map(|(_, s)| PathBuf::from(&s.path)).collect(),
            files: 0,
            bytes: 0,
            edges: Vec::new(),
        };
        walk.dir(&svc_root, &svc_root);
        for e in walk.edges {
            out.push(DetectedEdge { from: svc.alias.clone(), to: services[e.to].alias.clone(), source: e.source.as_str().to_string(), evidence: e.evidence });
        }
    }
    out
}

impl Walk<'_> {
    fn exhausted(&self) -> bool {
        self.files >= MAX_FILES || self.bytes >= MAX_TOTAL_BYTES
    }

    /// Depth-first walk with sorted entries so evidence order is deterministic.
    fn dir(&mut self, dir: &Path, svc_root: &Path) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            if self.exhausted() {
                return;
            }
            let path = entry.path();
            // `DirEntry::file_type` does not follow symlinks, so links are neither dirs nor files here.
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if SKIP_DIRS.contains(&name.as_ref()) || path.join("pyvenv.cfg").is_file() || self.other_roots.contains(&path) {
                    continue;
                }
                self.dir(&path, svc_root);
            } else if ft.is_file() {
                self.file(&path, svc_root);
            }
        }
    }

    fn file(&mut self, path: &Path, svc_root: &Path) {
        let Some(source) = classify(path, svc_root) else { return };
        if source == Source::Code && !self.include_code {
            return;
        }
        let Ok(meta) = fs::metadata(path) else { return };
        if meta.len() > MAX_FILE_BYTES {
            return;
        }
        let Ok(bytes) = fs::read(path) else { return };
        self.files += 1;
        self.bytes += bytes.len() as u64;
        if bytes[..bytes.len().min(BINARY_PROBE)].contains(&0) {
            return;
        }
        let text = String::from_utf8_lossy(&bytes);
        let is_compose = is_compose_file(path);
        let rel = rel_path(self.root, path);
        let mut hits = scan_text(&text, source, is_compose, self.tables);
        if source == Source::Env {
            hits.extend(scan_env_pairs(&text, self.tables));
            hits.sort_by_key(|h| h.line);
        }
        for h in hits {
            self.record(h.to, source, format!("{rel}:{}  {}", h.line, h.snippet));
        }
    }

    fn record(&mut self, to: usize, source: Source, evidence: String) {
        if to == self.from {
            return;
        }
        match self.edges.iter_mut().find(|e| e.to == to) {
            Some(e) => {
                e.source = e.source.min(source);
                if e.evidence.len() < MAX_EVIDENCE {
                    e.evidence.push(evidence);
                }
            }
            None => self.edges.push(EdgeAcc { to, source, evidence: vec![evidence] }),
        }
    }
}

/// One matched reference on a 1-based line.
struct Hit {
    line: usize,
    to: usize,
    snippet: String,
}

fn classify(path: &Path, svc_root: &Path) -> Option<Source> {
    let name = path.file_name()?.to_str()?.to_lowercase();
    if SKIP_FILES.contains(&name.as_str()) {
        return None;
    }
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let is_yaml = ext == "yml" || ext == "yaml";
    if name == ".env" || name.starts_with(".env.") || (is_yaml && is_compose_name(&name)) {
        return Some(Source::Env);
    }
    let in_config_dir = path
        .strip_prefix(svc_root)
        .ok()
        .and_then(|r| r.parent())
        .is_some_and(|p| p.components().any(|c| matches!(c.as_os_str().to_str(), Some("config" | "configs"))));
    let stem_is = |prefix: &str, exts: &[&str]| name.starts_with(prefix) && exts.contains(&ext.as_str());
    if in_config_dir
        || name.contains(".config.")
        || (name.contains("routes") && ext == "json")
        || stem_is("settings", &["py"])
        || stem_is("application", &["yml", "yaml", "properties"])
        || stem_is("appsettings", &["json"])
        || CONFIG_EXTS.contains(&ext.as_str())
    {
        return Some(Source::Config);
    }
    CODE_EXTS.contains(&ext.as_str()).then_some(Source::Code)
}

fn is_compose_name(lower_name: &str) -> bool {
    lower_name.starts_with("docker-compose") || lower_name.starts_with("compose.")
}

fn is_compose_file(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
    is_compose_name(&name) && (name.ends_with(".yml") || name.ends_with(".yaml"))
}

/// Path relative to the workspace root with `/` separators (falls back to the full path).
pub(crate) fn rel_path(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")
}

/// Trimmed, redacted (before truncation, so a cut never exposes a secret) and capped line.
pub(crate) fn snippet(line: &str) -> String {
    crate::topology::redact(line.trim()).chars().take(MAX_SNIPPET).collect()
}

/// Finds `host:port` references line by line.
fn scan_text(text: &str, source: Source, is_compose: bool, tables: &Tables) -> Vec<Hit> {
    let mut hits = Vec::new();
    for (n, line) in text.lines().enumerate() {
        let t = line.trim();
        if t.is_empty() || (source == Source::Env && t.starts_with('#')) {
            continue;
        }
        // `image: redis:7` looks like host:port but is a tag.
        if is_compose && t.trim_start_matches("- ").starts_with("image:") {
            continue;
        }
        for to in match_line(t, tables) {
            hits.push(Hit { line: n + 1, to, snippet: snippet(t) });
        }
    }
    hits
}

pub(crate) fn is_host_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_')
}

/// Service indexes referenced on one line, each at most once.
fn match_line(line: &str, tables: &Tables) -> Vec<usize> {
    let bytes = line.as_bytes();
    let mut found = Vec::new();
    for (i, &b) in bytes.iter().enumerate() {
        if b != b':' || !bytes.get(i + 1).is_some_and(u8::is_ascii_digit) {
            continue;
        }
        // Port: up to 5 digits, not followed by more digits or letters.
        let digits = bytes[i + 1..].iter().take_while(|d| d.is_ascii_digit()).count();
        let after = bytes.get(i + 1 + digits).copied();
        if digits > 5 || after.is_some_and(|a| a.is_ascii_alphanumeric() || a == b'_') {
            continue;
        }
        let Ok(port) = line[i + 1..i + 1 + digits].parse::<u16>() else { continue };
        // Host: the maximal run of hostname characters just before the colon.
        let start = bytes[..i].iter().rposition(|&c| !is_host_byte(c)).map_or(0, |p| p + 1);
        if start == i {
            continue;
        }
        if let Some(to) = tables.resolve(&line[start..i], port)
            && !found.contains(&to)
        {
            found.push(to);
        }
    }
    found
}

/// `KEY=value` (or `KEY: value`, optionally `export ` / `- ` prefixed) → (KEY, unquoted value).
fn parse_kv(line: &str) -> Option<(&str, &str)> {
    let t = line.trim().trim_start_matches("- ").trim_start_matches("export ").trim_start();
    let at = t.find(['=', ':'])?;
    let key = t[..at].trim();
    if key.is_empty() || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        return None;
    }
    Some((key, t[at + 1..].trim().trim_matches(['"', '\''])))
}

/// Host part of an env value: `http://localhost/x` → `localhost`. None when it carries a port.
fn bare_host(value: &str) -> Option<&str> {
    let v = value.split_once("://").map_or(value, |(_, rest)| rest);
    let host = v.split(['/', '?', '#']).next()?;
    (!host.is_empty() && !host.contains(':')).then_some(host)
}

/// Pairs `FOO_HOST=localhost` (or `FOO_URL=http://localhost`) with `FOO_PORT=8000` in one file.
fn scan_env_pairs(text: &str, tables: &Tables) -> Vec<Hit> {
    // prefix → (line, host, trimmed line)
    let mut hosts: Vec<(String, usize, String, String)> = Vec::new();
    let mut ports: HashMap<String, (usize, u16, String)> = HashMap::new();
    for (n, line) in text.lines().enumerate() {
        let t = line.trim();
        if t.starts_with('#') {
            continue;
        }
        let Some((key, value)) = parse_kv(t) else { continue };
        let key = key.to_ascii_uppercase();
        if let Some(prefix) = key.strip_suffix("_PORT") {
            if let Ok(p) = value.parse::<u16>() {
                ports.insert(prefix.to_string(), (n + 1, p, snippet(t)));
            }
        } else if let Some(prefix) = ["_HOSTNAME", "_HOST", "_URL"].iter().find_map(|s| key.strip_suffix(s))
            && let Some(host) = bare_host(value)
        {
            hosts.push((prefix.to_string(), n + 1, host.to_string(), snippet(t)));
        }
    }
    let mut hits = Vec::new();
    for (prefix, line, host, host_text) in hosts {
        let Some((_, port, port_text)) = ports.get(&prefix) else { continue };
        if let Some(to) = tables.resolve(&host, *port) {
            let both: String = format!("{host_text}  {port_text}").chars().take(MAX_SNIPPET).collect();
            hits.push(Hit { line, to, snippet: both });
        }
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn svc(root: &Path, alias: &str, folder: &str, port: Option<u16>) -> ServiceInfo {
        let path = root.join(folder);
        fs::create_dir_all(&path).unwrap();
        ServiceInfo { alias: alias.into(), path: path.to_string_lossy().into(), port }
    }

    fn write(root: &Path, rel: &str, content: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }

    /// web (3000) and api (8000), the usual pair.
    fn pair(root: &Path) -> Vec<ServiceInfo> {
        vec![svc(root, "web", "web", Some(3000)), svc(root, "api", "api", Some(8000))]
    }

    fn edge(from: &str, to: &str, source: &str, evidence: &[&str]) -> DetectedEdge {
        DetectedEdge { from: from.into(), to: to.into(), source: source.into(), evidence: evidence.iter().map(|s| s.to_string()).collect() }
    }

    #[test]
    fn env_url() {
        let dir = tempfile::tempdir().unwrap();
        let services = pair(dir.path());
        write(dir.path(), "web/.env", "# API_URL=http://localhost:8000\nAPI_URL=http://localhost:8000/v1\n");
        let got = scan_dependencies(dir.path(), &services, true);
        // The commented-out line is not evidence.
        assert_eq!(got, vec![edge("web", "api", "env", &["web/.env:2  API_URL=http://localhost:8000/v1"])]);
    }

    #[test]
    fn docker_compose_host_by_service_name() {
        let dir = tempfile::tempdir().unwrap();
        let services = pair(dir.path());
        // 5000 is not a known port; the service name alone is enough. `image: api:5` is a tag.
        write(dir.path(), "web/docker-compose.yml", "services:\n  web:\n    image: api:5\n    environment:\n      - BACKEND=http://API:5000/graphql\n");
        let got = scan_dependencies(dir.path(), &services, true);
        assert_eq!(got, vec![edge("web", "api", "env", &["web/docker-compose.yml:5  - BACKEND=http://API:5000/graphql"])]);
    }

    #[test]
    fn folder_name_counts_as_host() {
        let dir = tempfile::tempdir().unwrap();
        let services = vec![svc(dir.path(), "web", "web", None), svc(dir.path(), "Orders API", "orders-svc", Some(9000))];
        write(dir.path(), "web/.env", "ORDERS=http://orders-svc:1234\n");
        let got = scan_dependencies(dir.path(), &services, true);
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].from.as_str(), got[0].to.as_str()), ("web", "Orders API"));
    }

    #[test]
    fn config_json() {
        let dir = tempfile::tempdir().unwrap();
        let services = pair(dir.path());
        write(dir.path(), "web/proxy.config.json", "{\n  \"/api\": \"http://localhost:8081\"\n}\n");
        let mut services = services;
        services[1].port = Some(8081);
        let got = scan_dependencies(dir.path(), &services, true);
        assert_eq!(got, vec![edge("web", "api", "config", &["web/proxy.config.json:2  \"/api\": \"http://localhost:8081\""])]);
    }

    #[test]
    fn code_literal_in_ts() {
        let dir = tempfile::tempdir().unwrap();
        let services = pair(dir.path());
        write(dir.path(), "web/src/client.ts", "const base = 'http://127.0.0.1:8000';\nfetch(base + '/x');\n");
        let got = scan_dependencies(dir.path(), &services, true);
        assert_eq!(got, vec![edge("web", "api", "code", &["web/src/client.ts:1  const base = 'http://127.0.0.1:8000';"])]);
    }

    #[test]
    fn split_host_port_pair() {
        let dir = tempfile::tempdir().unwrap();
        let services = pair(dir.path());
        write(dir.path(), "web/.env.local", "export API_HOST=\"localhost\"\nOTHER=1\nAPI_PORT=8000\n");
        let got = scan_dependencies(dir.path(), &services, true);
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].from.as_str(), got[0].to.as_str(), got[0].source.as_str()), ("web", "api", "env"));
        assert_eq!(got[0].evidence, vec!["web/.env.local:1  export API_HOST=\"localhost\"  API_PORT=8000"]);
    }

    #[test]
    fn split_pair_with_url_and_unmatched_halves() {
        let dir = tempfile::tempdir().unwrap();
        let services = pair(dir.path());
        write(dir.path(), "web/.env", "A_URL=http://localhost\nA_PORT=8000\nB_HOST=localhost\nC_PORT=8000\n");
        let got = scan_dependencies(dir.path(), &services, true);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].evidence.len(), 1, "only the A pair matches");
    }

    #[test]
    fn skips_node_modules_and_venvs() {
        let dir = tempfile::tempdir().unwrap();
        let services = pair(dir.path());
        write(dir.path(), "web/node_modules/dep/index.js", "fetch('http://localhost:8000')");
        write(dir.path(), "web/dist/app.js", "fetch('http://localhost:8000')");
        write(dir.path(), "web/pyenv/pyvenv.cfg", "home = /usr/bin\n");
        write(dir.path(), "web/pyenv/lib/x.py", "URL = 'http://localhost:8000'");
        assert!(scan_dependencies(dir.path(), &services, true).is_empty());
    }

    #[test]
    fn skips_binary_and_oversized_files() {
        let dir = tempfile::tempdir().unwrap();
        let services = pair(dir.path());
        write(dir.path(), "web/a.js", "\0\0 http://localhost:8000");
        let big = format!("// http://localhost:8000\n{}", "x".repeat(MAX_FILE_BYTES as usize));
        write(dir.path(), "web/b.js", &big);
        assert!(scan_dependencies(dir.path(), &services, true).is_empty());
    }

    #[test]
    fn nested_service_folder_is_not_scanned_as_parent() {
        let dir = tempfile::tempdir().unwrap();
        let mut services = vec![svc(dir.path(), "mono", "mono", None), svc(dir.path(), "api", "mono/apps/api", Some(8000))];
        services.push(svc(dir.path(), "web", "mono/apps/web", Some(3000)));
        write(dir.path(), "mono/apps/web/.env", "API=http://localhost:8000\n");
        let got = scan_dependencies(dir.path(), &services, true);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].from, "web");
    }

    #[test]
    fn self_port_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let services = pair(dir.path());
        write(dir.path(), "api/.env", "SELF=http://localhost:8000\nPORT=8000\n");
        write(dir.path(), "api/src/main.ts", "app.listen(8000); // http://api:8000\n");
        assert!(scan_dependencies(dir.path(), &services, true).is_empty());
    }

    #[test]
    fn unknown_port_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let services = pair(dir.path());
        write(dir.path(), "web/.env", "DB=postgres://localhost:5432/x\nCACHE=http://localhost:70000\nT=localhost:8000x\n");
        assert!(scan_dependencies(dir.path(), &services, true).is_empty());
    }

    #[test]
    fn evidence_format_and_relative_path() {
        let dir = tempfile::tempdir().unwrap();
        let services = pair(dir.path());
        let long = format!("const u = 'http://localhost:8000'; // {}", "y".repeat(300));
        write(dir.path(), "web/src/lib/api/client.ts", &format!("\n\n    {long}\n"));
        let got = scan_dependencies(dir.path(), &services, true);
        let ev = &got[0].evidence[0];
        assert!(ev.starts_with("web/src/lib/api/client.ts:3  const u = 'http://localhost:8000';"), "{ev}");
        let snippet = ev.split_once("  ").unwrap().1;
        assert_eq!(snippet.chars().count(), MAX_SNIPPET);
    }

    #[test]
    fn evidence_capped_at_three_in_walk_order() {
        let dir = tempfile::tempdir().unwrap();
        let services = pair(dir.path());
        for name in ["a", "b", "c", "d", "e"] {
            write(dir.path(), &format!("web/src/{name}.js"), "x('http://localhost:8000');\n");
        }
        let got = scan_dependencies(dir.path(), &services, true);
        assert_eq!(got.len(), 1);
        let files: Vec<&str> = got[0].evidence.iter().map(|e| e.split(':').next().unwrap()).collect();
        assert_eq!(files, ["web/src/a.js", "web/src/b.js", "web/src/c.js"]);
    }

    #[test]
    fn dedupes_and_prefers_env_over_config_over_code() {
        let dir = tempfile::tempdir().unwrap();
        let mut services = pair(dir.path());
        services.push(svc(dir.path(), "auth", "auth", Some(9000)));
        // `a.ts` (code) sorts before `config.json` and `.env`, so evidence starts with code.
        write(dir.path(), "web/a.ts", "x('http://localhost:8000');\n");
        write(dir.path(), "web/config.json", "{\"api\": \"http://localhost:8000\"}\n");
        write(dir.path(), "web/.env", "API=localhost:8000\n");
        // auth is only referenced from config and code → config wins.
        write(dir.path(), "web/settings.json", "{\"auth\": \"localhost:9000\"}\n");
        write(dir.path(), "web/b.ts", "x('localhost:9000');\n");
        let got = scan_dependencies(dir.path(), &services, true);
        let web_api = got.iter().filter(|e| e.from == "web" && e.to == "api").collect::<Vec<_>>();
        assert_eq!(web_api.len(), 1, "one edge per (from, to)");
        assert_eq!(web_api[0].source, "env");
        assert_eq!(web_api[0].evidence.len(), 3);
        let web_auth = got.iter().find(|e| e.from == "web" && e.to == "auth").unwrap();
        assert_eq!(web_auth.source, "config");
        assert_eq!(web_auth.evidence.len(), 2);
    }
}

#[cfg(test)]
mod real_world {
    /// `AUXIN_SCAN_ROOT=~/code cargo test deps_prints -- --nocapture --ignored`
    #[test]
    #[ignore]
    fn deps_prints() {
        let root = std::env::var("AUXIN_SCAN_ROOT").expect("set AUXIN_SCAN_ROOT");
        let services: Vec<super::ServiceInfo> =
            crate::scan::scan(std::path::Path::new(&root)).into_iter().map(|s| super::ServiceInfo { alias: s.name, path: s.path, port: s.port_hint }).collect();
        for e in super::scan_dependencies(std::path::Path::new(&root), &services, true) {
            println!("{} -> {} [{}]\n    {}", e.from, e.to, e.source, e.evidence.join("\n    "));
        }
    }
}
