import type { Express, Request, Response } from "express";
import type { Server } from "socket.io";
import type {
  ClientToServerEvents,
  PlayerProfile,
  ServerToClientEvents,
} from "@holdem/shared";
import {
  deletePlayers,
  getPlayerById,
  getPlayerByUsername,
  listPlayers,
  setPlayerWallet,
} from "../db/players.js";
import { getLeaderboard, type LeaderboardSort } from "../db/leaderboard.js";
import { invalidateLeaderboardCache } from "../db/leaderboard.js";
import { getPlayerIdForToken } from "../db/sessions.js";
import type { Lobby } from "../rooms/lobby.js";

const ADMIN_USERNAMES = new Set<string>(["nk"]);

function bearerToken(req: Request): string | null {
  const auth = req.header("authorization");
  if (!auth) return null;
  const [scheme, token] = auth.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

async function requireAdmin(
  req: Request,
  res: Response,
): Promise<PlayerProfile | null> {
  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: "not authenticated" });
    return null;
  }
  const playerId = await getPlayerIdForToken(token);
  const player = playerId ? await getPlayerById(playerId) : null;
  if (!player) {
    res.status(401).json({ error: "not authenticated" });
    return null;
  }
  if (!ADMIN_USERNAMES.has(player.username)) {
    res.status(403).json({ error: "not authorized" });
    return null;
  }
  return player;
}

function parsePlayerIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw
        .map((id) => Number(id))
        .filter((id) => Number.isSafeInteger(id) && id > 0),
    ),
  );
}

async function ensurePlayersCanBeDeleted(
  res: Response,
  admin: PlayerProfile,
  lobby: Lobby,
  playerIds: number[],
): Promise<boolean> {
  if (playerIds.length === 0) {
    res.status(400).json({ error: "no players selected" });
    return false;
  }
  if (playerIds.includes(admin.id)) {
    res.status(400).json({ error: "cannot delete your own admin account" });
    return false;
  }
  const seated = playerIds.filter((id) => lobby.isPlayerSeated(id));
  if (seated.length > 0) {
    res.status(409).json({
      error:
        seated.length === 1
          ? "player is seated at a table; clear or leave the table first"
          : "one or more players are seated at tables; clear or leave those tables first",
      seatedPlayerIds: seated,
    });
    return false;
  }
  return true;
}

async function kickDeletedPlayerSockets(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  playerIds: number[],
) {
  const deleted = new Set(playerIds);
  const sockets = await io.fetchSockets();
  for (const socket of sockets) {
    const playerId = (socket.data as { playerId?: number | null }).playerId;
    if (!playerId || !deleted.has(playerId)) continue;
    socket.emit("session:kicked", "Player profile removed by admin");
    socket.disconnect(true);
  }
}

export function registerApiRoutes(
  app: Express,
  lobby: Lobby,
  io: Server<ClientToServerEvents, ServerToClientEvents>,
): void {
  app.get("/api/admin/players", async (req: Request, res: Response) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const q = String(req.query.q ?? "");
      const limit = Number(req.query.limit ?? 200);
      const players = await listPlayers(q, Number.isFinite(limit) ? limit : 200);
      res.json({ players });
    } catch (err) {
      console.error("[api] admin players failed:", err);
      res.status(503).json({ error: "failed to load players" });
    }
  });

  app.patch(
    "/api/admin/players/:id/wallet",
    async (req: Request, res: Response) => {
      try {
        const admin = await requireAdmin(req, res);
        if (!admin) return;
        const playerId = Number(req.params.id);
        const walletChips = Number(req.body?.walletChips);
        if (!Number.isSafeInteger(playerId) || playerId <= 0) {
          res.status(400).json({ error: "invalid player id" });
          return;
        }
        if (!Number.isSafeInteger(walletChips) || walletChips < 0) {
          res
            .status(400)
            .json({ error: "wallet must be a non-negative whole number" });
          return;
        }
        const player = await setPlayerWallet(playerId, walletChips);
        if (!player) {
          res.status(404).json({ error: "player not found" });
          return;
        }
        res.json({ player });
      } catch (err) {
        console.error("[api] admin wallet failed:", err);
        res.status(503).json({ error: "wallet update failed" });
      }
    },
  );

  app.delete("/api/admin/players/:id", async (req: Request, res: Response) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const playerId = Number(req.params.id);
      if (!Number.isSafeInteger(playerId) || playerId <= 0) {
        res.status(400).json({ error: "invalid player id" });
        return;
      }
      if (!(await ensurePlayersCanBeDeleted(res, admin, lobby, [playerId]))) {
        return;
      }
      const deleted = await deletePlayers([playerId]);
      if (deleted.length === 0) {
        res.status(404).json({ error: "player not found" });
        return;
      }
      invalidateLeaderboardCache();
      await kickDeletedPlayerSockets(io, [playerId]);
      res.json({ deleted });
    } catch (err) {
      console.error("[api] admin delete player failed:", err);
      res.status(503).json({ error: "player delete failed" });
    }
  });

  app.post(
    "/api/admin/players/bulk-delete",
    async (req: Request, res: Response) => {
      try {
        const admin = await requireAdmin(req, res);
        if (!admin) return;
        const playerIds = parsePlayerIds(req.body?.playerIds);
        if (
          !(await ensurePlayersCanBeDeleted(res, admin, lobby, playerIds))
        ) {
          return;
        }
        const deleted = await deletePlayers(playerIds);
        invalidateLeaderboardCache();
        await kickDeletedPlayerSockets(
          io,
          deleted.map((player) => player.id),
        );
        res.json({
          deleted,
          requested: playerIds.length,
          missing: playerIds.filter(
            (id) => !deleted.some((player) => player.id === id),
          ),
        });
      } catch (err) {
        console.error("[api] admin bulk delete players failed:", err);
        res.status(503).json({ error: "bulk delete failed" });
      }
    },
  );

  app.get("/api/profile/:username", async (req: Request, res: Response) => {
    try {
      const username = req.params.username ?? "";
      if (!username) {
        res.status(400).json({ error: "username required" });
        return;
      }
      const profile = await getPlayerByUsername(username);
      if (!profile) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json(profile);
    } catch (err) {
      console.error("[api] profile failed:", err);
      res.status(503).json({ error: "profile unavailable" });
    }
  });

  app.get("/api/leaderboard", async (req: Request, res: Response) => {
    try {
      const sortRaw = String(req.query.sort ?? "wallet");
      const allowed: LeaderboardSort[] = ["wallet", "won", "hands_won"];
      const sort: LeaderboardSort = allowed.includes(
        sortRaw as LeaderboardSort,
      )
        ? (sortRaw as LeaderboardSort)
        : "wallet";
      const data = await getLeaderboard(sort);
      res.json({ sort, entries: data });
    } catch (err) {
      console.error("[api] leaderboard failed:", err);
      res.status(503).json({ error: "leaderboard unavailable", entries: [] });
    }
  });
}
