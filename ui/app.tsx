import React, { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import type { Peer, Message, Channel, ChannelRole, ChannelMemoryEntry, FileEntry, WsEvent } from "../shared/types.ts";
import { PRESET_ROLES } from "./roles.ts";

// --- Helpers ---

function getHarnessClass(harness: string): string {
  if (harness.includes("claude")) return "claude-code";
  if (harness.includes("codex")) return "codex";
  if (harness.includes("opencode")) return "opencode";
  if (harness.includes("cursor")) return "cursor";
  return "default";
}

function harnessLabel(harness: string): string {
  const map: Record<string, string> = {
    "claude-code": "CC",
    codex: "CX",
    opencode: "OC",
    cursor: "CR",
  };
  return map[harness] ?? harness.slice(0, 3).toUpperCase();
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

// --- Login screen ---

function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");

  const submit = async () => {
    setError("");
    try {
      const res = await fetch("/health");
      if (!res.ok) {
        setError("Broker not reachable");
        return;
      }
      // Try to fetch admin peers to validate the master key
      const adminRes = await fetch("/admin/peers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token.trim()}`,
        },
        body: "{}",
      });
      if (adminRes.ok) {
        localStorage.setItem("agent-hive-token", token.trim());
        onLogin(token.trim());
      } else {
        setError("Invalid master key");
      }
    } catch {
      setError("Connection failed");
    }
  };

  return (
    <div className="login-container">
      <div className="login-box">
        <h1>Agent Hive</h1>
        <p>Enter the master key to access the dashboard.</p>
        {error && <div className="error">{error}</div>}
        <input
          type="password"
          placeholder="Master key"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          autoFocus
        />
        <button className="btn btn-primary" style={{ width: "100%" }} onClick={submit}>
          Connect
        </button>
      </div>
    </div>
  );
}

// --- Peer Card ---

function PeerCard({
  peer,
  masterToken,
}: {
  peer: Peer;
  masterToken: string;
}) {
  const isPending = peer.status === "pending";
  const isOffline = peer.status === "offline";

  const approve = async () => {
    await fetch("/auth/approve", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${masterToken}`,
      },
      body: JSON.stringify({ peer_id: peer.id }),
    });
  };

  const reject = async () => {
    await fetch("/auth/reject", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${masterToken}`,
      },
      body: JSON.stringify({ peer_id: peer.id }),
    });
  };

  return (
    <div className={`peer-card ${isPending ? "pending" : ""} ${isOffline ? "offline" : ""}`}>
      <div className="peer-card-header">
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span className={`peer-status-dot ${isOffline ? "offline" : "online"}`} />
          <span className="peer-name" style={{ color: peerColor(peer.name || peer.id) }}>{peer.name || peer.id}</span>
        </div>
        <span className={`harness-badge ${getHarnessClass(peer.harness)}`}>
          {harnessLabel(peer.harness)}
        </span>
      </div>
      <div className="peer-id-sub">{peer.id}</div>

      <div className="peer-info">
        <div>
          <span className="label">Host</span>
          <span className="value">{peer.hostname}</span>
        </div>
        <div>
          <span className="label">CWD</span>
          <span className="value">{peer.cwd}</span>
        </div>
        {peer.git_root && (
          <div>
            <span className="label">Repo</span>
            <span className="value">{peer.git_root}</span>
          </div>
        )}
      </div>

      {peer.summary && <div className="peer-summary">{peer.summary}</div>}

      <div className="peer-footer">
        <span className="channel-badge">#{peer.channel || "main"}</span>
        <span>{peer.harness}</span>
        {isOffline ? (
          <span style={{ color: "var(--text-dim)" }}>offline</span>
        ) : (
          <span>seen {timeAgo(peer.last_seen)}</span>
        )}
      </div>
      {((peer.tokens_in ?? 0) > 0 || (peer.tokens_out ?? 0) > 0) && (
        <div className="peer-tokens">
          <span title="Estimated input tokens (tool results received)">↓ {fmtTokens(peer.tokens_in ?? 0)}</span>
          <span title="Estimated output tokens (tool params sent)">↑ {fmtTokens(peer.tokens_out ?? 0)}</span>
          <span className="peer-tokens-total" title="Total estimated tokens">= {fmtTokens((peer.tokens_in ?? 0) + (peer.tokens_out ?? 0))}</span>
        </div>
      )}

      {isPending && (
        <div className="approval-actions">
          <button className="btn btn-approve" onClick={approve}>
            Approve
          </button>
          <button className="btn btn-reject" onClick={reject}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

// --- Channel Panel ---

function ChannelPanel({ channels, masterToken, selectedChannel, onSelectChannel }: { channels: Channel[]; masterToken: string; selectedChannel: string; onSelectChannel: (name: string) => void }) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["main"]));

  const toggleExpand = (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const createChannel = async () => {
    setError("");
    const name = newName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!name) { setError("Invalid name"); return; }
    const res = await fetch("/create-channel", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${masterToken}` },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!data.ok) { setError(data.error ?? "Failed"); return; }
    setCreating(false);
    setNewName("");
    setExpanded((prev) => new Set([...prev, name]));
  };

  const removeChannel = async (name: string) => {
    await fetch("/remove-channel", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${masterToken}` },
      body: JSON.stringify({ name }),
    });
  };

  return (
    <div className="section">
      <div className="section-header">
        Channels
        <span className="count">{channels.length}</span>
        <button className="btn-icon" onClick={() => { setCreating((v) => !v); setError(""); setNewName(""); }}>
          {creating ? "✕" : "+"}
        </button>
      </div>

      {creating && (
        <div className="channel-create">
          <input
            autoFocus
            placeholder="channel-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))}
            onKeyDown={(e) => { if (e.key === "Enter") createChannel(); if (e.key === "Escape") setCreating(false); }}
          />
          <button className="btn btn-approve" onClick={createChannel}>Create</button>
          {error && <span className="channel-error">{error}</span>}
        </div>
      )}

      <div className="channel-list">
        {channels.map((ch) => (
          <ChannelBlock
            key={ch.name}
            ch={ch}
            isExpanded={expanded.has(ch.name)}
            isSelected={selectedChannel === ch.name}
            onToggle={() => { toggleExpand(ch.name); onSelectChannel(ch.name); }}
            onRemove={() => removeChannel(ch.name)}
            masterToken={masterToken}
          />
        ))}
      </div>
    </div>
  );
}

