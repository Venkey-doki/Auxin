//! OTLP/HTTP trace receiver. Services that already use an OpenTelemetry SDK export
//! spans here (Auxin launches them with `OTEL_EXPORTER_OTLP_ENDPOINT`), and flow runs
//! read them back by trace id. gRPC (4317) is not served.

use crate::topology::{redact, MASK};
use flate2::read::GzDecoder;
use http_body_util::{BodyExt as _, Full, LengthLimitError, Limited};
use hyper::body::{Body as _, Bytes, Incoming};
use hyper::{header, server::conn::http1, service::service_fn, Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value::Value, AnyValue};
use prost::Message as _;
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::convert::Infallible;
use std::io::Read as _;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::{TcpListener, TcpSocket};

/// Standard OTLP/HTTP port, then a fallback for when the user's own collector holds it.
pub const PORTS: [u16; 2] = [4318, 4319];
const MAX_BODY: usize = 8 * 1024 * 1024;
const MAX_SPANS: usize = 50_000;
const MAX_ATTRS: usize = 40;
const KINDS: [&str; 6] = ["unspecified", "internal", "server", "client", "producer", "consumer"];
const STATUSES: [&str; 3] = ["unset", "ok", "error"];
const SECRET_KEYS: [&str; 5] = ["authorization", "cookie", "password", "secret", "token"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub trace_id: String,
    pub span_id: String,
    pub parent_span_id: Option<String>,
    pub name: String,
    pub kind: &'static str,
    /// Resource `service.name`, else "unknown".
    pub service: String,
    /// Milliseconds since the epoch, with a sub-millisecond fraction.
    pub start_ms: f64,
    pub duration_ms: f64,
    pub status: &'static str,
    pub status_message: Option<String>,
    /// Span attributes (not resource ones), stringified and redacted.
    pub attributes: Vec<(String, String)>,
    pub links: Vec<Link>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub trace_id: String,
    pub span_id: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Status {
    pub port: Option<u16>,
    /// True when serving on the fallback port because the standard one was taken.
    pub fallback: bool,
    pub error: Option<String>,
    pub spans: usize,
}

#[derive(Default)]
pub struct OtelState(Mutex<Store>);

#[derive(Default)]
struct Store {
    status: Status,
    traces: HashMap<String, Vec<Span>>,
    /// Trace ids in order of first receipt, for eviction.
    order: VecDeque<String>,
}

impl OtelState {
    pub fn status(&self) -> Status {
        self.0.lock().unwrap().status.clone()
    }

    fn insert(&self, spans: Vec<Span>) {
        let mut g = self.0.lock().unwrap();
        let Store { status, traces, order } = &mut *g;
        for span in spans {
            traces.entry(span.trace_id.clone()).or_insert_with(|| {
                order.push_back(span.trace_id.clone());
                Vec::new()
            }).push(span);
            status.spans += 1;
        }
        while status.spans > MAX_SPANS && let Some(oldest) = order.pop_front() {
            status.spans -= traces.remove(&oldest).map_or(0, |t| t.len());
        }
    }

    /// Every span of `trace_ids`, plus the traces linked one level away in either
    /// direction (a message consumer links to its producer's span), sorted by start.
    pub fn spans_for(&self, trace_ids: &[String]) -> Vec<Span> {
        let g = self.0.lock().unwrap();
        let wanted: HashSet<String> = trace_ids.iter().map(|t| t.to_lowercase()).collect();
        let mut ids = wanted.clone();
        for (id, spans) in &g.traces {
            for link in spans.iter().flat_map(|s| &s.links) {
                if wanted.contains(id) {
                    ids.insert(link.trace_id.clone());
                }
                if wanted.contains(&link.trace_id) {
                    ids.insert(id.clone());
                }
            }
        }
        let mut out: Vec<Span> = ids.iter().filter_map(|id| g.traces.get(id)).flatten().cloned().collect();
        out.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
        out
    }
}

/// Serves on the first free port of `PORTS` until the app exits; failure only shows in `otel_status`.
pub async fn run(state: Arc<OtelState>) {
    if let Some(listener) = bind(&state, &PORTS) {
        serve(listener, state).await;
    }
}

/// Binds loopback on the first free port and records the outcome. Must run inside the tokio runtime.
fn bind(state: &OtelState, ports: &[u16]) -> Option<TcpListener> {
    let mut errors = Vec::new();
    for (i, &port) in ports.iter().enumerate() {
        // No SO_REUSEADDR: on macOS it would let us shadow a collector listening on 0.0.0.0 at this port.
        let bound = TcpSocket::new_v4().and_then(|s| {
            s.bind((Ipv4Addr::LOCALHOST, port).into())?;
            s.listen(128)
        });
        match bound {
            Ok(listener) => {
                let status = &mut state.0.lock().unwrap().status;
                status.port = listener.local_addr().ok().map(|a| a.port());
                status.fallback = i > 0;
                return Some(listener);
            }
            Err(e) => errors.push(format!("127.0.0.1:{port}: {e}")),
        }
    }
    state.0.lock().unwrap().status.error = Some(format!("OTLP receiver is off: {}", errors.join("; ")));
    None
}

async fn serve(listener: TcpListener, state: Arc<OtelState>) {
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            // Out of file descriptors and the like; don't spin.
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        let state = state.clone();
        tauri::async_runtime::spawn(async move {
            let svc = service_fn(move |req| handle(state.clone(), req));
            let _ = http1::Builder::new().serve_connection(TokioIo::new(stream), svc).await;
        });
    }
}

