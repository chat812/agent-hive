use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::client::BrokerSender;
use crate::spawn::AgentProcess;

pub struct AgentManager {
    pub bridge_id: String,
    pub agents: HashMap<String, AgentProcess>,
}

impl AgentManager {
    pub fn new(bridge_id: String) -> Self {
        Self {
            bridge_id,
            agents: HashMap::new(),
        }
    }

    pub async fn spawn_agent(
        &mut self,
        cmd: String,
        args: Vec<String>,
        broker_tx: &Arc<Mutex<BrokerSender>>,
    ) -> Result<String> {
        let mut agent = AgentProcess::spawn(cmd, args)?;
        let id = agent.id.clone();

        // Register with broker
        let msg = serde_json::json!({
            "type": "register",
            "id": id,
            "name": format!("agent-{}", id),
            "pid": agent.pid,
            "bridge_id": self.bridge_id,
            "harness": "claude-code",
            "hostname": hostname::get().map(|h| h.to_string_lossy().to_string()).unwrap_or_default(),
        });
        let mut broker = broker_tx.lock().await;
        broker.send(&msg).await;
        drop(broker);

        // Start forwarding PTY output to broker in a background thread
        if let Some(reader) = agent.take_reader() {
            let session_id = id.clone();
            let broker_tx_clone = broker_tx.clone();
            let rt = tokio::runtime::Handle::current();
            std::thread::spawn(move || {
                use std::io::Read;
                let mut reader: Box<dyn std::io::Read + Send> = reader;
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let data = hex::encode(&buf[..n]);
                            let msg = serde_json::json!({
                                "type": "terminal_output",
                                "session_id": session_id,
                                "data": data,
                            });
                            rt.block_on(async {
                                let mut tx = broker_tx_clone.lock().await;
                                tx.send(&msg).await;
                            });
                        }
                        Err(_) => break,
                    }
                }
                // Notify broker that agent exited
                let exit_msg = serde_json::json!({
                    "type": "agent_exited",
                    "session_id": session_id,
                });
                rt.block_on(async {
                    let mut tx = broker_tx_clone.lock().await;
                    tx.send(&exit_msg).await;
                });
                println!("Agent {} PTY closed", session_id);
            });
        }

        self.agents.insert(id.clone(), agent);
        Ok(id)
    }

    pub async fn kill_agent(
        &mut self,
        id: &str,
        _broker_tx: &Arc<Mutex<BrokerSender>>,
    ) -> Result<()> {
        if let Some(mut agent) = self.agents.remove(id) {
            agent.kill()?;
            println!("Agent {} terminated", id);
        }
        Ok(())
    }

    pub fn list_agents(&self) {
        if self.agents.is_empty() {
            println!("No agents running.");
            return;
        }
        for (id, agent) in &self.agents {
            println!("  {}  pid={}  cmd={}", id, agent.pid, agent.cmd);
        }
    }

    pub async fn shutdown(&mut self, broker_tx: &Arc<Mutex<BrokerSender>>) {
        let ids: Vec<String> = self.agents.keys().cloned().collect();
        for id in ids {
            let _ = self.kill_agent(&id, broker_tx).await;
        }
    }

    pub fn write_to_agent(&mut self, id: &str, data: &[u8]) -> Result<()> {
        if let Some(agent) = self.agents.get_mut(id) {
            agent.write(data)?;
        }
        Ok(())
    }

    pub fn resize_agent(&mut self, id: &str, cols: u16, rows: u16) -> Result<()> {
        if let Some(agent) = self.agents.get_mut(id) {
            agent.resize(cols, rows)?;
        }
        Ok(())
    }
}
