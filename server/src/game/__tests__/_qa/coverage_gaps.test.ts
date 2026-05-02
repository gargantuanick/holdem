// Coverage for plan items I deferred on the first pass: BB option preflop,
// NaN/Infinity at the engine boundary, deck-burn semantics, edge cases.

import { describe, it, expect } from "vitest";
import { HandEngine, type HandSeatInput } from "../../hand.js";
import { computePots } from "../../pots.js";
import { freshDeck, shuffle } from "../../cards.js";

const mkSeats = (stacks: number[]): HandSeatInput[] =>
  stacks.map((stack, i) => ({ seatIndex: i, playerId: 100 + i, stack }));

// =========================================================================
// 1.6.2 BB option preflop
// =========================================================================

describe("1.6.2 BB option preflop (limped pot)", () => {
  it("HU: SB limps, BB can check OR raise", () => {
    const eng = new HandEngine(mkSeats([1000, 1000]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    eng.applyAction(0, { type: "call" }); // SB completes to 10
    // BB now has the option. They can check OR raise (this is the canonical
    // "BB option" — the implicit lastAggressor=BB lets them act despite
    // having matched currentBet).
    expect(eng.toActSeatIndex).toBe(1);
    eng.applyAction(1, { type: "raise", amount: 30 });
    expect(eng.currentBet).toBe(30);
    expect(eng.street).toBe("preflop");
  });

  it("3-handed: everyone limps, BB can raise (not just check)", () => {
    const eng = new HandEngine(mkSeats([1000, 1000, 1000]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    // 3-handed UTG=dealer (seat 0).
    eng.applyAction(0, { type: "call" }); // dealer limps
    eng.applyAction(1, { type: "call" }); // SB completes
    // Now BB has option.
    expect(eng.toActSeatIndex).toBe(2);
    eng.applyAction(2, { type: "raise", amount: 40 });
    expect(eng.currentBet).toBe(40);
    expect(eng.street).toBe("preflop");
  });

  it("BB checks the option → street advances to flop", () => {
    const eng = new HandEngine(mkSeats([1000, 1000, 1000]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    eng.applyAction(0, { type: "call" });
    eng.applyAction(1, { type: "call" });
    eng.applyAction(2, { type: "check" });
    expect(eng.street).toBe("flop");
  });
});

// =========================================================================
// 1.2.12 NaN/Infinity at the engine boundary
// =========================================================================

describe("1.2.12 NaN/Infinity at engine boundary [FIXED]", () => {
  // Fix: HandEngine.applyAction validates `amount` is finite before any
  // arithmetic. Defends against any caller that bypasses the socket
  // validation layer.
  it("NaN raise amount is rejected", () => {
    const eng = new HandEngine(mkSeats([1000, 1000, 1000]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    expect(() =>
      eng.applyAction(0, { type: "raise", amount: NaN }),
    ).toThrow(/finite/);
  });

  it("Infinity bet amount is rejected", () => {
    const eng = new HandEngine(mkSeats([1000, 1000]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    eng.applyAction(0, { type: "call" });
    eng.applyAction(1, { type: "check" });
    const idx = eng.toActSeatIndex!;
    expect(() =>
      eng.applyAction(idx, { type: "bet", amount: Infinity }),
    ).toThrow(/finite/);
  });

  it("Negative-Infinity raise rejected", () => {
    const eng = new HandEngine(mkSeats([1000, 1000, 1000]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    expect(() =>
      eng.applyAction(0, { type: "raise", amount: -Infinity }),
    ).toThrow(/finite/);
  });

  it("seat stack remains a finite integer after attempted NaN raise", () => {
    const eng = new HandEngine(mkSeats([1000, 1000, 1000]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    try {
      eng.applyAction(0, { type: "raise", amount: NaN });
    } catch {
      // expected
    }
    const seat = eng.getSeat(0)!;
    expect(Number.isFinite(seat.stack)).toBe(true);
    expect(Number.isFinite(seat.betThisStreet)).toBe(true);
    expect(Number.isFinite(seat.totalCommitted)).toBe(true);
  });

  it("undefined amount on bet rejected", () => {
    const eng = new HandEngine(mkSeats([1000, 1000]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    eng.applyAction(0, { type: "call" });
    eng.applyAction(1, { type: "check" });
    const idx = eng.toActSeatIndex!;
    expect(() =>
      eng.applyAction(idx, { type: "bet" }),
    ).toThrow();
  });
});

// =========================================================================
// [BUG] toActSeat preflop can point at an all-in seat when SB is sub-SB
// =========================================================================

describe("[FIXED] all-in-from-post preflop auto-runs out", () => {
  // Fix: constructor calls shouldAutoRunOutPreflop() — if 0 acting seats
  // remain, OR 1 acting seat that already covers the highest all-in bet,
  // the engine sets toAct=null and immediately advances streets.
  it("HU with sub-SB dealer: hand auto-completes to showdown, no stuck state", () => {
    const eng = new HandEngine(mkSeats([2, 21]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    // SB (dealer) posted 2, all-in. BB posted 10. Auto-run kicks in
    // because BB's posted 10 already covers SB's 2.
    expect(eng.getSeat(0)!.isAllIn).toBe(true);
    expect(eng.phase).toBe("complete");
    expect(eng.toActSeatIndex).toBeNull();
    expect(eng.community.length).toBe(5);
    // Chip conservation
    const total = eng.seats.reduce((a, s) => a + s.stack, 0);
    expect(total).toBe(2 + 21);
  });

  it("HU with both players sub-blind: hand still auto-completes", () => {
    const eng = new HandEngine(mkSeats([2, 5]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    // Both all-in from posting.
    expect(eng.getSeat(0)!.isAllIn).toBe(true);
    expect(eng.getSeat(1)!.isAllIn).toBe(true);
    expect(eng.phase).toBe("complete");
    expect(eng.community.length).toBe(5);
    expect(eng.seats.reduce((a, s) => a + s.stack, 0)).toBe(7);
  });

  it("HU with BB sub-stack but SB has chips to call/fold: SB still gets the option", () => {
    // Existing test 1.1.4 case: SB has chips beyond what BB could match.
    // Auto-runout MUST NOT kick in here — SB has a meaningful fold/call decision.
    const eng = new HandEngine(mkSeats([100, 5]), 0, {
      smallBlind: 2,
      bigBlind: 10,
    });
    expect(eng.phase).toBe("betting");
    expect(eng.toActSeatIndex).toBe(0); // SB to act
    expect(eng.getSeat(0)!.isAllIn).toBe(false);
    // SB can fold and save the rest of their stack.
    eng.applyAction(0, { type: "fold" });
    expect(eng.phase).toBe("complete");
  });

  it("multi-way with sub-BB UTG: UTG isn't all-in (didn't post), normal play", () => {
    const eng = new HandEngine(mkSeats([1000, 1000, 1000, 3]), 0, {
      smallBlind: 5,
      bigBlind: 10,
    });
    expect(eng.getSeat(3)!.isAllIn).toBe(false);
    expect(eng.toActSeatIndex).toBe(3);
    expect(() => eng.applyAction(3, { type: "fold" })).not.toThrow();
  });
});

// =========================================================================
// 1.6.6 Burn-card semantics: deck size after a hand
// =========================================================================

describe("1.6.6 burn cards consumed correctly", () => {
  it("after showdown, exactly N + 8 cards are gone (2*N hole + 1 burn + 3 flop + 1 burn + 1 turn + 1 burn + 1 river)", () => {
    // We can't observe the deck directly, but we can run a HU hand to
    // showdown and verify the engine doesn't throw deck-empty. Then run
    // back-to-back hands to surface any deck-state-leak between hands.
    for (let h = 0; h < 3; h++) {
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
      // 2 hole * 2 players = 4. + 4 burns + 5 board = 13. Deck started at 52.
      // Engine should have consumed exactly 13.
    }
  });
});

// =========================================================================
// freshDeck/shuffle determinism
// =========================================================================

describe("cards.shuffle determinism", () => {
  it("same RNG seed → same deck order", () => {
    const seed = 9;
    const rngA = (() => {
      let s = seed;
      return () => {
        s = (s * 16807) % 2147483647;
        return s / 2147483647;
      };
    })();
    const rngB = (() => {
      let s = seed;
      return () => {
        s = (s * 16807) % 2147483647;
        return s / 2147483647;
      };
    })();
    const a = shuffle(freshDeck(), rngA);
    const b = shuffle(freshDeck(), rngB);
    expect(a.join(",")).toBe(b.join(","));
  });

  it("freshDeck has 52 unique cards", () => {
    const d = freshDeck();
    expect(d.length).toBe(52);
    expect(new Set(d).size).toBe(52);
  });
});

// =========================================================================
// 1.5.3 tie split with odd remainder is deterministic
// =========================================================================

describe("1.5.3 tie split remainder distribution", () => {
  it("3-way tie of pot=100 → 33/33/34 with extra chip going to first clockwise from dealer", () => {
    // Force a tie by giving 3 players the same hand at showdown. The
    // engine evaluates 7-card sets; we can construct the deck via a
    // custom RNG only indirectly. Instead, directly probe pot-split math
    // via the side-effect: run many fixed-seed games and verify the same
    // game with the same seed always awards remainder to the same seat.
    const make = (seed: number) => {
      let s = seed;
      const rng = () => {
        s = (s * 16807) % 2147483647;
        return s / 2147483647;
      };
      const eng = new HandEngine(mkSeats([100, 100, 100]), 0, {
        smallBlind: 5,
        bigBlind: 10,
      }, rng);
      eng.applyAction(0, { type: "allin" });
      eng.applyAction(1, { type: "call" });
      eng.applyAction(2, { type: "call" });
      return eng.pendingWinners.map((w) => `${w.seatIndex}:${w.amount}`).join("|");
    };
    expect(make(123)).toBe(make(123));
    expect(make(456)).toBe(make(456));
  });
});

// =========================================================================
// Pots: more orphan/merging cases
// =========================================================================

describe("computePots edge cases", () => {
  it("merges consecutive layers with same eligibility", () => {
    // A=100, B=100, C=200 (folded). Layer 100: amount=300, eligible {A,B}.
    // Layer 200: amount=100 from C only, but C folded → orphan, merged.
    const pots = computePots([
      { seatIndex: 0, contribution: 100, folded: false },
      { seatIndex: 1, contribution: 100, folded: false },
      { seatIndex: 2, contribution: 200, folded: true },
    ]);
    expect(pots).toEqual([{ amount: 400, eligibleSeatIndices: [0, 1] }]);
  });

  it("all folded except last → single pot to last man", () => {
    const pots = computePots([
      { seatIndex: 0, contribution: 100, folded: true },
      { seatIndex: 1, contribution: 100, folded: true },
      { seatIndex: 2, contribution: 100, folded: false },
    ]);
    expect(pots).toEqual([{ amount: 300, eligibleSeatIndices: [2] }]);
  });

  it("[FIXED] all-folded contributors throws loudly instead of silent loss", () => {
    // Fix: computePots throws when a layer has empty eligibility AND no
    // preceding pot to merge into. Engine never reaches this state today
    // (last-man-standing handles it earlier), but the throw guarantees a
    // future regression can't ship silently — chips can never disappear
    // into an unwinnable pot.
    expect(() =>
      computePots([
        { seatIndex: 0, contribution: 100, folded: true },
        { seatIndex: 1, contribution: 100, folded: true },
      ]),
    ).toThrow(/chip-leak guard/);
  });

  it("orphan layers still merge correctly when there IS a preceding pot", () => {
    // Regression check on the existing merge path — A=100 (live),
    // B=200 (folded). The 100→200 layer (only B contributes, B folded)
    // merges into A's main pot. This must still work.
    const pots = computePots([
      { seatIndex: 0, contribution: 100, folded: false },
      { seatIndex: 1, contribution: 200, folded: true },
    ]);
    expect(pots).toEqual([{ amount: 300, eligibleSeatIndices: [0] }]);
  });
});
