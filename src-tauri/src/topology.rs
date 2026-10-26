//! Topology discovery: finds infrastructure (databases, caches, queues, external APIs, compose / k8s
//! workloads without a folder) and the edges between the project's services and it, from
//! docker-compose files, `.env` files, Kubernetes manifests, config files and (opt-in) source code.
//! Every edge carries redacted `<path>:<line>  <snippet>` evidence.

use crate::deps;
use serde::{Deserialize, Serialize};
use serde_yaml_ng::Value;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceRef {
    /// Folder path relative to the root (`api-gateway`, `apps/web`).
    pub key: String,
    /// Absolute folder.
    pub path: String,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    /// Only nodes that are not one of the given services.
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub key: String,
    /// "service" | "database" | "cache" | "queue" | "external"
    pub kind: String,
    pub label: String,
    /// "postgres", "redis", "rabbitmq", …
    pub tech: Option<String>,
    /// "localhost:5432"
    pub endpoint: Option<String>,
    pub evidence: Vec<Evidence>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    /// Node or service key.
    pub from: String,
    pub to: String,
    /// "http" | "database" | "cache" | "queue" | "other"
    pub kind: String,
    pub evidence: Vec<Evidence>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    /// "compose" | "env" | "config" | "k8s" | "code"
    pub source: String,
    /// "declared" | "inferred"
    pub confidence: String,
    /// `<path relative to root>:<line>  <redacted snippet>`
    pub detail: String,
}

const MAX_EVIDENCE: usize = 5;
const MAX_YAML_FILES: usize = 2_000;
const MAX_K8S_DEPTH: usize = 4;

/// Image name prefix (last path segment, no tag) → (kind, tech).
const IMAGES: &[(&str, &str, &str)] = &[
    ("postgres", "database", "postgres"), ("postgis", "database", "postgres"), ("timescale", "database", "postgres"),
    ("mysql", "database", "mysql"), ("mariadb", "database", "mysql"), ("mongo", "database", "mongodb"),
    ("redis", "cache", "redis"), ("valkey", "cache", "redis"), ("keydb", "cache", "redis"), ("memcached", "cache", "memcached"),
    ("rabbitmq", "queue", "rabbitmq"), ("kafka", "queue", "kafka"), ("cp-kafka", "queue", "kafka"), ("redpanda", "queue", "kafka"),
    ("nats", "queue", "nats"), ("elasticsearch", "database", "elasticsearch"), ("opensearch", "database", "elasticsearch"),
    ("localstack", "external", "aws"), ("minio", "external", "s3"),
];

/// URL scheme → (kind, tech, default port).
const SCHEMES: &[(&str, &str, &str, Option<u16>)] = &[
    ("postgres", "database", "postgres", Some(5432)), ("postgresql", "database", "postgres", Some(5432)),
    ("mysql", "database", "mysql", Some(3306)), ("mariadb", "database", "mysql", Some(3306)),
    ("mongodb", "database", "mongodb", Some(27017)), ("mongodb+srv", "database", "mongodb", None),
    ("redis", "cache", "redis", Some(6379)), ("rediss", "cache", "redis", Some(6379)),
    ("amqp", "queue", "rabbitmq", Some(5672)), ("amqps", "queue", "rabbitmq", Some(5671)),
    ("nats", "queue", "nats", Some(4222)), ("kafka", "queue", "kafka", Some(9092)),
];
const KAFKA: (&str, &str, &str, Option<u16>) = ("kafka", "queue", "kafka", Some(9092));

const SECRET_WORDS: &[&str] = &["PASSWORD", "PASSWD", "SECRET", "TOKEN", "API_KEY", "APIKEY", "PRIVATE_KEY", "CREDENTIAL", "AUTHORIZATION"];
pub(crate) const MASK: &str = "••••••";

pub fn discover(root: &Path, services: &[ServiceRef], code_scan: bool) -> Discovery {
    let mut g = Graph {
        root,
        services,
        canon: services.iter().map(|s| fs::canonicalize(&s.path).ok()).collect(),
        nodes: BTreeMap::new(),
        edges: BTreeMap::new(),
        names: HashMap::new(),
        ports: HashMap::new(),
    };
    g.compose();
    g.k8s();
    g.env_files();
    g.service_edges(code_scan);
    g.finish()
}

