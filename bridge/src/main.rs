mod client;
mod gateway;
mod manager;
mod spawn;

use anyhow::Result;
use futures_util::StreamExt;
use std::sync::Arc;
use tokio::io::AsyncBufReadExt;
use tokio::sync::Mutex;

#[tokio::main]
async fn main() -> Result<()> {
    let broker_url = std::env::var("HIVE_HOST")
        .map(|h| {
            // Convert http(s) to ws(s)
            h.replace("http://", "ws://").replace("https://", "wss://")
        })
        .unwrap_or_else(|_| "ws://127.0.0.1:7899".to_string());
    let master_key = std::env::var("AGENT_HIVE_TOKEN")
        .unwrap_or_else(|_| {
            // Try reading from ~/.agent-hive.key
            let home = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .unwrap_or_else(|_| ".".to_string());
            let key_path = format!("{}/.agent-hive.key", home);
            std::fs::read_to_string(&key_path).unwrap_or_default().trim().to_string()
        });
    let local_port: u16 = std::env::var("BRIDGE_LOCAL_PORT")
        .unwrap_or_else(|_| "17900".to_string())
        .parse()
        .unwrap_or(17900);

    let bridge_id = hex::encode(&uuid::Uuid::new_v4().as_bytes()[..4]);

    println!("Agent Hive Bridge {}", bridge_id);
    println!("Connecting to broker at {}", broker_url);

    let mgr = Arc::new(Mutex::new(manager::AgentManager::new(bridge_id.clone())));

    // Connect to broker
    let ws_stream = client::connect(&broker_url, &master_key, &bridge_id).await?;
    println!("Connected to broker");

    let (ws_sink, ws_stream) = ws_stream.split();

    let broker_tx = Arc::new(Mutex::new(client::BrokerSender::new(ws_sink)));
    let broker_rx = Arc::new(Mutex::new(ws_stream));

    // Start broker message reader
    let mgr_clone = mgr.clone();
    let broker_tx_reader = broker_tx.clone();
    tokio::spawn(async move {
        client::read_broker_messages(broker_rx, mgr_clone, broker_tx_reader).await;
    });

    // Start local gateway for coworkers
    let mgr_gateway = mgr.clone();
    let broker_tx_gateway = broker_tx.clone();
    tokio::spawn(async move {
        if let Err(e) = gateway::start(local_port, mgr_gateway, broker_tx_gateway).await {
            eprintln!("Gateway error: {}", e);
        }
    });

    // Interactive shell
    println!("Commands: spawn <cmd>, kill <id>, list, status, quit");
    let stdin = tokio::io::BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();

    loop {
        tokio::select! {
            line = lines.next_line() => {
                match line {
                    Ok(Some(input)) => {
                        let parts: Vec<String> = input.split_whitespace().map(String::from).collect();
                        if parts.is_empty() { continue; }

                        match parts[0].as_str() {
                            "spawn" => {
                                if parts.len() < 2 {
                                    println!("Usage: spawn <command> [args...]");
                                    continue;
                                }
                                let cmd = parts[1].clone();
                                let args: Vec<String> = parts[2..].to_vec();
                                let mut m = mgr.lock().await;
                                match m.spawn_agent(cmd, args, &broker_tx).await {
                                    Ok(id) => println!("Spawned agent: {}", id),
                                    Err(e) => eprintln!("Spawn failed: {}", e),
                                }
                            }
                            "kill" => {
                                if parts.len() < 2 {
                                    println!("Usage: kill <agent-id>");
                                    continue;
                                }
                                let mut m = mgr.lock().await;
                                match m.kill_agent(&parts[1], &broker_tx).await {
                                    Ok(()) => println!("Killed agent: {}", parts[1]),
                                    Err(e) => eprintln!("Kill failed: {}", e),
                                }
                            }
                            "list" => {
                                let m = mgr.lock().await;
                                m.list_agents();
                            }
                            "status" => {
                                let m = mgr.lock().await;
                                println!("Bridge: {}", m.bridge_id);
                                println!("Agents: {}", m.agents.len());
                            }
                            "quit" | "exit" => {
                                println!("Shutting down...");
                                let mut m = mgr.lock().await;
                                m.shutdown(&broker_tx).await;
                                break;
                            }
                            _ => println!("Unknown command: {}", parts[0]),
                        }
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
        }
    }

    Ok(())
}
