// Lobby createTable validation. Reachable via the lobby:create socket
// event — these inputs come from the client and must reject all the
// pathological cases. Listed as plan section 7 / createTable boundaries.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Lobby } from "../../lobby.js";
import * as players from "../../../db/players.js";

// Lobby pulls in DB modules at construction time via seedDefaultTables. We
// stub the modules it touches at import time so we can construct a Lobby
// without a real DB.

vi.mock("../../../db/players.js", () => ({
  creditWallet: vi.fn().mockResolvedValue(0),
  debitWallet: vi.fn().mockResolvedValue(0),
  getPlayerById: vi.fn().mockResolvedValue(null),
  incrementTablesJoined: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../db/handHistory.js", () => ({
  fetchHandHistory: vi.fn().mockResolvedValue([]),
  recordHandResult: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../db/leaderboard.js", () => ({
  invalidateLeaderboardCache: vi.fn(),
}));

// Minimal io stub.
function fakeIo() {
  return {
    sockets: { adapter: { rooms: new Map() }, sockets: new Map() },
    to: () => ({ emit: vi.fn() }),
    fetchSockets: async () => [],
  } as unknown as ConstructorParameters<typeof Lobby>[0];
}

function newLobby() {
  return new Lobby(fakeIo());
}

const baseArgs = {
  name: "T",
  maxSeats: 3,
  smallBlind: 5,
  bigBlind: 10,
  minBuyIn: 50,
  maxBuyIn: 500,
};

describe("createTable validation (plan §7)", () => {
  it("rejects non-finite blind values", () => {
    const lobby = newLobby();
    expect(() =>
      lobby.createTable({ ...baseArgs, smallBlind: NaN }),
    ).toThrow(/finite/);
    expect(() =>
      lobby.createTable({ ...baseArgs, bigBlind: Infinity }),
    ).toThrow(/finite/);
  });

  it("rejects non-integer values", () => {
    const lobby = newLobby();
    expect(() =>
      lobby.createTable({ ...baseArgs, smallBlind: 5.5 }),
    ).toThrow(/finite integer/);
  });

  it("rejects empty / overlong names", () => {
    const lobby = newLobby();
    expect(() => lobby.createTable({ ...baseArgs, name: "" })).toThrow(/required/);
    expect(() =>
      lobby.createTable({ ...baseArgs, name: "x".repeat(41) }),
    ).toThrow(/too long/);
  });

  it("rejects maxSeats outside 2..5", () => {
    const lobby = newLobby();
    expect(() => lobby.createTable({ ...baseArgs, maxSeats: 1 })).toThrow();
    expect(() => lobby.createTable({ ...baseArgs, maxSeats: 6 })).toThrow();
  });

  it("rejects SB >= BB", () => {
    const lobby = newLobby();
    expect(() =>
      lobby.createTable({ ...baseArgs, smallBlind: 10, bigBlind: 10 }),
    ).toThrow(/smallBlind/);
  });

  it("rejects minBuyIn < 2 BB", () => {
    const lobby = newLobby();
    expect(() =>
      lobby.createTable({ ...baseArgs, minBuyIn: 19 }), // BB=10 → must be ≥ 20
    ).toThrow(/2 BB/);
  });

  it("rejects maxBuyIn < minBuyIn", () => {
    const lobby = newLobby();
    expect(() =>
      lobby.createTable({ ...baseArgs, maxBuyIn: 49 }),
    ).toThrow(/maxBuyIn/);
  });

  it("rejects negative blinds", () => {
    const lobby = newLobby();
    expect(() =>
      lobby.createTable({ ...baseArgs, smallBlind: -1, bigBlind: 5 }),
    ).toThrow(/blinds/);
  });

  it("accepts a valid config", () => {
    const lobby = newLobby();
    expect(() => lobby.createTable(baseArgs)).not.toThrow();
  });
});

describe("buyIn validation", () => {
  it("rejects non-integer buyIn", async () => {
    const lobby = newLobby();
    const [t] = lobby.listTables();
    await expect(
      lobby.buyIn({
        tableId: t!.id,
        playerId: 1,
        username: "a",
        buyIn: 200.5,
      }),
    ).rejects.toThrow(/positive integer/);
  });

  it("rejects negative buyIn", async () => {
    const lobby = newLobby();
    const [t] = lobby.listTables();
    await expect(
      lobby.buyIn({
        tableId: t!.id,
        playerId: 1,
        username: "a",
        buyIn: -1,
      }),
    ).rejects.toThrow(/positive integer/);
  });

  it("rejects NaN buyIn", async () => {
    const lobby = newLobby();
    const [t] = lobby.listTables();
    await expect(
      lobby.buyIn({
        tableId: t!.id,
        playerId: 1,
        username: "a",
        buyIn: NaN,
      }),
    ).rejects.toThrow(/positive integer/);
  });
});