struct Graph<'a> {
    root: &'a Path,
    services: &'a [ServiceRef],
    /// Canonical service folders, for compose `build` contexts.
    canon: Vec<Option<PathBuf>>,
    nodes: BTreeMap<String, Node>,
    edges: BTreeMap<(String, String), Vec<Evidence>>,
    /// Lowercase compose / k8s name → node or service key.
    names: HashMap<String, String>,
    /// Published host port → compose node key.
    ports: HashMap<u16, String>,
}

impl Graph<'_> {
    fn is_service(&self, key: &str) -> bool {
        self.services.iter().any(|s| s.key == key)
    }

    /// The service whose key's last segment is `name`.
    fn service_named(&self, name: &str) -> Option<&str> {
        self.services.iter().find(|s| s.key.rsplit('/').next().is_some_and(|l| l.eq_ignore_ascii_case(name))).map(|s| s.key.as_str())
    }

    fn node(&mut self, key: &str, kind: &str, label: &str, tech: Option<&str>, endpoint: Option<String>, ev: Evidence) {
        let n = self.nodes.entry(key.to_string()).or_insert_with(|| Node {
            key: key.into(),
            kind: kind.into(),
            label: label.into(),
            tech: None,
            endpoint: None,
            evidence: Vec::new(),
        });
        if n.kind == "service" {
            n.kind = kind.into();
        }
        n.tech = n.tech.take().or(tech.map(String::from));
        n.endpoint = n.endpoint.take().or(endpoint);
        push_evidence(&mut n.evidence, ev);
    }

    fn edge(&mut self, from: &str, to: &str, ev: Evidence) {
        if from != to {
            push_evidence(self.edges.entry((from.to_string(), to.to_string())).or_default(), ev);
        }
    }

    fn finish(self) -> Discovery {
        let Graph { services, mut nodes, edges, .. } = self;
        nodes.retain(|k, _| !services.iter().any(|s| &s.key == k));
        let known = |k: &str| nodes.contains_key(k) || services.iter().any(|s| s.key == k);
        let edges = edges
            .into_iter()
            .filter(|((from, to), _)| known(from) && known(to))
            .map(|((from, to), evidence)| {
                let kind = nodes.get(&to).map(|n| n.kind.as_str()).filter(|k| matches!(*k, "database" | "cache" | "queue")).unwrap_or("http");
                Edge { from, to, kind: kind.into(), evidence }
            })
            .collect();
        Discovery { nodes: nodes.into_values().collect(), edges }
    }

    // ---- docker-compose ----

    fn compose(&mut self) {
        let mut files = Vec::new();
        for dir in std::iter::once(self.root.to_path_buf()).chain(self.services.iter().map(|s| PathBuf::from(&s.path))) {
            let Ok(entries) = fs::read_dir(&dir) else { continue };
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_lowercase();
                if (name.starts_with("docker-compose") || name.starts_with("compose")) && is_yaml(&name) && e.path().is_file() {
                    files.push(e.path());
                }
            }
        }
        files.sort();
        files.dedup();
        // (rel, dir, text, services, compose name → key). Identities first so edges can cross files.
        let mut parsed = Vec::new();
        for path in files {
            let Some(text) = read_text(&path) else { continue };
            let Ok(mut doc) = serde_yaml_ng::from_str::<Value>(&text) else { continue };
            let _ = doc.apply_merge();
            let Some(svcs) = doc.get("services").and_then(Value::as_mapping).cloned() else { continue };
            let rel = deps::rel_path(self.root, &path);
            let dir = path.parent().unwrap_or(self.root).to_path_buf();
            let mut local = HashMap::new();
            for (name, def) in &svcs {
                let Some(name) = name.as_str() else { continue };
                let key = self.compose_identity(&dir, name, def);
                self.names.entry(name.to_lowercase()).or_insert_with(|| key.clone());
                local.insert(name.to_lowercase(), key.clone());
                if self.is_service(&key) {
                    continue;
                }
                let header = header_line(&text, name);
                let image = def.get("image").and_then(Value::as_str);
                let (kind, tech) = image.and_then(image_tech).map_or(("service", None), |(k, t)| (k, Some(t)));
                let port = def.get("ports").and_then(Value::as_sequence).and_then(|p| p.iter().find_map(host_port));
                if let Some(p) = port {
                    self.ports.entry(p).or_insert_with(|| key.clone());
                }
                let line = image.and_then(|i| line_of(&text, header, i)).unwrap_or(header);
                self.node(&key, kind, name, tech, port.map(|p| format!("localhost:{p}")), ev("compose", true, &rel, &text, line));
            }
            parsed.push((rel, text, svcs, local));
        }
        for (rel, text, svcs, local) in &parsed {
            let resolve = |n: &str| local.get(&n.to_lowercase()).or_else(|| self.names.get(&n.to_lowercase())).cloned();
            let mut found = Vec::new();
            for (name, def) in svcs {
                let Some(name) = name.as_str() else { continue };
                let Some(from) = resolve(name) else { continue };
                let header = header_line(text, name);
                for field in ["depends_on", "links"] {
                    for target in compose_refs(def.get(field)) {
                        let Some(to) = resolve(target) else { continue };
                        let line = line_of(text, header, field).and_then(|l| line_of(text, l, target)).unwrap_or(header);
                        found.push((from.clone(), to, ev("compose", true, rel, text, line)));
                    }
                }
                for (key, value) in compose_env(def.get("environment")) {
                    let Some(to) = parse_target(value).and_then(|t| resolve(&t.host)) else { continue };
                    let line = line_of(text, header, key).unwrap_or(header);
                    found.push((from.clone(), to, ev("compose", false, rel, text, line)));
                }
            }
            for (from, to, e) in found {
                self.edge(&from, &to, e);
            }
        }
    }

    /// `build` context that is a given service folder → its key; else a service named like the
    /// compose service → its key; else the compose name.
    fn compose_identity(&self, dir: &Path, name: &str, def: &Value) -> String {
        let ctx = match def.get("build") {
            Some(Value::String(s)) => Some(s.as_str()),
            Some(b) => b.get("context").and_then(Value::as_str),
            None => None,
        };
        if let Some(abs) = ctx.and_then(|c| fs::canonicalize(dir.join(c)).ok())
            && let Some(i) = self.canon.iter().position(|c| c.as_ref() == Some(&abs))
        {
            return self.services[i].key.clone();
        }
        self.service_named(name).unwrap_or(name).to_string()
    }

    // ---- Kubernetes ----

    fn k8s(&mut self) {
        let mut files = Vec::new();
        yaml_files(self.root, 0, &mut files);
        // (rel, text, doc) for Service / Deployment / StatefulSet / DaemonSet documents.
        let mut docs = Vec::new();
        for path in files {
            let Some(text) = read_text(&path) else { continue };
            // `{{` = Helm template, not valid YAML until rendered.
            if text.contains("{{") || !text.contains("apiVersion") {
                continue;
            }
            let rel = deps::rel_path(self.root, &path);
            for doc in serde_yaml_ng::Deserializer::from_str(&text) {
                let Ok(v) = Value::deserialize(doc) else { break };
                let kind = v.get("kind").and_then(Value::as_str).unwrap_or("");
                if v.get("apiVersion").is_some() && ["Service", "Deployment", "StatefulSet", "DaemonSet"].contains(&kind) {
                    docs.push((rel.clone(), text.clone(), v));
                }
            }
        }
        let mut k8s_names: HashMap<String, String> = HashMap::new();
        for (rel, text, v) in &docs {
            let Some(name) = v.get("metadata").and_then(|m| m.get("name")).and_then(Value::as_str) else { continue };
            let key = self.service_named(name).unwrap_or(name).to_string();
            self.names.entry(name.to_lowercase()).or_insert_with(|| key.clone());
            k8s_names.insert(name.to_lowercase(), key.clone());
            if self.is_service(&key) {
                continue;
            }
            let tech = containers(v).find_map(|c| c.get("image").and_then(Value::as_str).and_then(image_tech));
            let (kind, tech) = tech.map_or(("service", None), |(k, t)| (k, Some(t)));
            let line = line_of(text, 0, &format!("name: {name}")).unwrap_or(0);
            self.node(&key, kind, name, tech, None, ev("k8s", true, rel, text, line));
        }
        for (rel, text, v) in &docs {
            let Some(from) = v.get("metadata").and_then(|m| m.get("name")).and_then(Value::as_str).and_then(|n| k8s_names.get(&n.to_lowercase())) else {
                continue;
            };
            let from = from.clone();
            for env in containers(v).filter_map(|c| c.get("env").and_then(Value::as_sequence)).flatten() {
                let Some(value) = env.get("value").and_then(Value::as_str) else { continue };
                let host = parse_target(value).map(|t| t.host).unwrap_or_else(|| value.trim().to_lowercase());
                let Some(to) = k8s_service_name(&host).and_then(|n| k8s_names.get(n)).cloned() else { continue };
                let line = line_of(text, 0, value).unwrap_or(0);
                self.edge(&from, &to, ev("k8s", false, rel, text, line));
            }
        }
    }

    // ---- .env files ----

    fn env_files(&mut self) {
        for svc in self.services {
            let Ok(entries) = fs::read_dir(&svc.path) else { continue };
            let mut files: Vec<PathBuf> = entries
                .flatten()
                .filter(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    (n == ".env" || n.starts_with(".env.")) && e.path().is_file()
                })
                .map(|e| e.path())
                .collect();
            files.sort();
            for path in files {
                let Some(text) = read_text(&path) else { continue };
                let rel = deps::rel_path(self.root, &path);
                for (i, line) in text.lines().enumerate() {
                    let t = line.trim().trim_start_matches("export ").trim_start();
                    if t.starts_with('#') {
                        continue;
                    }
                    let Some((key, value)) = t.split_once('=') else { continue };
                    let value = value.trim().trim_matches(['"', '\'']);
                    self.env_value(&svc.key, &key.trim().to_ascii_uppercase(), value, ev("env", false, &rel, &text, i));
                }
            }
        }
    }

    fn env_value(&mut self, from: &str, key: &str, value: &str, e: Evidence) {
        let Some(t) = parse_target(value) else { return };
        let kafka_key = (key.contains("KAFKA") && key.contains("BROKER")) || key.ends_with("_BROKERS");
        let infra = match t.scheme.as_deref() {
            Some(s) => SCHEMES.iter().find(|(name, ..)| *name == s).copied(),
            None if kafka_key => Some(KAFKA),
            None => None,
        };
        let local = deps::LOCAL_HOSTS.contains(&t.host.as_str());
        if let Some((_, kind, tech, default_port)) = infra {
            let port = t.port.or(default_port);
            let known = self.names.get(&t.host).or_else(|| port.filter(|_| local).and_then(|p| self.ports.get(&p)));
            let to = match known {
                Some(k) => k.clone(),
                None => {
                    let endpoint = port.map_or(t.host.clone(), |p| format!("{}:{p}", t.host));
                    let key = format!("{tech}@{endpoint}");
                    self.node(&key, kind, tech, Some(tech), Some(endpoint), e.clone());
                    key
                }
            };
            self.edge(from, &to, e);
        } else if matches!(t.scheme.as_deref(), Some("http" | "https")) {
            // Local services by port are deps' job; compose names (which may build a service under
            // another name) and public hosts are ours.
            if let Some(to) = self.names.get(&t.host).cloned() {
                self.edge(from, &to, e);
            } else if !local && is_public_host(&t.host) {
                let key = format!("ext:{}", t.host);
                self.node(&key, "external", &t.host, None, None, e.clone());
                self.edge(from, &key, e);
            }
        }
    }

    // ---- service → service (deps.rs) ----

    fn service_edges(&mut self, code_scan: bool) {
        let infos: Vec<deps::ServiceInfo> =
            self.services.iter().map(|s| deps::ServiceInfo { alias: s.key.clone(), path: s.path.clone(), port: s.port }).collect();
        for d in deps::scan_dependencies(self.root, &infos, code_scan) {
            for detail in &d.evidence {
                let e = Evidence { source: d.source.clone(), confidence: "inferred".into(), detail: redact(detail) };
                self.edge(&d.from, &d.to, e);
            }
        }
    }
}

