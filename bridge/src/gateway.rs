use anyhow::Result;
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use serde_json::Value;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use crate::client::BrokerSender;
use crate::manager::AgentManager;

pub async fn start(
    port: u16,
    _mgr: Arc<Mutex<AgentManager>>,
    broker_tx: Arc<Mutex<BrokerSender>>,
) -> Result<()> {
    let listener = TcpListener::bind(format!("127.0.0.1:{}", port)).await?;
    println!("Local gateway listening on http://127.0.0.1:{}", port);

    loop {
        let (stream, _) = listener.accept().await?;
        let broker_tx = broker_tx.clone();

        tokio::spawn(async move {
            let io = TokioIo::new(stream);
            let service = service_fn(move |req: Request<Incoming>| {
                let broker_tx = broker_tx.clone();
                handle_request(req, broker_tx)
            });

            if let Err(e) = http1::Builder::new().serve_connection(io, service).await {
                eprintln!("Gateway connection error: {}", e);
            }
        });
    }
}

async fn handle_request(
    req: Request<Incoming>,
    broker_tx: Arc<Mutex<BrokerSender>>,
) -> Result<Response<String>, hyper::Error> {
    let (parts, body) = req.into_parts();
    let path = parts.uri.path().to_string();

    let body_bytes = body.collect().await?.to_bytes();
    let body_val: Value = serde_json::from_slice(&body_bytes).unwrap_or(Value::Null);

    // Forward API requests to broker
    let mut broker = broker_tx.lock().await;
    let request_id = hex::encode(&uuid::Uuid::new_v4().as_bytes()[..4]);

    let api_request = serde_json::json!({
        "type": "api_request",
        "request_id": request_id,
        "method": "POST",
        "path": path,
        "body": body_val,
    });

    broker.send(&api_request).await;
    drop(broker);

    let response = serde_json::json!({ "ok": true, "request_id": request_id });
    Ok(Response::builder()
        .status(200)
        .header("Content-Type", "application/json")
        .body(response.to_string())
        .unwrap())
}
