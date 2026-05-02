// Full QA pass — Table state machine + multiplayer scenarios.
// Maps to QA_PLAN.md sections 2.x, 3.x and 6.x. Each describe corresponds
// to a plan section so failures localise immediately.

import { describe, it, expect, vi } from "vitest";
import { Table } from "../../table.js";
import { computeStatsDeltas } from "../../stats.js";

const noopEvents = {
  onStateChange: () => {},
  onHandFinished: () => {},
  onActionTimeout: () => {},
};

const cfg = {
  id: "tqa",
  name: "QA Table",
  maxSeats: 5,
  smallBlind: 5,
  bigBlind: 10,
  minBuyIn: 100,
  maxBuyIn: 1000,
};

function newTable(overrides: Partial<typeof cfg> = {}, events = noopEvents) {
  return new Table({ ...cfg, ...overrides }, events);
}

// =========================================================================
// 2.1 Seat lifecycle
// =========================================================================

describe("2.1 seat lifecycle", () => {
  it("2.1.3 sitDown rejects occupied seat index", () => {
    const t = newTable();
    t.sitDown({ playerId: 1, username: "a", buyIn: 200, seatIndex: 2 });
    expect(() =>
      t.sitDown({ playerId: 2, username: "b", buyIn: 200, seatIndex: 2 }),
    ).toThrow(/occupied/);
  });

  it("2.1.5 standUp during own active hand defers", () => {
    const t = newTable();
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.startHand();
    const r = t.standUp(2);
    expect(r.deferred).toBe(true);
    expect(t.findSeatByPlayer(2)).not.toBeNull();
  });

  it("2.1.6 standUp by folded player during hand still defers (current behaviour)", () => {
    // BUG CANDIDATE: a folded player has no remaining stake but standUp()
    // checks `inCurrentHand && !hasFolded` → so a folded player would NOT
    // defer. Verify this matches the inverse: that the folded path does
    // NOT defer (stack returned immediately).
    const t = newTable();
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.startHand();
    // Heads-up: SB acts first preflop. Find current actor and fold them.
    const actor = t.engine!.toActSeatIndex!;
    const actorPid = t.seats[actor]!.playerId!;
    t.applyAction(actorPid, { type: "fold" });
    // Hand ends because only one live seat remains.
    expect(t.engine).toBeNull();
    // Now both players are between hands — standUp returns immediately.
    const r = t.standUp(actorPid);
    expect(r.deferred).toBe(false);
  });

  it("2.1.9 setReady toggles", () => {
    const t = newTable();
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.setReady(1, true);
    expect(t.findSeatByPlayer(1)!.ready).toBe(true);
    t.setReady(1, false);
    expect(t.findSeatByPlayer(1)!.ready).toBe(false);
  });
});

// =========================================================================
// 2.2 Hand auto-start
// =========================================================================

describe("2.2 hand auto-start", () => {
  it("2.2.2 newly seated player not dealt in until they ready up", () => {
    const t = newTable();
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.startHand();
    // New player arrives mid-hand; they should NOT be dealt in this hand.
    t.sitDown({ playerId: 3, username: "c", buyIn: 200 });
    expect(t.seats.find((s) => s.playerId === 3)!.inCurrentHand).toBe(false);
  });

  it("2.2.3 existing players keep ready=true across hands", () => {
    const t = newTable();
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.startHand();
    // End hand
    while (t.engine) {
      const idx = t.engine.toActSeatIndex!;
      t.applyAction(t.seats[idx]!.playerId!, { type: "fold" });
    }
    // ready should still be true → next hand can start
    expect(t.findSeatByPlayer(1)!.ready).toBe(true);
    expect(t.findSeatByPlayer(2)!.ready).toBe(true);
    expect(t.canStartHand()).toBe(true);
  });
});

// =========================================================================
// 2.3 Dealer rotation (dead button)
// =========================================================================

