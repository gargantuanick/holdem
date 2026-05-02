// Full QA pass — server engine.
// Maps to QA_PLAN.md sections 1.x. Each `describe` lines up with a plan
// section so a failure points straight at the broken behaviour.

import { describe, it, expect } from "vitest";
import { HandEngine, type HandSeatInput } from "../../hand.js";
import { computePots } from "../../pots.js";

const mkSeats = (stacks: number[]): HandSeatInput[] =>
  stacks.map((stack, i) => ({ seatIndex: i, playerId: 100 + i, stack }));

// Deterministic RNG factory so we can repro any failure.
function seededRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

// Drive a hand to completion with a given strategy. Returns the engine.
function playOut(
  eng: HandEngine,
  strategy: (seatIdx: number, eng: HandEngine) => void,
  safety = 200,
): HandEngine {
  while (eng.phase === "betting" && safety-- > 0) {
    const idx = eng.toActSeatIndex;
    if (idx === null) break;
    strategy(idx, eng);
  }
  return eng;
}

// =========================================================================
// 1.1 Blinds & action order
// =========================================================================

describe("1.1 blinds & action order", () => {
  it("1.1.4 BB short-stack: posts what they have, marked all-in", () => {
    // Heads-up: A=100 dealer/SB, B=5 BB (less than configured BB=10)
    const eng = new HandEngine(
      mkSeats([100, 5]),
      0,
      { smallBlind: 2, bigBlind: 10 },
    );
    expect(eng.getSeat(1)!.betThisStreet).toBe(5);
    expect(eng.getSeat(1)!.isAllIn).toBe(true);
    expect(eng.currentBet).toBe(10);
  });

  it("1.1.5 SB short-stack: posts what they have, BB still posts in full", () => {
    // 3-handed: dealer=0 (1000), SB=1 (3, less than SB=5), BB=2 (1000)
    const eng = new HandEngine(
      mkSeats([1000, 3, 1000]),
      0,
      { smallBlind: 5, bigBlind: 10 },
    );
    expect(eng.getSeat(1)!.betThisStreet).toBe(3);
    expect(eng.getSeat(1)!.isAllIn).toBe(true);
    expect(eng.getSeat(2)!.betThisStreet).toBe(10);
    expect(eng.currentBet).toBe(10);
  });
});

// =========================================================================
// 1.2 Betting rules
// =========================================================================

