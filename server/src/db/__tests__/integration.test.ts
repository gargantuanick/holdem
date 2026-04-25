import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { closePool, getSql } from "../client.js";
import { runMigrations } from "../migrate.js";
import {
  creditWallet,
  debitWallet,
  findOrCreatePlayer,
  getPlayerById,
  STARTING_WALLET,
  tryRefill,
  validateUsername,
} from "../players.js";
import { createSession, getPlayerIdForToken } from "../sessions.js";
import { recordHandResult, fetchHandHistory } from "../handHistory.js";
import { getLeaderboard, invalidateLeaderboardCache } from "../leaderboard.js";

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const describeIfDb = DB_URL ? describe : describe.skip;

if (DB_URL) {
  // Override DATABASE_URL so getSql() picks it up.
  process.env.DATABASE_URL = DB_URL;
}

describeIfDb("DB integration", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    const sql = getSql();
    // Clean state — delete test players (prefixed t_) and their sessions/history.
    await sql`DELETE FROM hand_history WHERE table_id LIKE 'test-%'`;
    await sql`DELETE FROM sessions WHERE player_id IN
      (SELECT id FROM players WHERE username LIKE 't\\_%' ESCAPE '\\')`;
    await sql`DELETE FROM players WHERE username LIKE 't\\_%' ESCAPE '\\'`;
  });

  it("findOrCreatePlayer creates with starting wallet, then idempotent", async () => {
    const p1 = await findOrCreatePlayer("t_alice");
    expect(p1.username).toBe("t_alice");
    expect(p1.walletChips).toBe(STARTING_WALLET);
    expect(p1.handsPlayed).toBe(0);

    const p2 = await findOrCreatePlayer("t_alice");
    expect(p2.id).toBe(p1.id);
    expect(p2.walletChips).toBe(STARTING_WALLET);
  });

  it("validateUsername rejects bad input", () => {
    expect(validateUsername("a")).toBeNull();
    expect(validateUsername("with space")).toBeNull();
    expect(validateUsername("looooooooooooooooooooong")).toBeNull();
    expect(validateUsername("ok_name1")).toBe("ok_name1");
    expect(validateUsername("  trimmed  ")).toBe("trimmed");
  });

  it("debit/credit wallet round-trip", async () => {
    const p = await findOrCreatePlayer("t_bob");
    const w1 = await debitWallet(p.id, 500);
    expect(w1).toBe(STARTING_WALLET - 500);
    const w2 = await creditWallet(p.id, 200);
    expect(w2).toBe(STARTING_WALLET - 300);
  });

  it("debit beyond balance throws and does not mutate", async () => {
    const p = await findOrCreatePlayer("t_carol");
    await expect(debitWallet(p.id, STARTING_WALLET + 1)).rejects.toThrow();
    const fresh = await getPlayerById(p.id);
    expect(fresh!.walletChips).toBe(STARTING_WALLET);
  });

  it("session creation and resolution", async () => {
    const p = await findOrCreatePlayer("t_dan");
    const tok = await createSession(p.id);
    const pid = await getPlayerIdForToken(tok);
    expect(pid).toBe(p.id);
  });

  it("recordHandResult updates stats in transaction", async () => {
    const a = await findOrCreatePlayer("t_eve");
    const b = await findOrCreatePlayer("t_finn");
    await recordHandResult({
      tableId: "test-rh-1",
      handNumber: 1,
      winners: [
        { playerId: a.id, username: a.username, amount: 200, handDescription: "Pair of Aces" },
      ],
      potTotal: 200,
      communityCards: "Ah Ks 7d 2c 9h",
      perPlayer: [
        { playerId: a.id, netDelta: 100, grossWon: 200, grossLost: 0, wonHand: true, biggestPotWon: 200 },
        { playerId: b.id, netDelta: -100, grossWon: 0, grossLost: 100, wonHand: false, biggestPotWon: 0 },
      ],
    });
    const aa = await getPlayerById(a.id);
    const bb = await getPlayerById(b.id);
    expect(aa!.handsPlayed).toBe(1);
    expect(aa!.handsWon).toBe(1);
    expect(aa!.totalChipsWon).toBe(200);
    expect(aa!.biggestPotWon).toBe(200);
    expect(bb!.handsPlayed).toBe(1);
    expect(bb!.handsWon).toBe(0);
    expect(bb!.totalChipsLost).toBe(100);

    const hist = await fetchHandHistory("test-rh-1", 10);
    expect(hist).toHaveLength(1);
    expect(hist[0]!.handNumber).toBe(1);
    expect(hist[0]!.potTotal).toBe(200);
  });

  it("tryRefill respects cooldown and zero-balance gate", async () => {
    const p = await findOrCreatePlayer("t_grace");
    // Should fail because wallet > 0
    const f1 = await tryRefill(p.id);
    expect(f1.ok).toBe(false);
    // Drain to 0
    await debitWallet(p.id, STARTING_WALLET);
    const ok = await tryRefill(p.id);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.wallet).toBe(1000);
    // Cannot refill again immediately (last_refill_at set)
    await debitWallet(p.id, 1000);
    const f2 = await tryRefill(p.id);
    expect(f2.ok).toBe(false);
  });

  it("leaderboard returns top players by wallet", async () => {
    invalidateLeaderboardCache();
    const a = await findOrCreatePlayer("t_h1");
    const b = await findOrCreatePlayer("t_h2");
    await creditWallet(a.id, 50000);
    await creditWallet(b.id, 5000);
    const top = await getLeaderboard("wallet", 20);
    const aRank = top.find((r) => r.username === "t_h1");
    const bRank = top.find((r) => r.username === "t_h2");
    expect(aRank).toBeDefined();
    expect(bRank).toBeDefined();
    expect(aRank!.rank).toBeLessThan(bRank!.rank);
  });
});