fn push_evidence(list: &mut Vec<Evidence>, e: Evidence) {
    if list.len() < MAX_EVIDENCE && !list.iter().any(|x| x.detail == e.detail) {
        list.push(e);
    }
}

/// Evidence for 0-based line `line` of `text`.
fn ev(source: &str, declared: bool, rel: &str, text: &str, line: usize) -> Evidence {
    Evidence {
        source: source.into(),
        confidence: if declared { "declared" } else { "inferred" }.into(),
        detail: format!("{rel}:{}  {}", line + 1, deps::snippet(text.lines().nth(line).unwrap_or(""))),
    }
}

/// 0-based index of the first line at or after `from` containing `needle`.
fn line_of(text: &str, from: usize, needle: &str) -> Option<usize> {
    text.lines().enumerate().skip(from).find(|(_, l)| l.contains(needle)).map(|(i, _)| i)
}

/// The least-indented `name:` line (the service definition, not a `depends_on` map key).
fn header_line(text: &str, name: &str) -> usize {
    let headers = [format!("{name}:"), format!("\"{name}\":"), format!("'{name}':")];
    text.lines()
        .enumerate()
        .filter(|(_, l)| headers.iter().any(|h| l.trim() == h))
        .min_by_key(|(_, l)| l.len() - l.trim_start().len())
        .map_or(0, |(i, _)| i)
}

