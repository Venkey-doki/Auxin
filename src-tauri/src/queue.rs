//! Message-broker steps: publish one message to RabbitMQ or Kafka, or listen for
//! messages without taking them from the user's own consumers. A listen is a
//! subscription keyed by step id, so it can start before the request that causes
//! the message and be read (drained) by later calls with the same id.

use crate::netpolicy::NetPolicy;
use base64::Engine as _;
use lapin::message::{Delivery, DeliveryResult};
use lapin::options::{BasicConsumeOptions, BasicPublishOptions, ConfirmSelectOptions, ExchangeDeclareOptions, QueueBindOptions, QueueDeclareOptions};
use lapin::tcp::TLSConfig;
use lapin::types::{AMQPValue, FieldTable};
use lapin::uri::{AMQPScheme, AMQPUri};
use lapin::{AsyncTcpStream, BasicProperties, Channel, Confirmation, Connection, ConnectionProperties, ErrorKind, ExchangeKind};
use rskafka::client::partition::{Compression, OffsetAt, UnknownTopicHandling};
use rskafka::client::{error::Error as KafkaError, Client, ClientBuilder};
use rskafka::record::{Record, RecordAndOffset};
use rskafka::BackoffConfig;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Notify;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Per subscription; past it the oldest message is dropped and counted as skipped.
const BUFFER_CAP: usize = 1000;
/// Subscriptions nobody has read for this long are closed on the next access.
const IDLE: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Broker {
    /// `amqp(s)://user:pass@host:port/vhost`
    Rabbitmq { url: String },
    /// `host:9092,host2:9092`, optionally prefixed `kafka://`
    Kafka { url: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishRequest {
    pub id: String,
    pub broker: Broker,
    /// RabbitMQ exchange ("" is the default exchange) or Kafka topic.
    pub destination: String,
    pub routing_key: Option<String>,
    /// Kafka message key; picks the partition as Kafka's default partitioner does.
    pub key: Option<String>,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    pub body: String,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub policy: NetPolicy,
}

fn default_timeout() -> u64 {
    10_000
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumeRequest {
    pub id: String,
    pub broker: Broker,
    /// RabbitMQ exchange or Kafka topic.
    pub source: String,
    /// RabbitMQ binding pattern, `#` when absent.
    pub binding: Option<String>,
    /// When non-empty, only messages carrying one of these ids are kept.
    #[serde(default)]
    pub trace_ids: Vec<String>,
    pub wait_ms: u64,
    #[serde(default)]
    pub policy: NetPolicy,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    pub ms: u64,
    pub destination: String,
    pub partition: Option<i32>,
    pub offset: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumeResult {
    pub messages: Vec<Message>,
    /// Messages dropped since the last read: trace-id mismatches and buffer overflow.
    pub skipped: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub source: String,
    pub routing_key: Option<String>,
    pub key: Option<String>,
    pub partition: Option<i32>,
    pub offset: Option<i64>,
    pub headers: Vec<(String, String)>,
    /// UTF-8 body when it decodes cleanly, otherwise `body_base64` is set.
    pub body_text: Option<String>,
    pub body_base64: Option<String>,
    pub size: usize,
    pub received_at: u64,
}

fn message(source: String, headers: Vec<(String, String)>, data: &[u8]) -> Message {
    let (body_text, body_base64) = match std::str::from_utf8(data) {
        Ok(t) => (Some(t.to_string()), None),
        Err(_) => (None, Some(base64::engine::general_purpose::STANDARD.encode(data))),
    };
    let received_at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    Message { source, routing_key: None, key: None, partition: None, offset: None, headers, body_text, body_base64, size: data.len(), received_at }
}

/// `traceparent` carries the 32-hex trace id; `x-request-id` must equal the id.
fn has_trace(headers: &[(String, String)], ids: &[String]) -> bool {
    headers.iter().any(|(k, v)| {
        if k.eq_ignore_ascii_case("traceparent") {
            let v = v.to_ascii_lowercase();
            ids.iter().any(|id| v.contains(&id.to_ascii_lowercase()))
        } else {
            k.eq_ignore_ascii_case("x-request-id") && ids.iter().any(|id| v.trim() == id)
        }
    })
}

/// Messages received for one subscription, waiting to be read.
struct Buffer {
    trace_ids: Vec<String>,
    state: Mutex<Pending>,
    notify: Notify,
}

#[derive(Default)]
struct Pending {
    messages: VecDeque<Message>,
    skipped: u32,
    /// The broker connection failed; reported once the messages before it are read.
    error: Option<String>,
}

impl Buffer {
    fn new(trace_ids: Vec<String>) -> Self {
        let trace_ids = trace_ids.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        Buffer { trace_ids, state: Mutex::default(), notify: Notify::new() }
    }

    fn push(&self, m: Message) {
        let mut p = self.state.lock().unwrap();
        if !self.trace_ids.is_empty() && !has_trace(&m.headers, &self.trace_ids) {
            p.skipped = p.skipped.saturating_add(1);
            return;
        }
        if p.messages.len() >= BUFFER_CAP {
            p.messages.pop_front();
            p.skipped = p.skipped.saturating_add(1);
        }
        p.messages.push_back(m);
        drop(p);
        self.notify.notify_one();
    }

    fn fail(&self, e: String) {
        self.state.lock().unwrap().error.get_or_insert(e);
        self.notify.notify_one();
    }

    /// Drains what's buffered: `None` while there's nothing to report and `force` is off.
    fn take(&self, force: bool) -> Option<Result<(Vec<Message>, u32), String>> {
        let mut p = self.state.lock().unwrap();
        if p.messages.is_empty() {
            if let Some(e) = p.error.take() {
                return Some(Err(e));
            }
            if !force {
                return None;
            }
        }
        Some(Ok((p.messages.drain(..).collect(), std::mem::take(&mut p.skipped))))
    }

    /// Returns as soon as there's a message (or an error), else empty at the deadline.
    async fn wait(&self, wait: Duration) -> Result<(Vec<Message>, u32), String> {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            if let Some(out) = self.take(false) {
                return out;
            }
            if tokio::time::timeout_at(deadline, self.notify.notified()).await.is_err() {
                return self.take(true).unwrap_or(Ok((Vec::new(), 0)));
            }
        }
    }
}

/// Runs once when its subscription is dropped: closes the connection or stops the fetch tasks.
struct Closer(Option<Box<dyn FnOnce() + Send>>);

impl Drop for Closer {
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            f();
        }
    }
}

struct Sub {
    buf: Arc<Buffer>,
    last_read: Instant,
    _closer: Closer,
}

#[derive(Default)]
pub struct QueueState {
    subs: Mutex<HashMap<String, Sub>>,
    inflight: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
}

impl QueueState {
    /// Runs `f` so `cancel(id)` can abort it mid-flight (as `HttpState::send`).
    async fn tracked<T: Send + 'static>(&self, id: &str, f: impl Future<Output = Result<T, String>> + Send + 'static) -> Result<T, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let handle = tauri::async_runtime::spawn(async move {
            let _ = tx.send(f.await);
        });
        self.inflight.lock().unwrap().insert(id.to_string(), handle);
        let out = rx.await.unwrap_or_else(|_| Err("Cancelled".into()));
        self.inflight.lock().unwrap().remove(id);
        out
    }

    pub async fn publish(self: Arc<Self>, req: PublishRequest) -> Result<PublishResult, String> {
        let id = req.id.clone();
        self.tracked(&id, async move {
            let started = Instant::now();
            let (name, sent) = match &req.broker {
                Broker::Rabbitmq { url } => ("RabbitMQ", tokio::time::timeout(Duration::from_millis(req.timeout_ms.max(1)), rabbit_publish(&req, url)).await),
                Broker::Kafka { url } => ("Kafka", tokio::time::timeout(Duration::from_millis(req.timeout_ms.max(1)), kafka_publish(&req, url)).await),
            };
            let (partition, offset) = sent.map_err(|_| format!("Timed out publishing to {name}"))??;
            Ok(PublishResult { ms: started.elapsed().as_millis() as u64, destination: req.destination, partition, offset })
        })
        .await
    }

    /// Opens the subscription on first use of an id, then waits for messages.
    pub async fn consume(self: Arc<Self>, req: ConsumeRequest) -> Result<ConsumeResult, String> {
        let (id, me) = (req.id.clone(), self.clone());
        self.tracked(&id, async move { me.read(req).await }).await
    }

    async fn read(&self, req: ConsumeRequest) -> Result<ConsumeResult, String> {
        let buf = match self.touch(&req.id) {
            Some(buf) => buf,
            None => {
                let buf = Arc::new(Buffer::new(req.trace_ids.clone()));
                let closer = match &req.broker {
                    Broker::Rabbitmq { url } => rabbit_subscribe(&req, url, buf.clone()).await?,
                    Broker::Kafka { url } => kafka_subscribe(&req, url, buf.clone()).await?,
                };
                self.subs.lock().unwrap().insert(req.id.clone(), Sub { buf: buf.clone(), last_read: Instant::now(), _closer: closer });
                buf
            }
        };
        let out = buf.wait(Duration::from_millis(req.wait_ms)).await;
        if out.is_err() {
            self.subs.lock().unwrap().remove(&req.id);
        } else {
            self.touch(&req.id);
        }
        out.map(|(messages, skipped)| ConsumeResult { messages, skipped })
    }

    /// The live subscription for `id`, marked read now. Closes idle ones first.
    fn touch(&self, id: &str) -> Option<Arc<Buffer>> {
        let now = Instant::now();
        let mut subs = self.subs.lock().unwrap();
        subs.retain(|_, s| now.duration_since(s.last_read) < IDLE);
        subs.get_mut(id).map(|s| {
            s.last_read = now;
            s.buf.clone()
        })
    }

    /// Aborts an in-flight publish or wait and closes the subscription with this id.
    pub fn cancel(&self, id: &str) -> bool {
        let task = self.inflight.lock().unwrap().remove(id);
        if let Some(t) = &task {
            t.abort();
        }
        let sub = self.subs.lock().unwrap().remove(id);
        task.is_some() || sub.is_some()
    }
}

