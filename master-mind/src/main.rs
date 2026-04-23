use std::env;
use std::path::PathBuf;
use std::sync::Arc;
use std::collections::HashSet;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::Client;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::model::{Implementation, ServerCapabilities, ServerInfo};
use rmcp::handler::server::wrapper::Parameters;
use rmcp::{tool, tool_handler, tool_router, RoleServer, ServerHandler, ServiceExt};
use rmcp::schemars::{self, JsonSchema};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

// --- Helpers ---

fn log(msg: &str) {
    eprintln!("[master-mind] {}", msg);
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn read_master_key() -> Option<String> {
    let path = home_dir().join(".agent-hive.key");
    if path.exists() {
        if let Ok(key) = std::fs::read_to_string(&path) {
            let key = key.trim().to_string();
            if !key.is_empty() { return Some(key); }
        }
    }
    None
}

fn format_bytes(bytes: u64) -> String {
    if bytes == 0 { return "0B".to_string(); }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let i = (bytes as f64).log(1024.0).floor() as usize;
    let i = i.min(units.len() - 1);
    let val = bytes as f64 / 1024_f64.powi(i as i32);
    format!("{:.1}{}", val, units[i])
}

// --- Broker Client ---

struct BrokerClient {
    http: Client,
    broker_url: String,
    token: Mutex<Option<String>>,
    master_key: Mutex<Option<String>>,
}

impl BrokerClient {
    fn new(broker_url: String, master_key: Option<String>) -> Self {
        Self {
            http: Client::new(),
            broker_url,
            token: Mutex::new(None),
            master_key: Mutex::new(master_key),
        }
    }

    async fn set_token(&self, token: String) {
        *self.token.lock().await = Some(token);
    }

    async fn post<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: &impl Serialize,
    ) -> Result<T, String> {
        let token = self.token.lock().await.clone();
        let mut req = self.http.post(format!("{}{}", self.broker_url, path)).json(body);
        if let Some(ref t) = token {
            req = req.bearer_auth(t);
        }
        let res = req.send().await.map_err(|e| format!("Request failed ({}): {}", path, e))?;
        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            return Err(format!("Error ({}): {} {}", path, status, text));
        }
        res.json().await.map_err(|e| format!("Parse error ({}): {}", path, e))
    }

    async fn admin_post<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: &impl Serialize,
    ) -> Result<T, String> {
        let key = self.master_key.lock().await.clone();
        let mut req = self.http.post(format!("{}{}", self.broker_url, path)).json(body);
        if let Some(ref k) = key {
            req = req.bearer_auth(k);
        }
        let res = req.send().await.map_err(|e| format!("Request failed ({}): {}", path, e))?;
        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            return Err(format!("Error ({}): {} {}", path, status, text));
        }
        res.json().await.map_err(|e| format!("Parse error ({}): {}", path, e))
    }

    async fn health_check(&self) -> bool {
        match self.http.get(format!("{}/health", self.broker_url)).timeout(Duration::from_secs(2)).send().await {
            Ok(res) => res.status().is_success(),
            Err(_) => false,
        }
    }
}

// --- State ---

struct MasterMindState {
    id: Option<String>,
    name: String,
    channel: String,
    messages: Vec<serde_json::Value>,
}

// --- MCP Server ---

#[derive(Clone)]
struct MasterMindServer {
    broker: Arc<BrokerClient>,
    state: Arc<Mutex<MasterMindState>>,
    broker_url: String,
    tool_router: ToolRouter<Self>,
    ws_connected: Arc<std::sync::atomic::AtomicBool>,
    pushed_message_ids: Arc<Mutex<HashSet<i64>>>,
}

impl MasterMindServer {
    fn new(broker: Arc<BrokerClient>, state: Arc<Mutex<MasterMindState>>, broker_url: String) -> Self {
        Self {
            broker,
            state,
            broker_url,
            tool_router: Self::tool_router(),
            ws_connected: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            pushed_message_ids: Arc::new(Mutex::new(HashSet::new())),
        }
    }
}

// --- Tool parameter types ---

