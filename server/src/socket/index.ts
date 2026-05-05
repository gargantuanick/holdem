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

/** Hardcoded admin usernames. Admins can kick players from tables. */
const ADMIN_USERNAMES = new Set<string>(["nk"]);
function isAdmin(username: string | null): boolean {
  return !!username && ADMIN_USERNAMES.has(username);
}

export function registerSocketHandlers(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  lobby: Lobby,
): void {
  // Surface action-timeout events to the timed-out player so the client can
  // show a clear "You were sat out for taking too long" banner.
  lobby.onActionTimeout = (tableId: string, playerId: number) => {
    const sid = activeSocketByPlayer.get(playerId);
    if (!sid) return;
    const sock = io.sockets.sockets.get(sid);
    if (!sock) return;
    sock.emit("error", "Action timed out — sat out. Tap Sit in to rejoin.");
  };

  // Connection middleware: auto-resume from the handshake token BEFORE the
  // `connection` event fires. socket.io queues up the client's emits until
  // this middleware calls next(), so any table:join / table:action sent
  // immediately on (re)connect lands AFTER sock.data is populated. Without
  // running this in middleware (versus in the connection handler), there's
  // a race window where buffered events fire against an empty sock.data
  // and silently fail with "not authenticated".
  io.use(async (rawSock, next) => {
    const sock = rawSock as Socket<
      ClientToServerEvents,
      ServerToClientEvents,
      Record<string, never>,
      SocketData
    >;
    sock.data = { playerId: null, username: null, token: null };
    const handshakeToken = (sock.handshake.auth as { token?: unknown } | undefined)?.token;
    if (typeof handshakeToken !== "string" || handshakeToken.length === 0) {
      next();
      return;
    }
    try {
      const playerId = await getPlayerIdForToken(handshakeToken);
      if (!playerId) {
        next(); // bad/expired token; client will re-login on its own
        return;
      }
      const player = await getPlayerById(playerId);
      if (!player) {
        next();
        return;
      }
      // Don't kick prior socket here — handshake auth fires on every
      // reconnect and a kick storm would race with the user's other tabs.
      // Explicit auth:login still does kickPriorSocket for fresh logins.
      activeSocketByPlayer.set(player.id, sock.id);
      sock.data.playerId = player.id;
      sock.data.username = player.username;
      sock.data.token = handshakeToken;
      lobby.handleReconnect(player.id);
      rejoinSeatedRooms(sock, lobby, player.id);
      next();
    } catch (err) {
      console.error("[auth] handshake auto-resume failed:", err);
      // Don't reject the connection — fall back to "unauth'd until
      // explicit auth:login". The client will recover.
      next();
    }
  });

  io.on("connection", (rawSock) => {
    const sock = rawSock as Socket<
      ClientToServerEvents,
      ServerToClientEvents,
      Record<string, never>,
      SocketData
    >;
    // sock.data is already populated by the auth middleware above (or left
    // null if no handshake token was provided / token was invalid).

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
        rejoinSeatedRooms(sock, lobby, player.id);
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
        rejoinSeatedRooms(sock, lobby, player.id);
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

    sock.on("auth:logout", async (cb) => {
      // Best-effort: cash the player out of any tables they're at, then
      // invalidate the session token in the DB so it can't auto-resume.
      // Always ack ok — if the DB blip we still want the client to clear
      // its local session and return to login.
      const playerId = sock.data.playerId;
      const token = sock.data.token;
      if (playerId !== null) {
        try {
          activeSocketByPlayer.delete(playerId);
          // Force-leave any tables the player is seated at. We iterate
          // tables via the lobby; cashOut handles the wallet credit.
          for (const summary of lobby.listTables()) {
            const table = lobby.getTable(summary.id);
            if (!table || !table.findSeatByPlayer(playerId)) continue;
            try {
              await lobby.cashOut({ tableId: summary.id, playerId });
            } catch {
              // ignore — mid-hand deferred cashouts will resolve on hand end
            }
            sock.leave(summary.id);
          }
        } catch (err) {
          console.error("[auth] logout cleanup error:", err);
        }
      }
      if (typeof token === "string" && token.length > 0) {
        try {
          await deleteSession(token);
        } catch (err) {
          console.error("[auth] logout deleteSession error:", err);
        }
      }
      sock.data = { playerId: null, username: null, token: null };
      cb({ ok: true });
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

    sock.on("table:requestState", ({ tableId }, cb) => {
      const table = lobby.getTable(tableId);
      if (!table) {
        cb?.({ ok: false, error: "table not found" });
        return;
      }
      // Ensure the requester is in the socket.io room. Without this, a
      // tab takeover (Tab B logs in as same username → Tab A kicked) sees
      // the snapshot once but never receives push broadcasts because only
      // the original `table:join` called sock.join. Same fix covers any
      // client that rebuilt its connection without re-running buyIn.
      if (
        sock.data.playerId !== null &&
        table.findSeatByPlayer(sock.data.playerId)
      ) {
        sock.join(tableId);
      }
      sock.emit("table:state", table.publicState(sock.data.playerId));
      cb?.({ ok: true });
    });

    sock.on("table:sitOut", ({ tableId, sittingOut }) => {
      if (!sock.data.playerId) {
        sock.emit("error", "Not authenticated — please reload.");
        return;
      }
      const table = lobby.getTable(tableId);
      if (!table) return;
      try {
        table.setSittingOut(sock.data.playerId, sittingOut);
        if (!sittingOut && table.canStartHand()) {
          table.startHand();
        }
      } catch {
        // ignore
      }
    });

    sock.on("table:setReady", ({ tableId, ready }) => {
      if (!sock.data.playerId) {
        sock.emit("error", "Not authenticated — please reload.");
        return;
      }
      const table = lobby.getTable(tableId);
      if (!table) return;
      try {
        table.setReady(sock.data.playerId, ready);
        if (table.canStartHand()) {
          table.startHand();
        }
      } catch {
        // ignore
      }
    });

    sock.on("table:action", ({ tableId, action }) => {
      const tag = `[table:action] sock=${sock.id} pid=${sock.data.playerId} user=${sock.data.username} table=${tableId} action=${(action as { type?: unknown })?.type}`;
      if (!sock.data.playerId) {
        console.warn(`${tag} REJECT not-authenticated`);
        sock.emit("error", "Not authenticated — please reload.");
        return;
      }
      if (!isValidAction(action)) {
        console.warn(`${tag} REJECT invalid-payload`);
        sock.emit("error", "invalid action payload");
        return;
      }
      if (!takeActionToken(sock.id)) {
        console.warn(`${tag} REJECT rate-limited`);
        sock.emit("error", "rate limited; slow down");
        return;
      }
      const table = lobby.getTable(tableId);
      if (!table) {
        console.warn(`${tag} REJECT table-not-found`);
        return;
      }
      try {
        table.applyAction(sock.data.playerId, action);
        console.log(
          `${tag} OK toAct=${table.engine?.toActSeatIndex ?? "null"} street=${table.engine?.street ?? "idle"} currentBet=${table.engine?.currentBet ?? 0}`,
        );
      } catch (err) {
        console.warn(`${tag} ENGINE-REJECT ${errorMessage(err)}`);
        sock.emit("error", errorMessage(err));
      }
    });

    sock.on("table:showCards", ({ tableId }) => {
      if (!sock.data.playerId) return;
      const table = lobby.getTable(tableId);
      if (!table) return;
      // Only meaningful while the requester is actually in the current
      // hand and there's an active engine. Otherwise ignore the request so
      // the flag doesn't leak across hands.
      if (!table.engine) return;
      const seat = table.findSeatByPlayer(sock.data.playerId);
      if (seat && seat.inCurrentHand && !seat.hasFolded) {
        seat.showCardsAtShowdown = true;
      }
    });

    sock.on("table:dealNow", ({ tableId }, cb) => {
      const ack = cb ?? (() => {});
      if (!sock.data.playerId) {
        ack({ ok: false, error: "not authenticated" });
        return;
      }
      const table = lobby.getTable(tableId);
      if (!table) {
        ack({ ok: false, error: "table not found" });
        return;
      }
      // Anyone seated at the table can fast-forward — first press wins.
      if (!table.findSeatByPlayer(sock.data.playerId)) {
        ack({ ok: false, error: "not seated at this table" });
        return;
      }
      const dealt = table.dealNextHandNow();
      ack(dealt ? { ok: true } : { ok: false, error: "no hand pending" });
    });

    sock.on("admin:kickPlayer", async ({ tableId, targetPlayerId }, cb) => {
      if (!isAdmin(sock.data.username)) {
        cb({ ok: false, error: "not authorized" });
        return;
      }
      const table = lobby.getTable(tableId);
      if (!table) {
        cb({ ok: false, error: "table not found" });
        return;
      }
      if (!table.findSeatByPlayer(targetPlayerId)) {
        cb({ ok: false, error: "player not at this table" });
        return;
      }
      try {
        if (lobby.isBotPlayer(targetPlayerId)) {
          lobby.removeBot({ tableId, playerId: targetPlayerId });
        } else {
          await lobby.cashOut({ tableId, playerId: targetPlayerId });
          const targetSid = activeSocketByPlayer.get(targetPlayerId);
          if (targetSid) {
            io.to(targetSid).emit("error", "Kicked from table by admin");
          }
        }
        cb({ ok: true });
      } catch (err) {
        cb({ ok: false, error: errorMessage(err) });
      }
    });

    sock.on("admin:addBot", ({ tableId, buyIn }, cb) => {
      if (!isAdmin(sock.data.username)) {
        cb({ ok: false, error: "not authorized" });
        return;
      }
      try {
        const bot = lobby.addBot({ tableId, buyIn });
        cb({ ok: true, ...bot });
      } catch (err) {
        cb({ ok: false, error: errorMessage(err) });
      }
    });

    sock.on("admin:removeBot", ({ tableId, targetPlayerId }, cb) => {
      if (!isAdmin(sock.data.username)) {
        cb({ ok: false, error: "not authorized" });
        return;
      }
      try {
        const result = lobby.removeBot({ tableId, playerId: targetPlayerId });
        cb({ ok: true, deferred: result.deferred });
      } catch (err) {
        cb({ ok: false, error: errorMessage(err) });
      }
    });

    sock.on("admin:clearTable", async ({ tableId }, cb) => {
      if (!isAdmin(sock.data.username)) {
        cb({ ok: false, error: "not authorized" });
        return;
      }
      try {
        const cleared = await lobby.adminForceClear(tableId);
        for (const pid of cleared) {
          const sid = activeSocketByPlayer.get(pid);
          if (!sid) continue;
          const targetSock = io.sockets.sockets.get(sid);
          if (!targetSock) continue;
          // Force the cleared player's socket out of the table room and tell
          // their client to navigate back to the lobby — otherwise their
          // TablePage is stuck on the now-empty table view.
          targetSock.leave(tableId);
          targetSock.emit("table:evicted", {
            tableId,
            reason: "Table cleared by admin",
          });
        }
        const tableAfter = lobby.getTable(tableId);
        const occupiedAfter = tableAfter ? tableAfter.occupiedSeats().length : 0;
        console.log(
          `[admin:clearTable] tableId=${tableId} by=${sock.data.username} cleared=${cleared.length} occupiedAfter=${occupiedAfter} clearedIds=[${cleared.join(",")}]`,
        );
        cb({ ok: true, cleared: cleared.length, occupiedAfter });
      } catch (err) {
        cb({ ok: false, error: errorMessage(err) });
      }
    });

    sock.on("table:chat", ({ tableId, message }) => {
      if (!sock.data.playerId || !sock.data.username) return;
      if (typeof message !== "string") return;
      const table = lobby.getTable(tableId);
      if (!table || !table.findSeatByPlayer(sock.data.playerId)) {
        sock.emit("error", "Not seated at this table.");
        return;
      }
      // Hard cap: 200 chars after trim. Drop anything over the limit silently
      // — the client also enforces 200 via maxLength on the input.
      const trimmed = message.trim().slice(0, 200);
      if (!trimmed) return;
      // Rate limit chat per socket: 4 burst, 1.5/s sustained. This is more
      // permissive than table:action because chat is normal user chatter.
      if (!takeChatToken(sock.id)) {
        sock.emit("error", "chat rate limited; slow down");
        return;
      }
      const msg: ChatMessage = {
        username: sock.data.username,
        message: trimmed,
        at: Date.now(),
      };
      io.to(tableId).emit("table:chat", msg);
    });

    sock.on("disconnect", async () => {
      actionBuckets.delete(sock.id);
      chatBuckets.delete(sock.id);
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

/**
 * Re-attach this socket to the socket.io rooms for any tables the player
 * is currently seated at. Called after handshake auto-resume, auth:login,
 * and auth:resume so a fresh socket gets push broadcasts without having
 * to re-run table:join.
 *
 * Two distinct failure modes this fixes:
 *
 *   1. iOS / mobile reconnect. Backgrounding the tab silently drops the
 *      WebSocket. socket.io issues a fresh socket id on reconnect with
 *      no room memberships — the OLD socket's `sock.join(tableId)` from
 *      `table:join` doesn't carry over. Without this rebind, the player's
 *      new socket is authenticated but invisible to `Lobby.broadcastState`
 *      and other room-scoped emits, so they stop receiving `table:state`,
 *      `table:handFinished`, `table:history`, and `table:chat` while
 *      still being able to *send* actions (those route by playerId, not
 *      room). The visible symptom is the UI freezing on "my turn" while
 *      the server moves on, then "not your turn" errors on retry.
 *
 *   2. Tab takeover. Tab B logs in as the same username → Tab A is
 *      kicked. Tab B's socket is now active but never went through
 *      `table:join`, so it isn't in the room. Same symptom: snapshot on
 *      mount, then no push updates until refresh.
 */
function rejoinSeatedRooms(
  sock: Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>,
  lobby: Lobby,
  playerId: number,
): void {
  for (const summary of lobby.listTables()) {
    const table = lobby.getTable(summary.id);
    if (!table) continue;
    if (table.findSeatByPlayer(playerId)) {
      sock.join(summary.id);
    }
  }
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

const VALID_ACTION_TYPES = new Set([
  "fold",
  "check",
  "call",
  "bet",
  "raise",
  "allin",
]);

function isValidAction(action: unknown): boolean {
  if (!action || typeof action !== "object") return false;
  const a = action as { type?: unknown; amount?: unknown };
  if (typeof a.type !== "string" || !VALID_ACTION_TYPES.has(a.type)) {
    return false;
  }
  if (a.type === "bet" || a.type === "raise") {
    if (typeof a.amount !== "number") return false;
    if (!Number.isFinite(a.amount)) return false;
    if (a.amount <= 0) return false;
    // Cap at a generous sanity limit (10^9) to keep engine math safe.
    if (a.amount > 1_000_000_000) return false;
  }
  return true;
}

// Per-socket token bucket: ACTION_TOKEN_BURST tokens, refill at
// ACTION_TOKEN_RATE per second. Buys cheap protection against a misbehaving
// or malicious client spamming table:action.
const ACTION_TOKEN_BURST = 6;
const ACTION_TOKEN_RATE = 4; // tokens per second
const actionBuckets = new Map<string, { tokens: number; lastRefill: number }>();

function takeActionToken(socketId: string): boolean {
  return takeFromBucket(actionBuckets, socketId, ACTION_TOKEN_BURST, ACTION_TOKEN_RATE);
}

// Chat is more permissive than actions — typical chatter can be a few
// messages in a couple of seconds.
const CHAT_TOKEN_BURST = 4;
const CHAT_TOKEN_RATE = 1.5; // tokens per second
const chatBuckets = new Map<string, { tokens: number; lastRefill: number }>();

function takeChatToken(socketId: string): boolean {
  return takeFromBucket(chatBuckets, socketId, CHAT_TOKEN_BURST, CHAT_TOKEN_RATE);
}

function takeFromBucket(
  store: Map<string, { tokens: number; lastRefill: number }>,
  socketId: string,
  burst: number,
  rate: number,
): boolean {
  const now = Date.now();
  let bucket = store.get(socketId);
  if (!bucket) {
    bucket = { tokens: burst, lastRefill: now };
    store.set(socketId, bucket);
  }
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(burst, bucket.tokens + elapsed * rate);
  bucket.lastRefill = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// Logout endpoint to invalidate session token; not exposed via socket since
// users just close the browser. Kept here for reference.
export async function logout(token: string): Promise<void> {
  await deleteSession(token);
}
