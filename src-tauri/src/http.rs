//! HTTP client for flows. Requests go out from Rust rather than the webview, so
//! there is no CORS, headers like Origin/Cookie can be set, and timing is real.

use crate::netpolicy::{Blocked, NetPolicy, Resolver};
use base64::Engine as _;
use reqwest::{cookie::Jar, redirect::Policy, Client, Method};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Responses beyond this are cut in the UI; the full body goes to a temp file.
const MAX_INLINE_BODY: usize = 10 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum HttpBody {
    None,
    Text(String),
    Base64(String),
    /// Path relative to `HttpRequest::root`; read here so large payload files
    /// never cross the IPC bridge.
    File(String),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub id: String,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    pub body: HttpBody,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
    #[serde(default = "default_true")]
    pub follow_redirects: bool,
    #[serde(default)]
    pub insecure_tls: bool,
    /// Requests sharing a jar id share cookies (one jar per flow run).
    pub cookie_jar: Option<String>,
    /// Workspace root. A file body must resolve inside it.
    #[serde(default)]
    pub root: Option<String>,
    /// Where this request may connect; enforced on every hop and resolved address.
    #[serde(default)]
    pub policy: NetPolicy,
}

fn default_timeout() -> u64 {
    30_000
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub content_type: Option<String>,
    /// UTF-8 body when it decodes cleanly, otherwise `body_base64` is set.
    pub body_text: Option<String>,
    pub body_base64: Option<String>,
    pub size: usize,
    pub truncated: bool,
    /// Full body on disk when `truncated`.
    pub full_body_path: Option<String>,
    pub first_byte_ms: u64,
    pub total_ms: u64,
}

#[derive(Default)]
pub struct HttpState {
    jars: Mutex<HashMap<String, Arc<Jar>>>,
    inflight: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
}

impl HttpState {
    fn jar(&self, id: &str) -> Arc<Jar> {
        self.jars.lock().unwrap().entry(id.to_string()).or_default().clone()
    }

    pub fn drop_jar(&self, id: &str) {
        self.jars.lock().unwrap().remove(id);
    }

    /// Runs `send` so `cancel(id)` can abort it mid-flight.
    pub async fn send(self: Arc<Self>, req: HttpRequest, temp_dir: PathBuf) -> Result<HttpResponse, String> {
        let id = req.id.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let me = self.clone();
        let handle = tauri::async_runtime::spawn(async move {
            let _ = tx.send(execute(&me, req, temp_dir).await);
        });
        self.inflight.lock().unwrap().insert(id.clone(), handle);
        let out = rx.await.unwrap_or_else(|_| Err("Cancelled".into()));
        self.inflight.lock().unwrap().remove(&id);
        out
    }

    pub fn cancel(&self, id: &str) -> bool {
        match self.inflight.lock().unwrap().remove(id) {
            Some(h) => {
                h.abort();
                true
            }
            None => false,
        }
    }
}

/// A readable error that names only host:port: the full URL can carry a
/// resolved secret (`?key=…`), and reqwest's own messages append it.
fn friendly(e: reqwest::Error, url: &str) -> String {
    // Policy refusals from the resolver or redirect policy arrive wrapped.
    let mut src: Option<&dyn std::error::Error> = Some(&e);
    while let Some(s) = src {
        if let Some(b) = s.downcast_ref::<Blocked>() {
            return b.to_string();
        }
        src = s.source();
    }
    let h = reqwest::Url::parse(url)
        .ok()
        .map(|u| format!("{}:{}", u.host_str().unwrap_or("?"), u.port_or_known_default().unwrap_or(0)))
        .unwrap_or_else(|| "the server".to_string());
    if e.is_timeout() {
        format!("Timed out waiting for {h}")
    } else if e.is_connect() {
        format!("Couldn't connect to {h}. Is the service running?")
    } else if e.is_builder() {
        format!("Invalid request: {}", e.without_url())
    } else {
        format!("Request to {h} failed: {}", e.without_url())
    }
}

/// Flow files can come from a cloned repo, so a body file is only read when it
/// is inside the workspace: never an absolute path, `..`, or a symlink out.
fn body_file(root: Option<&str>, rel: &str) -> Result<PathBuf, String> {
    let outside = || format!("Body file {rel} is outside the workspace. Move it into the workspace folder to send it.");
    let p = Path::new(rel);
    if rel.is_empty() || p.is_absolute() || p.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err(outside());
    }
    let root = std::fs::canonicalize(root.ok_or("Body files need an open workspace")?).map_err(|e| format!("Couldn't open the workspace folder: {e}"))?;
    let full = std::fs::canonicalize(root.join(p)).map_err(|e| format!("Couldn't read body file {rel}: {e}"))?;
    if full.starts_with(&root) {
        Ok(full)
    } else {
        Err(outside())
    }
}