fn is_yaml(lower_name: &str) -> bool {
    lower_name.ends_with(".yml") || lower_name.ends_with(".yaml")
}

/// Text of a small, non-binary file.
fn read_text(path: &Path) -> Option<String> {
    if fs::metadata(path).ok()?.len() > deps::MAX_FILE_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if bytes[..bytes.len().min(deps::BINARY_PROBE)].contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// `postgres:16`, `docker.io/bitnami/kafka:3@sha256:…` → (kind, tech).
fn image_tech(image: &str) -> Option<(&'static str, &'static str)> {
    let last = image.split('@').next()?.rsplit('/').next()?.split(':').next()?.to_lowercase();
    IMAGES.iter().find(|(prefix, ..)| last.starts_with(prefix)).map(|(_, kind, tech)| (*kind, *tech))
}

/// Host side of one compose `ports` entry: `"5432:5432"`, `5432`, `"127.0.0.1:80:80/tcp"`, `{published: 5432}`.
fn host_port(v: &Value) -> Option<u16> {
    match v {
        Value::Number(n) => n.as_u64()?.try_into().ok(),
        Value::String(s) => {
            let parts: Vec<&str> = s.split('/').next()?.split(':').collect();
            let host = if parts.len() > 2 { parts[parts.len() - 2] } else { parts[0] };
            host.split('-').next()?.trim().parse().ok()
        }
        Value::Mapping(_) => host_port(v.get("published").or_else(|| v.get("target"))?),
        _ => None,
    }
}

/// Target names of `depends_on` / `links` (list or map form; `links: [db:alias]`).
fn compose_refs(v: Option<&Value>) -> Vec<&str> {
    match v {
        Some(Value::Sequence(s)) => s.iter().filter_map(Value::as_str).map(|t| t.split(':').next().unwrap_or(t)).collect(),
        Some(Value::Mapping(m)) => m.keys().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    }
}

/// `environment` as (key, string value) pairs, list (`K=V`) or map form.
fn compose_env(v: Option<&Value>) -> Vec<(&str, &str)> {
    match v {
        Some(Value::Sequence(s)) => s.iter().filter_map(Value::as_str).filter_map(|kv| kv.split_once('=')).collect(),
        Some(Value::Mapping(m)) => m.iter().filter_map(|(k, v)| Some((k.as_str()?, v.as_str()?))).collect(),
        _ => Vec::new(),
    }
}

/// `spec.template.spec.containers` of a workload (empty for a Service).
fn containers(v: &Value) -> impl Iterator<Item = &Value> {
    v.get("spec").and_then(|s| s.get("template")).and_then(|t| t.get("spec")).and_then(|s| s.get("containers")).and_then(Value::as_sequence).into_iter().flatten()
}

/// `cache`, `cache.ns`, `cache.ns.svc(.cluster.local)` → `cache`.
fn k8s_service_name(host: &str) -> Option<&str> {
    let parts: Vec<&str> = host.split('.').collect();
    (parts.len() <= 2 || parts[2] == "svc").then_some(parts[0])
}

fn is_public_host(host: &str) -> bool {
    host.contains('.')
        && !host.bytes().all(|b| b.is_ascii_digit() || b == b'.')
        && ![".local", ".internal", ".localhost", ".svc", ".cluster.local", ".lan", ".test"].iter().any(|s| host.ends_with(s))
}

/// One reference: `scheme://user@host:port/…` or bare `host:port`. Host and scheme lowercase.
struct Target {
    scheme: Option<String>,
    host: String,
    port: Option<u16>,
}

fn parse_target(value: &str) -> Option<Target> {
    let value = value.trim();
    let (scheme, rest) = match value.split_once("://") {
        Some((s, r)) => (Some(s), r),
        None => (None, value),
    };
    if scheme.is_some_and(|s| s.is_empty() || !s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))) {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    // Multi-host lists (`kafka1:9092,kafka2:9092`, mongo replica sets): the first one.
    let first = authority.split(',').next()?;
    let (host, port) = match first.rsplit_once(':') {
        Some((h, p)) => (h, Some(p.parse().ok()?)),
        None => (first, None),
    };
    if host.is_empty() || !host.bytes().all(deps::is_host_byte) || (scheme.is_none() && port.is_none()) {
        return None;
    }
    Some(Target { scheme: scheme.map(str::to_ascii_lowercase), host: host.to_ascii_lowercase(), port })
}