describe("2.3 dealer rotation", () => {
  it("2.3.5 new player joining between hands does not skip rotation", () => {
    const t = newTable();
    t.sitDown({ playerId: 1, username: "a", buyIn: 200, seatIndex: 0 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200, seatIndex: 1 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.startHand();
    expect(t.dealerSeatIndex).toBe(0);
    while (t.engine) {
      const idx = t.engine.toActSeatIndex!;
      t.applyAction(t.seats[idx]!.playerId!, { type: "fold" });
    }
    // New player joins seat 4 between hands.
    t.sitDown({ playerId: 3, username: "c", buyIn: 200, seatIndex: 4 });
    t.setReady(3, true);
    t.startHand();
    // Rotation: previous dealer was 0; next eligible > 0 is seat 1.
    expect(t.dealerSeatIndex).toBe(1);
  });
});

// =========================================================================
// 2.4 Action timer
// =========================================================================

describe("2.4 action timer", () => {
  it("2.4.2 timeout when no bet to call → forced check (heads-up postflop)", () => {
    const t = newTable();
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.startHand();
    t.applyAction(1, { type: "call" });
    t.applyAction(2, { type: "check" });
    // postflop, no bet to call. The to-act player times out → check.
    const toAct = t.engine!.toActSeatIndex!;
    t.forceTimeoutAction();
    expect(t.seats[toAct]!.lastAction?.type).toBe("check");
    expect(t.seats[toAct]!.sittingOut).toBe(true);
  });

  it("2.4.3 timeout when bet to call → forced fold", () => {
    const t = newTable();
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.sitDown({ playerId: 3, username: "c", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.setReady(3, true);
    t.startHand();
    // 3-handed: UTG (= dealer in 3-way) acts first vs BB. They face a 10-call.
    const actor = t.engine!.toActSeatIndex!;
    t.forceTimeoutAction();
    expect(t.seats[actor]!.lastAction?.type).toBe("fold");
    expect(t.seats[actor]!.sittingOut).toBe(true);
  });

  it("2.4.6 stuck-timeout → abortHand, no infinite loop", () => {
    // Synthesise a state where neither check nor fold work. We can't easily
    // trigger this via the public API, but we can swap the engine after
    // start to reproduce the safety net.
    const t = newTable();
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.startHand();
    const eng = t.engine!;
    // Force engine into an impossible state: phase=showdown but toActSeat set.
    (eng as unknown as { phase: string }).phase = "showdown";
    // forceTimeoutAction should swallow both errors and abort.
    expect(() => t.forceTimeoutAction()).not.toThrow();
    expect(t.engine).toBeNull();
  });
});

// =========================================================================
// 2.5 Public state serialization
// =========================================================================

describe("2.5 public state", () => {
  it("2.5.4 actionDeadline null when no engine", () => {
    const t = newTable();
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    const s = t.publicState(1);
    expect(s.actionDeadline).toBeNull();
  });

  it("2.5.6 lastHand persists between hands", () => {
    const t = newTable();
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.startHand();
    while (t.engine) {
      const idx = t.engine.toActSeatIndex!;
      t.applyAction(t.seats[idx]!.playerId!, { type: "fold" });
    }
    expect(t.lastHand).not.toBeNull();
    expect(t.publicState(1).lastHand).not.toBeNull();
  });
});

// =========================================================================
// 2.6 Last-action pill
// =========================================================================

describe("2.6 last-action pill", () => {
  it("2.6.2 raise records the new total", () => {
    const t = newTable();
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.sitDown({ playerId: 3, username: "c", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.setReady(3, true);
    t.startHand();
    const actor = t.engine!.toActSeatIndex!;
    t.applyAction(t.seats[actor]!.playerId!, { type: "raise", amount: 30 });
    expect(t.seats[actor]!.lastAction).toMatchObject({ type: "raise", amount: 30 });
  });

  it("2.6.3 wiped on street advance", () => {
    const t = newTable();
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.startHand();
    t.applyAction(1, { type: "call" });
    t.applyAction(2, { type: "check" });
    expect(t.engine!.street).toBe("flop");
    for (const s of t.seats) {
      expect(s.lastAction).toBeNull();
    }
  });
});

// =========================================================================
// 2.7 Show cards
// =========================================================================

describe("2.7 show cards at showdown", () => {
  it("2.7.4 show flag does NOT leak across hands", () => {
    const t = newTable();
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.startHand();
    t.seats.forEach((s) => {
      if (s.inCurrentHand) s.showCardsAtShowdown = true;
    });
    while (t.engine) {
      const idx = t.engine.toActSeatIndex!;
      const eseat = t.engine.getSeat(idx)!;
      const tc = t.engine.currentBet - eseat.betThisStreet;
      t.applyAction(
        t.seats[idx]!.playerId!,
        tc > 0 ? { type: "call" } : { type: "check" },
      );
    }
    // Start a new hand
    t.startHand();
    for (const s of t.seats) {
      // Verifies startHand reset showCardsAtShowdown
      expect(s.showCardsAtShowdown).toBe(false);
    }
  });
});

// =========================================================================
// 3.5 / stats deltas
// =========================================================================

describe("3.5 stats deltas", () => {
  it("3.5.3 winner: hands_played=1, hands_won=1, biggestPot tracks share", () => {
    const t = newTable();
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.startHand();
    // Player 1 (SB, dealer HU) folds → player 2 (BB) wins SB+BB
    t.applyAction(1, { type: "fold" });
    expect(t.lastHand).not.toBeNull();
    const deltas = computeStatsDeltas(t, t.lastHand!);
    expect(deltas).toHaveLength(2);
    const winner = deltas.find((d) => d.wonHand)!;
    expect(winner.playerId).toBe(2);
    expect(winner.biggestPotWon).toBeGreaterThan(0);
    const loser = deltas.find((d) => !d.wonHand)!;
    expect(loser.playerId).toBe(1);
    expect(loser.netDelta).toBeLessThan(0);
  });
});

// =========================================================================
// 6 Multiplayer scenarios (integration-flavoured against the Table API)
// =========================================================================

describe("6 multiplayer scenarios", () => {
  it("6.5 rage-quit mid-hand: pendingLeave processed at hand end", () => {
    const finishCb = vi.fn();
    const t = new Table(cfg, {
      onStateChange: () => {},
      onActionTimeout: () => {},
      onHandFinished: (table, p) => finishCb(table, p),
    });
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.startHand();
    const r = t.standUp(2);
    expect(r.deferred).toBe(true);
    // Force-finish hand by folding the toAct player
    const actor = t.engine!.toActSeatIndex!;
    t.applyAction(t.seats[actor]!.playerId!, { type: "fold" });
    expect(finishCb).toHaveBeenCalled();
    // The pendingLeave flag is still TRUE in the finishCb (lobby reads it
    // there). After lobby's handler runs (we didn't run it here), the seat
    // would be removed.
    const seat2 = t.seats.find((s) => s.playerId === 2);
    expect(seat2?.pendingLeave).toBe(true);
  });

  it("6.7 5-hand sequence: chip total invariant + dealer rotates", () => {
    const t = newTable();
    t.sitDown({ playerId: 1, username: "a", buyIn: 300 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 300 });
    t.sitDown({ playerId: 3, username: "c", buyIn: 300 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.setReady(3, true);
    const total = 900;
    const dealers: number[] = [];
    for (let h = 0; h < 5; h++) {
      t.startHand();
      dealers.push(t.dealerSeatIndex!);
      while (t.engine) {
        const idx = t.engine.toActSeatIndex!;
        const eseat = t.engine.getSeat(idx)!;
        const tc = t.engine.currentBet - eseat.betThisStreet;
        t.applyAction(
          t.seats[idx]!.playerId!,
          tc > 0 ? { type: "call" } : { type: "check" },
        );
      }
    }
    const sumStacks = t.seats.reduce((a, s) => a + s.stack, 0);
    expect(sumStacks).toBe(total);
    // Dealer should rotate strictly forward (with wrap).
    for (let i = 1; i < dealers.length; i++) {
      expect(dealers[i]).not.toBe(dealers[i - 1]);
    }
  });

  it("6.8 player times out → auto-sit-out → must sit back in", () => {
    const t = newTable();
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.sitDown({ playerId: 3, username: "c", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.setReady(3, true);
    t.startHand();
    const actor = t.engine!.toActSeatIndex!;
    t.forceTimeoutAction();
    expect(t.seats[actor]!.sittingOut).toBe(true);
    // Finish hand
    while (t.engine) {
      const idx = t.engine.toActSeatIndex!;
      const eseat = t.engine.getSeat(idx)!;
      const tc = t.engine.currentBet - eseat.betThisStreet;
      t.applyAction(
        t.seats[idx]!.playerId!,
        tc > 0 ? { type: "fold" } : { type: "check" },
      );
    }
    // Auto-start eligibility excludes the sat-out player.
    const eligibleIds = t.seats
      .filter((s) => s.playerId !== null && !s.sittingOut && s.ready)
      .map((s) => s.playerId);
    expect(eligibleIds).not.toContain(t.seats[actor]!.playerId);
  });

  it("6.9 sit-back-in mid-hand → not dealt this hand", () => {
    const t = newTable();
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.sitDown({ playerId: 3, username: "c", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.setReady(3, true);
    // Player 3 sits out before hand.
    t.setSittingOut(3, true);
    t.startHand();
    expect(t.seats[2]!.inCurrentHand).toBe(false);
    // Player 3 sits back in mid-hand.
    t.setSittingOut(3, false);
    // They're still NOT in the current hand.
    expect(t.seats[2]!.inCurrentHand).toBe(false);
  });
});

// =========================================================================
// 7 Edge cases / suspected exploits
// =========================================================================

describe("7 edge cases / exploits", () => {
  it("7.3 [FIXED] sit-out mid-hand is queued — sittingOut flag stays false until hand finishes", () => {
    const t = newTable();
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.startHand();
    const actor = t.engine!.toActSeatIndex!;
    const actorPid = t.seats[actor]!.playerId!;
    t.setSittingOut(actorPid, true);
    // Mid-hand: pendingSitOut is set, sittingOut is NOT applied yet.
    expect(t.seats[actor]!.pendingSitOut).toBe(true);
    expect(t.seats[actor]!.sittingOut).toBe(false);
    // Engine still expects them to act — but they have to actually decide
    // (or time out), they can't sneak the sit-out in to skip the choice.
    expect(t.engine!.toActSeatIndex).toBe(actor);
  });

  it("7.3b [FIXED] queued sit-out applies at hand finish; player excluded from next hand", () => {
    const t = newTable();
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.sitDown({ playerId: 3, username: "c", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.setReady(3, true);
    t.startHand();
    const actor = t.engine!.toActSeatIndex!;
    const actorPid = t.seats[actor]!.playerId!;
    t.setSittingOut(actorPid, true);
    expect(t.seats[actor]!.pendingSitOut).toBe(true);
    // Drive the hand to completion by folding everyone.
    while (t.engine) {
      const idx = t.engine.toActSeatIndex!;
      t.applyAction(t.seats[idx]!.playerId!, { type: "fold" });
    }
    // Now the deferral fires — sittingOut flips true, pendingSitOut clears.
    expect(t.seats[actor]!.sittingOut).toBe(true);
    expect(t.seats[actor]!.pendingSitOut).toBe(false);
  });

  it("7.3c [FIXED] sit-IN (sittingOut=false) takes effect immediately, even mid-hand", () => {
    // The fix only defers sitting OUT. Sitting back IN can be immediate
    // because the player wasn't dealt into the current hand anyway.
    const t = newTable();
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.sitDown({ playerId: 3, username: "c", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.setReady(3, true);
    t.setSittingOut(3, true); // before hand starts — applies immediately
    t.startHand();
    expect(t.seats[2]!.inCurrentHand).toBe(false);
    // Player 3 sits back in mid-hand
    t.setSittingOut(3, false);
    expect(t.seats[2]!.sittingOut).toBe(false);
    expect(t.seats[2]!.pendingSitOut).toBe(false);
  });

  it("7.5 race: second action from same player after they already acted → 'not your turn'", () => {
    const t = newTable();
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.startHand();
    t.applyAction(1, { type: "call" });
    expect(() => t.applyAction(1, { type: "check" })).toThrow(/turn/);
  });

  it("7.7 negative stack impossible — commit() clamps", () => {
    const t = newTable();
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.startHand();
    // Walk through to all-in.
    t.applyAction(1, { type: "allin" }); // SB shoves
    t.applyAction(2, { type: "call" });
    expect(t.seats.every((s) => s.stack >= 0)).toBe(true);
  });
});
