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
  | { type: "snapshot"; peers: Peer[]; recent_messages: Message[]; channels: Channel[] };
