use anyhow::Result;
use futures_util::StreamExt;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        client::IntoClientRequest,
        protocol::WebSocketConfig,
        Message,
    },
};

use crate::manager::AgentManager;

pub struct BrokerSender {
    sink: Option<futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Message,
    >>,
}

impl BrokerSender {
    pub fn new(
        sink: futures_util::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            Message,
        >,
    ) -> Self {
        Self { sink: Some(sink) }
    }

    pub fn new_placeholder() -> Self {
        Self { sink: None }
    }

    pub async fn send(&mut self, msg: &Value) {
        if let Some(sink) = &mut self.sink {
            let text = serde_json::to_string(msg).unwrap_or_default();
            let _ = futures_util::SinkExt::send(sink, Message::Text(text.into())).await;
        }
    }
}

pub async fn connect(
    broker_url: &str,
    bridge_id: &str,
    mutual_key: Option<&str>,
    hostname: &str,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
> {
    let base = if broker_url.ends_with('/') { broker_url.to_string() } else { format!("{}/", broker_url) };
    let url = match mutual_key {
        Some(key) => format!("{}ws/landlord?bridge_id={}&key={}&hostname={}", base, bridge_id, key, hostname),
        None => format!("{}ws/landlord?bridge_id={}&hostname={}", base, bridge_id, hostname),
    };
    let mut request = url.into_client_request()?;
    // Remove permessage-deflate extension for compatibility
    let headers = request.headers_mut();
    headers.remove("Sec-WebSocket-Extensions");

    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(16 * 1024 * 1024);
    let (ws_stream, _) = connect_async_with_config(request, Some(config), false).await?;
    Ok(ws_stream)
}

pub async fn read_broker_messages(
    rx: Arc<Mutex<futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>>>>,
    mgr: Arc<Mutex<AgentManager>>,
    broker_tx: Arc<Mutex<BrokerSender>>,
    bridge_id: &str,
) {
    let mut rx = rx.lock().await;
    while let Some(msg) = rx.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
                    let should_exit = handle_broker_message(parsed, &mgr, &broker_tx, bridge_id).await;
                    if should_exit {
                        break;
                    }
                }
            }
            Ok(Message::Close(_)) => {
                eprintln!("Broker disconnected");
                break;
            }
            Err(e) => {
                eprintln!("WebSocket error: {}", e);
                break;
            }
            _ => {}
        }
    }
}

/// Returns true if the landlord should exit (e.g., rejected)
async fn handle_broker_message(
    msg: Value,
    mgr: &Arc<Mutex<AgentManager>>,
    broker_tx: &Arc<Mutex<BrokerSender>>,
    _bridge_id: &str,
) -> bool {
    let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match msg_type {
        "landlord_pending" => {
            println!("Waiting for dashboard approval...");
            false
        }
        "landlord_approved" => {
            let mutual_key = msg.get("mutual_key").and_then(|v| v.as_str()).unwrap_or("");
            if !mutual_key.is_empty() {
                super::save_landlord_key(mutual_key);
                println!("Approved! Mutual key saved.");
            }
            false
        }
        "landlord_rejected" => {
            eprintln!("Landlord rejected by dashboard. Resetting identity.");
            super::delete_landlord_files();
            true // signal exit
        }
        "terminal_input" => {
            let session_id = msg.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
            let data_str = msg.get("data").and_then(|v| v.as_str()).unwrap_or("");
            let data = data_str.as_bytes().to_vec();
            let mut m = mgr.lock().await;
            let _ = m.write_to_agent(session_id, &data);
            false
        }
        "terminal_resize" => {
            let session_id = msg.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
            let cols = msg.get("cols").and_then(|v| v.as_u64()).unwrap_or(120) as u16;
            let rows = msg.get("rows").and_then(|v| v.as_u64()).unwrap_or(30) as u16;
            let mut m = mgr.lock().await;
            let _ = m.resize_agent(session_id, cols, rows);
            false
        }
        "spawn_agent" => {
            let cmd = msg.get("cmd").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let args: Vec<String> = msg.get("args")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            if !cmd.is_empty() {
                let mut m = mgr.lock().await;
                match m.spawn_agent(cmd, args, broker_tx).await {
                    Ok(id) => println!("Spawned agent from broker request: {}", id),
                    Err(e) => eprintln!("Spawn from broker failed: {}", e),
                }
            }
            false
        }
        "kill_agent" => {
            let session_id = msg.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
            if !session_id.is_empty() {
                let mut m = mgr.lock().await;
                let _ = m.kill_agent(session_id, broker_tx).await;
            }
            false
        }
        _ => false,
    }
}
