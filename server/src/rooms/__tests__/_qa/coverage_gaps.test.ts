// Coverage for plan items at the Table layer that the first pass deferred:
// timer cleanup on hand finish, all-sit-out, multi-pot stat deltas,
// disconnect timer behavior, public-state correctness across many states,
// abortHand idempotency.

import { describe, it, expect, vi } from "vitest";
import { Table } from "../../table.js";
import { computeStatsDeltas } from "../../stats.js";

const noopEvents = {
  onStateChange: () => {},
  onHandFinished: () => {},
  onActionTimeout: () => {},
};

const cfg = {
  id: "tg",
  name: "QA",
  maxSeats: 5,
  smallBlind: 5,
  bigBlind: 10,
  minBuyIn: 100,
  maxBuyIn: 1000,
};

// ===== timers ============================================================

describe("2.4.5 action timer cleared on hand finish", () => {
  it("forceTimeoutAction does not schedule a new timer once the hand is complete", () => {
    vi.useFakeTimers();
    try {
      const t = new Table(cfg, noopEvents);
      t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
      t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
      t.setReady(1, true);
      t.setReady(2, true);
      t.startHand();
      // Heads-up SB (=dealer) acts first preflop. Timeout will force fold,
      // ending the hand (only one live seat).
      t.forceTimeoutAction();
      expect(t.engine).toBeNull();
      // No actionDeadline lingering after a finished hand.
      expect(t.actionDeadline).toBeNull();
      // Advance time past the original turn timeout — nothing should fire.
      vi.advanceTimersByTime(60_000);
      // Still no engine, no exception.
      expect(t.engine).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ===== all sit out =======================================================

describe("all players sit out simultaneously [post-fix: deferred]", () => {
  it("during a hand → both flagged pendingSitOut, neither sittingOut yet", () => {
    const t = new Table(cfg, noopEvents);
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.startHand();
    t.setSittingOut(1, true);
    t.setSittingOut(2, true);
    expect(t.engine).not.toBeNull();
    expect(t.engine!.toActSeatIndex).not.toBeNull();
    // Both deferred (would dodge if applied immediately).
    expect(t.seats[0]!.pendingSitOut).toBe(true);
    expect(t.seats[1]!.pendingSitOut).toBe(true);
    expect(t.seats[0]!.sittingOut).toBe(false);
    expect(t.seats[1]!.sittingOut).toBe(false);
  });

  it("after the hand finishes, deferred sit-outs apply and no auto-start", () => {
    const t = new Table(cfg, noopEvents);
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.startHand();
    t.setSittingOut(1, true);
    t.setSittingOut(2, true);
    // Force the to-act player's timeout — they fold, hand ends.
    t.forceTimeoutAction();
    expect(t.engine).toBeNull();
    expect(t.seats[0]!.sittingOut).toBe(true);
    expect(t.seats[1]!.sittingOut).toBe(true);
    expect(t.canStartHand()).toBe(false);
  });
});

// ===== abortHand idempotency =============================================

describe("abortHand idempotent + safe with no engine", () => {
  it("abortHand on a table with no engine does not throw", () => {
    const t = new Table(cfg, noopEvents);
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    expect(() => t.abortHand()).not.toThrow();
    expect(t.engine).toBeNull();
  });

  it("abortHand twice in a row is safe", () => {
    const t = new Table(cfg, noopEvents);
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.startHand();
    t.abortHand();
    expect(() => t.abortHand()).not.toThrow();
    expect(t.engine).toBeNull();
  });
});

// ===== disconnect timer behavior =========================================

describe("disconnect timer", () => {
  it("startDisconnectTimer fires after grace if not cancelled", () => {
    vi.useFakeTimers();
    try {
      const t = new Table(cfg, noopEvents);
      t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
      let fired = false;
      t.startDisconnectTimer(1, 5_000, () => {
        fired = true;
      });
      vi.advanceTimersByTime(4_999);
      expect(fired).toBe(false);
      vi.advanceTimersByTime(2);
      expect(fired).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancelDisconnectTimer prevents fire", () => {
    vi.useFakeTimers();
    try {
      const t = new Table(cfg, noopEvents);
      t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
      let fired = false;
      t.startDisconnectTimer(1, 5_000, () => {
        fired = true;
      });
      t.cancelDisconnectTimer(1);
      vi.advanceTimersByTime(10_000);
      expect(fired).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-starting a disconnect timer cancels the previous one", () => {
    vi.useFakeTimers();
    try {
      const t = new Table(cfg, noopEvents);
      t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
      let fires = 0;
      t.startDisconnectTimer(1, 5_000, () => fires++);
      vi.advanceTimersByTime(2_000);
      t.startDisconnectTimer(1, 5_000, () => fires++);
      vi.advanceTimersByTime(4_000);
      // Old would have fired at t=5000; verify only the new timer counts.
      expect(fires).toBe(0);
      vi.advanceTimersByTime(2_000);
      expect(fires).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroy clears all disconnect timers", () => {
    vi.useFakeTimers();
    try {
      const t = new Table(cfg, noopEvents);
      t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
      t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
      let fires = 0;
      t.startDisconnectTimer(1, 5_000, () => fires++);
      t.startDisconnectTimer(2, 5_000, () => fires++);
      t.destroy();
      vi.advanceTimersByTime(10_000);
      expect(fires).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ===== stats deltas with side pots =======================================

describe("computeStatsDeltas with multi-pot showdowns", () => {
  it("biggestPotWon = max single-pot share when winning multiple pots", () => {
    // Construct a table state directly. The lobby's handleHandFinished
    // computes deltas off the table's snapshot, so we mimic that.
    const t = new Table(cfg, noopEvents);
    t.sitDown({ playerId: 1, username: "a", buyIn: 500 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 500 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.startHand();
    // End hand cheaply by force-folding.
    t.applyAction(t.seats[t.engine!.toActSeatIndex!]!.playerId!, { type: "fold" });
    expect(t.lastHand).not.toBeNull();
    // Synthesize a payload as if this player won multiple pots of varying
    // sizes (simulates side-pot scenario).
    const fakePayload = {
      ...t.lastHand!,
      winners: [
        { seatIndex: 0, playerId: 1, username: "a", amount: 50, handDescription: "x", potIndex: 0, showCards: null },
        { seatIndex: 0, playerId: 1, username: "a", amount: 200, handDescription: "x", potIndex: 1, showCards: null },
      ],
    };
    const deltas = computeStatsDeltas(t, fakePayload);
    const a = deltas.find((d) => d.playerId === 1)!;
    expect(a.grossWon).toBe(250);
    expect(a.biggestPotWon).toBe(200);
    expect(a.wonHand).toBe(true);
  });

  it("loser delta: netDelta negative, grossLost = contributed", () => {
    const t = new Table(cfg, noopEvents);
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.startHand();
    // SB folds → BB wins SB.
    t.applyAction(1, { type: "fold" });
    const deltas = computeStatsDeltas(t, t.lastHand!);
    const loser = deltas.find((d) => d.playerId === 1)!;
    expect(loser.netDelta).toBe(-5); // SB lost 5
    expect(loser.grossLost).toBe(5);
    expect(loser.grossWon).toBe(0);
    expect(loser.wonHand).toBe(false);
  });
});

// ===== public state correctness across states ===========================

describe("publicState correctness across phases", () => {
  it("idle: no engine, sensible defaults", () => {
    const t = new Table(cfg, noopEvents);
    const s = t.publicState(null);
    expect(s.street).toBe("idle");
    expect(s.communityCards).toEqual([]);
    expect(s.pots).toEqual([]);
    expect(s.totalPot).toBe(0);
    expect(s.toActSeat).toBeNull();
    expect(s.currentBet).toBe(0);
    expect(s.minRaise).toBe(cfg.bigBlind);
  });

  it("preflop: dealer + toAct populated, hole cards only for requester", () => {
    const t = new Table(cfg, noopEvents);
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.startHand();
    const s1 = t.publicState(1);
    const s2 = t.publicState(2);
    const sNull = t.publicState(null);
    const own1 = s1.seats.find((s) => s.playerId === 1)!;
    const opp1 = s1.seats.find((s) => s.playerId === 2)!;
    expect(own1.holeCards).not.toBeNull();
    expect(opp1.holeCards).toBeNull();
    expect(opp1.hasCards).toBe(true);
    // Spectator (forPlayerId=null) sees nobody's cards.
    for (const seat of sNull.seats) {
      expect(seat.holeCards).toBeNull();
    }
    // Each player sees only their own.
    const own2 = s2.seats.find((s) => s.playerId === 2)!;
    expect(own2.holeCards).not.toBeNull();
  });
});

// ===== ready flag behavior ==============================================

describe("ready flag", () => {
  it("standUp clears ready (verified via removeSeat)", () => {
    const t = new Table(cfg, noopEvents);
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.setReady(1, true);
    expect(t.findSeatByPlayer(1)!.ready).toBe(true);
    t.standUp(1);
    // After removal, the seat is empty. Re-seating starts ready=false.
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    expect(t.findSeatByPlayer(1)!.ready).toBe(false);
  });
});