async fn handle(state: Arc<OtelState>, req: Request<Incoming>) -> Result<Response<Full<Bytes>>, Infallible> {
    let ctype = req.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    let json = ctype.starts_with("application/json");
    // Exporters send OTLP content types and no Origin. A web page can POST to localhost only as a
    // "simple" request (text/plain, forms) and always sends an Origin, so both are refused.
    let from_browser = req.headers().contains_key(header::ORIGIN);
    let otlp = json || ctype.starts_with("application/x-protobuf");
    let code = match (req.method(), req.uri().path()) {
        (&Method::POST, _) if from_browser => StatusCode::FORBIDDEN,
        (&Method::POST, "/v1/traces" | "/v1/metrics" | "/v1/logs") if !otlp => StatusCode::UNSUPPORTED_MEDIA_TYPE,
        (&Method::POST, "/v1/traces") => match receive(req, json).await {
            Ok(spans) => {
                state.insert(spans);
                StatusCode::OK
            }
            Err(code) => code,
        },
        // Accepted and dropped so exporters configured for all signals don't log errors.
        (&Method::POST, "/v1/metrics" | "/v1/logs") => StatusCode::OK,
        _ => StatusCode::NOT_FOUND,
    };
    // An empty Export*ServiceResponse: no bytes in protobuf, `{}` in JSON.
    let body = if code == StatusCode::OK && json { Bytes::from_static(b"{}") } else { Bytes::new() };
    let ctype = if json { "application/json" } else { "application/x-protobuf" };
    Ok(Response::builder().status(code).header(header::CONTENT_TYPE, ctype).body(Full::new(body)).unwrap())
}

async fn receive(req: Request<Incoming>, json: bool) -> Result<Vec<Span>, StatusCode> {
    if req.body().size_hint().lower() > MAX_BODY as u64 {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let gzip = req.headers().get(header::CONTENT_ENCODING).is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"gzip"));
    let body = match Limited::new(req.into_body(), MAX_BODY).collect().await {
        Ok(b) => b.to_bytes().to_vec(),
        Err(e) if e.is::<LengthLimitError>() => return Err(StatusCode::PAYLOAD_TOO_LARGE),
        Err(_) => return Err(StatusCode::BAD_REQUEST),
    };
    let body = if gzip { gunzip(&body)? } else { body };
    let req = if json { serde_json::from_slice(&body).ok() } else { ExportTraceServiceRequest::decode(&body[..]).ok() };
    req.map(flatten).ok_or(StatusCode::BAD_REQUEST)
}

