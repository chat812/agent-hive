#!/usr/bin/env bun
/**
 * agent-hive broker daemon
 *
 * A public HTTP + WebSocket server backed by SQLite.
 * Tracks registered AI coding peers and routes messages between them.
 * Serves the web dashboard for admin approval and monitoring.
 *
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  ApproveRejectRequest,
  AuthStatusResponse,
  Peer,
  Message,
  Channel,
  WsEvent,
} from "./shared/types.ts";
import {
  loadOrCreateMasterKey,
  generateToken,
  extractBearerToken,
} from "./shared/auth.ts";

// --- Configuration ---

const HOST = process.env.AGENT_HIVE_HOST ?? "0.0.0.0";
const PORT = parseInt(process.env.AGENT_HIVE_PORT ?? "7899", 10);
const DB_PATH =
  process.env.AGENT_HIVE_DB ??
  `${process.env.HOME ?? process.env.USERPROFILE}/.agent-hive.db`;
const STALE_THRESHOLD_MS = 60_000; // 60s — mark offline after 4 missed heartbeats
const REMOVE_THRESHOLD_MS = 300_000; // 5 min — actually delete offline peers

// --- Master key ---

const MASTER_KEY = await loadOrCreateMasterKey();
console.error(`[broker] Master key loaded (use for dashboard login)`);
console.error(`[broker] Key: ${MASTER_KEY}`);

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS channels (
    name TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  )
`);

db.run(`INSERT OR IGNORE INTO channels (name, created_at) VALUES ('main', '${new Date().toISOString()}')`);

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL DEFAULT 'main',
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    harness TEXT NOT NULL DEFAULT 'claude-code',
    hostname TEXT NOT NULL DEFAULT 'localhost',
    summary TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS tokens (
    token TEXT PRIMARY KEY,
    peer_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (peer_id) REFERENCES peers(id) ON DELETE CASCADE
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS channel_roles (
    channel TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (channel, name)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS peer_channel_roles (
    name TEXT NOT NULL,
    channel TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (name, channel)
  )
`);

// Migrate: re-key peer_channel_roles by name (stable across sessions) if old schema had peer_id
try {
  db.query("SELECT peer_id FROM peer_channel_roles LIMIT 1").all();
  db.run("DROP TABLE peer_channel_roles");
  db.run("CREATE TABLE peer_channel_roles (name TEXT NOT NULL, channel TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', PRIMARY KEY (name, channel))");
} catch {}

db.run(`
  CREATE TABLE IF NOT EXISTS known_peers (
    name TEXT NOT NULL,
    hostname TEXT NOT NULL,
    PRIMARY KEY (name, hostname)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS channel_memory (
    channel TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    written_by TEXT NOT NULL DEFAULT '',
    written_at TEXT NOT NULL,
    PRIMARY KEY (channel, key)
  )
`);

// Migrate: add columns if missing (for existing DBs)
try { db.run("ALTER TABLE peers ADD COLUMN harness TEXT NOT NULL DEFAULT 'claude-code'"); } catch {}
try { db.run("ALTER TABLE peers ADD COLUMN hostname TEXT NOT NULL DEFAULT 'localhost'"); } catch {}
try { db.run("ALTER TABLE peers ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'"); } catch {}
try { db.run("ALTER TABLE peers ADD COLUMN name TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.run("ALTER TABLE peers ADD COLUMN channel TEXT NOT NULL DEFAULT 'main'"); } catch {}
try { db.run("ALTER TABLE messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'main'"); } catch {}
try { db.run("ALTER TABLE peers ADD COLUMN role TEXT NOT NULL DEFAULT ''"); } catch {}

// --- WebSocket clients ---

const wsClients = new Set<any>();

function broadcast(event: WsEvent) {
  const data = JSON.stringify(event);
  for (const ws of wsClients) {
    try {
      ws.send(data);
    } catch {
      wsClients.delete(ws);
    }
  }
}

// --- Clean stale peers (heartbeat-based) ---

function cleanStalePeers() {
  const now = Date.now();
  const offlineCutoff = new Date(now - STALE_THRESHOLD_MS).toISOString();
  const removeCutoff = new Date(now - REMOVE_THRESHOLD_MS).toISOString();

  // Delete peers that have been offline for too long
  const toRemove = db
    .query("SELECT id FROM peers WHERE last_seen < ?")
    .all(removeCutoff) as { id: string }[];
  for (const { id } of toRemove) removePeer(id);

  // Mark recently-stale approved peers as offline (keep them visible in UI)
  const toOffline = db
    .query("SELECT id FROM peers WHERE last_seen < ? AND last_seen >= ? AND status = 'approved'")
    .all(offlineCutoff, removeCutoff) as { id: string }[];
  for (const { id } of toOffline) {
    db.run("UPDATE peers SET status = 'offline' WHERE id = ?", [id]);
    const peer = selectPeerById.get(id) as Peer | null;
    if (peer) broadcast({ type: "peer_updated", peer });
  }
}

function removePeer(id: string) {
  db.run("DELETE FROM tokens WHERE peer_id = ?", [id]);
  db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [id]);
  db.run("DELETE FROM peers WHERE id = ?", [id]);
  broadcast({ type: "peer_left", peer_id: id });
}

cleanStalePeers();
setInterval(cleanStalePeers, 30_000);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, name, channel, pid, cwd, git_root, tty, harness, hostname, summary, status, registered_at, last_seen)
  VALUES (?, ?, 'main', ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
`);
const selectAllChannels = db.prepare("SELECT * FROM channels ORDER BY name ASC");
const selectChannelByName = db.prepare("SELECT name FROM channels WHERE name = ?");
const insertChannel = db.prepare("INSERT OR IGNORE INTO channels (name, created_at) VALUES (?, ?)");
const deleteChannel = db.prepare("DELETE FROM channels WHERE name != 'main' AND name = ?");
const updatePeerChannel = db.prepare("UPDATE peers SET channel = ? WHERE id = ?");
const updatePeerRole = db.prepare("UPDATE peers SET role = ? WHERE id = ?");
const resetPeersInChannel = db.prepare("UPDATE peers SET channel = 'main', role = '' WHERE channel = ?");
const selectPeersByChannel = db.prepare("SELECT * FROM peers WHERE channel = ? AND status IN ('approved', 'offline')");
const selectRolesByChannel = db.prepare("SELECT name, description FROM channel_roles WHERE channel = ? ORDER BY name ASC");
const insertChannelRole = db.prepare("INSERT OR REPLACE INTO channel_roles (channel, name, description) VALUES (?, ?, ?)");
const deleteChannelRole = db.prepare("DELETE FROM channel_roles WHERE channel = ? AND name = ?");
const clearRoleFromPeers = db.prepare("UPDATE peers SET role = '' WHERE channel = ? AND role = ?");
const upsertPeerChannelRole = db.prepare("INSERT OR REPLACE INTO peer_channel_roles (name, channel, role) VALUES (?, ?, ?)");
const selectPeerChannelRole = db.prepare("SELECT role FROM peer_channel_roles WHERE name = ? AND channel = ?");
const insertKnownPeer = db.prepare("INSERT OR IGNORE INTO known_peers (name, hostname) VALUES (?, ?)");
const isKnownPeer = db.prepare("SELECT 1 FROM known_peers WHERE name = ? AND hostname = ?");
const upsertMemory = db.prepare("INSERT OR REPLACE INTO channel_memory (channel, key, value, written_by, written_at) VALUES (?, ?, ?, ?, ?)");
const selectMemoryKeys = db.prepare("SELECT key, written_by, written_at, length(value) as size FROM channel_memory WHERE channel = ? ORDER BY written_at DESC");
const selectMemoryEntry = db.prepare("SELECT key, value, written_by, written_at, length(value) as size FROM channel_memory WHERE channel = ? AND key = ?");
const deleteMemoryEntry = db.prepare("DELETE FROM channel_memory WHERE channel = ? AND key = ?");
const deleteChannelMemory = db.prepare("DELETE FROM channel_memory WHERE channel = ?");
const selectMemoryKeyNames = db.prepare("SELECT key FROM channel_memory WHERE channel = ? ORDER BY key ASC");

const updateLastSeen = db.prepare("UPDATE peers SET last_seen = ? WHERE id = ?");
const updateSummary = db.prepare("UPDATE peers SET summary = ? WHERE id = ?");
const updateStatus = db.prepare("UPDATE peers SET status = ? WHERE id = ?");
const selectAllPeers = db.prepare("SELECT * FROM peers WHERE status = 'approved'");
const selectAllPeersAny = db.prepare("SELECT * FROM peers");
const selectPeersByDirectory = db.prepare("SELECT * FROM peers WHERE cwd = ? AND status = 'approved'");
const selectPeersByGitRoot = db.prepare("SELECT * FROM peers WHERE git_root = ? AND status = 'approved'");
const selectPeerById = db.prepare("SELECT * FROM peers WHERE id = ?");
const insertMessage = db.prepare("INSERT INTO messages (from_id, to_id, text, sent_at, channel, delivered) VALUES (?, ?, ?, ?, ?, 0)");
const selectUndelivered = db.prepare("SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC");
const markDelivered = db.prepare("UPDATE messages SET delivered = 1 WHERE id = ?");
const insertToken = db.prepare("INSERT INTO tokens (token, peer_id, created_at) VALUES (?, ?, ?)");
const selectToken = db.prepare("SELECT * FROM tokens WHERE token = ?");
const selectRecentMessages = db.prepare("SELECT * FROM messages ORDER BY sent_at DESC LIMIT 50");

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// --- Auth helpers ---

function isValidAuth(authHeader: string | null): boolean {
  const token = extractBearerToken(authHeader);
  if (!token) return false;
  if (token === MASTER_KEY) return true;
  const row = selectToken.get(token) as { peer_id: string } | null;
  if (!row) return false;
  // Check the peer is approved
  const peer = selectPeerById.get(row.peer_id) as Peer | null;
  return peer?.status === "approved";
}

function isMasterKey(authHeader: string | null): boolean {
  return extractBearerToken(authHeader) === MASTER_KEY;
}

function getPeerIdFromToken(authHeader: string | null): string | null {
  const token = extractBearerToken(authHeader);
  if (!token) return null;
  if (token === MASTER_KEY) return null; // master key isn't tied to a peer
  const row = selectToken.get(token) as { peer_id: string } | null;
  return row?.peer_id ?? null;
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();
  const sessionToken = generateToken(32);

  // Remove any existing registration for this PID + hostname (re-registration)
  const existingByPid = db
    .query("SELECT id FROM peers WHERE pid = ? AND hostname = ?")
    .get(body.pid, body.hostname) as { id: string } | null;
  if (existingByPid) removePeer(existingByPid.id);

  // Replace any existing session with the same name + hostname — handles reconnect
  // where the old session is still alive (approved) or marked offline
  const existingByName = db
    .query("SELECT id FROM peers WHERE name = ? AND hostname = ?")
    .get(body.name, body.hostname) as { id: string } | null;
  if (existingByName && existingByName.id !== existingByPid?.id) removePeer(existingByName.id);

  const known = isKnownPeer.get(body.name ?? "", body.hostname) as { 1: number } | null;

  insertPeer.run(
    id, body.name ?? "", body.pid, body.cwd, body.git_root ?? null, body.tty ?? null,
    body.harness, body.hostname, body.summary, now, now
  );
  insertToken.run(sessionToken, id, now);

  if (known) {
    // Previously approved — auto-approve without requiring dashboard interaction
    updateStatus.run("approved", id);
    pushChannelRole(id, "main");
    const peer = selectPeerById.get(id) as Peer;
    broadcast({ type: "peer_joined", peer });
  } else {
    const peer = selectPeerById.get(id) as Peer;
    broadcast({ type: "peer_pending", peer });
  }

  return { id, token: sessionToken };
}

function pushChannelRole(peer_id: string, channel: string): { role: string; memory_keys: string[] } {
  const peer = selectPeerById.get(peer_id) as Peer | null;
  if (!peer) return { role: "", memory_keys: [] };
  const row = selectPeerChannelRole.get(peer.name, channel) as { role: string } | null;
  const role = row?.role ?? "";
  updatePeerRole.run(role, peer_id);
  const memory_keys = (selectMemoryKeyNames.all(channel) as { key: string }[]).map(r => r.key);
  return { role, memory_keys };
}

function handleApprove(body: ApproveRejectRequest): { ok: boolean; role: string; memory_keys: string[]; error?: string } {
  const peer = selectPeerById.get(body.peer_id) as Peer | null;
  if (!peer) return { ok: false, role: "", memory_keys: [], error: "Peer not found" };
  updateStatus.run("approved", body.peer_id);
  insertKnownPeer.run(peer.name, peer.hostname); // remember for future auto-approval
  const { role, memory_keys } = pushChannelRole(body.peer_id, peer.channel);
  const updated = selectPeerById.get(body.peer_id) as Peer;
  broadcast({ type: "peer_joined", peer: updated });
  return { ok: true, role, memory_keys };
}

function handleReject(body: ApproveRejectRequest): { ok: boolean; error?: string } {
  const peer = selectPeerById.get(body.peer_id) as Peer | null;
  if (!peer) return { ok: false, error: "Peer not found" };
  updateStatus.run("rejected", body.peer_id);
  broadcast({ type: "peer_left", peer_id: body.peer_id });
  return { ok: true };
}

function handleAuthStatus(token: string): AuthStatusResponse | { error: string } {
  const row = selectToken.get(token) as { peer_id: string } | null;
  if (!row) return { error: "Invalid token" };
  const peer = selectPeerById.get(row.peer_id) as Peer | null;
  if (!peer) return { error: "Peer not found" };
  return { status: peer.status, peer_id: peer.id };
}

function handleHeartbeat(body: HeartbeatRequest): { role: string } {
  updateLastSeen.run(new Date().toISOString(), body.id);
  const peer = selectPeerById.get(body.id) as Peer | null;
  return { role: peer?.role ?? "" };
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
  const peer = selectPeerById.get(body.id) as Peer | null;
  if (peer) broadcast({ type: "peer_updated", peer });
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];

  switch (body.scope) {
    case "all":
    case "network":
      peers = selectAllPeers.all() as Peer[];
      break;
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      if (body.git_root) {
        peers = selectPeersByGitRoot.all(body.git_root) as Peer[];
      } else {
        peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      }
      break;
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  return peers;
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  const target = selectPeerById.get(body.to_id) as Peer | null;
  if (!target) return { ok: false, error: `Peer ${body.to_id} not found` };
  if (target.status !== "approved") return { ok: false, error: `Peer ${body.to_id} is not approved` };

  const sender = selectPeerById.get(body.from_id) as Peer | null;
  const channel = sender?.channel ?? "main";
  const now = new Date().toISOString();
  insertMessage.run(body.from_id, body.to_id, body.text, now, channel);

  const msg: Message = {
    id: 0, // not critical for broadcast
    from_id: body.from_id,
    to_id: body.to_id,
    text: body.text,
    sent_at: now,
    channel,
    delivered: false,
  };
  broadcast({ type: "message_sent", message: msg });

  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];
  for (const msg of messages) {
    markDelivered.run(msg.id);
  }
  return { messages };
}

function handleUnregister(body: { id: string }): void {
  const peer = selectPeerById.get(body.id) as Peer | null;
  if (peer?.status === "approved") {
    // Mark offline instead of deleting — keeps the peer visible in channel lists
    const now = new Date().toISOString();
    db.run("UPDATE peers SET status = 'offline', last_seen = ? WHERE id = ?", [now, body.id]);
    const updated = selectPeerById.get(body.id) as Peer | null;
    if (updated) broadcast({ type: "peer_updated", peer: updated });
  } else {
    removePeer(body.id);
  }
}

// --- Channel helpers ---

function sanitizeChannelName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32) || "main";
}

function getChannelsWithPeers(): Channel[] {
  const channels = selectAllChannels.all() as { name: string; created_at: string }[];
  return channels.map((ch) => ({
    name: ch.name,
    created_at: ch.created_at,
    peers: selectPeersByChannel.all(ch.name) as Peer[],
    roles: selectRolesByChannel.all(ch.name) as { name: string; description: string }[],
  }));
}

function handleListChannels(): Channel[] {
  return getChannelsWithPeers();
}

function handleCreateChannel(body: { name: string }): { ok: boolean; error?: string } {
  const name = sanitizeChannelName(body.name ?? "");
  if (!name || name === "") return { ok: false, error: "Invalid channel name" };
  insertChannel.run(name, new Date().toISOString());
  broadcast({ type: "channel_created", name });
  return { ok: true };
}

function handleRemoveChannel(body: { name: string }): { ok: boolean; error?: string } {
  if (body.name === "main") return { ok: false, error: "Cannot remove the main channel" };
  deleteChannelMemory.run(body.name);
  resetPeersInChannel.run(body.name);
  deleteChannel.run(body.name);
  broadcast({ type: "channel_removed", name: body.name });
  // Broadcast updated peers that were reset to main
  const movedPeers = (selectPeersByChannel.all("main") as Peer[]);
  for (const peer of movedPeers) {
    broadcast({ type: "peer_updated", peer });
  }
  return { ok: true };
}

function handleLeaveChannel(body: { id: string }): { ok: boolean; error?: string } {
  const peer = selectPeerById.get(body.id) as Peer | null;
  if (!peer) return { ok: false, error: "Peer not found" };
  updatePeerChannel.run("main", body.id);
  pushChannelRole(body.id, "main");
  const updated = selectPeerById.get(body.id) as Peer;
  broadcast({ type: "peer_updated", peer: updated });
  return { ok: true };
}

function handleJoinChannel(body: { id: string; channel: string }): { ok: boolean; channel: string; role: string; memory_keys: string[]; error?: string } {
  const peer = selectPeerById.get(body.id) as Peer | null;
  if (!peer) return { ok: false, channel: "", role: "", memory_keys: [], error: "Peer not found" };
  const name = sanitizeChannelName(body.channel ?? "main");

  // Verify channel exists (main always exists)
  if (name !== "main" && !selectChannelByName.get(name)) {
    // Channel is gone — land peer in main
    updatePeerChannel.run("main", body.id);
    const updated = selectPeerById.get(body.id) as Peer;
    broadcast({ type: "peer_updated", peer: updated });
    return { ok: false, channel: "main", role: "", memory_keys: [], error: `Channel #${name} does not exist` };
  }

  // Leave current channel first (broadcast peer_updated from old channel)
  if (peer.channel !== name) {
    updatePeerChannel.run("main", body.id);
    updatePeerRole.run("", body.id);
    const leaving = selectPeerById.get(body.id) as Peer;
    broadcast({ type: "peer_updated", peer: leaving });
  }
  updatePeerChannel.run(name, body.id);
  const { role, memory_keys } = pushChannelRole(body.id, name);
  const updated = selectPeerById.get(body.id) as Peer;
  broadcast({ type: "peer_updated", peer: updated });
  return { ok: true, channel: name, role, memory_keys };
}

// --- Embed dashboard assets (embedded in binary with --compile) ---

import dashboardHtml from "./ui/index.html" with { type: "text" };
import dashboardJs from "./ui/app.bundle.js" with { type: "text" };
import dashboardCss from "./ui/app.css" with { type: "text" };

// --- HTTP + WebSocket Server ---

Bun.serve({
  port: PORT,
  hostname: HOST,

  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    // WebSocket upgrade for dashboard
    if (path === "/ws") {
      const token = url.searchParams.get("token");
      if (token !== MASTER_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }
      const upgraded = server.upgrade(req);
      if (upgraded) return new Response(null, { status: 101 });
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    // --- Static dashboard assets ---

    if (req.method === "GET") {
      if (path === "/" || path === "/index.html") {
        return new Response(dashboardHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (path === "/app.bundle.js") {
        return new Response(dashboardJs, { headers: { "Content-Type": "application/javascript; charset=utf-8" } });
      }
      if (path === "/app.css") {
        return new Response(dashboardCss, { headers: { "Content-Type": "text/css; charset=utf-8" } });
      }
      if (path === "/health") {
        return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
      }
      return new Response("Not found", { status: 404 });
    }

    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Registration: no auth required (peer gets pending token)
    if (path === "/register") {
      try {
        const body = (await req.json()) as RegisterRequest;
        return Response.json(handleRegister(body));
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 });
      }
    }

    // Auth status check: use token in body (peer checking its own status)
    if (path === "/auth/status") {
      try {
        const body = (await req.json()) as { token: string };
        return Response.json(handleAuthStatus(body.token));
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 });
      }
    }

    // --- Admin-only endpoints (master key required) ---

    const authHeader = req.headers.get("Authorization");

    if (path === "/auth/approve" || path === "/auth/reject") {
      if (!isMasterKey(authHeader)) {
        return Response.json({ error: "Master key required" }, { status: 403 });
      }
      try {
        const body = (await req.json()) as ApproveRejectRequest;
        const result = path === "/auth/approve" ? handleApprove(body) : handleReject(body);
        return Response.json(result);
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 });
      }
    }

    // List all peers (including pending) — admin only
    if (path === "/admin/peers") {
      if (!isMasterKey(authHeader)) {
        return Response.json({ error: "Master key required" }, { status: 403 });
      }
      return Response.json(selectAllPeersAny.all());
    }

    // Recent messages — admin only
    if (path === "/admin/messages") {
      if (!isMasterKey(authHeader)) {
        return Response.json({ error: "Master key required" }, { status: 403 });
      }
      return Response.json(selectRecentMessages.all());
    }

    if (path === "/admin/clear-messages") {
      if (!isMasterKey(authHeader)) {
        return Response.json({ error: "Master key required" }, { status: 403 });
      }
      db.run("DELETE FROM messages");
      return Response.json({ ok: true });
    }

    // Channel management — master key only for create/remove
    if (path === "/create-channel" || path === "/remove-channel") {
      if (!isMasterKey(authHeader)) {
        return Response.json({ error: "Master key required" }, { status: 403 });
      }
      const body = await req.json();
      if (path === "/create-channel") return Response.json(handleCreateChannel(body as { name: string }));
      return Response.json(handleRemoveChannel(body as { name: string }));
    }

    // Role management — master key only
    if (path === "/add-channel-role" || path === "/remove-channel-role" || path === "/set-peer-role") {
      if (!isMasterKey(authHeader)) {
        return Response.json({ error: "Master key required" }, { status: 403 });
      }
      const body = await req.json() as Record<string, string>;
      if (path === "/add-channel-role") {
        const { channel, name, description } = body;
        if (!channel || !name) return Response.json({ error: "channel and name required" }, { status: 400 });
        insertChannelRole.run(channel, name.trim(), description ?? "");
        const ch = getChannelsWithPeers().find((c) => c.name === channel);
        if (ch) broadcast({ type: "channel_updated", channel: ch });
        return Response.json({ ok: true });
      }
      if (path === "/remove-channel-role") {
        const { channel, name } = body;
        deleteChannelRole.run(channel, name);
        clearRoleFromPeers.run(channel, name);
        const ch = getChannelsWithPeers().find((c) => c.name === channel);
        if (ch) {
          broadcast({ type: "channel_updated", channel: ch });
          for (const p of ch.peers) broadcast({ type: "peer_updated", peer: p });
        }
        return Response.json({ ok: true });
      }
      if (path === "/set-peer-role") {
        const { peer_id, role } = body;
        const peer = selectPeerById.get(peer_id) as Peer | null;
        if (!peer) return Response.json({ error: "Peer not found" }, { status: 404 });
        upsertPeerChannelRole.run(peer.name, peer.channel, role ?? "");
        updatePeerRole.run(role ?? "", peer_id);
        const updated = selectPeerById.get(peer_id) as Peer;
        broadcast({ type: "peer_updated", peer: updated });
        return Response.json({ ok: true });
      }
    }

    // --- Authenticated endpoints (approved session token or master key) ---

    if (!isValidAuth(authHeader)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/heartbeat":
          return Response.json(handleHeartbeat(body as HeartbeatRequest));
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/unregister":
          handleUnregister(body as { id: string });
          return Response.json({ ok: true });
        case "/list-channels":
          return Response.json(handleListChannels());
        case "/leave-channel":
          return Response.json(handleLeaveChannel(body as { id: string }));
        case "/join-channel":
          return Response.json(handleJoinChannel(body as { id: string; channel: string }));
        case "/set-role": {
          const { id, role } = body as { id: string; role: string };
          const peer = selectPeerById.get(id) as Peer | null;
          if (!peer) return Response.json({ error: "Peer not found" }, { status: 404 });
          upsertPeerChannelRole.run(peer.name, peer.channel, role ?? "");
          updatePeerRole.run(role ?? "", id);
          const updated = selectPeerById.get(id) as Peer;
          broadcast({ type: "peer_updated", peer: updated });
          return Response.json({ ok: true });
        }
        case "/memory-set": {
          const { channel, entries, peer_id } = body as { channel: string; entries: { key: string; value: string }[]; peer_id: string };
          const peer = selectPeerById.get(peer_id) as Peer | null;
          if (!peer || peer.channel !== channel) return Response.json({ ok: false, error: "Not a member of this channel" });
          const now = new Date().toISOString();
          for (const entry of entries) {
            const key = entry.key.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 128);
            if (!key) continue;
            if (entry.value.length > 65536) return Response.json({ ok: false, error: `Value for "${key}" too large (max 64KB)` });
            upsertMemory.run(channel, key, entry.value, peer_id, now);
            broadcast({ type: "memory_updated", channel, key, written_by: peer_id, written_at: now, size: entry.value.length });
          }
          return Response.json({ ok: true });
        }
        case "/memory-list": {
          const { channel } = body as { channel: string };
          return Response.json({ entries: selectMemoryKeys.all(channel) });
        }
        case "/memory-get": {
          const { channel, key } = body as { channel: string; key: string };
          const entry = selectMemoryEntry.get(channel, key);
          if (!entry) return Response.json({ error: "Not found" }, { status: 404 });
          return Response.json(entry);
        }
        case "/memory-delete": {
          const { channel, key, peer_id } = body as { channel: string; key: string; peer_id: string };
          deleteMemoryEntry.run(channel, key);
          broadcast({ type: "memory_updated", channel, key, written_by: peer_id, written_at: new Date().toISOString(), size: 0, deleted: true });
          return Response.json({ ok: true });
        }
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },

  websocket: {
    open(ws) {
      wsClients.add(ws);
      // Send current state snapshot
      const peers = selectAllPeersAny.all() as Peer[];
      const recent_messages = selectRecentMessages.all() as Message[];
      const channels = getChannelsWithPeers();
      ws.send(JSON.stringify({ type: "snapshot", peers, recent_messages, channels } satisfies WsEvent));
    },
    message(_ws, _message) {
      // Dashboard doesn't send messages to broker via WS (uses REST)
    },
    close(ws) {
      wsClients.delete(ws);
    },
  },

  development: {
    hmr: true,
    console: true,
  },
});

console.error(`[broker] listening on ${HOST}:${PORT} (db: ${DB_PATH})`);
