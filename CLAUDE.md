---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# Agent Hive

Peer discovery and messaging network for AI coding instances (Claude Code, Codex, OpenCode, etc.).

## Architecture

- `broker.ts` — Public HTTP + WebSocket server on 0.0.0.0:7899 + SQLite. Serves the web dashboard. Approval-based auth.
- `server.ts` — TypeScript MCP stdio server, one per AI coding instance. Connects to broker, exposes tools, pushes channel notifications.
- `../coworker/src/main.rs` — Rust MCP stdio server. Functionally identical to server.ts but compiles to a ~3 MB self-contained binary. This is the primary server used in `.mcp.json`.
- `shared/types.ts` — Shared TypeScript types for broker API and WebSocket events.
- `shared/auth.ts` — Token generation, master key management.
- `shared/summarize.ts` — Auto-summary generation via OpenAI.
- `ui/` — React web dashboard (approval management, peer visualization, message log).
- `cli.ts` — CLI utility for inspecting broker state and managing auth.

## Running

```bash
# Start the broker (generates master key on first run):
bun broker.ts

# Start Claude Code with the channel flag:
claude --dangerously-load-development-channels server:agent-hive

# .mcp.json (Rust binary, recommended):
# { "mcpServers": { "agent-hive": { "command": "/path/to/coworker" } } }

# .mcp.json (TypeScript source):
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
3. Admin opens the web dashboard, logs in with master key
4. Dashboard shows pending peers with Approve/Reject buttons
5. Once approved, the peer can use all API endpoints
6. Local peers with access to `~/.agent-hive.key` are auto-approved

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_HIVE_HOST` | `0.0.0.0` | Broker bind address |
| `AGENT_HIVE_PORT` | `7899` | Broker port |
| `AGENT_HIVE_DB` | `~/.agent-hive.db` | SQLite path |
| `HIVE_HOST` | `http://127.0.0.1:7899` | Broker URL (for clients) |
| `AGENT_HIVE_TOKEN` | (from `~/.agent-hive.key`) | Auth token |
| `AGENT_HIVE_HARNESS` | `claude-code` | Harness type identifier |
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