/// The addresses of `host:port` the policy lets us dial.
async fn allowed(policy: &NetPolicy, host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    let (p, h) = (policy.clone(), host.to_string());
    tauri::async_runtime::spawn_blocking(move || p.check_host(&h, port)).await.map_err(|e| e.to_string())?.map_err(|b| b.to_string())
}

fn host_port(host: &str, port: u16) -> String {
    if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") }
}

// ---- RabbitMQ ----

fn rabbit_uri(url: &str) -> Result<AMQPUri, String> {
    let bad = || "The RabbitMQ URL isn't valid. Use amqp://user:password@host:5672/vhost.".to_string();
    let url = url.trim();
    let mut uri: AMQPUri = url.parse().map_err(|_| bad())?;
    // amq-protocol only reads domain names, so an IP literal would become "localhost".
    if let Some(h) = reqwest::Url::parse(url).map_err(|_| bad())?.host_str().filter(|h| !h.is_empty()) {
        uri.authority.host = h.trim_start_matches('[').trim_end_matches(']').to_string();
    }
    // `amqp://host/` names the empty vhost, which RabbitMQ never has; people mean "/".
    if uri.vhost.is_empty() {
        uri.vhost = "/".into();
    }
    Ok(uri)
}

fn rabbit_at(uri: &AMQPUri) -> String {
    host_port(&uri.authority.host, uri.authority.port)
}

