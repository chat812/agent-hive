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
    sink: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Message,
    >,
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
        Self { sink }
    }

    pub async fn send(&mut self, msg: &Value) {
        let text = serde_json::to_string(msg).unwrap_or_default();
        let _ = futures_util::SinkExt::send(&mut self.sink, Message::Text(text.into())).await;
    }
}

pub async fn connect(
    broker_url: &str,
    master_key: &str,
    bridge_id: &str,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
> {
    let base = if broker_url.ends_with('/') { broker_url.to_string() } else { format!("{}/", broker_url) };
    let url = format!("{}ws/bridge?token={}&bridge_id={}", base, master_key, bridge_id);
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
) {
    let mut rx = rx.lock().await;
    while let Some(msg) = rx.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
                    handle_broker_message(parsed, &mgr, &broker_tx).await;
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

async fn handle_broker_message(
    msg: Value,
    mgr: &Arc<Mutex<AgentManager>>,
    broker_tx: &Arc<Mutex<BrokerSender>>,
) {
    let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match msg_type {
        "terminal_input" => {
            let session_id = msg.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
            let data_str = msg.get("data").and_then(|v| v.as_str()).unwrap_or("");
            let data = data_str.as_bytes().to_vec();
            let mut m = mgr.lock().await;
            let _ = m.write_to_agent(session_id, &data);
        }
        "terminal_resize" => {
            let session_id = msg.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
            let cols = msg.get("cols").and_then(|v| v.as_u64()).unwrap_or(120) as u16;
            let rows = msg.get("rows").and_then(|v| v.as_u64()).unwrap_or(30) as u16;
            let mut m = mgr.lock().await;
            let _ = m.resize_agent(session_id, cols, rows);
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
        }
        "kill_agent" => {
            let session_id = msg.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
            if !session_id.is_empty() {
                let mut m = mgr.lock().await;
                let _ = m.kill_agent(session_id, broker_tx).await;
            }
        }
        _ => {}
    }
}
