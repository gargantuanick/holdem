import type { Server, Socket } from "socket.io";
import type {
  ChatMessage,
  ClientToServerEvents,
  ServerToClientEvents,
} from "@holdem/shared";
import {
  findOrCreatePlayer,
  getPlayerById,
  tryRefill,
  validateUsername,
} from "../db/players.js";
import {
  createSession,
  deleteSession,
  getPlayerIdForToken,
} from "../db/sessions.js";
import type { Lobby } from "../rooms/lobby.js";
import { fetchHandHistory } from "../db/handHistory.js";

interface SocketData {
  playerId: number | null;
  username: string | null;
  token: string | null;
}

/**
 * Tracks the active socket per playerId. If a second socket logs in as the same
 * username, the first is kicked.
 */
const activeSocketByPlayer = new Map<number, string>();

export function registerSocketHandlers(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  lobby: Lobby,
): void {
  io.on("connection", (rawSock) => {
    const sock = rawSock as Socket<
      ClientToServerEvents,
      ServerToClientEvents,
      Record<string, never>,
      SocketData
    >;
    sock.data = { playerId: null, username: null, token: null };

    sock.on("ping", (cb) => {
      cb("pong");
    });

    sock.on("auth:login", async ({ username }, cb) => {
      try {
        const valid = validateUsername(username);
        if (!valid) {
          cb({ ok: false, error: "username must be 2–20 chars: letters, numbers, underscore" });
          return;
        }
        const player = await findOrCreatePlayer(valid);
        const token = await createSession(player.id);
        kickPriorSocket(io, player.id, sock.id);
        activeSocketByPlayer.set(player.id, sock.id);
        sock.data.playerId = player.id;
        sock.data.username = player.username;
        sock.data.token = token;
        lobby.handleReconnect(player.id);
        cb({ ok: true, token, player });
      } catch (err) {
        console.error("[auth] login error:", err);
        cb({ ok: false, error: "login failed" });
      }
    });

    sock.on("auth:resume", async ({ token }, cb) => {
      try {
        const playerId = await getPlayerIdForToken(token);
        if (!playerId) {
          cb({ ok: false, error: "invalid session" });
          return;
        }
        const player = await getPlayerById(playerId);
        if (!player) {
          cb({ ok: false, error: "player missing" });
          return;
        }
        kickPriorSocket(io, player.id, sock.id);
        activeSocketByPlayer.set(player.id, sock.id);
        sock.data.playerId = player.id;
        sock.data.username = player.username;
        sock.data.token = token;
        lobby.handleReconnect(player.id);
        cb({ ok: true, player });
      } catch (err) {
        console.error("[auth] resume error:", err);
        cb({ ok: false, error: "resume failed" });
      }
    });

    sock.on("auth:refill", async (cb) => {
      const playerId = sock.data.playerId;
      if (!playerId) {
        cb({ ok: false, error: "not authenticated" });
        return;
      }
      const r = await tryRefill(playerId);
      if (!r.ok) {
        cb({
          ok: false,
          error: r.reason,
          nextRefillAt: r.nextRefillAt?.toISOString(),
        });
        return;
      }
      cb({ ok: true, wallet: r.wallet });
      sock.emit("wallet:update", r.wallet);
    });

    sock.on("lobby:list", (cb) => {
      cb(lobby.listTables());
    });

    sock.on("lobby:create", async (args, cb) => {
      try {
        if (!sock.data.playerId) {
          cb({ ok: false, error: "not authenticated" });
          return;
        }
        const t = lobby.createTable(args);
        cb({ ok: true, tableId: t.config.id });
      } catch (err) {
        cb({ ok: false, error: errorMessage(err) });
      }
    });

    sock.on("table:join", async ({ tableId, buyIn, seatIndex }, cb) => {
      try {
        if (!sock.data.playerId || !sock.data.username) {
          cb({ ok: false, error: "not authenticated" });
          return;
        }
        const { wallet } = await lobby.buyIn({
          tableId,
          playerId: sock.data.playerId,
          username: sock.data.username,
          buyIn,
          seatIndex,
        });
        sock.join(tableId);
        const table = lobby.getTable(tableId);
        if (table) {
          sock.emit("table:state", table.publicState(sock.data.playerId));
          if (process.env.DATABASE_URL) {
            try {
              const history = await fetchHandHistory(tableId, 50);
              sock.emit("table:history", history);
            } catch {
              // ignore in dev without DB
            }
          }
        }
        sock.emit("wallet:update", wallet);
        cb({ ok: true });
      } catch (err) {
        cb({ ok: false, error: errorMessage(err) });
      }
    });

    sock.on("table:leave", async ({ tableId }, cb) => {
      try {
        if (!sock.data.playerId) {
          cb({ ok: false, error: "not authenticated" });
          return;
        }
        const { wallet, deferred } = await lobby.cashOut({
          tableId,
          playerId: sock.data.playerId,
        });
        if (!deferred) {
          sock.leave(tableId);
          sock.emit("wallet:update", wallet);
        }
        cb({ ok: true });
      } catch (err) {
        cb({ ok: false, error: errorMessage(err) });
      }
    });

    sock.on("table:rebuy", async ({ tableId, amount }, cb) => {
      try {
        if (!sock.data.playerId) {
          cb({ ok: false, error: "not authenticated" });
          return;
        }
        const { wallet } = await lobby.rebuy({
          tableId,
          playerId: sock.data.playerId,
          amount,
        });
        sock.emit("wallet:update", wallet);
        cb({ ok: true });
      } catch (err) {
        cb({ ok: false, error: errorMessage(err) });
      }
    });

    sock.on("table:sitOut", ({ tableId, sittingOut }) => {
      if (!sock.data.playerId) return;
      const table = lobby.getTable(tableId);
      if (!table) return;
      try {
        table.setSittingOut(sock.data.playerId, sittingOut);
      } catch {
        // ignore
      }
    });

    sock.on("table:action", ({ tableId, action }) => {
      if (!sock.data.playerId) return;
      const table = lobby.getTable(tableId);
      if (!table) return;
      try {
        table.applyAction(sock.data.playerId, action);
      } catch (err) {
        sock.emit("error", errorMessage(err));
      }
    });

    sock.on("table:showCards", ({ tableId }) => {
      if (!sock.data.playerId) return;
      const table = lobby.getTable(tableId);
      if (!table) return;
      const seat = table.findSeatByPlayer(sock.data.playerId);
      if (seat) {
        seat.showCardsAtShowdown = true;
      }
    });

    sock.on("table:chat", ({ tableId, message }) => {
      if (!sock.data.playerId || !sock.data.username) return;
      const trimmed = message.trim().slice(0, 200);
      if (!trimmed) return;
      const msg: ChatMessage = {
        username: sock.data.username,
        message: trimmed,
        at: Date.now(),
      };
      io.to(tableId).emit("table:chat", msg);
    });

    sock.on("disconnect", async () => {
      const pid = sock.data.playerId;
      if (pid != null) {
        // Only handle disconnect if THIS socket was the active one (avoid the
        // "kicked" socket triggering grace timers on the new active socket).
        if (activeSocketByPlayer.get(pid) === sock.id) {
          activeSocketByPlayer.delete(pid);
          lobby.handleDisconnect(pid);
        }
      }
      if (sock.data.token) {
        // Don't delete session on disconnect — the user may reconnect quickly.
      }
    });
  });
}

function kickPriorSocket(io: Server, playerId: number, currentSocketId: string) {
  const prev = activeSocketByPlayer.get(playerId);
  if (prev && prev !== currentSocketId) {
    const prevSock = io.sockets.sockets.get(prev);
    if (prevSock) {
      prevSock.emit("session:kicked", "logged in elsewhere");
      prevSock.disconnect(true);
    }
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Logout endpoint to invalidate session token; not exposed via socket since
// users just close the browser. Kept here for reference.
export async function logout(token: string): Promise<void> {
  await deleteSession(token);
}
