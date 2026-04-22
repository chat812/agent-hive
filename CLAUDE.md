---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# Agent Hive

Multi-agent coordination network for AI coding instances (Claude Code, Codex, OpenCode, etc.).

## Architecture

- `broker.ts` — HTTP + WebSocket server on 0.0.0.0:7899 + SQLite. Serves the web dashboard. Approval-based auth. Auto-builds UI bundle on startup. Routes terminal I/O between landlords and dashboards.
- `server.ts` — TypeScript MCP stdio server, one per AI coding instance. Connects to broker via WebSocket (HTTP fallback), exposes tools, pushes channel notifications.
- `coworker/src/main.rs` — Rust MCP stdio server. Functionally identical to server.ts but compiles to a ~3 MB binary. Primary server for `.mcp.json`. Includes idle/stall detection and `report_issue` tool.
- `bridge/` — Rust binary (one per machine, now called agent-hive-landlord). Spawns agent processes with PTYs, multiplexes terminal I/O over a single WebSocket to the broker. Also runs a local HTTP gateway for coworker MCP servers.
- `shared/types.ts` — Shared TypeScript types for broker API, dashboard WebSocket events, and agent WebSocket events.
- `shared/auth.ts` — Token generation, master key management.
- `shared/summarize.ts` — Auto-summary generation via OpenAI.
- `ui/roles.ts` — Role prompt definitions (Master, Worker, Executor, Vuln Researcher, Vuln Validator, Sys Admin, Advisor).
- `ui/app.tsx` — React web dashboard (role assignment, channel management, peer cards, message log with pagination, memory browser, xterm.js terminal panels).
- `ui/app.css` — Dashboard styles.
- `cli.ts` — CLI utility for inspecting broker state and managing auth.

## Transport

Agents connect to the broker using a hybrid model:
- **WebSocket** (`/ws/agent?token=...`) — primary transport for instant push (messages, role changes, abort signals). Heartbeat ping every 5s.
- **HTTP** — fallback polling every 1s + heartbeat every 2s when WS is down. All tool calls (send_message, list_peers, memory_set, etc.) always use HTTP.
- Auto-reconnect with exponential backoff (1s → 30s cap).

Landlords connect via:
- **WebSocket** (`/ws/landlord?token=MASTER_KEY&bridge_id=...`) — multiplexed transport for terminal I/O, agent registration, and spawn/kill commands. Ping every 5s keeps landlord agents alive.
- **Local HTTP gateway** (port 17900) — relays coworker API calls to the broker via the landlord WebSocket.

Dashboard receives terminal data via the main `/ws` WebSocket. Terminal input/resize/spawn/kill are sent as JSON messages over the same connection.

## Roles

7 preset roles in `ui/roles.ts` with structured coordination prompts:
- **Master** — coordinator, plans and assigns, never executes. Tool-restricted to Agent Hive tools only. Progress enforcement via status key monitoring.
- **Worker / Executor** — general implementers. ACK task receipt. Advisor review gate before reporting to Master.
- **Vuln Researcher** — security auditor. Waits for Master assignment. 5-phase workflow (recon → lab → decompile → taint trace → report). Validation gate: all findings go through Validator.
- **Vuln Validator** — adversarial verifier. Severity-tiered deep review. ACK → INFO REQUEST → CHALLENGE → DEFENSE → VERDICT protocol.
- **Sys Admin** — infrastructure. ACKs all requests. Lab provisioning for Researchers, LAB RUN execution for Validators.
- **Advisor** — strategic oracle. ACKs requests. APPROVED/FEEDBACK on results.

Key protocols: ACK on every request, channel isolation via `list_peers(scope: "channel")`, headless mode (agents use `send_message`/`report_issue` instead of terminal output), idle detection (30s nudge, 60s Master alert).

## Running

```bash
# Start the broker (generates master key on first run, auto-builds UI):
bun broker.ts

# Start the landlord (connects to broker, spawns agents with PTYs):
cd bridge && cargo run --release
# Or set env vars:
# HIVE_HOST=http://127.0.0.1:7899 AGENT_HIVE_TOKEN=<key> cargo run --release
# The landlord auto-detects the coworker binary and auto-configures the MCP
# server globally in ~/.claude.json. No manual .mcp.json setup needed.

# Start Claude Code with the channel flag:
claude --dangerously-load-development-channels server:agent-hive

# .mcp.json (Rust binary, manual — not needed if landlord auto-configured):
# { "mcpServers": { "agent-hive": { "command": "/path/to/coworker" } } }

# .mcp.json (TypeScript source, manual):
# { "mcpServers": { "agent-hive": { "command": "bun", "args": ["./server.ts"] } } }

# CLI:
bun cli.ts status
bun cli.ts peers
bun cli.ts approve <peer-id>
bun cli.ts reject <peer-id>
bun cli.ts send <peer-id> <message>
bun cli.ts key
bun cli.ts kill-broker
```

## Agent names

Each peer gets a generated name (e.g. `crimson-falcon`) stored in `.agent-hive/name` at the project's git root. Stable per project — same name every time you reconnect from that directory.

## Auth Flow

1. Broker generates a master key on first start → `~/.agent-hive.key`
2. New peer calls `/register` → gets a session token in **pending** state
3. Local peers with access to `~/.agent-hive.key` are auto-approved
4. Remote peers → appear in dashboard as pending; admin approves/rejects
5. Once approved, peer connects via WebSocket for push delivery
6. All API endpoints require valid session token

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_HIVE_HOST` | `0.0.0.0` | Broker bind address |
| `AGENT_HIVE_PORT` | `7899` | Broker port |
| `AGENT_HIVE_DB` | `~/.agent-hive.db` | SQLite path |
| `HIVE_HOST` | `http://127.0.0.1:7899` | Broker URL (for clients) |
| `AGENT_HIVE_TOKEN` | (from `~/.agent-hive.key`) | Auth token |
| `AGENT_HIVE_HARNESS` | `claude-code` | Harness type identifier |
| `COWORKER_PATH` | (auto-detected) | Override path to coworker binary for auto MCP config |
| `OPENAI_API_KEY` | — | Enables auto-summary |

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