fn yaml_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        if out.len() >= MAX_YAML_FILES {
            return;
        }
        let path = e.path();
        let Ok(ft) = e.file_type() else { continue };
        let name = e.file_name().to_string_lossy().to_lowercase();
        if ft.is_dir() {
            let helm = name == "templates" && dir.parent().and_then(Path::file_name).is_some_and(|n| n == "charts");
            let skip = name.starts_with('.') || deps::SKIP_DIRS.contains(&name.as_str()) || helm || path.join("pyvenv.cfg").is_file();
            if depth < MAX_K8S_DEPTH && !skip {
                yaml_files(&path, depth + 1, out);
            }
        } else if ft.is_file() && is_yaml(&name) {
            out.push(path);
        }
    }
}

// ---- redaction ----

/// Masks credentials in an evidence snippet: URL userinfo (`postgres://u:p@h` → `postgres://••••@h`)
/// and the value of any secret-looking key (`DB_PASSWORD=x`, `"apiKey": "x"`, `?token=x` → `••••••`).
pub(crate) fn redact(s: &str) -> String {
    mask_secret_values(&strip_userinfo(s))
}

fn strip_userinfo(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find("://") {
        let (head, tail) = rest.split_at(i + 3);
        out.push_str(head);
        let end = tail.find(|c: char| matches!(c, '/' | '?' | '#' | '"' | '\'' | '`') || c.is_whitespace()).unwrap_or(tail.len());
        match tail[..end].rfind('@') {
            Some(at) => {
                out.push_str("••••");
                rest = &tail[at..];
            }
            None => rest = tail,
        }
    }
    out.push_str(rest);
    out
}