fn gunzip(body: &[u8]) -> Result<Vec<u8>, StatusCode> {
    let mut out = Vec::new();
    GzDecoder::new(body).take(MAX_BODY as u64 + 1).read_to_end(&mut out).map_err(|_| StatusCode::BAD_REQUEST)?;
    if out.len() > MAX_BODY { Err(StatusCode::PAYLOAD_TOO_LARGE) } else { Ok(out) }
}

fn flatten(req: ExportTraceServiceRequest) -> Vec<Span> {
    let mut out = Vec::new();
    for rs in req.resource_spans {
        let service = rs.resource.iter().flat_map(|r| &r.attributes).find(|kv| kv.key == "service.name").map(|kv| text(kv.value.as_ref()));
        let service = service.filter(|s| !s.is_empty()).unwrap_or_else(|| "unknown".into());
        for s in rs.scope_spans.into_iter().flat_map(|ss| ss.spans) {
            let status = s.status.unwrap_or_default();
            out.push(Span {
                trace_id: hex(&s.trace_id),
                span_id: hex(&s.span_id),
                parent_span_id: Some(hex(&s.parent_span_id)).filter(|p| !p.is_empty()),
                name: s.name,
                kind: KINDS.get(s.kind as usize).unwrap_or(&KINDS[0]),
                service: service.clone(),
                start_ms: (s.start_time_unix_nano / 1_000_000) as f64 + (s.start_time_unix_nano % 1_000_000) as f64 / 1e6,
                duration_ms: s.end_time_unix_nano.saturating_sub(s.start_time_unix_nano) as f64 / 1e6,
                status: STATUSES.get(status.code as usize).unwrap_or(&STATUSES[0]),
                status_message: Some(redact(&status.message)).filter(|m| !m.is_empty()),
                attributes: s.attributes.iter().take(MAX_ATTRS).map(|kv| (kv.key.clone(), redact_attr(&kv.key, &text(kv.value.as_ref())))).collect(),
                links: s.links.iter().map(|l| Link { trace_id: hex(&l.trace_id), span_id: hex(&l.span_id) }).collect(),
            });
        }
    }
    out
}

fn redact_attr(key: &str, value: &str) -> String {
    let key = key.to_ascii_lowercase();
    if SECRET_KEYS.iter().any(|w| key.contains(w)) { MASK.into() } else { redact(value) }
}