fn amqp_code(e: &lapin::Error) -> Option<u16> {
    match e.kind() {
        ErrorKind::ProtocolError(a) => Some(a.get_id()),
        _ => None,
    }
}

/// Never includes the URL: only host:port, user name and the server's own reply.
fn rabbit_failed(e: &lapin::Error, at: &str) -> String {
    match e.kind() {
        ErrorKind::ProtocolError(a) => format!("RabbitMQ at {at} refused: {}", a.get_message()),
        ErrorKind::IOError(_) | ErrorKind::MissingHeartbeatError => format!("Lost the connection to RabbitMQ at {at}."),
        _ => format!("RabbitMQ at {at} failed: {e}"),
    }
}

fn rabbit_connect_error(e: &lapin::Error, uri: &AMQPUri) -> String {
    match amqp_code(e) {
        Some(403) => format!("RabbitMQ refused the login for user “{}”.", uri.authority.userinfo.username),
        Some(_) => rabbit_failed(e, &rabbit_at(uri)),
        None => format!("Couldn't connect to RabbitMQ at {}. Is it running?", rabbit_at(uri)),
    }
}

async fn rabbit_connect(uri: &AMQPUri, policy: &NetPolicy) -> Result<Connection, String> {
    let addrs = allowed(policy, &uri.authority.host, uri.authority.port).await?;
    let down = || format!("Couldn't connect to RabbitMQ at {}. Is it running?", rabbit_at(uri));
    if addrs.is_empty() {
        return Err(down());
    }
    let (tls, host) = (matches!(uri.scheme, AMQPScheme::AMQPS), uri.authority.host.clone());
    let runtime = lapin::runtime::default_runtime().map_err(|e| e.to_string())?;
    // Dial only the addresses the policy allowed; TLS still verifies the host name.
    let connect = Connection::connector(
        uri.clone(),
        runtime,
        async move |_, rt| {
            let s = AsyncTcpStream::connect(&rt, addrs.clone()).await?;
            Ok(if tls { s.into_tls(&host, TLSConfig::default()).await? } else { s })
        },
        ConnectionProperties::default(),
    );
    match tokio::time::timeout(CONNECT_TIMEOUT, connect).await {
        Ok(Ok(c)) => Ok(c),
        Ok(Err(e)) => Err(rabbit_connect_error(&e, uri)),
        Err(_) => Err(down()),
    }
}

/// Passive declare: checks the exchange exists, never creates one.
async fn rabbit_exchange(ch: &Channel, name: &str, uri: &AMQPUri) -> Result<(), String> {
    let passive = ExchangeDeclareOptions { passive: true, ..Default::default() };
    ch.exchange_declare(name.into(), ExchangeKind::Direct, passive, FieldTable::default()).await.map_err(|e| match amqp_code(&e) {
        Some(404) => format!("RabbitMQ has no exchange “{name}” on vhost “{}”.", uri.vhost),
        _ => rabbit_failed(&e, &rabbit_at(uri)),
    })
}

fn amqp_headers(headers: &[(String, String)]) -> FieldTable {
    let mut t = FieldTable::default();
    for (k, v) in headers.iter().filter(|(k, _)| !k.trim().is_empty()) {
        t.insert(k.trim().into(), AMQPValue::LongString(v.as_str().into()));
    }
    t
}

fn amqp_text(v: &AMQPValue) -> String {
    match v {
        AMQPValue::LongString(s) => s.to_string(),
        AMQPValue::ShortString(s) => s.to_string(),
        AMQPValue::ByteArray(b) => String::from_utf8_lossy(b.as_slice()).into_owned(),
        AMQPValue::Boolean(b) => b.to_string(),
        AMQPValue::ShortShortInt(n) => n.to_string(),
        AMQPValue::ShortShortUInt(n) => n.to_string(),
        AMQPValue::ShortInt(n) => n.to_string(),
        AMQPValue::ShortUInt(n) => n.to_string(),
        AMQPValue::LongInt(n) => n.to_string(),
        AMQPValue::LongUInt(n) => n.to_string(),
        AMQPValue::LongLongInt(n) => n.to_string(),
        AMQPValue::Float(n) => n.to_string(),
        AMQPValue::Double(n) => n.to_string(),
        AMQPValue::Timestamp(n) => n.to_string(),
        AMQPValue::Void => String::new(),
        other => format!("{other:?}"),
    }
}

fn header_strings(t: &FieldTable) -> Vec<(String, String)> {
    t.inner().iter().map(|(k, v)| (k.to_string(), amqp_text(v))).collect()
}

fn rabbit_message(d: Delivery) -> Message {
    let headers = d.properties.headers().as_ref().map(header_strings).unwrap_or_default();
    Message { routing_key: Some(d.routing_key.to_string()), ..message(d.exchange.to_string(), headers, &d.data) }
}

