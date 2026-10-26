//! HTTP client for flows. Requests go out from Rust rather than the webview, so
//! there is no CORS, headers like Origin/Cookie can be set, and timing is real.

use base64::Engine as _;
use reqwest::{cookie::Jar, redirect::Policy, Client, Method};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
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
    /// Absolute path; read here so large payload files never cross the IPC bridge.
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

async fn execute(state: &HttpState, req: HttpRequest, temp_dir: PathBuf) -> Result<HttpResponse, String> {
    let method = Method::from_str(&req.method.to_uppercase()).map_err(|_| format!("Unknown method {}", req.method))?;
    let mut builder = Client::builder()
        .timeout(Duration::from_millis(req.timeout_ms.max(1)))
        .redirect(if req.follow_redirects { Policy::limited(10) } else { Policy::none() })
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
        HttpBody::File(p) => rb.body(std::fs::read(&p).map_err(|e| format!("Couldn't read body file {p}: {e}"))?),
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
    fn file_body_is_read_from_disk() {
        let (url, server) = serve_once("HTTP/1.1 204 No Content\r\n\r\n", 0);
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("payload.json");
        std::fs::write(&f, r#"{"region":"eu-west"}"#).unwrap();
        let state = Arc::new(HttpState::default());
        let res = rt().block_on(state.send(req(url, "POST", HttpBody::File(f.to_string_lossy().into())), std::env::temp_dir())).unwrap();
        assert_eq!(res.status, 204);
        assert!(server.join().unwrap().ends_with(r#"{"region":"eu-west"}"#));
    }
}
