import type { Express, Request, Response } from "express";
import { getPlayerByUsername } from "../db/players.js";
import { getLeaderboard, type LeaderboardSort } from "../db/leaderboard.js";

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
}