async fn rabbit_publish(req: &PublishRequest, url: &str) -> Result<(Option<i32>, Option<i64>), String> {
    let uri = rabbit_uri(url)?;
    let at = rabbit_at(&uri);
    let conn = rabbit_connect(&uri, &req.policy).await?;
    let fail = |e: lapin::Error| rabbit_failed(&e, &at);
    let sent = async {
        let ch = conn.create_channel().await.map_err(fail)?;
        if !req.destination.is_empty() {
            rabbit_exchange(&ch, &req.destination, &uri).await?;
        }
        ch.confirm_select(ConfirmSelectOptions::default()).await.map_err(fail)?;
        let mut props = BasicProperties::default().with_headers(amqp_headers(&req.headers));
        if serde_json::from_str::<serde_json::Value>(&req.body).is_ok() {
            props = props.with_content_type("application/json".into());
        }
        let key = req.routing_key.as_deref().unwrap_or("");
        let confirm = ch.basic_publish(req.destination.as_str().into(), key.into(), BasicPublishOptions::default(), req.body.as_bytes(), props).await.map_err(fail)?;
        match confirm.await.map_err(fail)? {
            Confirmation::Nack(_) => Err(format!("RabbitMQ at {at} didn't accept the message.")),
            _ => Ok((None, None)),
        }
    }
    .await;
    let _ = conn.close(200, "OK".into()).await;
    sent
}

async fn rabbit_subscribe(req: &ConsumeRequest, url: &str, buf: Arc<Buffer>) -> Result<Closer, String> {
    let uri = rabbit_uri(url)?;
    if req.source.is_empty() {
        return Err("RabbitMQ's default exchange delivers straight to a queue, so listening there would take messages from your workers. Pick a named exchange.".into());
    }
    let at = rabbit_at(&uri);
    let conn = rabbit_connect(&uri, &req.policy).await?;
    let fail = |e: lapin::Error| rabbit_failed(&e, &at);
    let setup = async {
        let ch = conn.create_channel().await.map_err(fail)?;
        rabbit_exchange(&ch, &req.source, &uri).await?;
        // A private server-named queue RabbitMQ deletes when we disconnect: the
        // exchange copies messages into it, so the user's own queues lose nothing.
        let private = QueueDeclareOptions { exclusive: true, auto_delete: true, ..Default::default() };
        let q = ch.queue_declare("".into(), private, FieldTable::default()).await.map_err(fail)?;
        let binding = req.binding.as_deref().filter(|b| !b.is_empty()).unwrap_or("#");
        ch.queue_bind(q.name().clone(), req.source.as_str().into(), binding.into(), QueueBindOptions::default(), FieldTable::default()).await.map_err(fail)?;
        let opts = BasicConsumeOptions { no_ack: true, exclusive: true, ..Default::default() };
        let consumer = ch.basic_consume(q.name().clone(), "".into(), opts, FieldTable::default()).await.map_err(fail)?;
        Ok::<_, String>((ch, consumer))
    }
    .await;
    let (ch, consumer) = match setup {
        Ok(x) => x,
        Err(e) => {
            let _ = conn.close(200, "OK".into()).await;
            return Err(e);
        }
    };
    consumer.set_delegate(move |d: DeliveryResult| {
        let (buf, at) = (buf.clone(), at.clone());
        async move {
            match d {
                Ok(Some(d)) => buf.push(rabbit_message(d)),
                Ok(None) => buf.fail(format!("RabbitMQ at {at} ended the subscription.")),
                Err(e) => buf.fail(rabbit_failed(&e, &at)),
            }
        }
    });
    Ok(Closer(Some(Box::new(move || {
        drop((consumer, ch));
        tauri::async_runtime::spawn(async move {
            let _ = conn.close(200, "OK".into()).await;
        });
    }))))
}

// ---- Kafka ----

fn kafka_brokers(url: &str) -> Result<Vec<(String, u16)>, String> {
    let bad = || "The Kafka brokers aren't valid. Use host:9092, separated by commas.".to_string();
    let list = url.trim();
    let list = list.strip_prefix("kafka://").unwrap_or(list);
    let mut out = Vec::new();
    for b in list.split(',').map(|b| b.trim().trim_end_matches('/')).filter(|b| !b.is_empty()) {
        let (host, port) = match b.rsplit_once(':') {
            Some((h, p)) if !b.ends_with(']') => (h, p.parse().map_err(|_| bad())?),
            _ => (b, 9092),
        };
        let host = host.trim_start_matches('[').trim_end_matches(']');
        if host.is_empty() || host.contains(['/', '@']) {
            return Err(bad());
        }
        out.push((host.to_string(), port));
    }
    if out.is_empty() { Err(bad()) } else { Ok(out) }
}

fn kafka_at(brokers: &[(String, u16)]) -> String {
    brokers.iter().map(|(h, p)| host_port(h, *p)).collect::<Vec<_>>().join(", ")
}

fn kafka_failed(e: KafkaError, at: &str) -> String {
    match e {
        KafkaError::ServerError { protocol_error, error_message, .. } => {
            format!("Kafka at {at} refused the request: {protocol_error}{}", error_message.map(|m| format!(" ({m})")).unwrap_or_default())
        }
        KafkaError::Connection(_) | KafkaError::RetryFailed(_) | KafkaError::Timeout => format!("Lost the connection to Kafka at {at}."),
        e => format!("Kafka at {at} failed: {e}"),
    }
}