// PRESET_ROLES imported from ./roles.ts

const ROLE_ICONS_MAP: Record<string, { icon: string; color: string }> = {
  Master:   { icon: "👑", color: "#c8922a" },
  Worker:   { icon: "🔨", color: "#5b8ce6" },
  Executor: { icon: "⚡", color: "#9b6fe6" },
  Advisor:  { icon: "🎓", color: "#7dc96b" },
};

function getRoleIcon(role: string): { label: string; color: string } | null {
  if (!role) return null;
  const preset = PRESET_ROLES.find((r) => r.prompt === role);
  if (preset) {
    const m = ROLE_ICONS_MAP[preset.label];
    if (m) return { label: m.icon, color: m.color };
  }
  const firstWord = role.trim().split(/\s+/)[0];
  if (firstWord) return { label: firstWord[0].toUpperCase(), color: "#666" };
  return null;
}

function RolePopup({ peer, masterToken, onClose }: {
  peer: Peer; masterToken: string; onClose: () => void;
}) {
  const [prompt, setPrompt] = useState(peer.role ?? "");
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const save = async () => {
    setSaving(true);
    await fetch("/set-peer-role", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${masterToken}` },
      body: JSON.stringify({ peer_id: peer.id, role: prompt }),
    });
    setSaving(false);
    onClose();
  };

  const kickFromChannel = async () => {
    await fetch("/admin/kick-peer", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${masterToken}` },
      body: JSON.stringify({ peer_id: peer.id }),
    });
    onClose();
  };

  const removePeer = async () => {
    await fetch("/admin/remove-peer", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${masterToken}` },
      body: JSON.stringify({ peer_id: peer.id }),
    });
    onClose();
  };

  const activePreset = PRESET_ROLES.find((r) => r.prompt === prompt)?.label ?? null;

  return (
    <div className="role-popup-overlay" onClick={onClose}>
      <div className="role-popup" onClick={(e) => e.stopPropagation()}>
        <div className="role-popup-header">
          <div className="role-popup-name">{peer.name || peer.id}</div>
          <div className="role-popup-meta">{peer.harness} · {peer.hostname}</div>
          {peer.summary && <div className="role-popup-summary">{peer.summary}</div>}
        </div>

        <div className="role-preset-row">
          {PRESET_ROLES.map((r) => (
            <button
              key={r.label}
              className={`role-preset-btn${activePreset === r.label ? " active" : ""}`}
              onClick={() => setPrompt(r.prompt)}
              title={r.description}
            >
              {r.label}
            </button>
          ))}
          <span className="role-preset-hint">or write your own below</span>
        </div>

        <textarea
          ref={textareaRef}
          className="role-prompt-textarea"
          placeholder={"Describe this agent's role and responsibilities…"}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save();
          }}
          rows={8}
        />

        <div className="role-popup-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          {peer.channel !== "main" && (
            <button className="btn" style={{ color: "var(--red)" }} onClick={kickFromChannel} title="Move back to #main">
              Remove from channel
            </button>
          )}
          <button className="btn" style={{ color: "var(--red)" }} onClick={removePeer} title="Remove this peer from the network">
            Remove peer
          </button>
          {prompt && (
            <button className="btn" style={{ color: "var(--text-dim)" }} onClick={() => setPrompt("")}>
              Clear role
            </button>
          )}
          <button className="btn btn-approve" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Set Role"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MemoryValuePopup({ entry, masterToken, channel, onClose, onDelete }: {
  entry: { key: string; written_by: string; written_at: string; size: number };
  masterToken: string; channel: string;
  onClose: () => void; onDelete: () => void;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/memory-get", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${masterToken}` },
          body: JSON.stringify({ channel, key: entry.key }),
        });
        if (res.ok) {
          const data = await res.json();
          setValue(data.value ?? "");
        } else {
          setValue("(not found)");
        }
      } catch {
        setValue("(error fetching)");
      }
      setLoading(false);
    })();
  }, []);

  return (
    <div className="role-popup-overlay" onClick={onClose}>
      <div className="role-popup" onClick={(e) => e.stopPropagation()}>
        <div className="role-popup-header">
          <div className="role-popup-name">{entry.key}</div>
          <div className="role-popup-meta">
            by {entry.written_by} · {timeAgo(entry.written_at)} · {entry.size}B
          </div>
        </div>
        <div className="role-popup-label">Value</div>
        {loading ? (
          <div className="memory-value-loading">Loading…</div>
        ) : (
          <pre className="memory-value-pre">{value}</pre>
        )}
        <div className="role-popup-actions">
          <button className="btn" style={{ color: "var(--red)" }} onClick={onDelete}>Delete</button>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function ChannelBlock({ ch, isExpanded, isSelected, onToggle, onRemove, masterToken }: {
  ch: Channel; isExpanded: boolean; isSelected: boolean;
  onToggle: () => void; onRemove: () => void; masterToken: string;
}) {
  const [activePeer, setActivePeer] = useState<Peer | null>(null);
  const onlineCount = ch.peers.filter((p) => p.status !== "offline").length;


  return (
    <>
      <div className="channel-block">
        <div className={`channel-row${isSelected ? " selected" : ""}`} onClick={onToggle}>
          <span className="channel-expand-arrow">{isExpanded ? "▾" : "▸"}</span>
          <span className="channel-hash">#</span>
          <span className="channel-row-name">{ch.name}</span>
          <span className="channel-row-count">
            {onlineCount}{ch.peers.length > onlineCount ? `/${ch.peers.length}` : ""}
          </span>
          {ch.name !== "main" && (
            <button className="btn-remove" onClick={(e) => { e.stopPropagation(); onRemove(); }} title="Remove channel">✕</button>
          )}
        </div>

        {isExpanded && (
          <div className="channel-members">
            {ch.peers.length === 0 ? (
              <div className="channel-empty">No members</div>
            ) : (
              ch.peers.map((p) => (
                <div
                  key={p.id}
                  className={`channel-member-row clickable${p.status === "offline" ? " offline" : ""}`}
                  onClick={() => setActivePeer(p)}
                >
                  <span className={`peer-status-dot ${p.status === "offline" ? "offline" : "online"}`} />
                  <span className={`harness-badge ${getHarnessClass(p.harness)}`}>{harnessLabel(p.harness)}</span>
                  <span className="channel-member-name" style={{ color: peerColor(p.name || p.id) }}>{p.name || p.id}<RoleEmoji role={p.role} /></span>
                </div>
              ))
            )}

          </div>
        )}
      </div>

      {activePeer && (
        <RolePopup
          peer={activePeer}
          masterToken={masterToken}
          onClose={() => setActivePeer(null)}
        />
      )}
    </>
  );
}

// --- Message Item ---

// Deterministic color from peer name — each agent always gets the same color
const PEER_COLORS = [
  "#e05c5c", "#e0854a", "#d4b84a", "#7dc96b",
  "#4fc4cf", "#5b8ce6", "#8b6fe6", "#e06ba8",
  "#4db89a", "#c47c5c", "#9bc45c", "#7c9ee0",
];

function peerColor(name: string): string {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = (Math.imul(h, 33) ^ name.charCodeAt(i)) >>> 0;
  return PEER_COLORS[h % PEER_COLORS.length];
}

function RoleEmoji({ role }: { role?: string }) {
  const icon = getRoleIcon(role ?? "");
  if (!icon) return null;
  return <span className="role-emoji" title={role}>{icon.label}</span>;
}

function fileIcon(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (["png","jpg","jpeg","gif","webp","svg","ico"].includes(ext)) return "🖼️";
  if (["zip","tar","gz","7z","rar","bz2"].includes(ext)) return "🗜️";
  if (["md","txt","rst","log"].includes(ext)) return "📝";
  if (["js","ts","jsx","tsx","py","rs","go","rb","java","c","cpp","h","cs"].includes(ext)) return "⚙️";
  if (["json","yaml","yml","toml","xml","env","ini","conf"].includes(ext)) return "🔧";
  return "📄";
}

function FileList({ files, masterToken, channel, peers }: {
  files: FileEntry[]; masterToken: string; channel: string; peers: Peer[];
}) {
  const handleDelete = async (file_id: string) => {
    await fetch("/file-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${masterToken}` },
      body: JSON.stringify({ file_id }),
    });
  };

  if (files.length === 0) return <div className="empty">No files in #{channel}.</div>;

  return (
    <div className="file-list">
      {files.map((f) => {
        const uploader = peers.find((p) => p.id === f.peer_id);
        const uploaderName = uploader?.name || f.peer_name || f.peer_id;
        const sizeStr = f.size >= 1024 * 1024
          ? `${(f.size / 1024 / 1024).toFixed(1)}MB`
          : f.size >= 1024 ? `${(f.size / 1024).toFixed(1)}KB` : `${f.size}B`;
        return (
          <div key={f.id} className="file-row">
            <span className="file-icon">{fileIcon(f.filename)}</span>
            <div className="file-info">
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span className="file-name">{f.path || f.filename}</span>
                {f.version > 1 && <span className="file-version-badge">v{f.version}</span>}
              </div>
              <span className="file-meta">
                <span style={{ color: peerColor(uploaderName) }}>{uploaderName}</span>
                {" · "}{sizeStr}{" · "}{timeAgo(f.uploaded_at)}
              </span>
              <span className="file-id" title={f.id}>id: {f.id}</span>
            </div>
            <a className="btn-icon file-download" href={`/files/${f.id}`} download={f.filename} title="Download">↓</a>
            <button className="btn-icon" style={{ color: "var(--red)" }} onClick={() => handleDelete(f.id)} title="Delete">✕</button>
          </div>
        );
      })}
    </div>
  );
}