fn is_secret_key(key: &str) -> bool {
    let k: String = key.to_ascii_uppercase().chars().filter(|c| !matches!(c, '_' | '-' | '.')).collect();
    SECRET_WORDS.iter().any(|w| k.contains(&w.replace('_', "")))
}

fn mask_secret_values(s: &str) -> String {
    let b = s.as_bytes();
    let is_key_byte = |c: u8| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.');
    let mut out = String::with_capacity(s.len());
    let (mut copied, mut i) = (0, 0);
    while i < b.len() {
        if !is_key_byte(b[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && is_key_byte(b[i]) {
            i += 1;
        }
        // `KEY=v`, `KEY: v`, `"KEY": "v"`
        let mut j = i + usize::from(matches!(b.get(i), Some(b'"' | b'\'')));
        while b.get(j) == Some(&b' ') {
            j += 1;
        }
        if !matches!(b.get(j), Some(b'=' | b':')) || !is_secret_key(&s[start..i]) {
            continue;
        }
        j += 1;
        while b.get(j) == Some(&b' ') {
            j += 1;
        }
        let (from, to) = match b.get(j) {
            Some(&q @ (b'"' | b'\'')) => (j + 1, s[j + 1..].find(q as char).map_or(b.len(), |e| j + 1 + e)),
            _ => (j, unquoted_end(s, j)),
        };
        if to > from {
            out.push_str(&s[copied..from]);
            out.push_str(MASK);
            copied = to;
        }
        i = to.max(i);
    }
    out.push_str(&s[copied..]);
    out
}

/// Where an unquoted value starting at `from` ends: at the end of the line or a
/// delimiter, or before a space that starts the next `key=` (so `Bearer abc` and
/// `two words` are masked whole, but `PASSWORD=x url=…` keeps `url=…`).
fn unquoted_end(s: &str, from: usize) -> usize {
    let line = s[from..].find(['\n', '\r', ',', '}', ']', '&', ';', '"', '\'']).map_or(s.len(), |e| from + e);
    let mut end = from;
    for word in s[from..line].split_inclusive(char::is_whitespace) {
        let w = word.trim();
        let k = w.find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))).unwrap_or(w.len());
        // `key=…`, or `key:` on its own (`user:pass` and `https://…` are part of the value).
        let next_key = end > from && k > 0 && (w[k..].starts_with('=') || w[k..] == *":");
        if next_key {
            break;
        }
        end += word.len();
    }
    from + s[from..end].trim_end().len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/demo-stack")
    }

    fn svc(root: &Path, key: &str, port: Option<u16>) -> ServiceRef {
        let path = root.join(key);
        fs::create_dir_all(&path).unwrap();
        ServiceRef { key: key.into(), path: path.to_string_lossy().into(), port }
    }

    fn write(root: &Path, rel: &str, content: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }

    fn edge<'a>(d: &'a Discovery, from: &str, to: &str) -> &'a Edge {
        d.edges.iter().find(|e| e.from == from && e.to == to).unwrap_or_else(|| panic!("no edge {from} -> {to}: {:#?}", d.edges))
    }

    fn has(e: &Edge, source: &str, confidence: &str) -> bool {
        e.evidence.iter().any(|x| x.source == source && x.confidence == confidence)
    }

    fn demo(code_scan: bool) -> Discovery {
        let root = fixture();
        let services = vec![svc(&root, "api", Some(4000)), svc(&root, "worker", None)];
        discover(&root, &services, code_scan)
    }

    #[test]
    fn demo_stack_nodes_and_edges() {
        let d = demo(false);
        let keys: Vec<&str> = d.nodes.iter().map(|n| n.key.as_str()).collect();
        assert_eq!(keys, ["cache", "ext:api.stripe.com", "postgres", "rabbitmq"]);
        let node = |k: &str| d.nodes.iter().find(|n| n.key == k).unwrap();
        let pg = node("postgres");
        assert_eq!((pg.kind.as_str(), pg.tech.as_deref(), pg.endpoint.as_deref()), ("database", Some("postgres"), Some("localhost:5432")));
        let mq = node("rabbitmq");
        assert_eq!((mq.kind.as_str(), mq.tech.as_deref(), mq.endpoint.as_deref()), ("queue", Some("rabbitmq"), Some("localhost:5672")));
        let cache = node("cache");
        assert_eq!((cache.kind.as_str(), cache.tech.as_deref()), ("cache", Some("redis")));
        let ext = node("ext:api.stripe.com");
        assert_eq!((ext.kind.as_str(), ext.label.as_str()), ("external", "api.stripe.com"));

        let pairs: Vec<(&str, &str, &str)> = d.edges.iter().map(|e| (e.from.as_str(), e.to.as_str(), e.kind.as_str())).collect();
        assert_eq!(
            pairs,
            [
                ("api", "cache", "cache"),
                ("api", "ext:api.stripe.com", "http"),
                ("api", "postgres", "database"),
                ("api", "rabbitmq", "queue"),
                ("worker", "rabbitmq", "queue"),
            ]
        );
        let api_pg = edge(&d, "api", "postgres");
        assert!(has(api_pg, "compose", "declared") && has(api_pg, "compose", "inferred"), "{api_pg:#?}");
        assert_eq!(api_pg.evidence[0].detail, "docker-compose.yml:8  - postgres");
        let api_mq = edge(&d, "api", "rabbitmq");
        assert!(has(api_mq, "compose", "declared") && has(api_mq, "env", "inferred"), "{api_mq:#?}");
        assert!(has(edge(&d, "worker", "rabbitmq"), "compose", "declared"));
        assert!(has(edge(&d, "api", "ext:api.stripe.com"), "env", "inferred"));
        assert!(has(edge(&d, "api", "cache"), "k8s", "inferred"));
    }

    #[test]
    fn demo_stack_json_has_no_credentials() {
        let json = serde_json::to_string(&demo(true)).unwrap();
        assert!(!json.contains("devpass") && !json.contains("guest:guest"), "{json}");
        assert!(json.contains("postgres://••••@postgres:5432/app"), "{json}");
        // camelCase contract keys.
        for key in ["\"nodes\"", "\"edges\"", "\"endpoint\"", "\"tech\"", "\"confidence\"", "\"detail\"", "\"evidence\""] {
            assert!(json.contains(key), "{key}");
        }
    }

    #[test]
    fn redaction() {
        assert_eq!(redact("DATABASE_URL=postgres://app:devpass@db:5432/app"), "DATABASE_URL=postgres://••••@db:5432/app");
        assert_eq!(redact("- POSTGRES_PASSWORD=devpass"), "- POSTGRES_PASSWORD=••••••");
        assert_eq!(redact("POSTGRES_PASSWORD: devpass"), "POSTGRES_PASSWORD: ••••••");
        assert_eq!(redact("\"apiKey\": \"sk_live_1\","), "\"apiKey\": \"••••••\",");
        assert_eq!(redact("export GITHUB_TOKEN='a b'"), "export GITHUB_TOKEN='••••••'");
        assert_eq!(redact("x=https://h/cb?client_secret=abc&y=1"), "x=https://h/cb?client_secret=••••••&y=1");
        assert_eq!(redact("mongodb+srv://u:p@a@c.example.net,d:1/x"), "mongodb+srv://••••@c.example.net,d:1/x");
        assert_eq!(redact("private-key: k"), "private-key: ••••••");
        assert_eq!(redact("Authorization: Bearer eyJabc.def"), "Authorization: ••••••");
        assert_eq!(redact("DB_PASSWORD=two words\nNEXT=1"), "DB_PASSWORD=••••••\nNEXT=1");
        assert_eq!(redact("TOKEN=abc  "), "TOKEN=••••••  ");
        assert_eq!(redact("Authorization: Basic user:pass"), "Authorization: ••••••");
        // Untouched: no secret key, no userinfo; idempotent.
        assert_eq!(redact("API_URL=http://localhost:8000"), "API_URL=http://localhost:8000");
        assert_eq!(redact(&redact("PASSWORD=x url=redis://:p@h")), "PASSWORD=•••••• url=redis://••••@h");
    }

    #[test]
    fn code_scan_is_opt_in() {
        let dir = tempfile::tempdir().unwrap();
        let services = vec![svc(dir.path(), "web", None), svc(dir.path(), "pg", Some(5432))];
        write(dir.path(), "web/src/db.ts", "connect('postgres://localhost:5432/app');\n");
        assert!(discover(dir.path(), &services, false).edges.is_empty());
        let d = discover(dir.path(), &services, true);
        assert_eq!(d.edges.len(), 1);
        assert_eq!((d.edges[0].from.as_str(), d.edges[0].to.as_str()), ("web", "pg"));
        assert_eq!(d.edges[0].evidence[0].source, "code");
        assert_eq!(d.edges[0].evidence[0].detail, "web/src/db.ts:1  connect('postgres://localhost:5432/app');");
    }

    #[test]
    fn compose_name_maps_to_service_without_build() {
        let dir = tempfile::tempdir().unwrap();
        let services = vec![svc(dir.path(), "apps/web", Some(3000))];
        write(
            dir.path(),
            "compose.yaml",
            "services:\n  web:\n    image: node:20\n    ports: [\"3000:3000\"]\n    links: [\"db:database\"]\n  db:\n    image: mysql:8\n    ports:\n      - target: 3306\n        published: \"3307\"\n",
        );
        let d = discover(dir.path(), &services, false);
        assert_eq!(d.nodes.len(), 1, "{:#?}", d.nodes);
        assert_eq!((d.nodes[0].key.as_str(), d.nodes[0].kind.as_str(), d.nodes[0].endpoint.as_deref()), ("db", "database", Some("localhost:3307")));
        assert_eq!(d.edges.len(), 1);
        assert_eq!((d.edges[0].from.as_str(), d.edges[0].to.as_str(), d.edges[0].kind.as_str()), ("apps/web", "db", "database"));
        assert_eq!(d.edges[0].evidence[0].detail, "compose.yaml:5  links: [\"db:database\"]");
    }

    #[test]
    fn helm_templates_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = |name: &str| format!("apiVersion: v1\nkind: Service\nmetadata:\n  name: {name}\n");
        write(dir.path(), "charts/app/templates/svc.yaml", &manifest("templated"));
        write(dir.path(), "deploy/helmish.yaml", &format!("{}  labels: {{{{ .Values.labels }}}}\n", manifest("braces")));
        write(dir.path(), "deploy/plain.yaml", &manifest("plain"));
        let d = discover(dir.path(), &[], false);
        let keys: Vec<&str> = d.nodes.iter().map(|n| n.key.as_str()).collect();
        assert_eq!(keys, ["plain"]);
    }

    #[test]
    fn env_infra_without_compose_and_self_edges_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let services = vec![svc(dir.path(), "api", Some(8000))];
        write(
            dir.path(),
            "api/.env.local",
            "# REDIS_URL=redis://old:6379\nREDIS_URL=redis://localhost\nKAFKA_BROKERS=k1:9093,k2:9093\nSELF=http://localhost:8000\nLAN=http://10.0.0.5:80\n",
        );
        let d = discover(dir.path(), &services, false);
        let keys: Vec<&str> = d.nodes.iter().map(|n| n.key.as_str()).collect();
        assert_eq!(keys, ["kafka@k1:9093", "redis@localhost:6379"]);
        assert_eq!(d.nodes[1].endpoint.as_deref(), Some("localhost:6379"));
        let pairs: Vec<(&str, &str)> = d.edges.iter().map(|e| (e.from.as_str(), e.to.as_str())).collect();
        assert_eq!(pairs, [("api", "kafka@k1:9093"), ("api", "redis@localhost:6379")]);
        assert_eq!(d.edges[1].evidence[0].detail, "api/.env.local:2  REDIS_URL=redis://localhost");
    }
}
