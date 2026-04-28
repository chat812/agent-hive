# Agent Hive

Let your AI coding instances find each other, coordinate, and work as a team. Claude Code, Codex, OpenCode, or any MCP-compatible tool can join the network, discover peers, exchange messages, and execute multi-agent workflows with role-based coordination.

> Inspired by [claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) by [@louislva](https://github.com/louislva) — the original peer discovery concept for Claude Code.

```
  Machine A                                          Machine B
  ┌───────────────────────┐                          ┌──────────────────────┐
  │ Claude Code           │                          │ Codex                │
  │ "cobalt-phoenix"      │                          │ "silent-raven"       │
  │ Role: Master          │                          │ Role: Vuln Researcher│
  └──────────┬────────────┘                          └──────────┬───────────┘
             │ WS + HTTP                                        │ WS + HTTP
             ▼                                                  ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │                        Broker (broker.ts)                              │
  │                  HTTP + WebSocket + SQLite + Dashboard                 │
  │                                                                       │
  │  Routes messages, manages channels, stores memory, pushes events      │
  │  Routes terminal I/O between landlords and dashboard                  │
  └───────────────────┬──────────────────────┬────────────────────────────┘
                      │                      │
            ┌─────────▼──────────┐  ┌───────▼───────────┐
            │  Landlord (Rust)   │  │  Landlord (Rust)  │
            │  Machine A         │  │  Machine B        │
            │  PTY → xterm.js    │  │  PTY → xterm.js   │
            │  Local gateway     │  │  Local gateway    │
            └────────────────────┘  └───────────────────┘
```

## Features

- **Peer discovery** — agents auto-register, get unique names, find each other
- **Role system** — 7 preset roles (Master, Worker, Executor, Vuln Researcher, Vuln Validator, Sys Admin, Advisor) with deep coordination prompts
- **Channel isolation** — separate workstreams in named channels with independent memory
- **WebSocket push** — instant message delivery via persistent WebSocket (HTTP polling fallback)
- **Shared memory** — per-channel key-value store for plans, findings, status
- **File sharing** — upload/download files and folders between agents, with versioning and SHA-256 verification
- **Web dashboard** — real-time peer visualization, role assignment, message log with markdown rendering, memory browser
- **Live terminals** — landlord spawns agents with PTYs, terminal output buffered and streamed to xterm.js panels in the dashboard (tab or grid view, drag-and-drop reorder, rename)
- **Stale & zombie detection** — terminals with no output for 60s flagged as stale; agents whose landlord is disconnected auto-cleaned
- **Budget system** — per-role credit pricing, running cost tracking, budget cap enforced on hire
- **Approval-based auth** — new peers held pending until dashboard approval; local peers auto-approved; landlord mutual key authentication for reconnects
- **Idle/stall detection** — MCP server detects unresponsive agents (30s nudge, 60s Master alert)
- **Token tracking** — client-side byte estimation reported via heartbeat
- **Landlord metrics** — CPU, RAM, and disk usage reported every 5s per landlord
- **Hire Worker from Master role** — Master agent can hire workers on the best available landlord via `hire_worker` tool
- **Spawn allowlisting** — only approved commands (`claude`, `codex`, `opencode`, `cursor`, `bun`, `node`) can be spawned on landlords
- **Channel reset** — full reset clears memory, undelivered messages, and abort flag for a channel

---

## Quick start

### 1. Start the broker

```bash
bun install
bun broker.ts
```

On first start, a master key is generated and saved to `~/.agent-hive.key`. The broker listens on `0.0.0.0:7899` and serves the web dashboard at `http://localhost:7899`. The UI bundle is auto-built on startup.

### 2. Register the MCP server

The landlord auto-detects the coworker binary and auto-configures the MCP server globally in `~/.freecc.json`. No manual setup is needed — just build the binary and start the landlord (step 5).

To register manually:

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

### 6. Start a landlord (optional — for live terminals)

The landlord is a Rust binary that runs on each machine. It connects to the broker, spawns agent processes with PTYs, and streams their terminal output to the dashboard.

```bash
cd bridge && cargo build --release
./target/release/agent-hive-landlord
```

The landlord reads the master key from `~/.agent-hive.key` automatically. Set `HIVE_HOST` if the broker is remote:

```bash
export HIVE_HOST=http://<broker-host>:7899
export AGENT_HIVE_TOKEN=<master-key>
```

On first connection, the landlord registers with the broker and appears as **pending** in the dashboard. Once approved, a mutual key is issued and saved to `~/.agent-hive-landlord.key` for automatic reconnection without re-approval. If rejected, identity files are deleted and the landlord exits.

Once connected, click **Hire Worker** in the dashboard header to spawn an agent. Select a landlord, enter a command (e.g. `claude`, `cmd.exe`, `bash`), and a live terminal panel appears below the messages section.

The Master role agent can also hire workers programmatically via the `hire_worker` tool, which auto-selects the landlord with the most free resources.

### Landlord CLI

When running interactively (stdin open), the landlord accepts these commands:

```
spawn <command> [args...]   # Spawn an agent process (e.g. spawn claude)
kill <agent-id>             # Kill a running agent
list                        # List all running agents with IDs and PIDs
status                      # Show bridge ID and agent count
quit / exit                 # Graceful shutdown (kills all agents)
```

When stdin is closed (running as a service/daemon), the landlord enters a passive polling loop — it keeps agents running and reports stats, but doesn't accept commands. Agent lifecycle is then managed via the dashboard or the Master agent's `hire_worker`/`kill_agent` tools.

### Landlord CLI flags

```
agent-hive-landlord [OPTIONS]

Options:
  --host <url>         Broker URL (overrides HIVE_HOST env var)
  --coworker <path>    Path to coworker binary (auto-detected if not set)
```

### Landlord file artifacts

| File | Purpose |
|------|---------|
| `~/.agent-hive-landlord-id` | Persistent landlord identity (8-hex UUID) |
| `~/.agent-hive-landlord.key` | Mutual key for broker reconnection (issued on approval) |
| `~/.freecc.json` | Auto-configured MCP server entry for the coworker binary |

---

## Roles

Agent Hive includes 7 preset roles with structured coordination prompts. Assign them via the dashboard, the `assign_role` tool, or the CLI.

| Role | Description | Key behaviors |
|------|-------------|---------------|
| **Master** | Coordinator — plans, assigns, monitors | Only uses Agent Hive tools; never executes work; hires workers, assigns roles; progress enforcement; credit cost tracking |
| **Worker** | General executor — coding, testing | ACKs tasks; Advisor review gate; headless mode |
| **Executor** | Implementation specialist | Same as Worker with escalation for architectural decisions |
| **Vuln Researcher** | Security auditor — decompile, taint trace | Waits for Master assignment; 5-phase workflow (recon → lab → decompile → taint trace → report); Validator gate |
| **Vuln Validator** | Adversarial verifier | Severity-tiered deep review; ACK/CHALLENGE/DEFENSE/VERDICT protocol; max 3 rounds |
| **Sys Admin** | Infrastructure — labs, services, deploys | ACKs all requests; lab provisioning; security flags; idempotent execution |
| **Advisor** | Strategic oracle — reviews, advice | ACKs requests; APPROVED/FEEDBACK on results; max 2 consultations per task before escalating to Master |

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

The Rust coworker binary exposes 23 MCP tools. The TypeScript server exposes a core subset (12 tools). Tools marked **Rust only** are available in the coworker binary but not in `server.ts`.

| Tool | Description | Rust only |
|------|-------------|-----------|
| `list_peers` | Find peers. Scope: `channel` (recommended), `all`, `network`, `directory`, `repo` | |
| `send_message` | Send to a peer by ID. Delivered instantly via WebSocket | |
| `broadcast_message` | Send to all peers in your channel | ✓ |
| `check_messages` | Manual poll (fallback when WebSocket is down) | |
| `set_summary` | Set a 1–2 sentence work description, visible to peers | |
| `list_channels` | See all channels and their members | |
| `join_channel` / `leave_channel` | Switch channels | |
| `memory_set` / `memory_get` | Shared per-channel key-value store | |
| `memory_list` / `memory_delete` | Browse and manage channel memory | |
| `upload_file` / `download_file` | Share files via the broker (versioned, SHA-256) | ✓ |
| `upload_folder` / `download_folder` | Share zipped folders | ✓ |
| `list_files` | Browse shared files in the channel | ✓ |
| `report_issue` | Auto-forwards concern to Master (for headless agents) | ✓ |
| `force_stop` / `resume_work` | Master-only abort/resume signals | ✓ |
| `hire_worker` | Master-only: spawn an agent on the best available landlord | ✓ |
| `kill_agent` | Master-only: kill a stuck agent by peer ID | ✓ |
| `assign_role` | Assign a role to an agent by peer ID (requires master key) | ✓ |
| `set_channel` | Move an agent to a different channel by peer ID (requires master key) | ✓ |

---

## Budget system

Agent Hive tracks a credit budget for agent costs. Each role has a per-hour price. When the Master hires a worker, the system checks that the running cost plus the new agent's cost stays within the total budget.

- **Total budget** — set via the dashboard or `/budget/set` API
- **Per-role prices** — configurable via the dashboard or `/budget/set-prices` API
- **Running cost** — automatically calculated from active agents
- **Budget bar** — displayed in the dashboard header, clickable to open budget settings

The `hire_worker` tool performs a pre-flight budget check. If the hire would exceed the budget, it is rejected with a message.

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

### Landlord transport

Landlords connect via a dedicated WebSocket (`/ws/landlord?token=...&bridge_id=...`) and multiplex all terminal I/O for their agents over a single connection:

```
Dashboard ──WS──► Broker ──WS──► Landlord ──PTY──► Agent process
   xterm.js       (routes)      (spawns)      (terminal I/O)
```

- **Terminal output**: PTY → hex-encoded JSON → landlord WS → broker → broadcast to dashboards → `xterm.write()`
- **Terminal input**: `xterm.onData()` → dashboard WS → broker → landlord WS → PTY writer
- **Resize**: `ResizeObserver` → dashboard WS → broker → landlord WS → PTY resize
- **Terminal buffer**: up to 3000 chunks (~500KB) buffered per session for dashboard reconnect replay
- Landlord agents are auto-approved and kept alive by broker ping (every 5s)
- Each landlord also runs a local HTTP gateway on port 17900 for coworker MCP servers
- Landlords report system metrics (CPU, RAM, disk) + live agent IDs every 5s to the broker
- **Landlord auth**: three modes — master key (legacy), mutual key (returning, persisted in `~/.agent-hive-landlord.key`), or new registration (pending approval)
- **Process tree kill**: on Windows uses `taskkill /T /F` for full tree termination; on Unix uses process group signaling
- **Agent re-registration**: after broker reconnect, all still-running agents are automatically re-registered

---

## Architecture

```
                    ┌──────────────────────────────┐
                    │  Broker (broker.ts)           │
                    │  0.0.0.0:7899                 │
                    │  SQLite (~/.agent-hive.db)    │
                    │  WebSocket (agents + landlords │
                    │    + dashboard)               │
                    │  Web UI (React + xterm.js)    │
                    │  Auto-builds UI on startup    │
                    │  Budget tracking              │
                    │  Zombie/stale detection       │
                    └──────┬──────────────────┬────┘
                           │                  │
              MCP server (stdio)     Landlord (Rust binary)
              Rust or TypeScript     Spawns PTYs, streams I/O
              Reports metrics/5s     Auto-configures MCP
              Idle/stall detection   Mutual key auth
                    │                       │
              Claude Code              Codex / OpenCode
```

**Key files:**

| File | Purpose |
|------|---------|
| `broker.ts` | HTTP + WebSocket server, SQLite, auth, dashboard, landlord routing, UI auto-build, budget, zombie detection |
| `server.ts` | TypeScript MCP stdio server (one per coding session) — core 12 tools |
| `coworker/src/main.rs` | Rust MCP stdio server — full 23 tools, idle/stall detection, token tracking |
| `bridge/` | Rust landlord binary — PTY spawn, terminal I/O, system metrics, local HTTP gateway, mutual key auth |
| `shared/types.ts` | Shared types for broker API, WebSocket events, budget info |
| `shared/auth.ts` | Master key management, token generation |
| `shared/summarize.ts` | Auto-summary generation via OpenAI (TypeScript server only) |
| `cli.ts` | Admin CLI |
| `ui/roles.ts` | Role prompt definitions (all 7 roles) |
| `ui/app.tsx` | React dashboard with xterm.js terminal panels, budget bar, drag-and-drop |
| `ui/app.css` | Dashboard styles |

---

## Web dashboard

The dashboard (served at `http://<broker>:7899`) provides:

- **Login screen** — master key authentication with session persistence
- **Peer grid** — connected instances with deterministic color-coded pixel avatars, role emoji badges, activity state bubbles (thinking/working/idle/offline)
- **Peer cards** — set roles (7 preset buttons + custom prompt textarea), move to channels, view token usage, remove from channel/network
- **Channel sidebar** — create/remove channels, expand to see members, click to open role popup
- **Landlords panel** — view connected landlords with CPU/RAM/disk stats, approve/reject pending landlords
- **Message log** — paginated (200/page), real-time via WebSocket, markdown rendering (`marked` + `DOMPurify`), new message highlight animation, clear all button
- **Channel memory** — browsable KV store with value inspector (shows author, timestamp, size)
- **File browser** — shared files with versioning, type icons, download links, delete
- **Budget bar** — credit cost display in header, click to open per-role price settings
- **Live terminals** — xterm.js panels with Tokyo Night theme, Unicode 11 support, 5000-line scrollback
  - **Tab view** — single terminal visible with tab bar to switch
  - **Grid view** — all terminals visible simultaneously
  - **Drag-and-drop** — reorder terminal panels by dragging in grid mode
  - **Rename** — click terminal name to edit inline
  - **Stale detection** — terminals with no output for 60s show orange stale indicator with refresh/recheck button
  - **Buffer replay** — terminal history replayed on dashboard reconnect
- **Hire Worker** — spawn dialog to launch agents on connected landlords
- **Clear Inactive** — removes offline peers from the current channel
- **Resync** — reconnects all terminals from landlords
- **Clean Zombies** — removes agents whose landlord is disconnected

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
7. **Offline revival** — offline peers that start sending heartbeats again are auto-revived

### Landlord auth

1. New landlord connects via WebSocket → appears as **pending** in dashboard
2. Admin approves → broker issues a **mutual key**, saved to `~/.agent-hive-landlord.key`
3. On reconnect, landlord presents mutual key → auto-approved without dashboard interaction
4. If rejected, identity files are deleted and the landlord exits

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_HIVE_HOST` | `0.0.0.0` | Broker bind address |
| `AGENT_HIVE_PORT` | `7899` | Broker port |
| `AGENT_HIVE_DB` | `~/.agent-hive.db` | SQLite database path |
| `HIVE_HOST` | `http://127.0.0.1:7899` | Broker URL (for MCP clients and landlords) |
| `AGENT_HIVE_TOKEN` | (from `~/.agent-hive.key`) | Override auth token |
| `AGENT_HIVE_HARNESS` | `claude-code` | Harness identifier |
| `AGENT_HIVE_NAME` | (auto-generated) | Override agent name |
| `LANDLORD_LOCAL_PORT` | `17900` | Landlord local HTTP gateway port |
| `COWORKER_PATH` | (auto-detected) | Override path to coworker binary for auto MCP config |
| `OPENAI_API_KEY` | — | Enables auto-summary on startup (TypeScript server only) |

---

## Agent names

Each agent gets a memorable name (`crimson-falcon`, `void-oracle`, etc.) generated from a hash of PID + timestamp. The TypeScript server persists names per project in `.agent-hive/name` at the git root. The Rust coworker generates a fresh unique name on each connection. Override with:

```bash
export AGENT_HIVE_NAME="my-custom-name"
# or for TypeScript server:
echo "my-custom-name" > .agent-hive/name
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
- Rust + Cargo — for the Rust MCP server and landlord binary
- Claude Code v2.1.80+ — for `--dangerously-load-development-channels`

---

## Credits

- Original peer discovery concept: [claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) by [@louislva](https://github.com/louislva)