function MemoryPanel({ memory, masterToken, channel }: {
  memory: ChannelMemoryEntry[]; masterToken: string; channel: string;
}) {
  const [activeEntry, setActiveEntry] = useState<ChannelMemoryEntry | null>(null);

  const handleDelete = async (key: string) => {
    await fetch("/memory-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${masterToken}` },
      body: JSON.stringify({ channel, key, peer_id: "admin" }),
    });
    setActiveEntry(null);
  };

  const handleClear = async () => {
    await fetch("/memory-clear", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${masterToken}` },
      body: JSON.stringify({ channel }),
    });
  };

  return (
    <div className="memory-panel">
      <div className="memory-panel-toolbar">
        <span className="memory-panel-label">{memory.length} {memory.length === 1 ? "entry" : "entries"}</span>
        {memory.length > 0 && (
          <button className="btn-icon" style={{ color: "var(--red)", marginLeft: "auto" }} onClick={handleClear} title="Clear all memory">✕ clear</button>
        )}
      </div>
      {memory.length === 0 ? (
        <div className="empty">No memory in #{channel}.</div>
      ) : (
        memory.map((m) => (
          <div key={m.key} className="memory-row clickable" onClick={() => setActiveEntry(m)}>
            <span className="memory-key">{m.key}</span>
            <span className="memory-size">{m.size >= 1024 ? `${(m.size / 1024).toFixed(1)}KB` : `${m.size}B`}</span>
            <span className="memory-age">{timeAgo(m.written_at)}</span>
          </div>
        ))
      )}
      {activeEntry && (
        <MemoryValuePopup
          entry={activeEntry}
          masterToken={masterToken}
          channel={channel}
          onClose={() => setActiveEntry(null)}
          onDelete={() => handleDelete(activeEntry.key)}
        />
      )}
    </div>
  );
}

function MessageItem({ msg, peers, isNew }: { msg: Message; peers: Peer[]; isNew?: boolean }) {
  const fromPeer = peers.find((p) => p.id === msg.from_id);
  const toPeer = peers.find((p) => p.id === msg.to_id);
  const fromName = fromPeer?.name || msg.from_id;
  const toName = toPeer?.name || msg.to_id;
  return (
    <div className={`message-item${isNew ? " message-new" : ""}`}>
      <div className="message-meta">
        <span className="from" style={{ color: peerColor(fromName) }}>{fromName}<RoleEmoji role={fromPeer?.role} /></span>
        <span>→</span>
        <span className="to" style={{ color: peerColor(toName) }}>{toName}<RoleEmoji role={toPeer?.role} /></span>
        <span>{timeAgo(msg.sent_at)}</span>
      </div>
      <div className="message-text">{msg.text}</div>
    </div>
  );
}

// --- Pixel Character ---

function PixelAvatar({ seed, size = 56 }: { seed: string; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let h = 5381;
    for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 33) ^ seed.charCodeAt(i)) >>> 0;

    // Extract features — use >>> (unsigned) so h > 2^31 never produces negative indices
    const hairStyle  = h % 8;
    const skinIdx    = (h >>> 3) % 3;
    const hasGlasses = ((h >>> 5) % 4) === 0;   // 25%
    const hasBeard   = ((h >>> 7) % 3) === 0;   // 33%
    const shirtStyle = (h >>> 9) % 4;
    const legStyle   = (h >>> 11) % 2;
    const hairHue    = (h >>> 13) % 360;
    const shirtHue   = ((h >>> 4) * 137 + 90) % 360;
    const pantsHue   = ((h >>> 6) * 251 + 200) % 360;

    // 0=clear 1=hair 2=skin 3=eye 4=shirt 5=pants 6=glasses 7=beard
    const H = 1, S = 2, E = 3, T = 4, P = 5, G = 6, B = 7;
    const _ = 0;

    const hairRows: number[][][] = [
      [[_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_]],  // bald
      [[_,_,H,H,H,H,_,_],[_,_,_,_,_,_,_,_]],  // tiny tuft
      [[_,H,H,H,H,H,H,_],[_,_,_,_,_,_,_,_]],  // short
      [[_,H,H,H,H,H,H,_],[_,H,H,H,H,H,H,_]],  // medium flat
      [[_,_,_,H,H,_,_,_],[_,_,H,H,H,H,_,_]],  // mohawk
      [[_,H,H,H,H,H,H,_],[H,_,_,H,H,_,_,H]],  // long with sides
      [[H,H,H,H,H,H,H,H],[_,_,H,H,H,H,_,_]],  // fluffy
      [[_,H,_,H,H,_,H,_],[_,H,H,H,H,H,H,_]],  // spiky
    ];

    const row3 = hasGlasses
      ? [_,S,G,E,E,G,S,_]
      : [_,S,E,S,S,E,S,_];

    const row4 = hasBeard
      ? [_,B,B,B,B,B,B,_]
      : [_,S,S,S,S,S,S,_];

    const shirtRows: number[][][] = [
      [[T,T,T,T,T,T,T,T],[T,T,T,T,T,T,T,T]],  // plain
      [[T,T,T,T,T,T,T,T],[T,T,H,T,T,H,T,T]],  // buttons (hair color)
      [[T,_,T,T,T,T,_,T],[T,T,T,T,T,T,T,T]],  // open collar
      [[T,T,T,P,P,T,T,T],[T,T,T,P,P,T,T,T]],  // center stripe
    ];

    const row7 = legStyle === 0
      ? [_,P,P,_,_,P,P,_]
      : [_,P,_,_,_,_,P,_];

    const grid = [
      hairRows[hairStyle][0],
      hairRows[hairStyle][1],
      [_,S,S,S,S,S,S,_],
      row3,
      row4,
      shirtRows[shirtStyle][0],
      shirtRows[shirtStyle][1],
      row7,
    ];

    const skinColor = [`hsl(25,60%,76%)`,`hsl(22,50%,62%)`,`hsl(20,40%,44%)`][skinIdx];
    const palette = [
      '', `hsl(${hairHue},65%,42%)`, skinColor,
      `#0f0f18`, `hsl(${shirtHue},60%,42%)`,
      `hsl(${pantsHue},38%,26%)`, `hsl(200,25%,68%)`,
      `hsl(${hairHue},55%,35%)`,
    ];

    ctx.clearRect(0, 0, 8, 8);
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++) {
        const v = grid[r][c];
        if (v) { ctx.fillStyle = palette[v]; ctx.fillRect(c, r, 1, 1); }
      }
  }, [seed]);
  return <canvas ref={canvasRef} width={8} height={8} style={{ width: size, height: size, imageRendering: "pixelated", display: "block" }} />;
}

