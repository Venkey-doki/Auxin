//! One entry point for every kind of step a flow can run. Each kind is a
//! variant here with its own module: HTTP requests and message-queue steps.

use crate::http::{HttpRequest, HttpResponse, HttpState};
use crate::queue::{ConsumeRequest, ConsumeResult, PublishRequest, PublishResult, QueueState};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

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