/// Kafka's Java `Utils.murmur2`, which its default partitioner uses for keys.
fn murmur2(data: &[u8]) -> i32 {
    const M: u32 = 0x5bd1_e995;
    let mut h = 0x9747_b28c_u32 ^ data.len() as u32;
    let (chunks, rest) = data.as_chunks::<4>();
    for c in chunks {
        let mut k = u32::from_le_bytes(*c).wrapping_mul(M);
        k ^= k >> 24;
        h = h.wrapping_mul(M) ^ k.wrapping_mul(M);
    }
    if !rest.is_empty() {
        for (i, b) in rest.iter().enumerate() {
            h ^= (*b as u32) << (8 * i);
        }
        h = h.wrapping_mul(M);
    }
    h ^= h >> 13;
    h = h.wrapping_mul(M);
    (h ^ (h >> 15)) as i32
}

/// The partition a Java producer would pick for this key.
fn kafka_partition(key: &[u8], partitions: usize) -> i32 {
    ((murmur2(key) & 0x7fff_ffff) as usize % partitions.max(1)) as i32
}

async fn kafka_client(brokers: &[(String, u16)], policy: &NetPolicy) -> Result<Client, String> {
    let mut addrs = Vec::new();
    for (h, p) in brokers {
        addrs.extend(allowed(policy, h, *p).await?);
    }
    let down = || format!("Couldn't connect to Kafka at {}. Is it running?", kafka_at(brokers));
    if addrs.is_empty() {
        return Err(down());
    }
    // Bootstraps by checked address. Partition leaders are dialled at the
    // addresses the cluster advertises, which rskafka resolves itself.
    let backoff = BackoffConfig { deadline: Some(CONNECT_TIMEOUT), ..Default::default() };
    let build = ClientBuilder::new(addrs.iter().map(SocketAddr::to_string).collect()).backoff_config(backoff).build();
    match tokio::time::timeout(CONNECT_TIMEOUT, build).await {
        Ok(Ok(c)) => Ok(c),
        _ => Err(down()),
    }
}

async fn kafka_partitions(client: &Client, topic: &str, at: &str) -> Result<usize, String> {
    let topics = client.list_topics().await.map_err(|e| kafka_failed(e, at))?;
    topics.into_iter().find(|t| t.name == topic).map(|t| t.partitions.len()).ok_or_else(|| format!("Kafka has no topic “{topic}”."))
}

fn kafka_message(topic: &str, partition: i32, r: RecordAndOffset) -> Message {
    let headers = r.record.headers.into_iter().map(|(k, v)| (k, String::from_utf8_lossy(&v).into_owned())).collect();
    let key = r.record.key.map(|k| String::from_utf8_lossy(&k).into_owned());
    Message { key, partition: Some(partition), offset: Some(r.offset), ..message(topic.to_string(), headers, &r.record.value.unwrap_or_default()) }
}

async fn kafka_publish(req: &PublishRequest, url: &str) -> Result<(Option<i32>, Option<i64>), String> {
    let brokers = kafka_brokers(url)?;
    let at = kafka_at(&brokers);
    let client = kafka_client(&brokers, &req.policy).await?;
    let partitions = kafka_partitions(&client, &req.destination, &at).await?;
    let partition = req.key.as_deref().map_or(0, |k| kafka_partition(k.as_bytes(), partitions));
    let pc = client.partition_client(req.destination.clone(), partition, UnknownTopicHandling::Error).await.map_err(|e| kafka_failed(e, &at))?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let record = Record {
        key: req.key.clone().map(String::into_bytes),
        value: Some(req.body.clone().into_bytes()),
        headers: req.headers.iter().filter(|(k, _)| !k.trim().is_empty()).map(|(k, v)| (k.trim().to_string(), v.clone().into_bytes())).collect(),
        timestamp: rskafka::chrono::DateTime::from_timestamp_millis(now).unwrap_or_default(),
    };
    let offsets = pc.produce(vec![record], Compression::NoCompression).await.map_err(|e| kafka_failed(e, &at))?;
    Ok((Some(partition), offsets.first().copied()))
}

