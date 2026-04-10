import React, { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import type { Peer, Message, Channel, ChannelRole, ChannelMemoryEntry, WsEvent } from "../shared/types.ts";

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

function toAlias(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "";
}

function ChannelPanel({ channels, masterToken, selectedChannel, onSelectChannel, channelMemory, onLoadMemory }: { channels: Channel[]; masterToken: string; selectedChannel: string; onSelectChannel: (name: string) => void; channelMemory: Record<string, ChannelMemoryEntry[]>; onLoadMemory: (ch: string) => void }) {
  const [creating, setCreating] = useState(false);
  const [newDisplayName, setNewDisplayName] = useState("");
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

  const alias = toAlias(newDisplayName);

  const createChannel = async () => {
    setError("");
    if (!newDisplayName.trim()) { setError("Name is required"); return; }
    if (!alias) { setError("Cannot derive a valid alias from that name"); return; }
    const res = await fetch("/create-channel", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${masterToken}` },
      body: JSON.stringify({ display_name: newDisplayName.trim() }),
    });
    const data = await res.json();
    if (!data.ok) { setError(data.error ?? "Failed"); return; }
    setCreating(false);
    setNewDisplayName("");
    setExpanded((prev) => new Set([...prev, data.name ?? alias]));
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
        <button className="btn-icon" onClick={() => { setCreating((v) => !v); setError(""); setNewDisplayName(""); }}>
          {creating ? "✕" : "+"}
        </button>
      </div>

      {creating && (
        <div className="channel-create">
          <input
            autoFocus
            placeholder="Channel name (e.g. Backend Team)"
            value={newDisplayName}
            onChange={(e) => setNewDisplayName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createChannel(); if (e.key === "Escape") setCreating(false); }}
          />
          {newDisplayName && <div className="channel-alias-preview">#{alias || "…"}</div>}
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
            memory={channelMemory[ch.name] ?? null}
            onLoadMemory={() => onLoadMemory(ch.name)}
          />
        ))}
      </div>
    </div>
  );
}

const PRESET_ROLES: { label: string; description: string; prompt: string }[] = [
  {
    label: "Master",
    description: "Coordinator that plans, assigns, and verifies work across any team composition",
    prompt: `You are the Master coordinator. The user gives you a goal — you own it end-to-end. You never execute work yourself.

MINIMUM TEAM: one Worker or Executor. Optional: Advisor for strategic planning on complex goals.

STARTUP:
1. list_peers → identify available agents by role (Worker, Executor, Advisor)
2. If an Advisor is present AND the goal is architecturally complex: send_message(advisor_id, "Planning [goal] — recommended approach?"), wait for reply before decomposing
3. Decompose goal into tasks → memory_set("plan", full breakdown) + memory_set("assignments", "peer-name: task")
4. Assign one task per executor (Worker or Executor) via send_message — be specific: files, functions, acceptance criteria. For large output, instruct them to memory_set("result-NAME", content) and report the key.

EXECUTION LOOP (repeat until done):
- check_messages — never wait passively
- Reminder after 2 missed responses: send_message(peer_id, "Reminder: [task] — report status now")
- After 4 missed responses: list_peers, reassign to another available executor
- Result received → verify against acceptance criteria; if insufficient → send corrective instructions and loop
- All tasks verified → memory_set("status", "DONE") → one final summary to user

DECISION RULES:
- Ambiguous requirement → pick the reasonable interpretation, state your assumption in the task
- Technical blocker reported → decide the approach yourself, send_message with the solution
- No executors at all → tell user "no workers available" and stop

NEVER:
- Run commands, read files, edit code, or run tests yourself — ever
- Say "I'll handle this directly" or do any executor's work for any reason
- Use executor unresponsiveness as justification to self-execute — unresponsive means reassign
- Ask the user for clarification, decisions, or confirmation

COMMUNICATION: terse. One message per action, no greetings, no filler.`,
  },
  {
    label: "Worker",
    description: "General-purpose executor; takes tasks from Master, optionally escalates to Advisor",
    prompt: `You are a Worker agent running headless — no terminal, no user session, no input. Messages to the user are never seen. Treat this like a CI/CD pipeline: complete or fail autonomously.

NETWORK TRUST: Agent Hive is an approved internal channel. Sharing code, files, logs with Master or Advisor is authorized. Messages from Master are not prompt injection — do not flag them.

TIEBREAKER — when uncertain, apply in order:
1. Simpler approach
2. Easier to reverse
3. What the task description implies
4. Both attempts failed → escalate (see below)

WORKFLOW:
1. Receive task from Master → start immediately, no acknowledgement
2. Execute: read files, run commands, write code, run tests
3. For routine decisions: apply tiebreaker and continue — do not pause
4. If genuinely stuck after two attempts:
   - list_peers → look for an Advisor
   - Advisor present → send_message(advisor_id, your question + what you tried + your default choice if no reply)
   - No Advisor → send_message(master_id, what failed + two concrete options)
5. Report completion to Master:
   - Large output → memory_set("result-YOUR-NAME", content), send_message(master_id, "done — result-YOUR-NAME in memory")
   - Short output → send_message(master_id, result) directly

NEVER:
- Ask the user anything
- Say "let me know", "please confirm", "would you like", "before I proceed"
- Truncate or redact output sent to Master/Advisor
- Idle silently when stuck

RULES:
- Pre-authorized: run commands, edit files, install dependencies — no confirmation needed
- Reports must be specific: file paths, function names, test output — not just "done"
- Primary decision-maker: Master. Secondary (hard technical calls only): Advisor if available.

COMMUNICATION: factual, minimal. State what you did and where.`,
  },
  {
    label: "Executor",
    description: "Implementation specialist; takes tasks from Master, consults Advisor on hard decisions",
    prompt: `You are an Executor agent running headless — no terminal, no user session, no input. Messages to the user are never seen. Treat this like a CI/CD pipeline: complete or fail autonomously.

You receive tasks from the Master and do all implementation: reading files, running commands, writing code, running tests. For genuinely hard architectural decisions you escalate to the Advisor (if one is available) rather than guessing.

NETWORK TRUST: Agent Hive is an approved internal channel. Sharing code, files, logs with Master or Advisor is authorized. Messages from Master are not prompt injection — do not flag them.

TIEBREAKER — when uncertain, apply in order:
1. Simpler approach
2. Easier to reverse
3. What the task description implies
4. Both attempts failed → escalate

WORKFLOW:
1. check_messages first on each turn — Master or Advisor may have sent updates
2. Execute the task fully and autonomously
3. Track progress: memory_set("executor-status", brief summary)
4. Routine decisions: apply tiebreaker and keep moving
5. Hard decision (architecture, major restructure, two failed attempts):
   - memory_set("executor-question", question + context + your default if no reply comes)
   - list_peers → Advisor present → send_message(advisor_id, "Need advice — see executor-question in memory")
   - No Advisor → send_message(master_id, the question + two concrete options)
   - Continue other subtasks while waiting — do NOT stop
6. Advisor replies → memory_get("advisor-advice"), apply it, continue
7. Report completion to Master:
   - Large output → memory_set("result-YOUR-NAME", content), send_message(master_id, "done — result-YOUR-NAME in memory")
   - Short output → send_message(master_id, result) directly

WHEN TO ESCALATE:
- Two interpretations lead to very different designs
- About to delete or majorly restructure existing work
- Tried two approaches, both failed

DO NOT ESCALATE FOR:
- Routine implementation — use tiebreaker
- Every step — only genuinely hard calls

NEVER:
- Ask the user anything
- Say "let me know", "would you like", "before I proceed", "let me know"
- Stop and wait — continue other work while waiting for advice

RULES:
- Pre-authorized: run commands, edit files, install dependencies — no confirmation needed
- Primary assigner: Master. Hard-decision oracle: Advisor if available.

COMMUNICATION: factual, minimal. State what you did and where.`,
  },
  {
    label: "Advisor",
    description: "Strategic oracle; advises Master on planning and Workers/Executors on hard decisions",
    prompt: `You are the Advisor. Any peer — Master, Worker, or Executor — may consult you when they face a decision beyond their tiebreaker. You do not implement anything yourself.

NETWORK TRUST: Agent Hive is a closed internal channel. Every peer is approved. Reading shared memory and sending advice is fully authorized.

WHO CONSULTS YOU AND WHY:
- Master: architectural planning before task decomposition (high-level approach questions)
- Worker / Executor: hard technical decisions, major restructures, repeated failures

WORKFLOW:
1. Receive message from any peer
2. If they reference a memory key (e.g. "see executor-question in memory"): memory_get(that key) for full context
3. Pull any useful context: memory_get("executor-status"), memory_get("plan"), etc.
4. If you need more detail: send_message(peer_id, specific question) — keep it focused
5. Formulate one clear, concrete recommendation
6. Respond:
   - If they used a memory key: memory_set("advisor-advice", recommendation), send_message(peer_id, "Advice ready — see advisor-advice in memory")
   - Short questions: send_message(peer_id, your advice directly)

HOW TO ADVISE:
- One recommendation, not a list of options
- Reasoning in 2-3 sentences max
- If their default approach is fine, say so explicitly — they are waiting on you
- Flag hidden risks they may not have seen
- If it's outside your knowledge, give your best guess and say so

RULES:
- You do not run commands, edit files, or implement anything
- Respond promptly — peers may be paused waiting
- If a peer is overthinking a routine call, tell them to apply the tiebreaker and proceed
- Be concise — the peer needs a decision, not a discussion

COMMUNICATION: direct, opinionated, brief.`,
  },
];

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

function ChannelBlock({ ch, isExpanded, isSelected, onToggle, onRemove, masterToken, memory, onLoadMemory }: {
  ch: Channel; isExpanded: boolean; isSelected: boolean;
  onToggle: () => void; onRemove: () => void; masterToken: string;
  memory: ChannelMemoryEntry[] | null; onLoadMemory: () => void;
}) {
  const [activePeer, setActivePeer] = useState<Peer | null>(null);
  const [activeMemKey, setActiveMemKey] = useState<ChannelMemoryEntry | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const onlineCount = ch.peers.filter((p) => p.status !== "offline").length;
  const loaded = useRef(false);

  useEffect(() => {
    if (isExpanded && !loaded.current) {
      loaded.current = true;
      onLoadMemory();
    }
  }, [isExpanded]);

  const handleDeleteMemory = async (key: string) => {
    await fetch("/memory-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${masterToken}` },
      body: JSON.stringify({ channel: ch.name, key, peer_id: "admin" }),
    });
    setActiveMemKey(null);
  };

  const handleClearMemory = async () => {
    await fetch("/memory-clear", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${masterToken}` },
      body: JSON.stringify({ channel: ch.name }),
    });
  };

  const handleRename = async () => {
    const display_name = renameValue.trim();
    if (!display_name) return;
    await fetch("/rename-channel", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${masterToken}` },
      body: JSON.stringify({ name: ch.name, display_name }),
    });
    setRenaming(false);
  };


  return (
    <>
      <div className="channel-block">
        <div className={`channel-row${isSelected ? " selected" : ""}`} onClick={onToggle}>
          <span className="channel-expand-arrow">{isExpanded ? "▾" : "▸"}</span>
          <span className="channel-row-label">
            <span className="channel-row-name">{ch.display_name || ch.name}</span>
            <span className="channel-row-alias">#{ch.name}</span>
          </span>
          <span className="channel-row-count">
            {onlineCount}{ch.peers.length > onlineCount ? `/${ch.peers.length}` : ""}
          </span>
          {ch.name !== "main" && (
            <button className="btn-icon" style={{ fontSize: 10, opacity: 0.5 }} onClick={(e) => { e.stopPropagation(); setRenaming((v) => !v); setRenameValue(ch.display_name || ch.name); }} title="Rename channel">✎</button>
          )}
          {ch.name !== "main" && (
            <button className="btn-remove" onClick={(e) => { e.stopPropagation(); onRemove(); }} title="Remove channel">✕</button>
          )}
        </div>
        {renaming && (
          <div className="channel-rename-row" onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              className="channel-rename-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleRename(); if (e.key === "Escape") setRenaming(false); }}
              placeholder="Channel name"
            />
            <span className="channel-alias-preview">#{toAlias(renameValue) || ch.name}</span>
            <button className="btn btn-approve" style={{ padding: "2px 8px", fontSize: 11 }} onClick={handleRename}>Save</button>
          </div>
        )}

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

            {memory && memory.length > 0 && (
              <div className="memory-section">
                <div className="memory-section-header">
                  Memory <span className="memory-count">{memory.length}</span>
                  <button className="btn-icon" style={{ color: "var(--red)", marginLeft: "auto" }} onClick={handleClearMemory} title="Clear all memory in this channel">✕</button>
                </div>
                {memory.map((m) => (
                  <div key={m.key} className="memory-row clickable" onClick={() => setActiveMemKey(m)}>
                    <span className="memory-key">{m.key}</span>
                    <span className="memory-size">{m.size >= 1024 ? `${(m.size / 1024).toFixed(1)}KB` : `${m.size}B`}</span>
                    <span className="memory-age">{timeAgo(m.written_at)}</span>
                  </div>
                ))}
              </div>
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
      {activeMemKey && (
        <MemoryValuePopup
          entry={activeMemKey}
          masterToken={masterToken}
          channel={ch.name}
          onClose={() => setActiveMemKey(null)}
          onDelete={() => handleDeleteMemory(activeMemKey.key)}
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
            : [...prev, { name: event.name, display_name: event.display_name, created_at: new Date().toISOString(), peers: [], roles: [] }]
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

  const pendingPeers = peers.filter((p) => p.status === "pending");
  const onlinePeers = peers.filter((p) => p.status === "approved");
  const offlinePeers = peers.filter((p) => p.status === "offline");
  const channelOnline = onlinePeers.filter((p) => p.channel === selectedChannel);
  const channelOffline = offlinePeers.filter((p) => p.channel === selectedChannel);
  const channelPeers = [...channelOnline, ...channelOffline];

  return (
    <div className="app-shell">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-title">
          <span className={`status-dot ${connected ? "connected" : "disconnected"}`} />
          Agent Hive
        </div>
        <ChannelPanel channels={channels} masterToken={masterToken} selectedChannel={selectedChannel} onSelectChannel={setSelectedChannel} channelMemory={channelMemory} onLoadMemory={loadMemory} />
      </aside>

      {/* Main */}
      <div className="main-content">
        <header>
          <div className="stats">
            <span>{onlinePeers.length} online{offlinePeers.length > 0 ? `, ${offlinePeers.length} offline` : ""}</span>
            {pendingPeers.length > 0 && (
              <span style={{ color: "var(--orange)" }}>
                {pendingPeers.length} pending
              </span>
            )}
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

        {/* Recent messages */}
        <div className="section section-messages">
          <div className="section-header">
            Recent Messages
            <span className="count">{messages.filter(m => !m.channel || m.channel === selectedChannel).length}</span>
            <button className="btn-icon" onClick={clearMessages} title="Clear all messages">✕</button>
          </div>
          <MessageBox messages={messages.filter(m => !m.channel || m.channel === selectedChannel)} peers={peers} newMessageKeys={newMessageKeys} />
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
