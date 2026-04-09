#!/usr/bin/env bun
/**
 * agent-hive CLI
 *
 * Utility for inspecting broker state, sending messages, and managing auth.
 *
 * Usage:
 *   agent-hive-cli status              Show broker status and all peers
 *   agent-hive-cli peers               List active peers
 *   agent-hive-cli send <id> <msg>     Send a message to a peer
 *   agent-hive-cli approve <id>        Approve a pending peer
 *   agent-hive-cli reject <id>         Reject a pending peer
 *   agent-hive-cli key                 Show the master key
 *   agent-hive-cli kill-broker         Stop the broker process
 */

import type { Peer } from "./shared/types.ts";
import { readMasterKey } from "./shared/auth.ts";

const BROKER_URL =
  process.env.HIVE_HOST ??
  `http://127.0.0.1:${process.env.AGENT_HIVE_PORT ?? "7899"}`;

async function getToken(): Promise<string> {
  const envToken = process.env.AGENT_HIVE_TOKEN;
  if (envToken) return envToken;
  const masterKey = await readMasterKey();
  if (masterKey) return masterKey;
  console.error("No auth token found. Set AGENT_HIVE_TOKEN or create ~/.agent-hive.key");
  process.exit(1);
}

async function api<T>(path: string, body: unknown = {}): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`Error: ${res.status} ${text}`);
    process.exit(1);
  }
  return res.json() as Promise<T>;
}

function formatPeer(p: Peer): string {
  const status =
    p.status === "approved" ? "\x1b[32m[approved]\x1b[0m" :
    p.status === "pending" ? "\x1b[33m[pending]\x1b[0m" :
    "\x1b[31m[rejected]\x1b[0m";

  const lines = [
    `  ${p.id} ${status}  ${p.harness} @ ${p.hostname}`,
    `    CWD: ${p.cwd}`,
  ];
  if (p.git_root) lines.push(`    Repo: ${p.git_root}`);
  if (p.summary) lines.push(`    Summary: ${p.summary}`);
  lines.push(`    Last seen: ${p.last_seen}`);
  return lines.join("\n");
}

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "status": {
    try {
      const healthRes = await fetch(`${BROKER_URL}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      const health = (await healthRes.json()) as { status: string; peers: number };
      console.log(`Broker: ${health.status} (${health.peers} approved peers)`);
      console.log(`URL: ${BROKER_URL}\n`);
    } catch {
      console.error(`Broker not reachable at ${BROKER_URL}`);
      process.exit(1);
    }

    const peers = await api<Peer[]>("/admin/peers");
    if (peers.length === 0) {
      console.log("No peers registered.");
    } else {
      const pending = peers.filter((p) => p.status === "pending");
      const approved = peers.filter((p) => p.status === "approved");
      if (pending.length > 0) {
        console.log(`Pending (${pending.length}):`);
        for (const p of pending) console.log(formatPeer(p));
        console.log();
      }
      if (approved.length > 0) {
        console.log(`Active (${approved.length}):`);
        for (const p of approved) console.log(formatPeer(p));
      }
    }
    break;
  }

  case "peers": {
    const peers = await api<Peer[]>("/admin/peers");
    const active = peers.filter((p) => p.status === "approved");
    if (active.length === 0) {
      console.log("No active peers.");
    } else {
      for (const p of active) console.log(formatPeer(p));
    }
    break;
  }

  case "send": {
    const [toId, ...msgParts] = args;
    if (!toId || msgParts.length === 0) {
      console.error("Usage: agent-hive-cli send <peer-id> <message>");
      process.exit(1);
    }
    const result = await api<{ ok: boolean; error?: string }>("/send-message", {
      from_id: "cli",
      to_id: toId,
      text: msgParts.join(" "),
    });
    if (result.ok) {
      console.log(`Message sent to ${toId}`);
    } else {
      console.error(`Failed: ${result.error}`);
    }
    break;
  }

  case "approve": {
    const [peerId] = args;
    if (!peerId) {
      console.error("Usage: agent-hive-cli approve <peer-id>");
      process.exit(1);
    }
    const result = await api<{ ok: boolean; error?: string }>("/auth/approve", {
      peer_id: peerId,
    });
    if (result.ok) {
      console.log(`Peer ${peerId} approved`);
    } else {
      console.error(`Failed: ${result.error}`);
    }
    break;
  }

  case "reject": {
    const [peerId] = args;
    if (!peerId) {
      console.error("Usage: agent-hive-cli reject <peer-id>");
      process.exit(1);
    }
    const result = await api<{ ok: boolean; error?: string }>("/auth/reject", {
      peer_id: peerId,
    });
    if (result.ok) {
      console.log(`Peer ${peerId} rejected`);
    } else {
      console.error(`Failed: ${result.error}`);
    }
    break;
  }

  case "key": {
    const key = await readMasterKey();
    if (key) {
      console.log(key);
    } else {
      console.error("No master key found. Start the broker first.");
    }
    break;
  }

  case "kill-broker": {
    try {
      const healthRes = await fetch(`${BROKER_URL}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      const health = (await healthRes.json()) as { status: string; peers: number };
      console.log(`Broker has ${health.peers} peer(s). Shutting down...`);

      const isWin = process.platform === "win32";
      const port = process.env.AGENT_HIVE_PORT ?? "7899";

      if (isWin) {
        const proc = Bun.spawnSync(["cmd", "/c", `netstat -ano | findstr :${port}`]);
        const output = new TextDecoder().decode(proc.stdout).trim();
        const match = output.match(/\s(\d+)\s*$/m);
        const pid = match?.[1];
        if (pid) {
          Bun.spawnSync(["taskkill", "/F", "/PID", pid]);
          console.log(`Killed broker (PID ${pid})`);
        } else {
          console.log("Could not find broker PID");
        }
      } else {
        const proc = Bun.spawnSync(["lsof", "-ti", `tcp:${port}`]);
        const pid = new TextDecoder().decode(proc.stdout).trim();
        if (pid) {
          process.kill(parseInt(pid), "SIGTERM");
          console.log(`Killed broker (PID ${pid})`);
        } else {
          console.log("Could not find broker PID");
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  default:
    console.log(`Agent Hive CLI

Usage:
  agent-hive-cli status              Show broker status and all peers
  agent-hive-cli peers               List active peers
  agent-hive-cli send <id> <msg>     Send a message to a peer
  agent-hive-cli approve <id>        Approve a pending peer
  agent-hive-cli reject <id>         Reject a pending peer
  agent-hive-cli key                 Show the master key
  agent-hive-cli kill-broker         Stop the broker process

Environment:
  HIVE_HOST  Broker URL (default: http://127.0.0.1:7899)
  AGENT_HIVE_TOKEN       Auth token (default: read from ~/.agent-hive.key)
  AGENT_HIVE_PORT        Broker port (default: 7899)`);
}
