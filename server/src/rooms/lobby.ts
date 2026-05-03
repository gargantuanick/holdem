import { randomUUID } from "node:crypto";
import type { Server } from "socket.io";
import type {
  ClientToServerEvents,
  HandFinishedPayload,
  LobbyTableSummary,
  PlayerAction,
  ServerToClientEvents,
  TableConfig,
} from "@holdem/shared";
import { Table, type TableSeat } from "./table.js";
import {
  creditWallet,
  debitWallet,
  getPlayerById,
  incrementTablesJoined,
} from "../db/players.js";
import { fetchHandHistory, recordHandResult } from "../db/handHistory.js";
import { invalidateLeaderboardCache } from "../db/leaderboard.js";
import { computeStatsDeltas } from "./stats.js";

/**
 * Lobby owns the set of tables and brokers wallet operations.
 *
 * The Lobby is intentionally the only thing that knows about both the DB and
 * the Table — Table itself stays transport-agnostic and DB-free.
 */
export class Lobby {
  private tables = new Map<string, Table>();
  private io: Server<ClientToServerEvents, ServerToClientEvents>;
  private nextBotPlayerId = -1;
  private nextBotNumber = 1;
  private botActionTimers = new Map<
    string,
    { key: string; timer: ReturnType<typeof setTimeout> }
  >();
  /** Tracks which playerIds entered each table this session (for tables_joined++). */
  private joinedAt = new Map<string, Set<number>>();
  /**
   * Set by the socket layer so the lobby can notify the timed-out player's
   * socket directly. Wired up in registerSocketHandlers.
   */
  onActionTimeout: ((tableId: string, playerId: number) => void) | null = null;

  constructor(io: Server<ClientToServerEvents, ServerToClientEvents>) {
    this.io = io;
    this.seedDefaultTables();
  }

  private seedDefaultTables() {
    this.createTable({
      name: "Beginner Stakes",
      maxSeats: 5,
      smallBlind: 5,
      bigBlind: 10,
      minBuyIn: 200, // 20× BB
      maxBuyIn: 1000, // 100× BB
    });
    this.createTable({
      name: "Mid Stakes",
      maxSeats: 5,
      smallBlind: 25,
      bigBlind: 50,
      minBuyIn: 1000,
      maxBuyIn: 5000,
    });
    this.createTable({
      name: "Heads-up Express",
      maxSeats: 2,
      smallBlind: 10,
      bigBlind: 20,
      minBuyIn: 400,
      maxBuyIn: 2000,
    });
  }