#[derive(Debug, Deserialize, JsonSchema)]
struct HireWorkerParams {
    #[schemars(description = "Command to run, e.g. 'freecc' or 'claude'")]
    cmd: String,
    #[schemars(description = "Arguments for the command")]
    args: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct SendMessageParams {
    #[schemars(description = "Peer ID to send to")]
    to_id: String,
    #[schemars(description = "Message text")]
    message: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct BroadcastParams {
    #[schemars(description = "Message text to broadcast")]
    message: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct KillAgentParams {
    #[schemars(description = "Agent peer ID to kill")]
    agent_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct CreateChannelParams {
    #[schemars(description = "Channel name to create")]
    name: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct MemoryKeyParams {
    #[schemars(description = "Memory key")]
    key: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct MemorySetParams {
    #[schemars(description = "Memory key")]
    key: String,
    #[schemars(description = "Memory value")]
    value: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct MemoryChannelParams {
    #[schemars(description = "Channel name (defaults to current channel)")]
    channel: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct GetProgressParams {
    #[schemars(description = "Agent peer ID or name to check progress for")]
    agent_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct EmptyParams {}

// --- Tools ---

#[tool_router]
impl MasterMindServer {
    #[tool(
        name = "network_status",
        description = "Get full network status: all landlords with CPU/RAM/disk stats, all agents with roles and status, and all channels."
    )]
    async fn network_status(
        &self,
        _params: Parameters<EmptyParams>,
    ) -> String {
        // Get landlords
        let landlords: Vec<serde_json::Value> = match self.broker.admin_post("/admin/landlords", &serde_json::json!({})).await {
            Ok(v) => v,
            Err(e) => return format!("Error getting landlords: {}", e),
        };

        // Get peers
        let peers: Vec<serde_json::Value> = match self.broker.post("/list-peers", &serde_json::json!({
            "scope": "all", "cwd": ".", "git_root": null
        })).await {
            Ok(v) => v,
            Err(e) => return format!("Error getting peers: {}", e),
        };

        // Get channels
        let channels: Vec<serde_json::Value> = match self.broker.post("/list-channels", &serde_json::json!({})).await {
            Ok(v) => v,
            Err(_) => vec![],
        };

        let mut result = String::new();

        // Landlords
        result.push_str(&format!("=== Landlords ({} connected) ===\n", landlords.len()));
        for l in &landlords {
            let id = l.get("id").and_then(|v| v.as_str()).unwrap_or("?");
            let hostname = l.get("hostname").and_then(|v| v.as_str()).unwrap_or("?");
            let agents = l.get("agents").and_then(|v| v.as_u64()).unwrap_or(0);
            result.push_str(&format!("  {} ({}) — {} agents", hostname, id, agents));
            if let (Some(cpu), Some(ram), Some(disk)) = (
                l.get("cpu_pct").and_then(|v| v.as_f64()),
                l.get("ram_free").and_then(|v| v.as_u64()),
                l.get("disk_free").and_then(|v| v.as_u64()),
            ) {
                result.push_str(&format!(" — CPU {:.0}% · RAM {} free · Disk {} free", cpu, format_bytes(ram), format_bytes(disk)));
            }
            result.push('\n');
        }

        // Agents
        let state = self.state.lock().await;
        let my_id = state.id.as_deref().unwrap_or("");
        result.push_str(&format!("\n=== Agents ({} total) ===\n", peers.len()));
        for p in &peers {
            let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("?");
            let id = p.get("id").and_then(|v| v.as_str()).unwrap_or("?");
            let role = p.get("role").and_then(|v| v.as_str()).unwrap_or("");
            let status = p.get("status").and_then(|v| v.as_str()).unwrap_or("?");
            let channel = p.get("channel").and_then(|v| v.as_str()).unwrap_or("main");
            let harness = p.get("harness").and_then(|v| v.as_str()).unwrap_or("?");
            let summary = p.get("summary").and_then(|v| v.as_str()).unwrap_or("");
            let marker = if id == my_id { " (you)" } else { "" };
            result.push_str(&format!("  {} ({}) [{}] #{} — {} — {}{}\n", name, id, status, channel, harness, role, marker));
            if !summary.is_empty() {
                result.push_str(&format!("    Summary: {}\n", summary));
            }
        }
        drop(state);

        // Channels
        result.push_str(&format!("\n=== Channels ({} total) ===\n", channels.len()));
        for ch in &channels {
            let name = ch.get("name").and_then(|v| v.as_str()).unwrap_or("?");
            let peer_count = ch.get("peers").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
            result.push_str(&format!("  #{} — {} peers\n", name, peer_count));
        }

        result
    }

    #[tool(
        name = "hire_worker",
        description = "Hire a new worker agent. Automatically selects the landlord with the most free resources (lowest CPU, highest free RAM). Returns the agent ID."
    )]
    async fn hire_worker(
        &self,
        Parameters(HireWorkerParams { cmd, args }): Parameters<HireWorkerParams>,
    ) -> String {
        let landlords: Vec<serde_json::Value> = match self.broker.admin_post("/admin/landlords", &serde_json::json!({})).await {
            Ok(v) => v,
            Err(e) => return format!("Error getting landlords: {}", e),
        };

        if landlords.is_empty() {
            return "No landlords connected. Start a landlord first.".to_string();
        }

        // Score landlords: prefer lower CPU, more free RAM, more free disk
        let best = landlords.iter().max_by(|a, b| {
            let score = |l: &serde_json::Value| -> f64 {
                let cpu = l.get("cpu_pct").and_then(|v| v.as_f64()).unwrap_or(50.0);
                let ram = l.get("ram_free").and_then(|v| v.as_u64()).unwrap_or(0) as f64;
                let disk = l.get("disk_free").and_then(|v| v.as_u64()).unwrap_or(0) as f64;
                // Normalize: lower CPU is better, more RAM/disk is better
                (100.0 - cpu) + (ram / 1e9) * 2.0 + (disk / 1e9) * 0.5
            };
            score(a).partial_cmp(&score(b)).unwrap_or(std::cmp::Ordering::Equal)
        });

        let landlord = match best {
            Some(l) => l,
            None => return "No suitable landlord found".to_string(),
        };

        let bridge_id = landlord.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let hostname = landlord.get("hostname").and_then(|v| v.as_str()).unwrap_or("unknown");

        let body = serde_json::json!({
            "bridge_id": bridge_id,
            "cmd": cmd,
            "args": args.unwrap_or_default(),
        });

        match self.broker.admin_post::<serde_json::Value>("/admin/spawn-agent", &body).await {
            Ok(v) => {
                if v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false) {
                    format!("Hired worker on {} ({}) — command: {}", hostname, bridge_id, cmd)
                } else {
                    format!("Spawn failed: {}", v.get("error").and_then(|e| e.as_str()).unwrap_or("unknown error"))
                }
            }
            Err(e) => format!("Error hiring worker: {}", e),
        }
    }

    #[tool(
        name = "send_message",
        description = "Send a message to a specific agent by peer ID."
    )]
    async fn send_message(
        &self,
        Parameters(SendMessageParams { to_id, message }): Parameters<SendMessageParams>,
    ) -> String {
        let state = self.state.lock().await;
        let my_id = match &state.id {
            Some(id) => id.clone(),
            None => return "Not registered yet".to_string(),
        };
        drop(state);

        let body = serde_json::json!({ "from_id": my_id, "to_id": to_id, "text": message });
        match self.broker.post::<serde_json::Value>("/send-message", &body).await {
            Ok(v) if v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false) =>
                format!("Message sent to {}", to_id),
            Ok(v) => format!("Failed: {}", v.get("error").and_then(|e| e.as_str()).unwrap_or("unknown")),
            Err(e) => format!("Error: {}", e),
        }
    }

    #[tool(
        name = "broadcast_message",
        description = "Broadcast a message to all agents in your current channel."
    )]
    async fn broadcast_message(
        &self,
        Parameters(BroadcastParams { message }): Parameters<BroadcastParams>,
    ) -> String {
        let state = self.state.lock().await;
        let my_id = match &state.id {
            Some(id) => id.clone(),
            None => return "Not registered yet".to_string(),
        };
        let channel = state.channel.clone();
        drop(state);

        // Get peers in channel
        let peers: Vec<serde_json::Value> = match self.broker.post("/list-peers", &serde_json::json!({
            "scope": "channel", "cwd": ".", "git_root": null, "exclude_id": my_id
        })).await {
            Ok(v) => v,
            Err(e) => return format!("Error listing peers: {}", e),
        };

        let mut sent = 0;
        for p in &peers {
            let pid = p.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if pid.is_empty() { continue; }
            let body = serde_json::json!({ "from_id": my_id, "to_id": pid, "text": message });
            if self.broker.post::<serde_json::Value>("/send-message", &body).await.is_ok() {
                sent += 1;
            }
        }
        format!("Broadcast to {} peers in #{}", sent, channel)
    }

    #[tool(
        name = "check_messages",
        description = "Check for new messages from other agents (e.g. Master-role agents reporting progress)."
    )]
    async fn check_messages(
        &self,
        _params: Parameters<EmptyParams>,
    ) -> String {
        let mut state = self.state.lock().await;
        let my_id = state.id.clone();
        let messages: Vec<serde_json::Value> = state.messages.drain(..).collect();
        drop(state);

        // Also poll broker for any missed messages
        let id = match my_id {
            Some(id) => id,
            None => return "Not registered yet".to_string(),
        };
        let poll: Vec<serde_json::Value> = self.broker.post("/peek-messages", &serde_json::json!({ "id": id }))
            .await.unwrap_or_default();

        let pushed = self.pushed_message_ids.lock().await;
        let mut new_poll: Vec<serde_json::Value> = poll.into_iter()
            .filter(|m| {
                let mid = m.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
                !pushed.contains(&mid)
            })
            .collect();
        drop(pushed);

        let all: Vec<serde_json::Value> = [messages, new_poll].concat();
        if all.is_empty() {
            return "No new messages.".to_string();
        }

        let mut result = format!("{} new message(s):\n\n", all.len());
        for msg in &all {
            let from = msg.get("from_id").and_then(|v| v.as_str()).unwrap_or("?");
            let from_name = msg.get("from_name").and_then(|v| v.as_str()).unwrap_or(from);
            let text = msg.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let sent_at = msg.get("sent_at").and_then(|v| v.as_str()).unwrap_or("");
            result.push_str(&format!("[{}] {} ({}):\n{}\n\n", sent_at, from_name, from, text));
        }
        result
    }

    #[tool(
        name = "list_channels",
        description = "List all channels and their members."
    )]
    async fn list_channels(
        &self,
        _params: Parameters<EmptyParams>,
    ) -> String {
        match self.broker.post::<Vec<serde_json::Value>>("/list-channels", &serde_json::json!({})).await {
            Ok(channels) => {
                if channels.is_empty() { return "No channels.".to_string(); }
                let mut result = format!("Channels ({}):\n", channels.len());
                for ch in &channels {
                    let name = ch.get("name").and_then(|v| v.as_str()).unwrap_or("?");
                    let empty_peers: Vec<serde_json::Value> = vec![];
                    let peers = ch.get("peers").and_then(|v| v.as_array()).unwrap_or(&empty_peers);
                    result.push_str(&format!("  #{} — {} peers\n", name, peers.len()));
                    for p in peers {
                        let pname = p.get("name").and_then(|v| v.as_str()).unwrap_or("?");
                        let role = p.get("role").and_then(|v| v.as_str()).unwrap_or("");
                        let status = p.get("status").and_then(|v| v.as_str()).unwrap_or("?");
                        result.push_str(&format!("    {} [{}] — {}\n", pname, status, role));
                    }
                }
                result
            }
            Err(e) => format!("Error: {}", e),
        }
    }

    #[tool(
        name = "create_channel",
        description = "Create a new channel."
    )]
    async fn create_channel(
        &self,
        Parameters(CreateChannelParams { name }): Parameters<CreateChannelParams>,
    ) -> String {
        match self.broker.admin_post::<serde_json::Value>("/create-channel", &serde_json::json!({ "name": name })).await {
            Ok(v) => format!("Channel #{} created: {:?}", name, v),
            Err(e) => format!("Error: {}", e),
        }
    }

    #[tool(
        name = "get_agent_progress",
        description = "Read an agent's progress from shared channel memory. Checks worker-status-{agent_id} key."
    )]
    async fn get_agent_progress(
        &self,
        Parameters(GetProgressParams { agent_id }): Parameters<GetProgressParams>,
    ) -> String {
        let state = self.state.lock().await;
        let channel = state.channel.clone();
        drop(state);

        let key = format!("worker-status-{}", agent_id);
        match self.broker.post::<serde_json::Value>("/memory-get", &serde_json::json!({
            "channel": channel, "key": key
        })).await {
            Ok(v) => {
                let value = v.get("value").and_then(|v| v.as_str()).unwrap_or("No status found");
                format!("Progress for {}:\n{}", agent_id, value)
            }
            Err(e) => format!("Error: {}", e),
        }
    }

    #[tool(
        name = "kill_agent",
        description = "Kill an agent by peer ID. Sends kill command to the agent's landlord."
    )]
    async fn kill_agent(
        &self,
        Parameters(KillAgentParams { agent_id }): Parameters<KillAgentParams>,
    ) -> String {
        // Find the agent's bridge_id via list-peers
        let peers: Vec<serde_json::Value> = match self.broker.post("/list-peers", &serde_json::json!({
            "scope": "all", "cwd": ".", "git_root": null
        })).await {
            Ok(v) => v,
            Err(e) => return format!("Error finding agent: {}", e),
        };

        let agent = peers.iter().find(|p| {
            p.get("id").and_then(|v| v.as_str()).unwrap_or("") == agent_id
        });

        let agent = match agent {
            Some(a) => a,
            None => return format!("Agent {} not found", agent_id),
        };

        let bridge_id = agent.get("bridge_id").and_then(|v| v.as_str()).unwrap_or("");
        if bridge_id.is_empty() {
            // Direct peer, use remove-peer
            match self.broker.admin_post::<serde_json::Value>("/admin/remove-peer", &serde_json::json!({ "peer_id": agent_id })).await {
                Ok(v) => format!("Agent removed: {:?}", v),
                Err(e) => format!("Error: {}", e),
            }
        } else {
            match self.broker.admin_post::<serde_json::Value>("/admin/kill-agent", &serde_json::json!({
                "bridge_id": bridge_id, "session_id": agent_id
            })).await {
                Ok(v) => format!("Kill command sent: {:?}", v),
                Err(e) => format!("Error: {}", e),
            }
        }
    }

    #[tool(
        name = "list_memory",
        description = "List all memory keys in the current channel."
    )]
    async fn list_memory(
        &self,
        Parameters(MemoryChannelParams { channel }): Parameters<MemoryChannelParams>,
    ) -> String {
        let state = self.state.lock().await;
        let ch = channel.unwrap_or_else(|| state.channel.clone());
        drop(state);

        match self.broker.post::<serde_json::Value>("/memory-list", &serde_json::json!({ "channel": ch })).await {
            Ok(v) => {
                let empty_entries: Vec<serde_json::Value> = vec![];
                let entries = v.get("entries").and_then(|v| v.as_array()).unwrap_or(&empty_entries);
                if entries.is_empty() { return format!("No memory keys in #{}", ch); }
                let mut result = format!("Memory in #{} ({} keys):\n", ch, entries.len());
                for e in entries {
                    let key = e.get("key").and_then(|v| v.as_str()).unwrap_or("?");
                    let size = e.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                    let by = e.get("written_by").and_then(|v| v.as_str()).unwrap_or("?");
                    result.push_str(&format!("  {} ({}B by {})\n", key, size, by));
                }
                result
            }
            Err(e) => format!("Error: {}", e),
        }
    }

    #[tool(
        name = "get_memory",
        description = "Get a value from shared channel memory."
    )]
    async fn get_memory(
        &self,
        Parameters(MemoryKeyParams { key }): Parameters<MemoryKeyParams>,
    ) -> String {
        let state = self.state.lock().await;
        let channel = state.channel.clone();
        drop(state);

        match self.broker.post::<serde_json::Value>("/memory-get", &serde_json::json!({
            "channel": channel, "key": key
        })).await {
            Ok(v) => {
                let value = v.get("value").and_then(|v| v.as_str()).unwrap_or("(not found)");
                format!("{}: {}", key, value)
            }
            Err(e) => format!("Error: {}", e),
        }
    }

    #[tool(
        name = "set_memory",
        description = "Set a key-value pair in shared channel memory."
    )]
    async fn set_memory(
        &self,
        Parameters(MemorySetParams { key, value }): Parameters<MemorySetParams>,
    ) -> String {
        let state = self.state.lock().await;
        let my_id = match &state.id {
            Some(id) => id.clone(),
            None => return "Not registered yet".to_string(),
        };
        let channel = state.channel.clone();
        drop(state);

        match self.broker.post::<serde_json::Value>("/memory-set", &serde_json::json!({
            "channel": channel, "key": key, "value": value, "peer_id": my_id
        })).await {
            Ok(_) => format!("Set {} ({} bytes) in #{}", key, value.len(), channel),
            Err(e) => format!("Error: {}", e),
        }
    }
}