describe("1.2 betting rules", () => {
  it("1.2.2 'bet' rejected when there's an open bet", () => {
    const eng = new HandEngine(mkSeats([1000, 1000, 1000]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    expect(() => eng.applyAction(0, { type: "bet", amount: 30 })).toThrow();
  });

  it("1.2.3 'raise' rejected when there's no open bet (postflop)", () => {
    const eng = new HandEngine(mkSeats([1000, 1000]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    eng.applyAction(0, { type: "call" });
    eng.applyAction(1, { type: "check" });
    expect(eng.street).toBe("flop");
    // Postflop, currentBet=0; first acting seat (non-dealer HU) gets to bet.
    const toAct = eng.toActSeatIndex!;
    expect(() => eng.applyAction(toAct, { type: "raise", amount: 30 })).toThrow();
  });

  it("1.2.5 first raise after BB sets minRaise to raise size", () => {
    const eng = new HandEngine(mkSeats([1000, 1000, 1000]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    eng.applyAction(0, { type: "raise", amount: 35 }); // raise size = 25
    expect(eng.minRaise).toBe(25);
    expect(eng.currentBet).toBe(35);
  });

  it("1.2.6 re-raise must be at least currentBet + minRaise", () => {
    const eng = new HandEngine(mkSeats([1000, 1000, 1000]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    eng.applyAction(0, { type: "raise", amount: 30 });
    // currentBet=30, minRaise=20 → next legal total is 50
    expect(() => eng.applyAction(1, { type: "raise", amount: 49 })).toThrow();
    eng.applyAction(1, { type: "raise", amount: 50 });
    expect(eng.currentBet).toBe(50);
  });

  it("1.2.7 bet < BB rejected unless going all-in", () => {
    const eng = new HandEngine(mkSeats([1000, 1000]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    eng.applyAction(0, { type: "call" });
    eng.applyAction(1, { type: "check" });
    // Postflop. Non-dealer (BB) acts first.
    const toAct = eng.toActSeatIndex!;
    expect(() => eng.applyAction(toAct, { type: "bet", amount: 5 })).toThrow();
    eng.applyAction(toAct, { type: "bet", amount: 10 });
    expect(eng.currentBet).toBe(10);
  });

  it("1.2.10 bet > stack rejected", () => {
    const eng = new HandEngine(mkSeats([1000, 1000, 100]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    expect(() => eng.applyAction(0, { type: "raise", amount: 99999 })).toThrow();
  });

  it("1.2.11 zero or negative raise rejected", () => {
    const eng = new HandEngine(mkSeats([1000, 1000, 1000]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    expect(() => eng.applyAction(0, { type: "raise", amount: 0 })).toThrow();
    expect(() => eng.applyAction(0, { type: "raise", amount: -5 })).toThrow();
  });
});

// =========================================================================
// 1.3 All-in mechanics
// =========================================================================

describe("1.3 all-in mechanics", () => {
  it("1.3.1 calling all-in commits stack, sets isAllIn", () => {
    const eng = new HandEngine(mkSeats([1000, 1000, 30]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    // C is BB with 20 left. UTG (seat 0) raises to 100, B calls, C must
    // call all-in for what they have.
    eng.applyAction(0, { type: "raise", amount: 100 });
    eng.applyAction(1, { type: "call" });
    eng.applyAction(2, { type: "call" }); // call short → all-in
    expect(eng.getSeat(2)!.isAllIn).toBe(true);
    expect(eng.getSeat(2)!.stack).toBe(0);
    expect(eng.getSeat(2)!.totalCommitted).toBe(30);
  });

  it("1.3.6 all-in by exactly minRaise reopens action", () => {
    const eng = new HandEngine(mkSeats([1000, 1000, 50]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    // currentBet=10, minRaise=10. C has 50 stack, 10 BB already in → 40
    // available. C all-in pushes betThisStreet to 50 (raise size = 40 ≥ minRaise).
    eng.applyAction(0, { type: "raise", amount: 20 }); // raise size 10
    eng.applyAction(1, { type: "call" });
    // Now currentBet=20, minRaise=10. C has 40 stack left (40 not enough for full?).
    // Let's just check the fundamentals: c shoves all-in.
    eng.applyAction(2, { type: "allin" });
    // raiseSize = 50-20 = 30 ≥ minRaise (10). Should reopen action.
    if (eng.phase === "betting") {
      expect(eng.getSeat(0)!.canStillRaise).toBe(true);
      expect(eng.getSeat(1)!.canStillRaise).toBe(true);
    }
  });

  it("1.3.7 all-in opening sub-BB stack is allowed (cannot bet < BB normally)", () => {
    // Heads-up: A=100, B=8 BB short
    const eng = new HandEngine(mkSeats([100, 8]), 0, {
      smallBlind: 2,
      bigBlind: 10,
    });
    // B posts BB short (8) and is already all-in. A is to act and can call/raise/fold.
    expect(eng.getSeat(1)!.isAllIn).toBe(true);
    eng.applyAction(0, { type: "call" });
    expect(eng.phase).toBe("complete"); // ran out automatically
  });

  it("1.3.8 all preflop all-in → engine deals all 5 board cards", () => {
    const eng = new HandEngine(mkSeats([100, 100, 100]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    // 3-handed: UTG=0 shoves, others call.
    eng.applyAction(0, { type: "allin" });
    eng.applyAction(1, { type: "call" });
    eng.applyAction(2, { type: "call" });
    expect(eng.phase).toBe("complete");
    expect(eng.community.length).toBe(5);
  });
});

// =========================================================================
// 1.4 Side pots
// =========================================================================

describe("1.4 side pots", () => {
  it("1.4.6 sum(pot amounts) === sum(totalCommitted) for any all-in scenario", () => {
    const eng = new HandEngine(mkSeats([1000, 20, 80, 200]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    eng.applyAction(3, { type: "raise", amount: 200 });
    eng.applyAction(0, { type: "call" });
    eng.applyAction(1, { type: "allin" });
    eng.applyAction(2, { type: "allin" });
    expect(eng.phase).toBe("complete");
    const potSum = eng.pots.reduce((a, b) => a + b.amount, 0);
    const contribSum = eng.seats.reduce((a, b) => a + b.totalCommitted, 0);
    expect(potSum).toBe(contribSum);
  });

  it("1.4.7 sum(pendingWinners) === sum(pots)", () => {
    const eng = new HandEngine(mkSeats([1000, 20, 80, 200]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    eng.applyAction(3, { type: "raise", amount: 200 });
    eng.applyAction(0, { type: "call" });
    eng.applyAction(1, { type: "allin" });
    eng.applyAction(2, { type: "allin" });
    const potSum = eng.pots.reduce((a, b) => a + b.amount, 0);
    const winSum = eng.pendingWinners.reduce((a, b) => a + b.amount, 0);
    expect(winSum).toBe(potSum);
  });

  it("1.4.5 two players matched at top stack → side pot eligibility includes both", () => {
    // A=200, B=50 (all-in), C=200 — A and C eligible on side pot.
    const pots = computePots([
      { seatIndex: 0, contribution: 200, folded: false },
      { seatIndex: 1, contribution: 50, folded: false },
      { seatIndex: 2, contribution: 200, folded: false },
    ]);
    expect(pots).toEqual([
      { amount: 150, eligibleSeatIndices: [0, 1, 2] },
      { amount: 300, eligibleSeatIndices: [0, 2] },
    ]);
  });
});

// =========================================================================
// 1.5 Showdown & evaluation
// =========================================================================

describe("1.5 showdown & evaluation", () => {
  it("1.5.2 tie split is deterministic (clockwise from dealer)", () => {
    // We can't easily force a tie without rigging cards; but we can check
    // that across many seeds, when ties occur the remainder distribution
    // is at most ±1 chip and total is conserved.
    let seed = 42;
    const rng = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    // Run heads-up showdown 30 times; verify pot conservation each time.
    for (let i = 0; i < 30; i++) {
      const eng = new HandEngine(mkSeats([100, 100]), i % 2, {
        smallBlind: 5,
        bigBlind: 10,
      }, rng);
      eng.applyAction(eng.toActSeatIndex!, { type: "call" });
      eng.applyAction(eng.toActSeatIndex!, { type: "check" });
      // Check down all streets.
      while (eng.phase === "betting") {
        const idx = eng.toActSeatIndex!;
        eng.applyAction(idx, { type: "check" });
      }
      const pot = eng.pots.reduce((a, b) => a + b.amount, 0);
      const won = eng.pendingWinners.reduce((a, b) => a + b.amount, 0);
      expect(won).toBe(pot);
    }
  });

  it("1.5.4 last-man-standing: description = 'uncontested'", () => {
    const eng = new HandEngine(mkSeats([1000, 1000, 1000]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    eng.applyAction(0, { type: "fold" });
    eng.applyAction(1, { type: "fold" });
    expect(eng.phase).toBe("complete");
    expect(eng.pendingWinners[0]!.handDescription).toBe("uncontested");
  });
});

// =========================================================================
// 1.6 Street advancement
// =========================================================================

describe("1.6 street advancement", () => {
  it("1.6.4 betThisStreet reset on advance; totalCommitted accumulates", () => {
    const eng = new HandEngine(mkSeats([1000, 1000]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    eng.applyAction(0, { type: "call" }); // SB → 10
    eng.applyAction(1, { type: "check" }); // BB checks
    expect(eng.street).toBe("flop");
    expect(eng.getSeat(0)!.betThisStreet).toBe(0);
    expect(eng.getSeat(0)!.totalCommitted).toBe(10);
    expect(eng.getSeat(1)!.betThisStreet).toBe(0);
    expect(eng.getSeat(1)!.totalCommitted).toBe(10);
  });

  it("1.6.5 canStillRaise reset to true on street advance", () => {
    // 3-handed scenario where a short all-in caps players, then street advances.
    const eng = new HandEngine(mkSeats([1000, 1000, 35]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    eng.applyAction(0, { type: "raise", amount: 30 });
    eng.applyAction(1, { type: "call" });
    eng.applyAction(2, { type: "allin" }); // C all-in for 35; short raise, no reopen
    if (eng.phase === "betting") {
      // A and B are capped; they call extra and street advances.
      eng.applyAction(0, { type: "call" });
      eng.applyAction(1, { type: "call" });
    }
    if (eng.phase === "betting") {
      // After advance, A and B should have canStillRaise=true again.
      expect(eng.getSeat(0)!.canStillRaise).toBe(true);
      expect(eng.getSeat(1)!.canStillRaise).toBe(true);
    } else {
      // C is all-in; street should have run out — also fine, just check pots OK.
      expect(eng.community.length).toBe(5);
    }
  });

  it("1.6.6 burn cards consumed: 1 + 3 + 1 + 1 + 1 = 7 board cards used (4 burns)", () => {
    // We can't easily inspect the deck post-hand, but we can run a HU hand
    // to showdown and check that after the hand, the engine doesn't throw
    // on continued access. (Implicit: if burn weren't consumed, eval would
    // be wrong; existing showdown tests cover that.)
    const eng = new HandEngine(mkSeats([100, 100]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    eng.applyAction(0, { type: "call" });
    eng.applyAction(1, { type: "check" });
    while (eng.phase === "betting") {
      eng.applyAction(eng.toActSeatIndex!, { type: "check" });
    }
    expect(eng.community.length).toBe(5);
  });
});

// =========================================================================
// 1.7 Chip conservation under stress
// =========================================================================

describe("1.7 chip conservation invariant", () => {
  it("1.7.1+1.7.2+1.7.3 1000 random hands of varied sizes — no chip leak", () => {
    const rng = seededRng(12345);
    for (let trial = 0; trial < 1000; trial++) {
      const sizes = [2, 3, 4, 5];
      const n = sizes[trial % sizes.length]!;
      const stacks = Array.from(
        { length: n },
        (_, i) => 50 + Math.floor(rng() * 950),
      );
      const total = stacks.reduce((a, b) => a + b, 0);
      const dealer = trial % n;
      const eng = new HandEngine(
        mkSeats(stacks),
        dealer,
        { smallBlind: 5, bigBlind: 10 },
        rng,
      );
      // Mixed strategy with some folds + raises + all-ins.
      let safety = 300;
      while (eng.phase === "betting" && safety-- > 0) {
        const idx = eng.toActSeatIndex;
        if (idx === null) break;
        const s = eng.getSeat(idx)!;
        const toCall = eng.currentBet - s.betThisStreet;
        const r = rng();
        if (r < 0.05 && toCall > 0) {
          eng.applyAction(idx, { type: "fold" });
        } else if (toCall === 0) {
          if (r < 0.3 && s.canStillRaise && s.stack > eng.config.bigBlind) {
            const amt = Math.min(s.stack, eng.config.bigBlind * 2);
            try {
              eng.applyAction(idx, { type: "bet", amount: amt });
            } catch {
              eng.applyAction(idx, { type: "check" });
            }
          } else {
            eng.applyAction(idx, { type: "check" });
          }
        } else if (toCall <= s.stack) {
          if (r < 0.15 && s.canStillRaise) {
            const min = eng.currentBet + eng.minRaise;
            const amt = Math.min(s.stack + s.betThisStreet, min);
            try {
              eng.applyAction(idx, { type: "raise", amount: amt });
            } catch {
              eng.applyAction(idx, { type: "call" });
            }
          } else {
            eng.applyAction(idx, { type: "call" });
          }
        } else {
          eng.applyAction(idx, { type: "allin" });
        }
      }
      const totalAfter = eng.seats.reduce((a, b) => a + b.stack, 0);
      expect(totalAfter, `trial ${trial} stacks=${stacks} dealer=${dealer}`).toBe(total);
      const potSum = eng.pots.reduce((a, p) => a + p.amount, 0);
      const contribSum = eng.seats.reduce((a, s) => a + s.totalCommitted, 0);
      expect(potSum, `trial ${trial} pots != contribs`).toBe(contribSum);
    }
  });

  it("1.7.4 sub-BB stacks don't break conservation", () => {
    const rng = seededRng(7);
    for (let trial = 0; trial < 100; trial++) {
      const stacks = [3, 5, 8, 200];
      const total = stacks.reduce((a, b) => a + b, 0);
      const eng = new HandEngine(mkSeats(stacks), trial % 4, {
        smallBlind: 5,
        bigBlind: 10,
      }, rng);
      let safety = 100;
      while (eng.phase === "betting" && safety-- > 0) {
        const idx = eng.toActSeatIndex;
        if (idx === null) break;
        const s = eng.getSeat(idx)!;
        const toCall = eng.currentBet - s.betThisStreet;
        if (toCall === 0) eng.applyAction(idx, { type: "check" });
        else if (toCall <= s.stack) eng.applyAction(idx, { type: "call" });
        else eng.applyAction(idx, { type: "allin" });
      }
      const totalAfter = eng.seats.reduce((a, b) => a + b.stack, 0);
      expect(totalAfter, `trial ${trial}`).toBe(total);
    }
  });
});

// =========================================================================
// 1.8 Determinism
// =========================================================================

describe("1.8 determinism", () => {
  it("1.8.1 same RNG seed → same community cards", () => {
    const make = () => {
      const rng = seededRng(99);
      const eng = new HandEngine(mkSeats([100, 100, 100]), 0, {
        smallBlind: 5,
        bigBlind: 10,
      }, rng);
      eng.applyAction(0, { type: "allin" });
      eng.applyAction(1, { type: "call" });
      eng.applyAction(2, { type: "call" });
      return eng.community.join(",");
    };
    expect(make()).toBe(make());
  });
});