// --- Peer Avatar Item ---

function peerActivityState(peer: Peer): "offline" | "idle" | "working" | "thinking" {
  if (peer.status === "offline") return "offline";
  const age = Date.now() - new Date(peer.last_seen).getTime();
  if (age < 15_000) return "thinking";      // within one heartbeat cycle → active
  if (peer.summary && age < 180_000) return "working"; // has summary + seen < 3min
  return "idle";
}

function ActivityBubble({ state, summary }: { state: "offline" | "idle" | "working" | "thinking"; summary: string }) {
  if (state === "offline") {
    return <div className="avatar-bubble avatar-bubble-offline">offline</div>;
  }
  if (state === "idle") {
    return <div className="avatar-bubble avatar-bubble-idle">idle</div>;
  }
  if (state === "thinking") {
    return (
      <div className="avatar-bubble avatar-bubble-thinking">
        <span className="bubble-dot" />
        <span className="bubble-dot" />
        <span className="bubble-dot" />
      </div>
    );
  }
  // working
  const snippet = summary.length > 28 ? summary.slice(0, 26) + "…" : summary;
  return <div className="avatar-bubble avatar-bubble-working">{snippet || "working…"}</div>;
}

function PeerAvatarItem({ peer }: { peer: Peer }) {
  const [hovered, setHovered] = useState(false);
  const isOffline = peer.status === "offline";
  const label = (peer.name || peer.id).replace(/-\w+$/, ""); // first word only
  const state = peerActivityState(peer);
  const roleIcon = getRoleIcon(peer.role ?? "");
  return (
    <div className={`peer-avatar-item${isOffline ? " offline" : ""}`} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <ActivityBubble state={state} summary={peer.summary ?? ""} />
      <div style={{ position: "relative", width: 48, height: 48 }}>
        <PixelAvatar seed={peer.name || peer.id} size={48} />
        {roleIcon && (
          <div className="role-icon-badge" style={{ background: roleIcon.color }} title={peer.role}>
            {roleIcon.label}
          </div>
        )}
      </div>
      <span className="peer-avatar-name" style={{ color: peerColor(peer.name || peer.id) }}>{label}</span>
      {hovered && (
        <div className="peer-avatar-tooltip">
          <div className="tooltip-name">{peer.name || peer.id}</div>
          <div className="tooltip-detail">{peer.harness} · {peer.hostname}</div>
          <div className="tooltip-detail" title={peer.cwd}>{peer.cwd.split(/[\\/]/).slice(-2).join("/")}</div>
          {peer.summary && <div className="tooltip-summary">{peer.summary}</div>}
          {isOffline && <div className="tooltip-offline">offline</div>}
        </div>
      )}
    </div>
  );
}

