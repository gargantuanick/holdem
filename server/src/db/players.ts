import type { PlayerProfile } from "@holdem/shared";
import { getSql } from "./client.js";

export interface PlayerRow {
  id: string; // bigint as string from postgres
  username: string;
  wallet_chips: string;
  hands_played: string;
  hands_won: string;
  tables_joined: string;
  total_chips_won: string;
  total_chips_lost: string;
  biggest_pot_won: string;
  last_refill_at: Date | null;
  created_at: Date;
  last_seen_at: Date;
}

export const STARTING_WALLET = 10_000;
export const REFILL_AMOUNT = 1_000;
export const REFILL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function rowToProfile(r: PlayerRow): PlayerProfile {
  return {
    id: Number(r.id),
    username: r.username,
    walletChips: Number(r.wallet_chips),
    handsPlayed: Number(r.hands_played),
    handsWon: Number(r.hands_won),
    tablesJoined: Number(r.tables_joined),
    totalChipsWon: Number(r.total_chips_won),
    totalChipsLost: Number(r.total_chips_lost),
    biggestPotWon: Number(r.biggest_pot_won),
    createdAt: r.created_at.toISOString(),
    lastSeenAt: r.last_seen_at.toISOString(),
    lastRefillAt: r.last_refill_at ? r.last_refill_at.toISOString() : null,
  };
}

const USERNAME_RE = /^[a-zA-Z0-9_]{2,20}$/;
export function validateUsername(raw: string): string | null {
  const trimmed = raw.trim();
  if (!USERNAME_RE.test(trimmed)) return null;
  return trimmed;
}

export async function findOrCreatePlayer(
  username: string,
): Promise<PlayerProfile> {
  const sql = getSql();
  // try to find first
  const existing = await sql<PlayerRow[]>`
    SELECT * FROM players WHERE username = ${username} LIMIT 1
  `;
  if (existing.length > 0) {
    const row = existing[0]!;
    await sql`UPDATE players SET last_seen_at = NOW() WHERE id = ${row.id}`;
    return rowToProfile(row);
  }
  const inserted = await sql<PlayerRow[]>`
    INSERT INTO players (username, wallet_chips)
    VALUES (${username}, ${STARTING_WALLET})
    ON CONFLICT (username) DO UPDATE SET last_seen_at = NOW()
    RETURNING *
  `;
  return rowToProfile(inserted[0]!);
}

export async function getPlayerById(id: number): Promise<PlayerProfile | null> {
  const sql = getSql();
  const rows = await sql<PlayerRow[]>`
    SELECT * FROM players WHERE id = ${id} LIMIT 1
  `;
  return rows[0] ? rowToProfile(rows[0]) : null;
}

export async function getPlayerByUsername(
  username: string,
): Promise<PlayerProfile | null> {
  const sql = getSql();
  const rows = await sql<PlayerRow[]>`
    SELECT * FROM players WHERE username = ${username} LIMIT 1
  `;
  return rows[0] ? rowToProfile(rows[0]) : null;
}

/**
 * Adjusts the wallet by `delta`. Returns the new wallet.
 * Throws if the result would go negative.
 */
export async function adjustWallet(
  playerId: number,
  delta: number,
): Promise<number> {
  const sql = getSql();
  const rows = await sql<{ wallet_chips: string }[]>`
    UPDATE players
    SET wallet_chips = wallet_chips + ${delta}
    WHERE id = ${playerId} AND wallet_chips + ${delta} >= 0
    RETURNING wallet_chips
  `;
  if (rows.length === 0) {
    throw new Error("insufficient wallet");
  }
  return Number(rows[0]!.wallet_chips);
}

/**
 * Atomically deduct `amount` from wallet. Returns the new wallet.
 * Throws if insufficient.
 */
export async function debitWallet(
  playerId: number,
  amount: number,
): Promise<number> {
  if (amount < 0) throw new Error("debit must be non-negative");
  return adjustWallet(playerId, -amount);
}

export async function creditWallet(
  playerId: number,
  amount: number,
): Promise<number> {
  if (amount < 0) throw new Error("credit must be non-negative");
  return adjustWallet(playerId, amount);
}

/**
 * Daily refill: only if wallet is 0 and last_refill_at older than 24h (or null).
 */
export async function tryRefill(
  playerId: number,
): Promise<{ ok: true; wallet: number } | { ok: false; nextRefillAt: Date | null; reason: string }> {
  const sql = getSql();
  const rows = await sql<PlayerRow[]>`
    SELECT * FROM players WHERE id = ${playerId} LIMIT 1
  `;
  const row = rows[0];
  if (!row) return { ok: false, nextRefillAt: null, reason: "player not found" };
  if (Number(row.wallet_chips) > 0) {
    return { ok: false, nextRefillAt: null, reason: "wallet not empty" };
  }
  const now = Date.now();
  if (row.last_refill_at) {
    const next = row.last_refill_at.getTime() + REFILL_COOLDOWN_MS;
    if (now < next) {
      return { ok: false, nextRefillAt: new Date(next), reason: "cooldown" };
    }
  }
  const updated = await sql<{ wallet_chips: string }[]>`
    UPDATE players
    SET wallet_chips = ${REFILL_AMOUNT}, last_refill_at = NOW()
    WHERE id = ${playerId} AND wallet_chips = 0
    RETURNING wallet_chips
  `;
  if (updated.length === 0) {
    return { ok: false, nextRefillAt: null, reason: "race lost" };
  }
  return { ok: true, wallet: Number(updated[0]!.wallet_chips) };
}

export async function incrementTablesJoined(playerId: number): Promise<void> {
  const sql = getSql();
  await sql`
    UPDATE players SET tables_joined = tables_joined + 1 WHERE id = ${playerId}
  `;
}