fn text(v: Option<&AnyValue>) -> String {
    match v.and_then(|v| v.value.as_ref()) {
        Some(Value::StringValue(s)) => s.clone(),
        Some(Value::BoolValue(b)) => b.to_string(),
        Some(Value::IntValue(i)) => i.to_string(),
        Some(Value::DoubleValue(d)) => d.to_string(),
        Some(Value::BytesValue(b)) => hex(b),
        Some(Value::ArrayValue(a)) => format!("[{}]", a.values.iter().map(|v| text(Some(v))).collect::<Vec<_>>().join(", ")),
        Some(Value::KvlistValue(l)) => format!("{{{}}}", l.values.iter().map(|kv| format!("{}: {}", kv.key, text(kv.value.as_ref()))).collect::<Vec<_>>().join(", ")),
        _ => String::new(),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use opentelemetry_proto::tonic::common::v1::KeyValue;
    use opentelemetry_proto::tonic::resource::v1::Resource;
    use opentelemetry_proto::tonic::trace::v1::{span, ResourceSpans, ScopeSpans, Span as PSpan, Status as PStatus};
    use std::io::{Read, Write};

    const T1: &str = "5b8efff798038103d269b633813fc60c";
    const T2: &str = "0af7651916cd43dd8448eb211c80319c";
    const T3: &str = "4bf92f3577b34da6a3ce929d0e0e4736";
    const NS: u64 = 1_700_000_000_000_000_000;

    fn start(ports: &[u16]) -> (Arc<OtelState>, Option<u16>) {
        let state = Arc::new(OtelState::default());
        let listener = tauri::async_runtime::block_on(async { bind(&state, ports) });
        if let Some(l) = listener {
            tauri::async_runtime::spawn(serve(l, state.clone()));
        }
        let port = state.status().port;
        (state, port)
    }

    fn post(port: u16, path: &str, headers: &[(&str, &str)], body: Vec<u8>) -> (u16, Vec<u8>) {
        tauri::async_runtime::block_on(async {
            let mut req = reqwest::Client::new().post(format!("http://127.0.0.1:{port}{path}")).body(body);
            for (k, v) in headers {
                req = req.header(*k, *v);
            }
            let res = req.send().await.unwrap();
            (res.status().as_u16(), res.bytes().await.unwrap().to_vec())
        })
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    fn kv(key: &str, v: &str) -> KeyValue {
        KeyValue { key: key.into(), value: Some(AnyValue { value: Some(Value::StringValue(v.into())) }), ..Default::default() }
    }

    #[allow(clippy::too_many_arguments)]
    fn pspan(trace: &str, id: &str, parent: &str, name: &str, kind: span::SpanKind, start_us: u64, dur_us: u64, attributes: Vec<KeyValue>) -> PSpan {
        PSpan {
            trace_id: unhex(trace),
            span_id: unhex(id),
            parent_span_id: unhex(parent),
            name: name.into(),
            kind: kind as i32,
            start_time_unix_nano: NS + start_us * 1000,
            end_time_unix_nano: NS + (start_us + dur_us) * 1000,
            attributes,
            ..Default::default()
        }
    }

    fn resource(service: Option<&str>, spans: Vec<PSpan>) -> ResourceSpans {
        let mut attributes = vec![kv("telemetry.sdk.language", "nodejs")];
        attributes.extend(service.map(|s| kv("service.name", s)));
        ResourceSpans { resource: Some(Resource { attributes, ..Default::default() }), scope_spans: vec![ScopeSpans { spans, ..Default::default() }], ..Default::default() }
    }

    /// web: server -> client + producer (T1); worker: consumer linked to the producer (T2); an unrelated trace (T3).
    fn sample() -> ExportTraceServiceRequest {
        use span::SpanKind::*;
        let server = pspan(T1, "1111111111111111", "", "POST /orders", Server, 0, 20_000, vec![kv("http.request.method", "POST")]);
        let client = pspan(T1, "2222222222222222", "1111111111111111", "SELECT orders", Client, 1_500, 5_250, vec![
            kv("db.connection_string", "postgres://app:devpass@db:5432/app"),
            kv("http.request.header.Authorization", "Bearer abc"),
            kv("db.user", "app"),
        ]);
        let producer = pspan(T1, "3333333333333333", "1111111111111111", "orders publish", Producer, 8_000, 1_000, vec![]);
        let mut consumer = pspan(T2, "4444444444444444", "", "orders process", Consumer, 9_500, 3_000, vec![]);
        consumer.links = vec![span::Link { trace_id: unhex(T1), span_id: unhex("3333333333333333"), ..Default::default() }];
        consumer.status = Some(PStatus { code: 2, message: "stock check failed".into() });
        let child = pspan(T2, "5555555555555555", "4444444444444444", "reserve", Internal, 10_000, 500, vec![]);
        let other = pspan(T3, "6666666666666666", "", "cron", Internal, 0, 1, vec![]);
        ExportTraceServiceRequest { resource_spans: vec![resource(Some("web"), vec![server, client, producer]), resource(Some("worker"), vec![consumer, child]), resource(None, vec![other])] }
    }

    fn names(spans: &[Span]) -> Vec<&str> {
        spans.iter().map(|s| s.name.as_str()).collect()
    }

    #[test]
    fn protobuf_spans_are_flattened_redacted_and_linked() {
        let (state, port) = start(&[0]);
        let (code, body) = post(port.unwrap(), "/v1/traces", &[("content-type", "application/x-protobuf")], sample().encode_to_vec());
        assert_eq!((code, body.len()), (200, 0));
        assert_eq!(state.status().spans, 6);

        let spans = state.spans_for(&[T1.to_uppercase()]);
        assert_eq!(names(&spans), ["POST /orders", "SELECT orders", "orders publish", "orders process", "reserve"]);
        let client = &spans[1];
        assert_eq!((client.trace_id.as_str(), client.span_id.as_str(), client.parent_span_id.as_deref()), (T1, "2222222222222222", Some("1111111111111111")));
        assert_eq!((client.kind, client.service.as_str(), client.status, client.status_message.as_deref()), ("client", "web", "unset", None));
        assert_eq!((client.start_ms, client.duration_ms), (1_700_000_000_001.5, 5.25));
        assert_eq!(client.attributes, [
            ("db.connection_string".to_string(), "postgres://••••@db:5432/app".to_string()),
            ("http.request.header.Authorization".to_string(), MASK.to_string()),
            ("db.user".to_string(), "app".to_string()),
        ]);
        assert_eq!((spans[0].kind, spans[0].parent_span_id.as_deref(), spans[2].kind), ("server", None, "producer"));
        let consumer = &spans[3];
        assert_eq!((consumer.kind, consumer.service.as_str(), consumer.status, consumer.status_message.as_deref()), ("consumer", "worker", "error", Some("stock check failed")));
        assert_eq!((consumer.links[0].trace_id.as_str(), consumer.links[0].span_id.as_str()), (T1, "3333333333333333"));

        // The other direction: the consumer's trace pulls in the producer's.
        assert_eq!(names(&state.spans_for(&[T2.into()])), names(&spans));
        let other = state.spans_for(&[T3.into()]);
        assert_eq!((names(&other), other[0].service.as_str()), (vec!["cron"], "unknown"));
        assert!(state.spans_for(&["ffffffffffffffffffffffffffffffff".into()]).is_empty());

        let json = serde_json::to_value(&spans[3]).unwrap();
        assert_eq!(json["startMs"], 1_700_000_000_009.5);
        assert_eq!(json["links"][0]["spanId"], "3333333333333333");
        assert_eq!(serde_json::to_value(state.status()).unwrap(), serde_json::json!({ "port": port, "fallback": false, "error": null, "spans": 6 }));
    }

    #[test]
    fn otlp_json_and_gzip() {
        // Shaped like @opentelemetry/exporter-trace-otlp-http output: hex ids, string nanos, int enums.
        let body = r#"{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"web"}},{"key":"host.name","value":{"stringValue":"mbp"}}],"droppedAttributesCount":0},
            "scopeSpans":[{"scope":{"name":"@opentelemetry/instrumentation-http","version":"0.57.0"},"spans":[
              {"traceId":"5B8EFFF798038103D269B633813FC60C","spanId":"eee19b7ec3c1b174","parentSpanId":"","traceState":"","name":"GET /api/users","kind":2,
               "startTimeUnixNano":"1729958400123456789","endTimeUnixNano":"1729958400173456789",
               "attributes":[{"key":"http.response.status_code","value":{"intValue":200}},{"key":"http.request.body.size","value":{"intValue":"512"}},
                 {"key":"url.full","value":{"stringValue":"http://localhost:3000/api/users?token=abc&page=2"}},{"key":"http.request.header.cookie","value":{"arrayValue":{"values":[{"stringValue":"sid=1"}]}}},
                 {"key":"retry","value":{"boolValue":false}},{"key":"ratio","value":{"doubleValue":0.5}}],
               "droppedAttributesCount":0,"events":[{"timeUnixNano":"1729958400133456789","name":"handled","attributes":[],"droppedAttributesCount":0}],"droppedEventsCount":0,
               "status":{"code":1},"links":[],"droppedLinksCount":0,"flags":257},
              {"traceId":"5b8efff798038103d269b633813fc60c","spanId":"aaaaaaaaaaaaaaaa","parentSpanId":"eee19b7ec3c1b174","name":"db","kind":3,"startTimeUnixNano":1729958400130000000,"endTimeUnixNano":1729958400140000000,"status":{}}
            ]}]}]}"#;
        let (state, port) = start(&[0]);
        let port = port.unwrap();
        assert_eq!(post(port, "/v1/traces", &[("content-type", "application/json")], body.into()), (200, b"{}".to_vec()));
        let spans = state.spans_for(&[T1.into()]);
        assert_eq!(names(&spans), ["GET /api/users", "db"]);
        let s = &spans[0];
        assert_eq!((s.trace_id.as_str(), s.span_id.as_str(), s.parent_span_id.as_deref(), s.kind, s.status, s.service.as_str()), (T1, "eee19b7ec3c1b174", None, "server", "ok", "web"));
        assert_eq!((s.start_ms, s.duration_ms), (1_729_958_400_123.456_8, 50.0));
        let attrs: Vec<(&str, &str)> = s.attributes.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        assert_eq!(attrs, [
            ("http.response.status_code", "200"),
            ("http.request.body.size", "512"),
            ("url.full", "http://localhost:3000/api/users?token=••••••&page=2"),
            ("http.request.header.cookie", MASK),
            ("retry", "false"),
            ("ratio", "0.5"),
        ]);
        assert_eq!((spans[1].kind, spans[1].parent_span_id.as_deref(), spans[1].status, spans[1].duration_ms), ("client", Some("eee19b7ec3c1b174"), "unset", 10.0));

        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        gz.write_all(&sample().encode_to_vec()).unwrap();
        let headers = [("content-type", "application/x-protobuf"), ("content-encoding", "gzip")];
        assert_eq!(post(port, "/v1/traces", &headers, gz.finish().unwrap()).0, 200);
        assert_eq!(state.status().spans, 8);
        assert_eq!(post(port, "/v1/traces", &headers, b"not gzip".to_vec()).0, 400);
    }

    #[test]
    fn rejects_bad_requests_and_drops_other_signals() {
        let (state, port) = start(&[0]);
        let port = port.unwrap();
        assert_eq!(post(port, "/v1/traces", &[("content-type", "application/x-protobuf")], vec![0xff, 0xff, 0xff]).0, 400);
        assert_eq!(post(port, "/v1/traces", &[("content-type", "application/json")], b"{\"resourceSpans\":5}".to_vec()).0, 400);
        assert_eq!(post(port, "/v1/metrics", &[("content-type", "application/x-protobuf")], vec![1, 2, 3]), (200, vec![]));
        assert_eq!(post(port, "/v1/logs", &[("content-type", "application/json")], b"{}".to_vec()), (200, b"{}".to_vec()));
        assert_eq!(post(port, "/v1/spans", &[], vec![]).0, 404);
        // What a web page could send to localhost: a "simple" text/plain POST, or anything with an Origin.
        assert_eq!(post(port, "/v1/traces", &[("content-type", "text/plain")], vec![]).0, 415);
        assert_eq!(post(port, "/v1/traces", &[("content-type", "application/x-protobuf"), ("origin", "https://evil.example")], vec![]).0, 403);
        assert_eq!(state.status().spans, 0);

        // Declared length over the limit is refused before the body is read.
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "POST /v1/traces HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-protobuf\r\nContent-Length: {}\r\n\r\n", MAX_BODY + 1).unwrap();
        let mut head = [0; 12];
        s.read_exact(&mut head).unwrap();
        assert_eq!(&head, b"HTTP/1.1 413");
    }

    #[test]
    fn falls_back_when_the_port_is_taken() {
        let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let busy = taken.local_addr().unwrap().port();
        let (state, port) = start(&[busy, 0]);
        let status = state.status();
        assert!(port.is_some_and(|p| p != busy) && status.fallback && status.error.is_none(), "{status:?}");

        let (state, port) = start(&[busy]);
        let error = state.status().error.unwrap_or_default();
        assert!(port.is_none() && error.contains(&format!("127.0.0.1:{busy}")), "{error}");
    }

    #[test]
    fn store_evicts_oldest_traces() {
        let state = OtelState::default();
        let span = |trace: usize| Span {
            trace_id: format!("{trace:032x}"),
            span_id: "0000000000000001".into(),
            parent_span_id: None,
            name: String::new(),
            kind: "internal",
            service: "s".into(),
            start_ms: 0.0,
            duration_ms: 0.0,
            status: "unset",
            status_message: None,
            attributes: vec![],
            links: vec![],
        };
        // 5,001 traces of 10 spans: the first one received has to go.
        for t in 0..=MAX_SPANS / 10 {
            state.insert((0..10).map(|_| span(t)).collect());
        }
        assert_eq!(state.status().spans, MAX_SPANS);
        assert!(state.spans_for(&[format!("{:032x}", 0)]).is_empty());
        assert_eq!(state.spans_for(&[format!("{:032x}", 1)]).len(), 10);
    }

    /// Two services instrumented by the real OpenTelemetry Node SDK (fixtures/otel, `npm ci` there first)
    /// export to a real receiver: the request's trace has both services' spans, parent and child, and the
    /// worker's consumer trace comes along through its link to the api's producer span.
    #[test]
    #[ignore]
    fn real_node_sdk_spans() {
        use std::io::BufRead;
        use std::process::{Command, Stdio};
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/otel");
        let (state, port) = start(&[0]);
        let port = port.unwrap();
        let free = || std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let (api_port, worker_port) = (free(), free());
        let spawn = |script: &str, name: &str, own: u16| {
            let mut child = Command::new("node")
                .args(["--require", "@opentelemetry/auto-instrumentations-node/register", script])
                .current_dir(&dir)
                .env("PORT", own.to_string())
                .env("WORKER_PORT", worker_port.to_string())
                .env("OTEL_EXPORTER_OTLP_ENDPOINT", format!("http://127.0.0.1:{port}"))
                .env("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf")
                .env("OTEL_SERVICE_NAME", name)
                .env("OTEL_BSP_SCHEDULE_DELAY", "100")
                .env("OTEL_METRICS_EXPORTER", "none")
                .env("OTEL_LOGS_EXPORTER", "none")
                .stdout(Stdio::piped())
                .spawn()
                .expect("node must be installed");
            let mut line = String::new();
            std::io::BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
            assert!(line.contains("ready"), "{name}: {line}");
            child
        };
        let mut worker = spawn("worker.js", "worker", worker_port);
        let mut api = spawn("api.js", "api", api_port);

        let trace = "4bf92f3577b34da6a3ce929d0e0e4736";
        tauri::async_runtime::block_on(async {
            reqwest::Client::new().get(format!("http://127.0.0.1:{api_port}/orders")).header("traceparent", format!("00-{trace}-00f067aa0ba902b7-01")).send().await.unwrap();
        });
        let mut spans = Vec::new();
        for _ in 0..50 {
            spans = state.spans_for(&[trace.to_string()]);
            if spans.iter().any(|s| s.name == "orders process") && spans.iter().filter(|s| s.trace_id == trace).count() >= 4 {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        for child in [&mut api, &mut worker] {
            let _ = child.kill();
            let _ = child.wait();
        }

        let api_server = spans.iter().find(|s| s.trace_id == trace && s.service == "api" && s.kind == "server").expect("api's server span");
        assert_eq!(api_server.parent_span_id.as_deref(), Some("00f067aa0ba902b7"), "continues the trace Auxin started");
        let work = spans.iter().find(|s| s.service == "worker" && s.kind == "server" && s.trace_id == trace).expect("worker's server span in the same trace");
        let parent = spans.iter().find(|s| Some(&s.span_id) == work.parent_span_id.as_ref()).expect("its parent arrived too");
        assert_eq!(parent.service, "api", "the worker's span is a child of an api span");
        let publish = spans.iter().find(|s| s.name == "orders publish").expect("producer span");
        let consume = spans.iter().find(|s| s.name == "orders process").expect("consumer span, found through its link");
        assert_ne!(consume.trace_id, trace);
        assert_eq!(consume.links[0].span_id, publish.span_id);
        assert!(api_server.duration_ms > 0.0 && api_server.start_ms > 1.7e12);
    }
}
