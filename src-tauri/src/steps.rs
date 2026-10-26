//! One entry point for every kind of step a flow can run. HTTP is the only kind
//! so far; new kinds become new variants here, each with its own module.

use crate::http::{HttpRequest, HttpResponse, HttpState};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StepRequest {
    Http(HttpRequest),
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StepResult {
    Http(HttpResponse),
}

pub async fn exec(http: Arc<HttpState>, req: StepRequest, temp_dir: PathBuf) -> Result<StepResult, String> {
    match req {
        StepRequest::Http(r) => http.send(r, temp_dir).await.map(StepResult::Http),
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
}
