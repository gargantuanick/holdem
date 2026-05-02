import type { Express, Request, Response } from "express";
import type { PlayerProfile } from "@holdem/shared";
import {
  getPlayerById,
  getPlayerByUsername,
  listPlayersForAdmin,
  setPlayerWallet,
} from "../db/players.js";
import { getPlayerIdForToken } from "../db/sessions.js";
import {
  getLeaderboard,
  invalidateLeaderboardCache,
  type LeaderboardSort,
} from "../db/leaderboard.js";

const ADMIN_USERNAMES = new Set<string>(["nk"]);

export function registerApiRoutes(app: Express): void {
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

  app.get("/api/admin/players", async (req: Request, res: Response) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const query = String(req.query.q ?? "");
      const limitRaw = Number(req.query.limit ?? 100);
      const players = await listPlayersForAdmin({
        query,
        limit: Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 100,
      });
      res.json({ players });
    } catch (err) {
      console.error("[api] admin players failed:", err);
      res.status(503).json({ error: "admin players unavailable" });
    }
  });

  app.patch("/api/admin/players/:id/wallet", async (req: Request, res: Response) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const playerId = Number(req.params.id);
      const walletChips = Number((req.body as { walletChips?: unknown }).walletChips);
      if (!Number.isInteger(playerId) || playerId <= 0) {
        res.status(400).json({ error: "invalid player id" });
        return;
      }
      if (
        !Number.isInteger(walletChips) ||
        walletChips < 0 ||
        walletChips > 1_000_000_000
      ) {
        res.status(400).json({
          error: "wallet must be a whole number between 0 and 1,000,000,000",
        });
        return;
      }
      try {
        const player = await setPlayerWallet(playerId, walletChips);
        invalidateLeaderboardCache();
        res.json({ player });
      } catch (err) {
        if (err instanceof Error && err.message === "player not found") {
          res.status(404).json({ error: "player not found" });
          return;
        }
        throw err;
      }
    } catch (err) {
      console.error("[api] admin wallet update failed:", err);
      res.status(503).json({ error: "wallet update unavailable" });
    }
  });
}

async function requireAdmin(
  req: Request,
  res: Response,
): Promise<PlayerProfile | null> {
  const auth = req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (!token) {
    res.status(401).json({ error: "missing session token" });
    return null;
  }
  const playerId = await getPlayerIdForToken(token);
  if (!playerId) {
    res.status(401).json({ error: "invalid session" });
    return null;
  }
  const player = await getPlayerById(playerId);
  if (!player) {
    res.status(401).json({ error: "player missing" });
    return null;
  }
  if (!ADMIN_USERNAMES.has(player.username)) {
    res.status(403).json({ error: "not authorized" });
    return null;
  }
  return player;
}
