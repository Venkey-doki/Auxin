//! One entry point for every kind of step a flow can run. Each kind is a
//! variant here with its own module: HTTP requests and message-queue steps.

use crate::http::{HttpRequest, HttpResponse, HttpState};
use crate::queue::{ConsumeRequest, ConsumeResult, PublishRequest, PublishResult, QueueState};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};

/// Steps in flight by id, for every kind, so Stop can abort any of them.
pub(crate) static INFLIGHT: LazyLock<Inflight> = LazyLock::new(Inflight::default);

/// Ids stopped before their step reached the backend; old ones are forgotten.
const STOPPED_EARLY_CAP: usize = 64;

#[derive(Default)]
pub(crate) struct Inflight(Mutex<Tasks>);

#[derive(Default)]
struct Tasks {
    running: HashMap<String, tauri::async_runtime::JoinHandle<()>>,
    stopped_early: VecDeque<String>,
}

impl Inflight {
    /// Runs `f` so `cancel(id)` can abort it mid-flight. If Stop came first, it doesn't run at all.
    pub async fn run<T: Send + 'static>(&self, id: &str, f: impl Future<Output = Result<T, String>> + Send + 'static) -> Result<T, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        {
            let mut t = self.0.lock().unwrap();
            if let Some(i) = t.stopped_early.iter().position(|x| x == id) {
                t.stopped_early.remove(i);
                return Err("Cancelled".into());
            }
            let handle = tauri::async_runtime::spawn(async move {
                let _ = tx.send(f.await);
            });
            t.running.insert(id.to_string(), handle);
        }
        let out = rx.await.unwrap_or_else(|_| Err("Cancelled".into()));
        self.0.lock().unwrap().running.remove(id);
        out
    }

    /// Aborts the step running with this id. With `early`, an id that isn't running
    /// yet is remembered, so its step is stopped when it arrives (Stop pressed just
    /// as a request was being handed to the backend).
    pub fn cancel(&self, id: &str, early: bool) -> bool {
        let mut t = self.0.lock().unwrap();
        if let Some(h) = t.running.remove(id) {
            h.abort();
            return true;
        }
        if early {
            if t.stopped_early.len() >= STOPPED_EARLY_CAP {
                t.stopped_early.pop_front();
            }
            t.stopped_early.push_back(id.to_string());
        }
        false
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StepRequest {
    Http(HttpRequest),
    #[serde(rename = "queue.publish")]
    QueuePublish(PublishRequest),
    #[serde(rename = "queue.consume")]
    QueueConsume(ConsumeRequest),
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StepResult {
    Http(HttpResponse),
    #[serde(rename = "queue.publish")]
    QueuePublish(PublishResult),
    #[serde(rename = "queue.consume")]
    QueueConsume(ConsumeResult),
}

pub async fn exec(http: Arc<HttpState>, queue: Arc<QueueState>, req: StepRequest, temp_dir: PathBuf) -> Result<StepResult, String> {
    match req {
        StepRequest::Http(r) => http.send(r, temp_dir).await.map(StepResult::Http),
        StepRequest::QueuePublish(r) => queue.publish(r).await.map(StepResult::QueuePublish),
        StepRequest::QueueConsume(r) => queue.consume(r).await.map(StepResult::QueueConsume),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn stop_before_the_step_arrives_still_stops_it() {
        let inflight = Inflight::default();
        assert!(!inflight.cancel("early", true));
        let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let r = ran.clone();
        let out = tauri::async_runtime::block_on(inflight.run("early", async move {
            r.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }));
        assert_eq!(out, Err("Cancelled".into()));
        assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
        // Only once: the same id can run afterwards.
        assert_eq!(tauri::async_runtime::block_on(inflight.run("early", async { Ok(1) })), Ok(1));
        // A plain cancel of an unknown id leaves nothing behind.
        assert!(!inflight.cancel("other", false));
        assert_eq!(tauri::async_runtime::block_on(inflight.run("other", async { Ok(2) })), Ok(2));
        // Running steps are aborted.
        let stopper = std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(100));
            INFLIGHT.cancel("slow", true)
        });
        let out = tauri::async_runtime::block_on(INFLIGHT.run("slow", async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            Ok(())
        }));
        assert!(stopper.join().unwrap());
        assert_eq!(out, Err("Cancelled".into()));
    }

    #[test]
    fn requests_are_tagged_by_kind() {
        let req: StepRequest = serde_json::from_str(r#"{"kind":"http","id":"a","method":"GET","url":"http://x","body":{"kind":"none"}}"#).unwrap();
        assert!(matches!(req, StepRequest::Http(ref r) if r.id == "a" && r.root.is_none()));
        let bad = serde_json::from_str::<StepRequest>(r#"{"kind":"carrier-pigeon","id":"a"}"#);
        assert!(bad.is_err());
    }

    #[test]
    fn queue_steps_use_the_agreed_json() {
        let req: StepRequest = serde_json::from_str(r#"{"kind":"queue.publish","id":"p","broker":{"type":"kafka","url":"localhost:9092"},"destination":"orders","key":"k1","headers":[["traceparent","00-x-y-01"]],"body":"{}"}"#).unwrap();
        assert!(matches!(req, StepRequest::QueuePublish(ref r) if r.timeout_ms == 10_000 && r.routing_key.is_none() && r.key.as_deref() == Some("k1") && r.policy.allow_private));
        let req: StepRequest = serde_json::from_str(r#"{"kind":"queue.consume","id":"c","broker":{"type":"rabbitmq","url":"amqp://localhost"},"source":"orders","binding":null,"waitMs":0}"#).unwrap();
        assert!(matches!(req, StepRequest::QueueConsume(ref r) if r.trace_ids.is_empty() && r.wait_ms == 0 && r.binding.is_none()));
        assert!(serde_json::from_str::<StepRequest>(r#"{"kind":"queue.consume","id":"c","broker":{"type":"sqs","url":"x"},"source":"o","waitMs":0}"#).is_err());

        let res = StepResult::QueuePublish(PublishResult { ms: 3, destination: "orders".into(), partition: Some(1), offset: Some(7) });
        assert_eq!(serde_json::to_string(&res).unwrap(), r#"{"kind":"queue.publish","ms":3,"destination":"orders","partition":1,"offset":7}"#);
        let res = StepResult::QueueConsume(ConsumeResult { messages: Vec::new(), skipped: 2 });
        assert_eq!(serde_json::to_string(&res).unwrap(), r#"{"kind":"queue.consume","messages":[],"skipped":2}"#);
    }
}