async fn execute(state: &HttpState, req: HttpRequest, temp_dir: PathBuf) -> Result<HttpResponse, String> {
    let method = Method::from_str(&req.method.to_uppercase()).map_err(|_| format!("Unknown method {}", req.method))?;
    // Unparseable URLs fall through to reqwest's own error below.
    if let Ok(u) = reqwest::Url::parse(&req.url) {
        req.policy.check_url(&u).map_err(|b| b.to_string())?;
        if req.policy.restricts() {
            let p = req.policy.clone();
            tauri::async_runtime::spawn_blocking(move || p.check_name(&u)).await.map_err(|e| e.to_string())?.map_err(|b| b.to_string())?;
        }
    }
    // IP literals skip the resolver, so `check_url` covers them; hostnames are
    // checked on the addresses they resolve to, which are the only ones dialed.
    let policy = Arc::new(req.policy.clone());
    let redirect = if req.follow_redirects {
        let (p, limit) = (policy.clone(), Policy::limited(10));
        // Each hop is judged like the first request, by name too (see `check_name`).
        Policy::custom(move |a| match p.check_url(a.url()).and_then(|()| p.check_name(a.url())) {
            Ok(()) => limit.redirect(a),
            Err(b) => a.error(b),
        })
    } else {
        Policy::none()
    };
    let mut builder = Client::builder()
        .timeout(Duration::from_millis(req.timeout_ms.max(1)))
        .redirect(redirect)
        .dns_resolver(Arc::new(Resolver(policy)))
        .danger_accept_invalid_certs(req.insecure_tls);
    if let Some(j) = &req.cookie_jar {
        builder = builder.cookie_provider(state.jar(j));
    }
    let client = builder.build().map_err(|e| e.to_string())?;

    let mut rb = client.request(method, &req.url);
    for (k, v) in &req.headers {
        if !k.trim().is_empty() {
            rb = rb.header(k.trim(), v);
        }
    }
    rb = match req.body {
        HttpBody::None => rb,
        HttpBody::Text(t) => rb.body(t),
        HttpBody::Base64(b) => rb.body(base64::engine::general_purpose::STANDARD.decode(b).map_err(|e| format!("Body isn't valid base64: {e}"))?),
        HttpBody::File(p) => rb.body(std::fs::read(body_file(req.root.as_deref(), &p)?).map_err(|e| format!("Couldn't read body file {p}: {e}"))?),
    };

    let started = Instant::now();
    let resp = rb.send().await.map_err(|e| friendly(e, &req.url))?;
    let first_byte_ms = started.elapsed().as_millis() as u64;
    let status = resp.status();
    let headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
        .collect();
    let content_type = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).map(String::from);
    let bytes = resp.bytes().await.map_err(|e| friendly(e, &req.url))?;
    let total_ms = started.elapsed().as_millis() as u64;

    let size = bytes.len();
    let truncated = size > MAX_INLINE_BODY;
    let full_body_path = if truncated {
        let _ = std::fs::create_dir_all(&temp_dir);
        let p = temp_dir.join(format!("response-{}.bin", req.id));
        std::fs::write(&p, &bytes).ok().map(|_| p.to_string_lossy().into_owned())
    } else {
        None
    };
    let shown = &bytes[..size.min(MAX_INLINE_BODY)];
    let (body_text, body_base64) = match std::str::from_utf8(shown) {
        Ok(t) => (Some(t.to_string()), None),
        // A cut can land inside a multi-byte char; trim back to the last valid boundary.
        Err(e) if truncated && e.error_len().is_none() => (Some(String::from_utf8_lossy(&shown[..e.valid_up_to()]).into_owned()), None),
        Err(_) => (None, Some(base64::engine::general_purpose::STANDARD.encode(shown))),
    };

    Ok(HttpResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        content_type,
        body_text,
        body_base64,
        size,
        truncated,
        full_body_path,
        first_byte_ms,
        total_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    /// One-shot HTTP server: records the raw request, replies with `reply`.
    fn serve_once(reply: &'static str, delay_ms: u64) -> (String, std::thread::JoinHandle<String>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = format!("http://{}", l.local_addr().unwrap());
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut r = BufReader::new(s.try_clone().unwrap());
            let mut head = String::new();
            let mut len = 0usize;
            loop {
                let mut line = String::new();
                r.read_line(&mut line).unwrap();
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap();
                }
                head.push_str(&line);
                if line == "\r\n" || line.is_empty() {
                    break;
                }
            }
            let mut body = vec![0; len];
            r.read_exact(&mut body).unwrap();
            std::thread::sleep(Duration::from_millis(delay_ms));
            let _ = s.write_all(reply.as_bytes());
            head + &String::from_utf8_lossy(&body)
        });
        (addr, h)
    }

    fn req(url: String, method: &str, body: HttpBody) -> HttpRequest {
        HttpRequest {
            id: format!("t{}", std::process::id()),
            method: method.into(),
            url,
            headers: vec![("Origin".into(), "https://example.test".into()), ("content-type".into(), "application/json".into())],
            body,
            timeout_ms: 2000,
            follow_redirects: true,
            insecure_tls: false,
            cookie_jar: None,
            root: None,
            policy: NetPolicy::default(),
        }
    }

    fn rt() -> tokio_rt::Runtime {
        tokio_rt::Runtime::new()
    }

    // Minimal runtime shim: tauri's async runtime is tokio underneath.
    mod tokio_rt {
        pub struct Runtime;
        impl Runtime {
            pub fn new() -> Self {
                Runtime
            }
            pub fn block_on<F: std::future::Future>(&self, f: F) -> F::Output {
                tauri::async_runtime::block_on(f)
            }
        }
    }

    #[test]
    fn patch_with_custom_origin_and_json_body() {
        let (url, server) = serve_once("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 16\r\n\r\n{\"updated\":true}", 0);
        let state = Arc::new(HttpState::default());
        let body = HttpBody::Text(r#"{"path":"settings.retries","value":3}"#.into());
        let res = rt().block_on(state.send(req(format!("{url}/module/v2/b6ba"), "PATCH", body), std::env::temp_dir())).unwrap();
        let raw = server.join().unwrap();
        assert!(raw.starts_with("PATCH /module/v2/b6ba HTTP/1.1"), "{raw}");
        assert!(raw.to_ascii_lowercase().contains("origin: https://example.test"), "{raw}");
        assert!(raw.ends_with(r#"{"path":"settings.retries","value":3}"#), "{raw}");
        assert_eq!(res.status, 200);
        assert_eq!(res.body_text.as_deref(), Some("{\"updated\":true}"));
        assert_eq!(res.content_type.as_deref(), Some("application/json"));
    }

    #[test]
    fn connection_refused_is_explained() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let state = Arc::new(HttpState::default());
        let err = rt().block_on(state.send(req(format!("http://127.0.0.1:{port}/x"), "GET", HttpBody::None), std::env::temp_dir())).unwrap_err();
        assert!(err.contains("Couldn't connect to 127.0.0.1"), "{err}");
    }

    #[test]
    fn errors_never_echo_the_url() {
        // A server that closes the connection without a response.
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            drop(s);
        });
        let state = Arc::new(HttpState::default());
        let err = rt().block_on(state.send(req(format!("http://127.0.0.1:{port}/x?key=SECRET123"), "GET", HttpBody::None), std::env::temp_dir())).unwrap_err();
        assert!(!err.contains("SECRET123"), "{err}");
        assert!(err.contains(&format!("127.0.0.1:{port}")), "{err}");
    }

    #[test]
    fn cancel_aborts_inflight_request() {
        let (url, _server) = serve_once("HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n", 1500);
        let state = Arc::new(HttpState::default());
        let s2 = state.clone();
        let mut r = req(url, "GET", HttpBody::None);
        r.id = "cancel-me".into();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            assert!(s2.cancel("cancel-me"));
        });
        let started = Instant::now();
        let err = rt().block_on(state.send(r, std::env::temp_dir())).unwrap_err();
        assert_eq!(err, "Cancelled");
        assert!(started.elapsed() < Duration::from_millis(1200));
    }

    #[test]
    fn file_body_is_read_from_the_project() {
        let (url, server) = serve_once("HTTP/1.1 204 No Content\r\n\r\n", 0);
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("payloads")).unwrap();
        std::fs::write(dir.path().join("payloads/a.json"), r#"{"region":"eu-west"}"#).unwrap();
        let state = Arc::new(HttpState::default());
        let mut r = req(url, "POST", HttpBody::File("payloads/a.json".into()));
        r.root = Some(dir.path().to_string_lossy().into());
        let res = rt().block_on(state.send(r, std::env::temp_dir())).unwrap();
        assert_eq!(res.status, 204);
        assert!(server.join().unwrap().ends_with(r#"{"region":"eu-west"}"#));
    }

    fn no_private(env: &str) -> NetPolicy {
        NetPolicy { allow_private: false, allow_hosts: Vec::new(), env: env.into() }
    }

    #[test]
    fn private_targets_follow_the_policy() {
        let state = Arc::new(HttpState::default());
        for url in ["http://127.0.0.1:9/x?key=SECRET123", "http://localhost:9/", "http://10.0.0.5/"] {
            let mut r = req(url.into(), "GET", HttpBody::None);
            r.policy = no_private("staging");
            let err = rt().block_on(state.clone().send(r, std::env::temp_dir())).unwrap_err();
            assert!(err.starts_with("Blocked by the network rules of “staging”: ") && err.contains("is a private address"), "{err}");
            assert!(!err.contains("SECRET123"), "{err}");
        }
        let mut r = req("http://169.254.169.254/latest/meta-data/".into(), "GET", HttpBody::None);
        r.policy.env = "dev".into();
        let err = rt().block_on(state.send(r, std::env::temp_dir())).unwrap_err();
        assert_eq!(err, "Blocked by the network rules of “dev”: 169.254.169.254 is a cloud metadata address.");
    }

    #[test]
    fn non_http_scheme_is_refused() {
        let state = Arc::new(HttpState::default());
        let err = rt().block_on(state.send(req("file:///etc/passwd".into(), "GET", HttpBody::None), std::env::temp_dir())).unwrap_err();
        assert_eq!(err, "Blocked by the network rules: file URLs aren't allowed, only http and https.");
    }

    #[test]
    fn unlisted_host_is_refused_by_name_before_connecting() {
        // Holds even when a proxy (which would hide the destination from the resolver) is in use.
        let state = Arc::new(HttpState::default());
        let mut r = req("https://prod.unresolvable.invalid/orders".into(), "GET", HttpBody::None);
        r.policy = NetPolicy { allow_private: true, allow_hosts: vec!["*.staging.example.com".into()], env: "staging".into() };
        let err = rt().block_on(state.send(r, std::env::temp_dir())).unwrap_err();
        assert_eq!(err, "Blocked by the network rules of “staging”: prod.unresolvable.invalid isn't in this environment's allowed hosts.");
    }

    #[test]
    fn redirect_to_metadata_is_blocked() {
        let (url, server) = serve_once("HTTP/1.1 302 Found\r\nlocation: http://169.254.169.254/latest/meta-data/\r\ncontent-length: 0\r\n\r\n", 0);
        let state = Arc::new(HttpState::default());
        let err = rt().block_on(state.send(req(format!("{url}/login"), "GET", HttpBody::None), std::env::temp_dir())).unwrap_err();
        server.join().unwrap();
        assert_eq!(err, "Blocked by the network rules: 169.254.169.254 is a cloud metadata address.");
    }

    #[test]
    fn resolver_refusal_reads_cleanly() {
        // Bypasses the up-front check to exercise the resolver's error path through reqwest.
        let client = Client::builder().dns_resolver(Arc::new(Resolver(Arc::new(no_private(""))))).build().unwrap();
        let url = "http://localhost:9/x?key=SECRET123";
        let err = friendly(rt().block_on(client.get(url).send()).unwrap_err(), url);
        assert!(err.starts_with("Blocked by the network rules: localhost is a private address"), "{err}");
    }

    #[test]
    fn policy_defaults_when_absent() {
        let r: HttpRequest = serde_json::from_str(r#"{"id":"a","method":"GET","url":"http://x","body":{"kind":"none"},"cookieJar":null}"#).unwrap();
        assert!(r.policy.allow_private && r.policy.allow_hosts.is_empty());
    }

    #[test]
    fn file_body_outside_the_project_is_refused() {
        let outer = tempfile::tempdir().unwrap();
        let project = outer.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let secret = outer.path().join("id_rsa");
        std::fs::write(&secret, "KEY").unwrap();
        let root = Some(project.to_string_lossy().into_owned());
        let abs = secret.to_string_lossy().into_owned();
        for rel in [abs.as_str(), "../id_rsa", "./../id_rsa", ""] {
            let err = body_file(root.as_deref(), rel).unwrap_err();
            assert!(err.contains("outside the workspace"), "{rel}: {err}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&secret, project.join("link.json")).unwrap();
            assert!(body_file(root.as_deref(), "link.json").unwrap_err().contains("outside the workspace"));
        }
        assert!(body_file(None, "a.json").is_err());
    }
}
