import { randomUUID } from "node:crypto";
import type { Server } from "socket.io";
import type {
  ClientToServerEvents,
  HandFinishedPayload,
  LobbyTableSummary,
  ServerToClientEvents,
  TableConfig,
} from "@holdem/shared";
import { Table } from "./table.js";
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
  /** Tracks which playerIds entered each table this session (for tables_joined++). */
  private joinedAt = new Map<string, Set<number>>();

  constructor(io: Server<ClientToServerEvents, ServerToClientEvents>) {
    this.io = io;
    this.seedDefaultTables();
  }

  private seedDefaultTables() {
    this.createTable({
      name: "Beginner Stakes",
      maxSeats: 6,
      smallBlind: 5,
      bigBlind: 10,
      minBuyIn: 200, // 20× BB
      maxBuyIn: 1000, // 100× BB
    });
    this.createTable({
      name: "Mid Stakes",
      maxSeats: 9,
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
    if (args.maxSeats < 2 || args.maxSeats > 9) {
      throw new Error("maxSeats must be 2..9");
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
      onStateChange: (t) => this.broadcastState(t),
      onHandFinished: (t, payload) => this.handleHandFinished(t, payload),
      onActionTimeout: () => {
        // No-op: state broadcast already covers it.
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
    if (table.findSeatByPlayer(args.playerId)) {
      throw new Error("already at this table");
    }
    if (args.buyIn < table.config.minBuyIn) {
      throw new Error(`buy-in below table minimum`);
    }
    if (args.buyIn > table.config.maxBuyIn) {
      throw new Error(`buy-in above table maximum`);
    }
    // Debit first; if seating fails, refund.
    const newWallet = await debitWallet(args.playerId, args.buyIn);
    try {
      table.sitDown({
        playerId: args.playerId,
        username: args.username,
        buyIn: args.buyIn,
        seatIndex: args.seatIndex,
      });
    } catch (err) {
      await creditWallet(args.playerId, args.buyIn);
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
      const wallet = await creditWallet(args.playerId, stack);
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
   */
  async adminForceClear(tableId: string): Promise<number[]> {
    const table = this.tables.get(tableId);
    if (!table) throw new Error("table not found");
    table.abortHand();
    const cleared: number[] = [];
    for (const seat of table.seats) {
      if (seat.playerId === null) continue;
      const playerId = seat.playerId;
      const stack = table.removeSeat(seat);
      if (stack > 0) {
        try {
          await creditWallet(playerId, stack);
        } catch (err) {
          console.error("[lobby] adminForceClear credit failed:", err);
        }
      }
      cleared.push(playerId);
    }
    invalidateLeaderboardCache();
    return cleared;
  }

  async rebuy(args: {
    tableId: string;
    playerId: number;
    amount: number;
  }): Promise<{ wallet: number; stack: number }> {
    const table = this.tables.get(args.tableId);
    if (!table) throw new Error("table not found");
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
      await creditWallet(args.playerId, args.amount);
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

    // 4) Process pending leaves: any seat with pendingLeave → cashOut now.
    for (const seat of table.seats) {
      if (
        seat.playerId !== null &&
        // pendingLeave is reset before this hook runs; we instead detect "wants
        // to leave" via stale flags. Simpler: track via seat.sittingOut + cashOut
        // sentinel. For now, if a seat is empty stack + sittingOut, leave it.
        seat.stack === 0 &&
        seat.sittingOut === false &&
        // Player chose to leave: we encoded that as table.standUp setting
        // pendingLeave during the hand. Already handled in finishHand path.
        false
      ) {
        // no-op
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
