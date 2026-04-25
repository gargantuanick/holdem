import type { LeaderboardEntry } from "@holdem/shared";
import { getSql } from "./client.js";

export type LeaderboardSort = "wallet" | "won" | "hands_won";

interface CacheEntry {
  at: number;
  data: LeaderboardEntry[];
}
const CACHE_TTL_MS = 60_000;
const cache = new Map<LeaderboardSort, CacheEntry>();

export async function getLeaderboard(
  sort: LeaderboardSort,
  limit = 20,
): Promise<LeaderboardEntry[]> {
  const cached = cache.get(sort);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.data;
  }
  const sql = getSql();
  let rows: Array<{
    username: string;
    wallet_chips: string;
    total_chips_won: string;
    hands_won: string;
    hands_played: string;
  }>;
  if (sort === "wallet") {
    rows = await sql`
      SELECT username, wallet_chips, total_chips_won, hands_won, hands_played
      FROM players
      ORDER BY wallet_chips DESC, id ASC
      LIMIT ${limit}
    `;
  } else if (sort === "won") {
    rows = await sql`
      SELECT username, wallet_chips, total_chips_won, hands_won, hands_played
      FROM players
      ORDER BY total_chips_won DESC, id ASC
      LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT username, wallet_chips, total_chips_won, hands_won, hands_played
      FROM players
      ORDER BY hands_won DESC, id ASC
      LIMIT ${limit}
    `;
  }
  const data: LeaderboardEntry[] = rows.map((r, i) => ({
    rank: i + 1,
    username: r.username,
    walletChips: Number(r.wallet_chips),
    totalChipsWon: Number(r.total_chips_won),
    handsWon: Number(r.hands_won),
    handsPlayed: Number(r.hands_played),
  }));
  cache.set(sort, { at: Date.now(), data });
  return data;
}

export function invalidateLeaderboardCache() {
  cache.clear();
}
