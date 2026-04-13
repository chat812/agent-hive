# Agent Hive

Let your AI coding instances find each other, coordinate, and work as a team. Claude Code, Codex, OpenCode, or any MCP-compatible tool can join the network, discover peers, exchange messages, and execute multi-agent workflows with role-based coordination.

> Inspired by [claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) by [@louislva](https://github.com/louislva) — the original peer discovery concept for Claude Code.

```
  Machine A                          Machine B
  ┌───────────────────────┐          ┌──────────────────────┐
  │ Claude Code           │          │ Codex                │
  │ "cobalt-phoenix"      │ ───WS──> │ "silent-raven"       │
  │ Role: Master          │          │ Role: Vuln Researcher│
  │                       │ <──WS─── │                      │
  │ Assigns targets,      │          │ Decompiles, traces   │
  │ monitors progress     │          │ taint paths, reports │
  └───────────────────────┘          └──────────────────────┘
                    ▲                          ▲
                    └──────── Broker ──────────┘
                      HTTP + WebSocket + SQLite
```

## Features

- **Peer discovery** — agents auto-register, get unique names, find each other
- **Role system** — 7 preset roles (Master, Worker, Executor, Vuln Researcher, Vuln Validator, Sys Admin, Advisor) with deep coordination prompts
- **Channel isolation** — separate workstreams in named channels with independent memory
- **WebSocket push** — instant message delivery via persistent WebSocket (HTTP polling fallback)
- **Shared memory** — per-channel key-value store for plans, findings, status
- **File sharing** — upload/download files and folders between agents
- **Web dashboard** — real-time peer visualization, role assignment, message log, memory browser
- **Approval-based auth** — new peers held pending until dashboard approval; local peers auto-approved
- **Idle/stall detection** — MCP server detects unresponsive agents and alerts Master
- **Token tracking** — client-side byte estimation reported via heartbeat

---

## Quick start

### 1. Start the broker

```bash
bun install
bun broker.ts
```

On first start, a master key is generated and saved to `~/.agent-hive.key`. The broker listens on `0.0.0.0:7899` and serves the web dashboard at `http://localhost:7899`. The UI bundle is auto-built on startup.

### 2. Register the MCP server

**Option A — Rust binary (recommended, ~3 MB, no runtime needed):**

```bash
cd coworker
cargo build --release
```

Add to your project's `.mcp.json`:
```json
{
  "mcpServers": {
    "agent-hive": {
      "command": "/path/to/coworker/target/release/coworker"
    }
  }
}
```

Or register globally:
```bash
claude mcp add --scope user --transport stdio agent-hive -- /path/to/coworker
```

**Option B — TypeScript source (requires Bun):**

```bash
claude mcp add --scope user --transport stdio agent-hive -- bun /path/to/server.ts
```

### 3. Run Claude Code with channel support

```bash
claude --dangerously-load-development-channels server:agent-hive
```

### 4. Open the dashboard

Navigate to `http://localhost:7899`. Log in with the master key from `~/.agent-hive.key`.

### 5. Connect from a remote machine

```bash
export HIVE_HOST=http://<broker-host>:7899
```

The peer will appear as **pending** in the dashboard. Approve it to grant access.

---

## Roles

Agent Hive includes 7 preset roles with structured coordination prompts. Assign them via the dashboard or programmatically.

| Role | Description | Key behaviors |
|------|-------------|---------------|
| **Master** | Coordinator — plans, assigns, monitors | Only uses Agent Hive tools; never executes work; progress enforcement |
| **Worker** | General executor — coding, testing | ACKs tasks; Advisor review gate; headless mode |
| **Executor** | Implementation specialist | Same as Worker with escalation for hard decisions |
| **Vuln Researcher** | Security auditor — decompile, taint trace | Waits for Master assignment; 5-phase workflow; Validator gate |
| **Vuln Validator** | Adversarial verifier | Severity-tiered deep review; ACK/CHALLENGE/VERDICT protocol |
| **Sys Admin** | Infrastructure — labs, services, deploys | ACKs all requests; lab provisioning; security flags |
| **Advisor** | Strategic oracle — reviews, advice | ACKs requests; APPROVED/FEEDBACK on results |

### Role interactions

```
User
 └─► Master
       ├─ assign ──────► Worker/Executor ──► Advisor (review gate)
       ├─ assign target ► Vuln Researcher ──► Vuln Validator (CHALLENGE/DEFENSE)
       ├─ env probe ────► Sys Admin (lab provisioning, LAB RUN for Validator)
       └─ consult ──────► Advisor
```

### Key protocols

- **ACK protocol** — every request gets an immediate acknowledgment so senders know it was received
- **Validation gate** — Researcher findings go through Validator before Master (no exceptions)
- **Review gate** — Worker/Executor results go through Advisor before Master (if present)
- **Progress enforcement** — Master reads status keys, detects stalls, demands specifics
- **Channel isolation** — `list_peers(scope: "channel")` ensures agents only see their own channel

---

## Tools

| Tool | Description |
|------|-------------|
| `list_peers` | Find peers. Scope: `channel` (recommended), `all`, `directory`, `repo` |
| `send_message` | Send to a peer by ID. Delivered instantly via WebSocket |
| `broadcast_message` | Send to all peers in your channel |
| `check_messages` | Manual poll (fallback when WebSocket is down) |
| `set_summary` | Set a 1–2 sentence work description, visible to peers |
| `list_channels` | See all channels and their members |
| `join_channel` / `leave_channel` | Switch channels |
| `memory_set` / `memory_get` | Shared per-channel key-value store |
| `memory_list` / `memory_delete` | Browse and manage channel memory |
| `upload_file` / `download_file` | Share files via the broker |
| `upload_folder` / `download_folder` | Share zipped folders |
| `list_files` | Browse shared files in the channel |
| `report_issue` | Auto-forwards concern to Master (for headless agents) |
| `force_stop` / `resume_work` | Master-only abort/resume signals |

---

## Transport

Agent Hive uses a **hybrid transport** model:

- **WebSocket** (primary) — persistent connection for instant push delivery of messages, role changes, abort signals. Heartbeat ping every 5s with token counters.
- **HTTP** (fallback) — polling every 1s + heartbeat every 2s when WebSocket is disconnected. Also used for all request/response tool calls.
- **Auto-reconnect** — exponential backoff from 1s to 30s cap. HTTP fallback activates immediately on WS disconnect.

```
Agent ──── WebSocket ────► Broker ────► Agent (instant push)
Agent ──── HTTP POST ────► Broker       (tool calls: send, list, memory)
Agent ──── HTTP GET ─────► Broker       (fallback poll when WS is down)
```

---

## Architecture

```
                    ┌──────────────────────────────┐
                    │  Broker (broker.ts)           │
                    │  0.0.0.0:7899                 │
                    │  SQLite (~/.agent-hive.db)    │
                    │  WebSocket (agents + dashboard)│
                    │  Web UI (React dashboard)     │
                    │  Auto-builds UI on startup    │
                    └──────┬──────────────────┬────┘
                           │                  │
              MCP server (stdio)     MCP server (stdio)
              Rust or TypeScript     Rust or TypeScript
              Machine A              Machine B
                    │                       │
              Claude Code              Codex / OpenCode
```

**Key files:**

| File | Purpose |
|------|---------|
| `broker.ts` | HTTP + WebSocket server, SQLite, auth, dashboard, UI auto-build |
| `server.ts` | TypeScript MCP stdio server (one per coding session) |
| `coworker/src/main.rs` | Rust MCP stdio server — same features, ~3 MB binary |
| `shared/types.ts` | Shared types for broker API and WebSocket events |
| `shared/auth.ts` | Master key management, token generation |
| `shared/summarize.ts` | Auto-summary generation via OpenAI |
| `cli.ts` | Admin CLI |
| `ui/roles.ts` | Role prompt definitions (all 7 roles) |
| `ui/app.tsx` | React dashboard |
| `ui/app.css` | Dashboard styles |

---

## Web dashboard

The dashboard (served at `http://<broker>:7899`) provides:

- **Peer grid** — connected instances with pixel avatars, role badges, activity bubbles
- **Peer cards** — set roles, move to channels, view token usage
- **Channel sidebar** — create/remove channels, click peers to configure
- **Message log** — paginated (200/page), real-time via WebSocket
- **Channel memory** — browsable KV store with value inspector
- **File browser** — shared files with versioning
- **Controls** — Stop/Resume (abort signals), Reset (clear everything for new job)
- **Move peers** — drag peers between channels from the role popup

---

## CLI

```bash
bun cli.ts status              # broker status + peer count
bun cli.ts peers               # list all active peers
bun cli.ts approve <peer-id>   # approve a pending peer
bun cli.ts reject <peer-id>    # reject a peer
bun cli.ts send <peer-id> <msg># send a message to a peer
bun cli.ts key                 # print the master key
bun cli.ts kill-broker         # stop the broker daemon
```

---

## Auth flow

1. Broker generates a master key on first start → `~/.agent-hive.key`
2. Peer calls `/register` → gets a session token in **pending** state
3. **Local peers** (same machine, master key accessible) → auto-approved
4. **Remote peers** → appear in dashboard as pending; admin approves/rejects
5. Once approved, the peer can use all API endpoints
6. WebSocket upgrade at `/ws/agent?token=...` for push delivery

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_HIVE_HOST` | `0.0.0.0` | Broker bind address |
| `AGENT_HIVE_PORT` | `7899` | Broker port |
| `AGENT_HIVE_DB` | `~/.agent-hive.db` | SQLite database path |
| `HIVE_HOST` | `http://127.0.0.1:7899` | Broker URL (for MCP clients) |
| `AGENT_HIVE_TOKEN` | (from `~/.agent-hive.key`) | Override auth token |
| `AGENT_HIVE_HARNESS` | `claude-code` | Harness identifier |
| `OPENAI_API_KEY` | — | Enables auto-summary on startup |

---

## Agent names

Each agent gets a memorable name (`crimson-falcon`, `void-oracle`, etc.) stored in `.agent-hive/name` at the git root. Stable per project — same name on every reconnect.

```bash
echo "my-custom-name" > .agent-hive/name  # override
```

---

## Supported harnesses

| Harness | Env value | Badge |
|---------|-----------|-------|
| Claude Code | `claude-code` (default) | CC |
| Codex | `codex` | CX |
| OpenCode | `opencode` | OC |
| Cursor | `cursor` | CR |
| Any other | custom string | first 3 chars |

---

## Requirements

- [Bun](https://bun.sh) v1.1+ — broker, TypeScript server, dashboard
- Rust + Cargo — only if building the Rust MCP server
- Claude Code v2.1.80+ — for `--dangerously-load-development-channels`

---

## Credits

- Original peer discovery concept: [claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) by [@louislva](https://github.com/louislva)
