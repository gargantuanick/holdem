import "dotenv/config";
import express from "express";
import cors from "cors";
import http from "node:http";
import { Server } from "socket.io";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@holdem/shared";
import { runMigrations } from "./db/migrate.js";
import { closePool, getSql } from "./db/client.js";
import { registerSocketHandlers } from "./socket/index.js";
import { registerApiRoutes } from "./api/index.js";
import { Lobby } from "./rooms/lobby.js";

const PORT = Number(process.env.PORT ?? 3001);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? "http://localhost:5173";

async function main() {
  // Run migrations before accepting traffic.
  if (process.env.DATABASE_URL) {
    try {
      await runMigrations();
      console.log("[server] migrations applied");
    } catch (err) {
      console.error("[server] migration failed:", err);
      process.exit(1);
    }
  } else {
    console.warn(
      "[server] DATABASE_URL not set — running without database (dev only)",
    );
  }

  const app = express();
  app.use(
    cors({
      origin: CLIENT_ORIGIN,
      credentials: true,
    }),
  );
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true, time: new Date().toISOString() });
  });

  registerApiRoutes(app);

  const server = http.createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
    cors: { origin: CLIENT_ORIGIN, credentials: true },
  });

  const lobby = new Lobby(io);
  registerSocketHandlers(io, lobby);

  server.listen(PORT, () => {
    console.log(`[server] listening on :${PORT}`);
    console.log(`[server] CORS origin: ${CLIENT_ORIGIN}`);
    if (process.env.DATABASE_URL) {
      // touch the pool early so connection issues surface fast
      getSql()`SELECT 1`.catch((e) => {
        console.error("[server] db ping failed:", e);
      });
    }
  });

  const shutdown = async () => {
    console.log("[server] shutting down");
    io.close();
    server.close();
    await closePool().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