  createTable(args: {
    name: string;
    maxSeats: number;
    smallBlind: number;
    bigBlind: number;
    minBuyIn: number;
    maxBuyIn: number;
  }): Table {
    // Reject non-finite numbers so NaN/Infinity can't sneak past range checks.
    for (const f of ["maxSeats", "smallBlind", "bigBlind", "minBuyIn", "maxBuyIn"] as const) {
      const v = args[f];
      if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
        throw new Error(`${f} must be a finite integer`);
      }
    }
    if (typeof args.name !== "string" || args.name.trim().length === 0) {
      throw new Error("name required");
    }
    if (args.name.length > 40) {
      throw new Error("name too long (max 40 chars)");
    }
    if (args.maxSeats < 2 || args.maxSeats > 5) {
      throw new Error("maxSeats must be 2..5");
    }
    if (args.bigBlind <= 0 || args.smallBlind <= 0) {
      throw new Error("blinds must be > 0");
    }
    if (args.smallBlind >= args.bigBlind) {
      throw new Error("smallBlind must be < bigBlind");
    }
    if (args.minBuyIn < args.bigBlind * 2) {
      throw new Error("minBuyIn must be at least 2 BB");
    }
    if (args.maxBuyIn < args.minBuyIn) {
      throw new Error("maxBuyIn must be >= minBuyIn");
    }
    const id = randomUUID();
    const config: TableConfig = { id, ...args };
    const table = new Table(config, {
      onStateChange: (t) => {
        this.broadcastState(t);
        this.scheduleBotAction(t);
      },
      onHandFinished: (t, payload) => this.handleHandFinished(t, payload),
      onActionTimeout: (t, seatIndex) => {
        const ts = t.seats[seatIndex];
        if (!ts || ts.playerId === null) return;
        this.onActionTimeout?.(t.config.id, ts.playerId);
      },
    });
    this.tables.set(id, table);
    this.joinedAt.set(id, new Set());
    return table;
  }

  listTables(): LobbyTableSummary[] {
    return Array.from(this.tables.values()).map((t) => ({
      id: t.config.id,
      name: t.config.name,
      maxSeats: t.config.maxSeats,
      occupiedSeats: t.occupiedSeats().length,
      smallBlind: t.config.smallBlind,
      bigBlind: t.config.bigBlind,
      minBuyIn: t.config.minBuyIn,
      maxBuyIn: t.config.maxBuyIn,
    }));
  }

  getTable(id: string): Table | null {
    return this.tables.get(id) ?? null;
  }

  isPlayerSeated(playerId: number): boolean {
    for (const table of this.tables.values()) {
      if (table.findSeatByPlayer(playerId)) return true;
    }
    return false;
  }

  isBotPlayer(playerId: number): boolean {
    for (const table of this.tables.values()) {
      const seat = table.findSeatByPlayer(playerId);
      if (seat?.isBot) return true;
    }
    return false;
  }

  addBot(args: {
    tableId: string;
    buyIn?: number;
  }): { playerId: number; username: string } {
    const table = this.tables.get(args.tableId);
    if (!table) throw new Error("table not found");
    if (table.occupiedSeats().length >= table.config.maxSeats) {
      throw new Error("table full");
    }
    const buyIn = args.buyIn ?? table.config.minBuyIn;
    if (
      !Number.isFinite(buyIn) ||
      !Number.isInteger(buyIn) ||
      buyIn < table.config.minBuyIn ||
      buyIn > table.config.maxBuyIn
    ) {
      throw new Error("invalid bot buy-in");
    }
    const playerId = this.nextBotPlayerId--;
    const username = `CPU ${this.nextBotNumber++}`;
    table.sitDown({
      playerId,
      username,
      buyIn,
      isBot: true,
    });
    table.setReady(playerId, true);
    if (table.canStartHand()) {
      table.startHand();
    }
    return { playerId, username };
  }

  removeBot(args: {
    tableId: string;
    playerId: number;
  }): { deferred: boolean } {
    const table = this.tables.get(args.tableId);
    if (!table) throw new Error("table not found");
    const seat = table.findSeatByPlayer(args.playerId);
    if (!seat) throw new Error("bot not at this table");
    if (!seat.isBot) throw new Error("target is not a bot");
    const result = table.standUp(args.playerId);
    return { deferred: result.deferred };
  }

  /** Buy-in flow: debit wallet → sit player at table. Returns new wallet balance. */
  async buyIn(args: {
    tableId: string;
    playerId: number;
    username: string;
    buyIn: number;
    seatIndex?: number;
  }): Promise<{ wallet: number }> {
    const table = this.tables.get(args.tableId);
    if (!table) throw new Error("table not found");
    if (
      typeof args.buyIn !== "number" ||
      !Number.isFinite(args.buyIn) ||
      !Number.isInteger(args.buyIn) ||
      args.buyIn <= 0
    ) {
      throw new Error("buy-in must be a positive integer");
    }
    if (table.findSeatByPlayer(args.playerId)) {
      throw new Error("already at this table");
    }
    if (args.buyIn < table.config.minBuyIn) {
      throw new Error(`buy-in below table minimum`);
    }
    if (args.buyIn > table.config.maxBuyIn) {
      throw new Error(`buy-in above table maximum`);
    }
    // Debit first; if seating fails, refund (with retry — if the credit
    // itself fails we must NOT lose the player's chips, so loop with backoff
    // and ultimately log a hard error for manual reconciliation).
    const newWallet = await debitWallet(args.playerId, args.buyIn);
    try {
      table.sitDown({
        playerId: args.playerId,
        username: args.username,
        buyIn: args.buyIn,
        seatIndex: args.seatIndex,
      });
    } catch (err) {
      await refundWithRetry(args.playerId, args.buyIn);
      throw err;
    }
    // Increment tables_joined once per session per table.
    const set = this.joinedAt.get(args.tableId)!;
    if (!set.has(args.playerId)) {
      set.add(args.playerId);
      await incrementTablesJoined(args.playerId);
    }
    invalidateLeaderboardCache();
    // Auto-start a hand if we now have enough players.
    if (table.canStartHand()) {
      table.startHand();
    }
    return { wallet: newWallet };
  }

  /** Cash-out flow: remove from table → credit wallet. Returns new wallet balance. */
  async cashOut(args: {
    tableId: string;
    playerId: number;
  }): Promise<{ wallet: number; deferred: boolean }> {
    const table = this.tables.get(args.tableId);
    if (!table) throw new Error("table not found");
    const seat = table.findSeatByPlayer(args.playerId);
    if (!seat) throw new Error("not at this table");
    // Use removeSeat to atomically pull the stack out.
    const { stack, deferred } = table.standUp(args.playerId);
    if (deferred) {
      return { wallet: 0, deferred: true };
    }
    if (stack > 0) {
      // Use the same retry path the buy-in rollback uses. Without it, a
      // single transient DB hiccup loses the player's chips: the seat is
      // already empty (standUp ran first) and a thrown credit means the
      // wallet was never updated. creditWithRetry retries up to 5x and
      // ultimately throws with a CRITICAL log so the chips can be
      // reconciled manually rather than disappearing.
      const wallet = await creditWithRetry(args.playerId, stack);
      invalidateLeaderboardCache();
      return { wallet, deferred: false };
    }
    const player = await getPlayerById(args.playerId);
    return { wallet: player?.walletChips ?? 0, deferred: false };
  }

  /**
   * Admin: nuke any in-progress hand and force-evict every seated player,
   * crediting their stacks back to their wallets. Returns the list of
   * playerIds that were cleared.
   *
   * Done in two passes: (1) synchronously empty every seat and cancel any
   * disconnect timers so the table is *immediately* clear, then (2) credit
   * wallets in parallel. A slow DB on one credit must never leave seats
   * occupied.
   */
  async adminForceClear(tableId: string): Promise<number[]> {
    const table = this.tables.get(tableId);
    if (!table) throw new Error("table not found");
    this.clearBotActionTimer(tableId);
    const before = table.seats
      .filter((s) => s.playerId !== null)
      .map((s) => `seat${s.seatIndex}:p${s.playerId}(${s.username},stack=${s.stack},committed=${s.totalCommitted},conn=${s.isConnected})`);
    console.log(
      `[adminForceClear] tableId=${tableId} occupiedBefore=${before.length} seats=[${before.join(" ")}]`,
    );
    // Pass 1 — snapshot refunds before abortHand clears committed chips.
    const refunds: Array<{ playerId: number; amount: number }> = [];
    for (const seat of table.seats) {
      if (seat.playerId === null) continue;
      const playerId = seat.playerId;
      table.cancelDisconnectTimer(playerId);
      if (!seat.isBot) {
        refunds.push({ playerId, amount: seat.stack + seat.totalCommitted });
      }
    }
    table.abortHand();
    // Pass 2 — synchronous seat eviction.
    for (const seat of table.seats) {
      if (seat.playerId === null) continue;
      table.removeSeat(seat);
    }
    // Pass 3 — credit wallets in parallel. Each goes through the retry
    // helper; a final terminal failure logs CRITICAL but doesn't reject
    // the parallel batch (admin still wants the table cleared even if one
    // wallet write keeps failing — the alternative is a half-cleared
    // table).
    await Promise.all(
      refunds
        .filter((r) => r.amount > 0)
        .map(async (r) => {
          try {
            await creditWithRetry(r.playerId, r.amount);
          } catch (err) {
            console.error(
              `[lobby] adminForceClear: CRITICAL chip loss for player ${r.playerId} amount=${r.amount}:`,
              err,
            );
          }
        }),
    );
    invalidateLeaderboardCache();
    return refunds.map((r) => r.playerId);
  }

  /**
   * Gracefully cash out every in-memory seat. This is used during local/dev
   * restarts so buy-ins are not stranded when tables disappear from memory.
   */
  async cashOutAll(
    reason = "Server restarted",
  ): Promise<{ players: number; chips: number }> {
    const refunds: Array<{ tableId: string; playerId: number; amount: number }> = [];
    for (const table of this.tables.values()) {
      this.clearBotActionTimer(table.config.id);
      for (const seat of table.seats) {
        if (seat.playerId === null) continue;
        table.cancelDisconnectTimer(seat.playerId);
        if (!seat.isBot) {
          refunds.push({
            tableId: table.config.id,
            playerId: seat.playerId,
            amount: seat.stack + seat.totalCommitted,
          });
        }
      }
      if (table.occupiedSeats().length > 0) {
        table.abortHand();
        for (const seat of table.seats) {
          if (seat.playerId !== null) table.removeSeat(seat);
        }
        this.io.to(table.config.id).emit("table:evicted", {
          tableId: table.config.id,
          reason,
        });
      }
    }

    const chips = refunds.reduce((sum, r) => sum + r.amount, 0);
    await Promise.all(
      refunds
        .filter((r) => r.amount > 0)
        .map(async (r) => {
          try {
            await creditWithRetry(r.playerId, r.amount);
          } catch (err) {
            console.error(
              `[lobby] cashOutAll: CRITICAL chip loss for player ${r.playerId} table=${r.tableId} amount=${r.amount}:`,
              err,
            );
          }
        }),
    );
    if (refunds.length > 0) invalidateLeaderboardCache();
    return { players: refunds.length, chips };
  }

  async rebuy(args: {
    tableId: string;
    playerId: number;
    amount: number;
  }): Promise<{ wallet: number; stack: number }> {
    const table = this.tables.get(args.tableId);
    if (!table) throw new Error("table not found");
    if (
      typeof args.amount !== "number" ||
      !Number.isFinite(args.amount) ||
      !Number.isInteger(args.amount) ||
      args.amount <= 0
    ) {
      throw new Error("rebuy must be a positive integer");
    }
    const seat = table.findSeatByPlayer(args.playerId);
    if (!seat) throw new Error("not at this table");
    const newWallet = await debitWallet(args.playerId, args.amount);
    try {
      const stack = table.rebuy(args.playerId, args.amount);
      // Auto-start a hand if rebuy made it possible.
      if (table.canStartHand()) {
        table.startHand();
      }
      return { wallet: newWallet, stack };
    } catch (err) {
      await refundWithRetry(args.playerId, args.amount);
      throw err;
    }
  }

  // === Internal hooks ===

  private broadcastState(table: Table) {
    const room = this.io.sockets.adapter.rooms.get(table.config.id);
    if (!room) return;
    for (const sid of room) {
      const sock = this.io.sockets.sockets.get(sid);
      if (!sock) continue;
      const playerId =
        (sock.data as { playerId?: number | null }).playerId ?? null;
      sock.emit("table:state", table.publicState(playerId));
    }
  }

  private scheduleBotAction(table: Table): void {
    const tableId = table.config.id;
    const toAct = table.engine?.toActSeatIndex ?? null;
    if (toAct === null) {
      this.clearBotActionTimer(tableId);
      return;
    }
    const seat = table.seats[toAct];
    if (!seat?.isBot || seat.playerId === null) {
      this.clearBotActionTimer(tableId);
      return;
    }
    const key = [
      table.handNumber,
      table.engine?.street,
      toAct,
      table.engine?.currentBet,
      seat.betThisStreet,
      seat.stack,
    ].join(":");
    const existing = this.botActionTimers.get(tableId);
    if (existing?.key === key) return;
    this.clearBotActionTimer(tableId);
    const timer = setTimeout(() => {
      this.botActionTimers.delete(tableId);
      const liveTable = this.tables.get(tableId);
      if (!liveTable?.engine) return;
      const liveToAct = liveTable.engine.toActSeatIndex;
      if (liveToAct === null) return;
      const liveSeat = liveTable.seats[liveToAct];
      if (!liveSeat?.isBot || liveSeat.playerId === null) return;
      try {
        liveTable.applyAction(
          liveSeat.playerId,
          chooseBotAction(liveTable, liveSeat),
        );
      } catch (err) {
        console.error("[bot] action failed:", err);
        try {
          liveTable.applyAction(liveSeat.playerId, { type: "fold" });
        } catch {
          // The table's action timer remains active as a final fallback.
        }
      }
    }, 600 + Math.floor(Math.random() * 700));
    this.botActionTimers.set(tableId, { key, timer });
  }

  private clearBotActionTimer(tableId: string): void {
    const existing = this.botActionTimers.get(tableId);
    if (!existing) return;
    clearTimeout(existing.timer);
    this.botActionTimers.delete(tableId);
  }

  private async handleHandFinished(
    table: Table,
    payload: HandFinishedPayload,
  ) {
    // 1) Compute per-player stats deltas using engine seat snapshot.
    //    We saved enough info on the table seats during the hand to compute this.
    try {
      const deltas = computeStatsDeltas(table, payload);
      const winnersForDb = payload.winners.map((w) => ({
        playerId: w.playerId,
        username: w.username,
        amount: w.amount,
        handDescription: w.handDescription,
      }));
      if (process.env.DATABASE_URL) {
        await recordHandResult({
          tableId: table.config.id,
          handNumber: payload.handNumber,
          winners: winnersForDb,
          potTotal: payload.potTotal,
          communityCards: payload.communityCards.join(" "),
          perPlayer: deltas,
        });
        invalidateLeaderboardCache();
      }
    } catch (err) {
      console.error("[lobby] failed to record hand:", err);
    }

    // 2) Notify clients
    this.io.to(table.config.id).emit("table:handFinished", payload);

    // 3) Refresh table hand history & broadcast to room.
    if (process.env.DATABASE_URL) {
      try {
        const history = await fetchHandHistory(table.config.id, 50);
        this.io.to(table.config.id).emit("table:history", history);
      } catch (err) {
        console.error("[lobby] failed to fetch history:", err);
      }
    }

    // 4) Process pending leaves: any seat with pendingLeave is a player who
    //    called table:leave (or was disconnected past their grace) during the
    //    just-finished hand. Now that the hand is over, actually remove the
    //    seat and credit their stack back to their wallet.
    for (const seat of table.seats) {
      if (!seat.pendingLeave || seat.playerId === null) continue;
      const playerId = seat.playerId;
      const isBot = seat.isBot;
      const stack = table.removeSeat(seat);
      if (isBot) continue;
      if (stack > 0) {
        try {
          const newWallet = await creditWithRetry(playerId, stack);
          // Push the updated wallet to the leaving player's socket if still connected.
          const sockets = await this.io.fetchSockets();
          for (const s of sockets) {
            if ((s.data as { playerId?: number | null }).playerId === playerId) {
              s.emit("wallet:update", newWallet);
              s.leave(table.config.id);
            }
          }
        } catch (err) {
          console.error(
            `[lobby] pendingLeave: CRITICAL chip loss for player ${playerId} stack=${stack}:`,
            err,
          );
        }
      }
    }

    // 5) Auto-stand any player whose stack is below big blind AND has been
    //    timed out repeatedly. For simplicity, leave manual rebuy/leave to player.
  }

  /**
   * Called when a socket disconnects. Starts a 60s grace timer; if not back,
   * stand up and refund stack.
   */
  handleDisconnect(playerId: number) {
    for (const table of this.tables.values()) {
      const seat = table.findSeatByPlayer(playerId);
      if (!seat) continue;
      table.setConnected(playerId, false);
      table.startDisconnectTimer(playerId, 60_000, async () => {
        try {
          const seatNow = table.findSeatByPlayer(playerId);
          if (!seatNow) return;
          if (seatNow.isConnected) return; // reconnected
          await this.cashOut({ tableId: table.config.id, playerId });
        } catch (err) {
          console.error("[lobby] disconnect cashout failed:", err);
        }
      });
    }
  }

  handleReconnect(playerId: number) {
    for (const table of this.tables.values()) {
      if (table.findSeatByPlayer(playerId)) {
        table.cancelDisconnectTimer(playerId);
        table.setConnected(playerId, true);
      }
    }
  }
}

