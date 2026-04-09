/**
 * Authentication utilities for agent-hive.
 *
 * Master key: generated once on first broker start, saved to ~/.agent-hive.key.
 * Session tokens: returned on /register, stored in DB, pending until admin approves.
 */

import { existsSync } from "node:fs";

const KEY_PATH =
  process.env.AGENT_HIVE_KEY_PATH ??
  `${process.env.HOME ?? process.env.USERPROFILE}/.agent-hive.key`;

/** Generate a cryptographically random hex token. */
export function generateToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Load the master key from disk, or generate + persist one. */
export async function loadOrCreateMasterKey(): Promise<string> {
  if (existsSync(KEY_PATH)) {
    const text = await Bun.file(KEY_PATH).text();
    const key = text.trim();
    if (key.length > 0) return key;
  }
  const key = generateToken(32); // 64-char hex
  await Bun.write(KEY_PATH, key + "\n");
  return key;
}

/** Read the master key from disk (client-side). Returns null if not found. */
export async function readMasterKey(): Promise<string | null> {
  if (!existsSync(KEY_PATH)) return null;
  const text = await Bun.file(KEY_PATH).text();
  const key = text.trim();
  return key.length > 0 ? key : null;
}

/** Extract bearer token from Authorization header. */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}
