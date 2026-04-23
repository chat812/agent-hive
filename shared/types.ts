// Unique ID for each peer instance (generated on registration)
export type PeerId = string;

export type PeerStatus = "pending" | "approved" | "rejected" | "offline";

export interface Peer {
  id: PeerId;
  name: string; // fancy generated name, e.g. "crimson-falcon" — stable per project dir
  channel: string; // current channel, default "main"
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  harness: string; // "claude-code" | "codex" | "opencode" | "cursor" | etc.
  hostname: string; // machine hostname
  summary: string;
  status: PeerStatus;
  role: string; // assigned role in current channel, empty if none
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
  tokens_in: number; // estimated input tokens consumed (tool results returned to agent)
  tokens_out: number; // estimated output tokens produced (tool params sent by agent)
  bridge_id?: string; // landlord that spawned this agent (empty for direct connections)
}

export interface ChannelRole {
  name: string;
  description: string;
}

export interface Channel {
  name: string;
  created_at: string;
  peers: Peer[];
  roles: ChannelRole[];
  aborted: boolean;
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  channel: string; // channel the message was sent in
  delivered: boolean;
}

export interface ChannelMemoryEntry {
  key: string;
  value?: string; // only present from /memory-get
  size: number; // byte length of value
  written_by: string; // peer_id
  written_at: string; // ISO timestamp
}

export interface FileEntry {
  id: string;
  path: string;        // logical path e.g. "datasets/model.pkl"
  version: number;     // auto-incremented per path per channel
  filename: string;    // original filename
  peer_id: string;
  peer_name: string;
  channel: string;
  cwd: string;
  size: number;
  sha256: string;
  uploaded_at: string;
}

// --- Broker API types ---

export interface RegisterRequest {
  name: string;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  harness: string;
  hostname: string;
  summary: string;
}

export interface RegisterResponse {
  id: PeerId;
  token: string; // session token (pending until approved)
  channel: string; // current channel (broker-assigned; already restored for known peers)
  role: string; // role in that channel
}

export interface AuthStatusRequest {
  token: string;
}

export interface AuthStatusResponse {
  status: PeerStatus;
  peer_id: PeerId;
  channel: string; // current channel after broker-side channel restoration
  role: string;
}

export interface ApproveRejectRequest {
  peer_id: PeerId;
}

export interface HeartbeatRequest {
  id: PeerId;
  tokens_in?: number;
  tokens_out?: number;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface ListPeersRequest {
  scope: "all" | "network" | "directory" | "repo";
  // The requesting peer's context (used for filtering)
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}

// --- Landlord types ---

export interface LandlordInfo {
  id: string;
  agents: number;
  hostname: string;
  status: "pending" | "approved" | "rejected";
  disk_free?: number; // bytes
  ram_free?: number;  // bytes
  cpu_pct?: number;   // 0-100
}

// --- WebSocket event types (broker → dashboard) ---

export type WsEvent =
  | { type: "peer_joined"; peer: Peer }
  | { type: "peer_left"; peer_id: PeerId }
  | { type: "peer_updated"; peer: Peer }
  | { type: "peer_pending"; peer: Peer }
  | { type: "message_sent"; message: Message }
  | { type: "channel_created"; name: string }
  | { type: "channel_removed"; name: string }
  | { type: "channel_updated"; channel: Channel }
  | { type: "memory_updated"; channel: string; key: string; written_by: string; written_at: string; size: number; deleted?: boolean }
  | { type: "file_uploaded"; file: FileEntry }
  | { type: "file_deleted"; file_id: string; channel: string }
  | { type: "channel_aborted"; name: string }
  | { type: "channel_resumed"; name: string }
  | { type: "snapshot"; peers: Peer[]; recent_messages: Message[]; channels: Channel[]; landlords?: LandlordInfo[]; pending_landlords?: LandlordInfo[]; terminal_history?: Record<string, string[]> }
  | { type: "terminal_output"; session_id: string; data: string } // hex-encoded PTY output
  | { type: "agent_exited"; session_id: string }
  | { type: "landlord_update"; landlords: LandlordInfo[] }
  | { type: "landlord_pending"; landlord: LandlordInfo }
  | { type: "landlord_approved"; landlord: LandlordInfo }
  | { type: "landlord_rejected"; landlord_id: string };
