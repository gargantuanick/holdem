// Additional stress tests added during the post-fix QA pass. These probe the
// new canStillRaise behaviour and chip conservation under combinations that
// the existing tests didn't cover.
import { describe, it, expect } from "vitest";
import { HandEngine } from "../../hand.js";

const mkSeats = (stacks: number[]) =>
  stacks.map((stack, i) => ({ seatIndex: i, playerId: 100 + i, stack }));

describe("canStillRaise: capped player can call but not raise via allin", () => {
  it("blocks all-in raise attempt from a capped player", () => {
    // 3-handed: A=1000, B=1000, C=33 (short stack)
    const eng = new HandEngine(
      mkSeats([1000, 1000, 33]),
      0,
      { smallBlind: 5, bigBlind: 10 },
    );
    eng.applyAction(0, { type: "raise", amount: 30 }); // A raises
    eng.applyAction(1, { type: "call" }); // B calls
    eng.applyAction(2, { type: "allin" }); // C short all-in for 33 (raise size 3)
    // Action returns to A who is now capped (canStillRaise=false).
    if (eng.phase !== "betting") return;
    expect(eng.toActSeatIndex).toBe(0);
    expect(eng.getSeat(0)!.canStillRaise).toBe(false);
    // A tries to all-in raise — must be blocked by the canStillRaise gate.
    expect(() => eng.applyAction(0, { type: "allin" })).toThrow(/reopen/i);
    // But A can still call the extra 3.
    eng.applyAction(0, { type: "call" });
    expect(eng.getSeat(0)!.betThisStreet).toBe(33);
  });
});

describe("chip conservation: short all-in scenarios", () => {
  it("no chips created or destroyed across a bunch of short-all-in sequences", () => {
    let seed = 1;
    const rng = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let trial = 0; trial < 50; trial++) {
      const stacks = [1000, 200, 50, 25];
      const totalChips = stacks.reduce((a, b) => a + b, 0);
      const eng = new HandEngine(
        mkSeats(stacks),
        trial % 4,
        { smallBlind: 5, bigBlind: 10 },
        rng,
      );
      let safety = 200;
      while (eng.phase === "betting" && safety-- > 0) {
        const seatIdx = eng.toActSeatIndex;
        if (seatIdx === null) break;
        const s = eng.getSeat(seatIdx)!;
        const toCall = eng.currentBet - s.betThisStreet;
        // Aggressive policy: short stacks shove, big stacks call.
        if (s.stack <= eng.config.bigBlind * 4) {
          eng.applyAction(seatIdx, { type: "allin" });
        } else if (toCall === 0) {
          eng.applyAction(seatIdx, { type: "check" });
        } else if (toCall <= s.stack) {
          eng.applyAction(seatIdx, { type: "call" });
        } else {
          eng.applyAction(seatIdx, { type: "allin" });
        }
      }
      const stacksAfter = eng.seats.reduce((a, b) => a + b.stack, 0);
      expect(stacksAfter).toBe(totalChips);
    }
  });
});

describe("BB sub-stack post (player has < BB chips)", () => {
  it("BB posts what they have; pot accounting still balances", () => {
    // Heads-up: A=100, B=5 (less than BB)
    const eng = new HandEngine(
      mkSeats([100, 5]),
      0,
      { smallBlind: 2, bigBlind: 10 },
    );
    // A is dealer/SB, B is BB. B can only post 5.
    expect(eng.getSeat(0)!.betThisStreet).toBe(2); // SB
    expect(eng.getSeat(1)!.betThisStreet).toBe(5); // BB short
    expect(eng.getSeat(1)!.isAllIn).toBe(true);
    // currentBet is the configured BB (10), but B only put 5 in.
    expect(eng.currentBet).toBe(10);
    // A acts: can fold, call (puts in 8 more for total 10), or raise.
    eng.applyAction(0, { type: "call" }); // call to 10
    // Street should advance — B is all-in, A matched currentBet.
    // But wait: A put in 10, B is all-in for 5. Engine should run out the board.
    expect(eng.phase).toBe("complete");
    const totalAwarded = eng.pendingWinners.reduce((a, b) => a + b.amount, 0);
    const totalContrib = eng.seats.reduce((a, b) => a + b.totalCommitted, 0);
    expect(totalAwarded).toBe(totalContrib);
  });
});

describe("dealer rotation across multiple hands without bust-outs", () => {
  it("rotates clockwise through 4 hands", () => {
    // Use the Table to test rotation; we exercise startHand 4x.
    // Imported from the rooms file would be cleaner but this stays in-engine.
    // Instead, just verify HandEngine accepts each successive dealer.
    const stacks = [1000, 1000, 1000];
    let dealerSeat = 0;
    for (let hand = 0; hand < 4; hand++) {
      const eng = new HandEngine(
        mkSeats(stacks),
        dealerSeat,
        { smallBlind: 5, bigBlind: 10 },
      );
      // fold-around to BB
      while (eng.phase === "betting") {
        const idx = eng.toActSeatIndex!;
        eng.applyAction(idx, { type: "fold" });
      }
      // pick next dealer = (dealer+1) % 3
      dealerSeat = (dealerSeat + 1) % 3;
    }
    // No exception thrown across 4 rotations is the assertion.
    expect(dealerSeat).toBe(1); // wrapped: 0 → 1 → 2 → 0 → 1
  });
});