// --- Message Box ---

function MessageBox({ messages, peers, newMessageKeys }: { messages: Message[]; peers: Peer[]; newMessageKeys: Set<string> }) {
  if (messages.length === 0) {
    return <div className="empty">No messages yet.</div>;
  }

  // messages[0] is newest; display oldest→newest so newest is at bottom
  const ordered = [...messages].reverse();

  return (
    <div className="message-box">
      {ordered.map((m, i) => {
        const key = `${m.from_id}-${m.sent_at}-${i}`;
        return (
          <MessageItem key={key} msg={m} peers={peers} isNew={newMessageKeys.has(`${m.from_id}-${m.sent_at}`)} />
        );
      })}
    </div>
  );
}

// --- Dashboard ---

function Dashboard({ masterToken }: { masterToken: string }) {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [connected, setConnected] = useState(false);
  const [newMessageKeys, setNewMessageKeys] = useState<Set<string>>(new Set());
  const [selectedChannel, setSelectedChannel] = useState<string>("main");
  const [channelMemory, setChannelMemory] = useState<Record<string, ChannelMemoryEntry[]>>({});
  const [channelFiles, setChannelFiles] = useState<Record<string, FileEntry[]>>({});
  const wsRef = useRef<WebSocket | null>(null);
  const [, setTick] = useState(0); // force re-render for timeAgo

  // Tick every 2s to update activity bubbles and relative timestamps
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 2000);
    return () => clearInterval(t);
  }, []);

  const handleEvent = useCallback((event: WsEvent) => {
    switch (event.type) {
      case "snapshot":
        setPeers(event.peers);
        setMessages(event.recent_messages);
        setChannels(event.channels ?? []);
        break;
      case "peer_pending":
      case "peer_joined":
        setPeers((prev) => {
          const filtered = prev.filter((p) => p.id !== event.peer.id);
          return [...filtered, event.peer];
        });
        break;
      case "peer_updated":
        setPeers((prev) =>
          prev.map((p) => (p.id === event.peer.id ? event.peer : p))
        );
        // Move peer between channel lists when their channel changes
        setChannels((prev) =>
          prev.map((ch) => {
            const inChannel = ch.peers.some((p) => p.id === event.peer.id);
            const belongs = event.peer.channel === ch.name && (event.peer.status === "approved" || event.peer.status === "offline");
            if (inChannel && belongs) {
              return { ...ch, peers: ch.peers.map((p) => p.id === event.peer.id ? event.peer : p) };
            } else if (inChannel && !belongs) {
              return { ...ch, peers: ch.peers.filter((p) => p.id !== event.peer.id) };
            } else if (!inChannel && belongs) {
              return { ...ch, peers: [...ch.peers, event.peer] };
            }
            return ch;
          })
        );
        break;
      case "peer_left":
        setPeers((prev) => prev.filter((p) => p.id !== event.peer_id));
        setChannels((prev) =>
          prev.map((ch) => ({ ...ch, peers: ch.peers.filter((p) => p.id !== event.peer_id) }))
        );
        break;
      case "channel_updated":
        setChannels((prev) => prev.map((ch) => ch.name === event.channel.name ? event.channel : ch));
        break;
      case "message_sent": {
        const msgKey = `${event.message.from_id}-${event.message.sent_at}`;
        setMessages((prev) => [event.message, ...prev].slice(0, 50));
        setNewMessageKeys((prev) => new Set([...prev, msgKey]));
        setTimeout(() => {
          setNewMessageKeys((prev) => {
            const next = new Set(prev);
            next.delete(msgKey);
            return next;
          });
        }, 800);
        break;
      }
      case "channel_created":
        setChannels((prev) =>
          prev.find((c) => c.name === event.name)
            ? prev
            : [...prev, { name: event.name, created_at: new Date().toISOString(), peers: [] }]
        );
        break;
      case "channel_removed":
        setChannels((prev) => prev.filter((c) => c.name !== event.name));
        setChannelMemory((prev) => { const next = { ...prev }; delete next[event.name]; return next; });
        break;
      case "memory_updated":
        setChannelMemory((prev) => {
          const ch = event.channel;
          const existing = prev[ch] ?? [];
          if (event.deleted) {
            return { ...prev, [ch]: existing.filter((e) => e.key !== event.key) };
          }
          const entry: ChannelMemoryEntry = { key: event.key, written_by: event.written_by, written_at: event.written_at, size: event.size };
          const idx = existing.findIndex((e) => e.key === event.key);
          if (idx >= 0) {
            const updated = [...existing];
            updated[idx] = entry;
            return { ...prev, [ch]: updated };
          }
          return { ...prev, [ch]: [entry, ...existing] };
        });
        break;
      case "file_uploaded":
        setChannelFiles((prev) => {
          const ch = event.file.channel;
          const existing = prev[ch] ?? [];
          return { ...prev, [ch]: [event.file, ...existing] };
        });
        break;
      case "file_deleted":
        setChannelFiles((prev) => {
          const existing = prev[event.channel] ?? [];
          return { ...prev, [event.channel]: existing.filter((f) => f.id !== event.file_id) };
        });
        break;
      case "channel_aborted":
        setChannels((prev) => prev.map((ch) =>
          ch.name === event.name ? { ...ch, aborted: true } : ch
        ));
        break;
      case "channel_resumed":
        setChannels((prev) => prev.map((ch) =>
          ch.name === event.name ? { ...ch, aborted: false } : ch
        ));
        break;
    }
  }, []);

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${location.host}/ws?token=${encodeURIComponent(masterToken)}`;

    function connect() {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        // Reconnect after 2s
        setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as WsEvent;
          handleEvent(event);
        } catch {}
      };
    }

    connect();
    return () => {
      wsRef.current?.close();
    };
  }, [masterToken, handleEvent]);

  const loadMemory = useCallback(async (ch: string) => {
    try {
      const res = await fetch("/memory-list", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${masterToken}` },
        body: JSON.stringify({ channel: ch }),
      });
      if (res.ok) {
        const data = await res.json();
        setChannelMemory((prev) => ({ ...prev, [ch]: data.entries ?? [] }));
      }
    } catch {}
  }, [masterToken]);

  const loadFiles = useCallback(async (ch: string) => {
    try {
      const res = await fetch("/file-list", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${masterToken}` },
        body: JSON.stringify({ channel: ch }),
      });
      if (res.ok) {
        const data = await res.json();
        setChannelFiles((prev) => ({ ...prev, [ch]: data.files ?? [] }));
      }
    } catch {}
  }, [masterToken]);

  const clearMessages = useCallback(async () => {
    try {
      await fetch("/admin/clear-messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${masterToken}` },
        body: "{}",
      });
      setMessages([]);
    } catch {}
  }, [masterToken]);

  useEffect(() => { loadFiles(selectedChannel); loadMemory(selectedChannel); }, [selectedChannel, loadFiles, loadMemory]);

  const pendingPeers = peers.filter((p) => p.status === "pending");
  const onlinePeers = peers.filter((p) => p.status === "approved");
  const offlinePeers = peers.filter((p) => p.status === "offline");
  const channelOnline = onlinePeers.filter((p) => p.channel === selectedChannel);
  const channelOffline = offlinePeers.filter((p) => p.channel === selectedChannel);
  const channelPeers = [...channelOnline, ...channelOffline];

  const selectedChannelData = channels.find((ch) => ch.name === selectedChannel);

  const handleForceStop = useCallback(async () => {
    await fetch("/channel-abort", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${masterToken}` },
      body: JSON.stringify({ channel: selectedChannel }),
    });
  }, [masterToken, selectedChannel]);

  const handleResume = useCallback(async () => {
    await fetch("/channel-resume", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${masterToken}` },
      body: JSON.stringify({ channel: selectedChannel }),
    });
  }, [masterToken, selectedChannel]);

  const handleReset = useCallback(async () => {
    await fetch("/channel-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${masterToken}` },
      body: JSON.stringify({ channel: selectedChannel }),
    });
  }, [masterToken, selectedChannel]);

  return (
    <div className="app-shell">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-title">
          <span className={`status-dot ${connected ? "connected" : "disconnected"}`} />
          Agent Hive
        </div>
        <ChannelPanel channels={channels} masterToken={masterToken} selectedChannel={selectedChannel} onSelectChannel={setSelectedChannel} />
      </aside>

      {/* Main */}
      <div className="main-content">
        <header>
          <h1 className="channel-title">
            <span className="channel-title-hash">#</span>{selectedChannel}
          </h1>
          {selectedChannelData?.aborted && (
            <div className="abort-badge">⛔ ABORTED</div>
          )}
          <div className="stats">
            <span>{onlinePeers.length} online{offlinePeers.length > 0 ? `, ${offlinePeers.length} offline` : ""}</span>
            {pendingPeers.length > 0 && (
              <span style={{ color: "var(--orange)" }}>
                {pendingPeers.length} pending
              </span>
            )}
            {selectedChannelData?.aborted ? (
              <button className="btn btn-resume" onClick={handleResume} title="Clear abort signal">✅ Resume</button>
            ) : (
              <button className="btn btn-force-stop" onClick={handleForceStop} title="Force all workers to stop">⛔ Stop</button>
            )}
            <button className="btn btn-reset" onClick={handleReset} title="Clear memory, messages, and notify all agents to start fresh">🔄 Reset</button>
          </div>
        </header>

        {/* Pending approvals */}
        {pendingPeers.length > 0 && (
          <div className="section">
            <div className="section-header">
              Pending Approval
              <span className="count pending">{pendingPeers.length}</span>
            </div>
            <div className="peer-grid">
              {pendingPeers.map((p) => (
                <PeerCard key={p.id} peer={p} masterToken={masterToken} />
              ))}
            </div>
          </div>
        )}

        {/* Active peers — filtered to selected channel */}
        <div className="section">
          <div className="section-header">
            <span>Active Peers</span>
            <span className="channel-badge" style={{ marginLeft: 4 }}>#{selectedChannel}</span>
            <span className="count">{channelOnline.length}</span>
            {channelOffline.length > 0 && <span className="count" style={{ opacity: 0.45 }}>{channelOffline.length} offline</span>}
          </div>
          {channelPeers.length === 0 ? (
            <div className="empty">No peers in #{selectedChannel}.</div>
          ) : (
            <div className="peer-avatar-grid">
              {channelPeers.map((p) => <PeerAvatarItem key={p.id} peer={p} />)}
            </div>
          )}
        </div>

        {/* Messages panel */}
        <div className="section section-messages">
          <div className="section-header">
            Messages
            <span className="count">{messages.filter(m => !m.channel || m.channel === selectedChannel).length}</span>
            <button className="btn-icon" style={{ marginLeft: "auto" }} onClick={clearMessages} title="Clear all messages">✕</button>
          </div>
          <MessageBox messages={messages.filter(m => !m.channel || m.channel === selectedChannel)} peers={peers} newMessageKeys={newMessageKeys} />
        </div>
      </div>

      {/* Right panel — Memory (top) + Files (bottom) always visible */}
      <div className="right-panel">
        <div className="right-section">
          <div className="right-section-header">
            Memory
            <span className="count">{(channelMemory[selectedChannel] ?? []).length}</span>
          </div>
          <MemoryPanel memory={channelMemory[selectedChannel] ?? []} masterToken={masterToken} channel={selectedChannel} />
        </div>
        <div className="right-section">
          <div className="right-section-header">
            Files
            <span className="count">{(channelFiles[selectedChannel] ?? []).length}</span>
          </div>
          <FileList files={channelFiles[selectedChannel] ?? []} masterToken={masterToken} channel={selectedChannel} peers={peers} />
        </div>
      </div>
    </div>
  );
}

// --- App ---

function App() {
  const [masterToken, setMasterToken] = useState<string | null>(
    localStorage.getItem("agent-hive-token")
  );

  if (!masterToken) {
    return <Login onLogin={setMasterToken} />;
  }

  return <Dashboard masterToken={masterToken} />;
}

// --- Mount ---

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