describe("bot seats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(players.creditWallet).mockResolvedValue(0);
    vi.mocked(players.debitWallet).mockResolvedValue(0);
  });

  it("adds and removes bots without touching player wallets", () => {
    const lobby = newLobby();
    const [summary] = lobby.listTables();
    const tableId = summary!.id;

    const bot = lobby.addBot({ tableId });
    const table = lobby.getTable(tableId)!;

    expect(table.findSeatByPlayer(bot.playerId)?.isBot).toBe(true);
    expect(table.findSeatByPlayer(bot.playerId)?.ready).toBe(true);

    const removed = lobby.removeBot({ tableId, playerId: bot.playerId });

    expect(removed.deferred).toBe(false);
    expect(table.findSeatByPlayer(bot.playerId)).toBeNull();
    expect(vi.mocked(players.debitWallet)).not.toHaveBeenCalled();
    expect(vi.mocked(players.creditWallet)).not.toHaveBeenCalled();
  });

  it("does not start bot-only hands", () => {
    const lobby = newLobby();
    const table = lobby.createTable({
      ...baseArgs,
      name: "CPU Test",
      maxSeats: 2,
    });

    lobby.addBot({ tableId: table.config.id, buyIn: 50 });
    lobby.addBot({ tableId: table.config.id, buyIn: 50 });

    expect(table.engine).toBeNull();
    expect(table.canStartHand()).toBe(false);
    expect(() => table.startHand()).toThrow(/real player/);
  });

  it("admin cleanup refunds human seats but skips bot seats", async () => {
    const lobby = newLobby();
    const [summary] = lobby.listTables();
    const tableId = summary!.id;

    vi.mocked(players.debitWallet).mockResolvedValue(9_800);
    await lobby.buyIn({ tableId, playerId: 1, username: "a", buyIn: 200 });
    const bot = lobby.addBot({ tableId });
    const table = lobby.getTable(tableId)!;
    table.setReady(1, true);
    table.startHand();

    vi.mocked(players.creditWallet).mockResolvedValue(10_000);
    const cleared = await lobby.adminForceClear(tableId);

    expect(cleared).toEqual([1]);
    expect(table.findSeatByPlayer(bot.playerId)).toBeNull();
    expect(vi.mocked(players.creditWallet)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(players.creditWallet)).toHaveBeenCalledWith(1, 200);
  });
});

// =========================================================================
// Fix #3 — chip-loss-on-credit-failure regression coverage
// =========================================================================

describe("cashOut credit retry [post-fix]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default behaviour after any per-test mockResolvedValueOnce
    // sequences from a prior test bleed through.
    vi.mocked(players.creditWallet).mockResolvedValue(0);
    vi.mocked(players.debitWallet).mockResolvedValue(0);
  });

  it("transient creditWallet failure is retried and ultimately succeeds (no chip loss)", async () => {
    const lobby = newLobby();
    const [t] = lobby.listTables();
    // Seat the player so we have something to cash out.
    vi.mocked(players.debitWallet).mockResolvedValueOnce(9_800);
    await lobby.buyIn({
      tableId: t!.id,
      playerId: 1,
      username: "a",
      buyIn: 200,
    });
    // Make creditWallet fail twice, then succeed. The retry helper does
    // exponential backoff at 50/100/200/400/800ms — well under the test
    // timeout.
    vi.mocked(players.creditWallet)
      .mockRejectedValueOnce(new Error("conn reset"))
      .mockRejectedValueOnce(new Error("conn reset"))
      .mockResolvedValueOnce(10_000);
    const result = await lobby.cashOut({ tableId: t!.id, playerId: 1 });
    expect(result.deferred).toBe(false);
    expect(result.wallet).toBe(10_000);
    // Confirm the retry happened (3 calls total: 2 failures + 1 success).
    expect(vi.mocked(players.creditWallet)).toHaveBeenCalledTimes(3);
  });

  it("terminal creditWallet failure throws (caller can surface to ops, no silent loss)", async () => {
    const lobby = newLobby();
    const [t] = lobby.listTables();
    vi.mocked(players.debitWallet).mockResolvedValueOnce(9_800);
    await lobby.buyIn({
      tableId: t!.id,
      playerId: 2,
      username: "b",
      buyIn: 200,
    });
    // Fail every retry attempt.
    vi.mocked(players.creditWallet).mockRejectedValue(new Error("DB down"));
    await expect(
      lobby.cashOut({ tableId: t!.id, playerId: 2 }),
    ).rejects.toThrow(/DB down/);
    // 5 retries.
    expect(vi.mocked(players.creditWallet)).toHaveBeenCalledTimes(5);
  });
});

describe("forced table cleanup refunds committed chips", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(players.creditWallet).mockResolvedValue(0);
    vi.mocked(players.debitWallet).mockResolvedValue(0);
  });

  async function seatTwoReadyPlayers() {
    const lobby = newLobby();
    const [summary] = lobby.listTables();
    const tableId = summary!.id;
    vi.mocked(players.debitWallet).mockResolvedValue(9_800);
    await lobby.buyIn({ tableId, playerId: 1, username: "a", buyIn: 200 });
    await lobby.buyIn({ tableId, playerId: 2, username: "b", buyIn: 200 });
    const table = lobby.getTable(tableId)!;
    table.setReady(1, true);
    table.setReady(2, true);
    table.startHand();
    return { lobby, tableId };
  }

  it("cashOutAll refunds stack plus committed blind chips on shutdown", async () => {
    const { lobby } = await seatTwoReadyPlayers();
    vi.mocked(players.creditWallet).mockResolvedValue(10_000);

    const result = await lobby.cashOutAll();

    expect(result).toEqual({ players: 2, chips: 400 });
    expect(vi.mocked(players.creditWallet)).toHaveBeenCalledWith(1, 200);
    expect(vi.mocked(players.creditWallet)).toHaveBeenCalledWith(2, 200);
  });

  it("adminForceClear refunds stack plus committed blind chips", async () => {
    const { lobby, tableId } = await seatTwoReadyPlayers();
    vi.mocked(players.creditWallet).mockResolvedValue(10_000);

    const cleared = await lobby.adminForceClear(tableId);

    expect(cleared.sort()).toEqual([1, 2]);
    expect(vi.mocked(players.creditWallet)).toHaveBeenCalledWith(1, 200);
    expect(vi.mocked(players.creditWallet)).toHaveBeenCalledWith(2, 200);
  });
});