/// No consumer group: each partition is read from its end as of now, so the
/// user's consumer groups and their offsets are untouched.
async fn kafka_subscribe(req: &ConsumeRequest, url: &str, buf: Arc<Buffer>) -> Result<Closer, String> {
    let brokers = kafka_brokers(url)?;
    let at = kafka_at(&brokers);
    let client = kafka_client(&brokers, &req.policy).await?;
    let mut starts = Vec::new();
    for p in 0..kafka_partitions(&client, &req.source, &at).await? as i32 {
        let pc = client.partition_client(req.source.clone(), p, UnknownTopicHandling::Error).await.map_err(|e| kafka_failed(e, &at))?;
        let offset = pc.get_offset(OffsetAt::Latest).await.map_err(|e| kafka_failed(e, &at))?;
        starts.push((pc, offset));
    }
    let tasks: Vec<_> = starts
        .into_iter()
        .map(|(pc, mut offset)| {
            let (buf, at, topic) = (buf.clone(), at.clone(), req.source.clone());
            tauri::async_runtime::spawn(async move {
                loop {
                    match pc.fetch_records(offset, 1..1_000_000, 500).await {
                        Ok((records, _)) => {
                            for r in records {
                                offset = r.offset + 1;
                                buf.push(kafka_message(&topic, pc.partition(), r));
                            }
                        }
                        Err(e) => return buf.fail(kafka_failed(e, &at)),
                    }
                }
            })
        })
        .collect();
    Ok(Closer(Some(Box::new(move || tasks.iter().for_each(|t| t.abort())))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use lapin::protocol::AMQPError;
    use lapin::types::{ByteArray, ShortString};
    use std::sync::atomic::{AtomicBool, Ordering};

    const TRACE: &str = "4bf92f3577b34da6a3ce929d0e0e4736";

    fn msg(n: usize, headers: &[(&str, &str)]) -> Message {
        message("orders".into(), headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), n.to_string().as_bytes())
    }

    #[test]
    fn rabbit_urls_default_user_and_vhost() {
        let u = rabbit_uri("amqp://localhost").unwrap();
        assert_eq!((u.authority.userinfo.username.as_str(), u.authority.host.as_str(), u.authority.port, u.vhost.as_str()), ("guest", "localhost", 5672, "/"));
        let u = rabbit_uri(" amqp://app:s3cret@10.0.0.5:5673/%2f ").unwrap();
        assert_eq!((u.authority.userinfo.username.as_str(), u.authority.host.as_str(), u.authority.port, u.vhost.as_str()), ("app", "10.0.0.5", 5673, "/"));
        let u = rabbit_uri("amqps://rabbit.internal/orders").unwrap();
        assert_eq!((u.authority.port, u.vhost.as_str(), matches!(u.scheme, AMQPScheme::AMQPS)), (5671, "orders", true));
        assert_eq!(rabbit_uri("amqp://h:5672/").unwrap().vhost, "/");
        assert_eq!(rabbit_at(&rabbit_uri("amqp://[::1]:5672").unwrap()), "[::1]:5672");
        let err = rabbit_uri("http://guest:hunter2@x").unwrap_err();
        assert!(err.starts_with("The RabbitMQ URL isn't valid") && !err.contains("hunter2"), "{err}");
    }

    #[test]
    fn kafka_broker_lists() {
        let want = vec![("localhost".to_string(), 9092), ("kafka-2".to_string(), 19092)];
        assert_eq!(kafka_brokers("localhost:9092, kafka-2:19092").unwrap(), want);
        assert_eq!(kafka_brokers("kafka://localhost:9092,kafka-2:19092/").unwrap(), want);
        assert_eq!(kafka_brokers("localhost").unwrap(), vec![("localhost".to_string(), 9092)]);
        assert_eq!(kafka_brokers("[::1]:9093,[::1]").unwrap(), vec![("::1".to_string(), 9093), ("::1".to_string(), 9092)]);
        assert_eq!(kafka_at(&kafka_brokers("[::1]:9093,b:1").unwrap()), "[::1]:9093, b:1");
        for bad in ["", " , ", "host:port", "user:pw@host:9092", ":9092"] {
            assert!(kafka_brokers(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn murmur2_matches_kafka() {
        // Vectors from Kafka's UtilsTest.testMurmur2.
        for (input, want) in [
            (&b"21"[..], -973932308),
            (b"foobar", -790332482),
            (b"a-little-bit-long-string", -985981536),
            (b"a-little-bit-longer-string", -1486304829),
            (b"lkjh234lh9fiuh90y23oiuhsafujhadof229phr9h19h89h8", -58897971),
            (b"abc", 479470107),
        ] {
            assert_eq!(murmur2(input), want, "{}", String::from_utf8_lossy(input));
        }
        assert_eq!(kafka_partition(b"21", 3), ((-973932308i32 & 0x7fff_ffff) % 3));
        assert_eq!(kafka_partition(b"anything", 1), 0);
    }

    #[test]
    fn amqp_headers_become_strings() {
        let mut t = amqp_headers(&[("traceparent".into(), format!("00-{TRACE}-00f067aa0ba902b7-01")), (" ".into(), "dropped".into())]);
        t.insert(ShortString::from("retries"), AMQPValue::LongInt(3));
        t.insert(ShortString::from("ok"), AMQPValue::Boolean(true));
        t.insert(ShortString::from("kind"), AMQPValue::ShortString("order".into()));
        t.insert(ShortString::from("raw"), AMQPValue::ByteArray(ByteArray::from(b"bytes".to_vec())));
        t.insert(ShortString::from("none"), AMQPValue::Void);
        let h = header_strings(&t);
        let get = |k: &str| h.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(h.len(), 6);
        assert_eq!(get("traceparent"), Some(format!("00-{TRACE}-00f067aa0ba902b7-01").as_str()));
        assert_eq!((get("retries"), get("ok"), get("kind"), get("raw"), get("none")), (Some("3"), Some("true"), Some("order"), Some("bytes"), Some("")));
    }

    #[test]
    fn trace_ids_match_traceparent_or_request_id() {
        let ids = vec![TRACE.to_string(), "req-42".to_string()];
        let has = |k: &str, v: &str| has_trace(&[(k.to_string(), v.to_string())], &ids);
        assert!(has("traceparent", &format!("00-{TRACE}-00f067aa0ba902b7-01")));
        assert!(has("TraceParent", &format!("00-{}-00f067aa0ba902b7-01", TRACE.to_uppercase())));
        assert!(has("X-Request-ID", "req-42"));
        assert!(!has("x-request-id", "req-421"));
        assert!(!has("traceparent", "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"));
        assert!(!has("x-trace", TRACE));
    }

    #[test]
    fn errors_never_show_the_password() {
        let uri = rabbit_uri("amqp://guest:hunter2@x").unwrap();
        let refused: lapin::Error = ErrorKind::ProtocolError(AMQPError::from_id(403, "ACCESS_REFUSED - Login was refused".into()).unwrap()).into();
        assert_eq!(rabbit_connect_error(&refused, &uri), "RabbitMQ refused the login for user “guest”.");
        let io: lapin::Error = std::io::Error::from(std::io::ErrorKind::ConnectionRefused).into();
        assert_eq!(rabbit_connect_error(&io, &uri), "Couldn't connect to RabbitMQ at x:5672. Is it running?");
        let other: lapin::Error = ErrorKind::ProtocolError(AMQPError::from_id(530, "NOT_ALLOWED - vhost x not found".into()).unwrap()).into();
        for e in [&refused, &io, &other] {
            assert!(!rabbit_connect_error(e, &uri).contains("hunter2"));
        }
    }

    #[test]
    fn connect_refused_names_host_and_port() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let uri = rabbit_uri(&format!("amqp://guest:hunter2@127.0.0.1:{port}")).unwrap();
        let err = tauri::async_runtime::block_on(rabbit_connect(&uri, &NetPolicy::default())).unwrap_err();
        assert_eq!(err, format!("Couldn't connect to RabbitMQ at 127.0.0.1:{port}. Is it running?"));
        let off = NetPolicy { allow_private: false, allow_hosts: Vec::new(), env: "prod".into() };
        let err = tauri::async_runtime::block_on(kafka_client(&kafka_brokers("localhost:9092").unwrap(), &off)).unwrap_err();
        assert!(err.starts_with("Blocked by the network rules of “prod”: localhost is a private address"), "{err}");
    }

    #[test]
    fn buffer_caps_and_counts_skipped() {
        let buf = Buffer::new(Vec::new());
        for n in 0..BUFFER_CAP + 5 {
            buf.push(msg(n, &[]));
        }
        let (messages, skipped) = buf.take(true).unwrap().unwrap();
        assert_eq!((messages.len(), skipped), (BUFFER_CAP, 5));
        assert_eq!(messages[0].body_text.as_deref(), Some("5"));
        assert_eq!(buf.take(true).unwrap().unwrap().1, 0);
        assert!(buf.take(false).is_none());
    }

    #[test]
    fn buffer_filters_by_trace_id() {
        let buf = Buffer::new(vec![TRACE.into(), " ".into()]);
        buf.push(msg(1, &[("traceparent", &format!("00-{TRACE}-00f067aa0ba902b7-01"))]));
        buf.push(msg(2, &[("content-type", "application/json")]));
        buf.push(msg(3, &[("x-request-id", TRACE)]));
        let (messages, skipped) = buf.take(true).unwrap().unwrap();
        assert_eq!(messages.iter().map(|m| m.body_text.clone().unwrap()).collect::<Vec<_>>(), ["1", "3"]);
        assert_eq!(skipped, 1);
    }

    #[test]
    fn wait_returns_early_or_empty_at_the_deadline() {
        let buf = Arc::new(Buffer::new(Vec::new()));
        let started = Instant::now();
        let (messages, _) = tauri::async_runtime::block_on(buf.wait(Duration::from_millis(80))).unwrap();
        assert!(messages.is_empty() && started.elapsed() >= Duration::from_millis(80));
        let b2 = buf.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            b2.push(msg(7, &[]));
        });
        let started = Instant::now();
        let (messages, _) = tauri::async_runtime::block_on(buf.wait(Duration::from_secs(5))).unwrap();
        assert_eq!(messages.len(), 1);
        assert!(started.elapsed() < Duration::from_secs(2));
        buf.push(msg(8, &[]));
        buf.fail("Lost the connection to Kafka at x:9092.".into());
        assert_eq!(tauri::async_runtime::block_on(buf.wait(Duration::ZERO)).unwrap().0.len(), 1);
        assert_eq!(tauri::async_runtime::block_on(buf.wait(Duration::ZERO)).unwrap_err(), "Lost the connection to Kafka at x:9092.");
    }

    fn sub(state: &QueueState, id: &str, idle: Duration) -> Arc<AtomicBool> {
        let closed = Arc::new(AtomicBool::new(false));
        let c = closed.clone();
        let closer = Closer(Some(Box::new(move || c.store(true, Ordering::SeqCst))));
        let last_read = Instant::now().checked_sub(idle).unwrap();
        state.subs.lock().unwrap().insert(id.into(), Sub { buf: Arc::new(Buffer::new(Vec::new())), last_read, _closer: closer });
        closed
    }

    #[test]
    fn idle_subscriptions_close_on_access() {
        let state = QueueState::default();
        let stale = sub(&state, "stale", IDLE + Duration::from_secs(1));
        let fresh = sub(&state, "fresh", Duration::from_secs(60));
        assert!(state.touch("fresh").is_some());
        assert!(stale.load(Ordering::SeqCst) && !fresh.load(Ordering::SeqCst));
        assert!(state.touch("stale").is_none());
    }

    #[test]
    fn cancel_closes_the_subscription() {
        let state = QueueState::default();
        let closed = sub(&state, "listen-1", Duration::ZERO);
        assert!(state.cancel("listen-1"));
        assert!(closed.load(Ordering::SeqCst));
        assert!(state.touch("listen-1").is_none());
        assert!(!state.cancel("listen-1"));
    }

    // ---- Against real brokers: see fixtures/brokers/docker-compose.yml ----

    fn amqp_url() -> String {
        std::env::var("AUXIN_TEST_AMQP").unwrap_or_else(|_| "amqp://guest:guest@localhost:5672/%2f".into())
    }

    fn kafka_url() -> String {
        std::env::var("AUXIN_TEST_KAFKA").unwrap_or_else(|_| "localhost:9092".into())
    }

    fn publish(state: &Arc<QueueState>, broker: &serde_json::Value, destination: &str, key: Option<&str>, headers: &[(&str, &str)]) -> PublishResult {
        let req = serde_json::json!({ "id": "pub", "broker": broker, "destination": destination, "routingKey": "orders.created", "key": key, "headers": headers, "body": "{\"id\":1}" });
        tauri::async_runtime::block_on(state.clone().publish(serde_json::from_value(req).unwrap())).unwrap()
    }

    fn consume(state: &Arc<QueueState>, broker: &serde_json::Value, source: &str, id: &str, wait_ms: u64) -> Result<ConsumeResult, String> {
        let req = serde_json::json!({ "id": id, "broker": broker, "source": source, "traceIds": [TRACE], "waitMs": wait_ms });
        tauri::async_runtime::block_on(state.clone().consume(serde_json::from_value(req).unwrap()))
    }

    /// Opens a listen, publishes a matching and a non-matching message, reads,
    /// times out empty, then checks cancel leaves a fresh subscription behind.
    fn round_trip(broker: serde_json::Value, dest: &str, key: Option<&str>) -> PublishResult {
        let state = Arc::new(QueueState::default());
        let tp = format!("00-{TRACE}-00f067aa0ba902b7-01");
        assert!(consume(&state, &broker, dest, "listen", 0).unwrap().messages.is_empty());
        publish(&state, &broker, dest, key, &[("x-other", "1")]);
        let sent = publish(&state, &broker, dest, key, &[("traceparent", &tp)]);
        let mut got = Vec::new();
        let mut skipped = 0;
        let started = Instant::now();
        while got.is_empty() && started.elapsed() < Duration::from_secs(10) {
            let r = consume(&state, &broker, dest, "listen", 3000).unwrap();
            got.extend(r.messages);
            skipped += r.skipped;
        }
        assert_eq!(got.len(), 1, "{got:?}");
        assert_eq!(skipped, 1);
        assert_eq!(got[0].body_text.as_deref(), Some("{\"id\":1}"));
        assert!(got[0].headers.iter().any(|(k, v)| k == "traceparent" && *v == tp), "{:?}", got[0].headers);
        let started = Instant::now();
        let r = consume(&state, &broker, dest, "listen", 300).unwrap();
        assert!(r.messages.is_empty() && r.skipped == 0 && started.elapsed() >= Duration::from_millis(300));
        assert!(state.cancel("listen"));
        publish(&state, &broker, dest, key, &[("traceparent", &tp)]);
        // A fresh subscription starts after that message, so it never sees it.
        assert!(consume(&state, &broker, dest, "listen", 0).unwrap().messages.is_empty());
        assert!(consume(&state, &broker, dest, "listen", 1500).unwrap().messages.is_empty());
        state.cancel("listen");
        sent
    }

    #[test]
    #[ignore = "needs RabbitMQ: docker compose -f fixtures/brokers/docker-compose.yml up -d"]
    fn queue_rabbitmq_round_trip() {
        let url = amqp_url();
        tauri::async_runtime::block_on(async {
            // Tests may declare; the step itself never does.
            let conn = Connection::connect(&url, ConnectionProperties::default()).await.unwrap();
            let ch = conn.create_channel().await.unwrap();
            ch.exchange_declare("auxin-test-topic".into(), ExchangeKind::Topic, ExchangeDeclareOptions::default(), FieldTable::default()).await.unwrap();
            conn.close(200, "OK".into()).await.unwrap();
        });
        let broker = serde_json::json!({ "type": "rabbitmq", "url": url });
        let sent = round_trip(broker.clone(), "auxin-test-topic", None);
        assert_eq!((sent.destination.as_str(), sent.partition, sent.offset), ("auxin-test-topic", None, None));
        let state = Arc::new(QueueState::default());
        let err = consume(&state, &broker, "auxin-no-such-exchange", "missing", 0).unwrap_err();
        assert_eq!(err, "RabbitMQ has no exchange “auxin-no-such-exchange” on vhost “/”.");
    }

    #[test]
    #[ignore = "needs Kafka: docker compose -f fixtures/brokers/docker-compose.yml up -d"]
    fn queue_kafka_round_trip() {
        let brokers = kafka_brokers(&kafka_url()).unwrap();
        tauri::async_runtime::block_on(async {
            let client = kafka_client(&brokers, &NetPolicy::default()).await.unwrap();
            if !client.list_topics().await.unwrap().iter().any(|t| t.name == "auxin-test") {
                client.controller_client().unwrap().create_topic("auxin-test", 3, 1, 5000).await.unwrap();
            }
        });
        let broker = serde_json::json!({ "type": "kafka", "url": kafka_url() });
        let sent = round_trip(broker.clone(), "auxin-test", Some("order-42"));
        assert_eq!(sent.partition, Some(kafka_partition(b"order-42", 3)));
        assert!(sent.offset.is_some());
        let state = Arc::new(QueueState::default());
        assert_eq!(consume(&state, &broker, "auxin-no-such-topic", "missing", 0).unwrap_err(), "Kafka has no topic “auxin-no-such-topic”.");
    }
}