/**
 * Best-effort wallet refund (legacy, used by buyIn/rebuy rollback paths).
 * Wraps creditWithRetry but swallows the final error after logging since
 * the rollback caller has nothing meaningful to do with it (the original
 * action they were rolling back has already errored).
 */
async function refundWithRetry(playerId: number, amount: number): Promise<void> {
  try {
    await creditWithRetry(playerId, amount);
  } catch (err) {
    console.error(
      `[lobby] CRITICAL: refund of ${amount} chips for player ${playerId} failed after 5 attempts:`,
      err,
    );
  }
}

/**
 * Credit a player's wallet with retry. Returns the new wallet balance on
 * success. Throws after 5 failed attempts with exponential backoff —
 * caller decides what to do with a terminal failure (typically log
 * CRITICAL and surface to ops).
 *
 * Used by every cash-out path (cashOut, pendingLeave, adminForceClear)
 * so a single transient DB hiccup can never silently lose chips.
 */
async function creditWithRetry(playerId: number, amount: number): Promise<number> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await creditWallet(playerId, amount);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 50 * Math.pow(2, attempt)));
    }
  }
  throw lastErr ?? new Error("creditWithRetry exhausted");
}

function chooseBotAction(table: Table, seat: TableSeat): PlayerAction {
  const currentBet = table.engine?.currentBet ?? 0;
  const toCall = Math.max(0, currentBet - seat.betThisStreet);
  if (toCall <= 0) {
    return { type: "check" };
  }

  const cheapByBlind = toCall <= table.config.bigBlind * 2;
  const cheapByStack = toCall <= Math.max(1, Math.floor(seat.stack * 0.2));
  if (cheapByBlind || cheapByStack) {
    return { type: "call" };
  }

  return Math.random() < 0.2 ? { type: "call" } : { type: "fold" };
}
