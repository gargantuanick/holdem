import { randomBytes } from "node:crypto";
import { getSql } from "./client.js";

export function newSessionToken(): string {
  return randomBytes(24).toString("hex");
}

export async function createSession(playerId: number): Promise<string> {
  const sql = getSql();
  const token = newSessionToken();
  await sql`
    INSERT INTO sessions (token, player_id) VALUES (${token}, ${playerId})
  `;
  return token;
}

export async function getPlayerIdForToken(token: string): Promise<number | null> {
  const sql = getSql();
  const rows = await sql<{ player_id: string }[]>`
    SELECT player_id FROM sessions WHERE token = ${token} LIMIT 1
  `;
  if (!rows[0]) return null;
  return Number(rows[0].player_id);
}

export async function deleteSession(token: string): Promise<void> {
  const sql = getSql();
  await sql`DELETE FROM sessions WHERE token = ${token}`;
}