#[tool_handler]
impl ServerHandler for MasterMindServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder().enable_tools().build(),
        )
        .with_server_info(Implementation::new("master-mind", "0.1.0"))
        .with_instructions(
            "You are the Master Mind — the central controller of the Agent Hive network.\n\n\
             Your role is to:\n\
             1. Monitor the network via `network_status` — see landlords, agents, resources\n\
             2. Hire workers via `hire_worker` — it auto-selects the best landlord based on free resources\n\
             3. Assign tasks by sending messages to Master-role agents via `send_message`\n\
             4. Track progress via `get_agent_progress` and `check_messages`\n\
             5. Create channels for task isolation via `create_channel`\n\
             6. Share plans and status via `set_memory` / `get_memory`\n\
             7. Kill stuck agents via `kill_agent`\n\n\
             Start by calling `network_status` to see what's available."
        )
    }
}

// --- Main ---

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let broker_url = env::var("HIVE_HOST").unwrap_or_else(|_| "http://127.0.0.1:7899".to_string());
    let master_key = read_master_key();

    if master_key.is_none() {
        return Err("No master key found. Set ~/.agent-hive.key or AGENT_HIVE_TOKEN env var.".into());
    }

    let broker = Arc::new(BrokerClient::new(broker_url.clone(), master_key.clone()));

    if !broker.health_check().await {
        return Err(format!("Broker at {} not reachable", broker_url).into());
    }
    log("Broker reachable");

    let my_hostname = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    // Register as a peer
    let reg_body = serde_json::json!({
        "name": "master-mind",
        "pid": std::process::id(),
        "cwd": ".",
        "git_root": serde_json::Value::Null,
        "tty": serde_json::Value::Null,
        "harness": "master-mind",
        "hostname": my_hostname,
        "summary": "Central network controller",
    });

    let reg: serde_json::Value = broker
        .post("/register", &reg_body)
        .await
        .map_err(|e| format!("Failed to register: {}", e))?;

    let peer_id = reg.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let token = reg.get("token").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let channel = reg.get("channel").and_then(|v| v.as_str()).unwrap_or("main").to_string();

    log(&format!("Registered as peer {} in #{}", peer_id, channel));
    broker.set_token(token.clone()).await;

    // Since we have the master key, auto-approve ourselves
    let auth: serde_json::Value = broker.post("/auth/status", &serde_json::json!({ "token": token })).await.unwrap_or_default();
    let status = auth.get("status").and_then(|v| v.as_str()).unwrap_or("unknown");
    log(&format!("Auth status: {}", status));

    let state = Arc::new(Mutex::new(MasterMindState {
        id: Some(peer_id.clone()),
        name: "master-mind".to_string(),
        channel: channel.clone(),
        messages: vec![],
    }));

    // Spawn WS connection for push delivery
    let ws_state = state.clone();
    let ws_broker_url = broker_url.replace("http://", "ws://").replace("https://", "wss://");
    tokio::spawn(async move {
        let mut backoff = Duration::from_secs(1);
        loop {
            let url = format!("{}/ws/agent?token={}", ws_broker_url, token);
            match connect_ws(&url).await {
                Ok(ws_stream) => {
                    backoff = Duration::from_secs(1);
                    let (_sink, mut rx) = ws_stream.split();
                    while let Some(msg) = rx.next().await {
                        match msg {
                            Ok(tokio_tungstenite::tungstenite::Message::Text(text)) => {
                                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
                                    let msg_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
                                    if msg_type == "message" {
                                        let mut s = ws_state.lock().await;
                                        s.messages.push(parsed);
                                    }
                                }
                            }
                            Ok(tokio_tungstenite::tungstenite::Message::Close(_)) => break,
                            Err(_) => break,
                            _ => {}
                        }
                    }
                }
                Err(e) => {
                    log(&format!("WS connect failed: {}", e));
                }
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(30));
        }
    });

    // Heartbeat
    let hb_broker = broker.clone();
    let hb_id = peer_id.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        loop {
            interval.tick().await;
            let body = serde_json::json!({ "id": hb_id });
            let _ = hb_broker.post::<serde_json::Value>("/heartbeat", &body).await;
        }
    });

    // Run MCP server
    let server = MasterMindServer::new(broker, state, broker_url);
    let (stdin, stdout) = rmcp::transport::stdio();
    log("Starting MCP server...");
    let running = server.serve((stdin, stdout)).await?;
    running.waiting().await?;

    Ok(())
}

async fn connect_ws(url: &str) -> Result<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, String> {
    let mut request = url.to_string().into_client_request().map_err(|e| e.to_string())?;
    let headers = request.headers_mut();
    headers.remove("Sec-WebSocket-Extensions");
    let mut config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
    config.max_message_size = Some(16 * 1024 * 1024);
    let (ws, _) = tokio_tungstenite::connect_async_with_config(request, Some(config), false).await.map_err(|e| e.to_string())?;
    Ok(ws)
}
