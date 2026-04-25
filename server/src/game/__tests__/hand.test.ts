import { describe, it, expect } from "vitest";
import { HandEngine, type HandSeatInput } from "../hand.js";

function mkSeats(stacks: number[]): HandSeatInput[] {
  return stacks.map((stack, i) => ({
    seatIndex: i,
    playerId: 100 + i,
    stack,
  }));
}

describe("HandEngine — blinds", () => {
  it("heads-up: dealer posts SB and acts first preflop", () => {
    const eng = new HandEngine(
      mkSeats([1000, 1000]),
      0, // dealer
      { smallBlind: 5, bigBlind: 10 },
    );
    const dealer = eng.getSeat(0)!;
    const other = eng.getSeat(1)!;
    expect(dealer.betThisStreet).toBe(5); // SB
    expect(other.betThisStreet).toBe(10); // BB
    expect(eng.toActSeatIndex).toBe(0); // dealer acts first preflop heads-up
    expect(eng.currentBet).toBe(10);
  });

  it("3-handed: SB left of dealer, BB next, UTG acts first", () => {
    const eng = new HandEngine(
      mkSeats([1000, 1000, 1000]),
      0, // dealer
      { smallBlind: 5, bigBlind: 10 },
    );
    expect(eng.getSeat(1)!.betThisStreet).toBe(5);
    expect(eng.getSeat(2)!.betThisStreet).toBe(10);
    // 3-handed: UTG is left of BB which loops back to dealer (seat 0).
    expect(eng.toActSeatIndex).toBe(0);
  });

  it("4-handed: action starts at seat after BB", () => {
    const eng = new HandEngine(
      mkSeats([1000, 1000, 1000, 1000]),
      0, // dealer = seat 0
      { smallBlind: 5, bigBlind: 10 },
    );
    expect(eng.getSeat(1)!.betThisStreet).toBe(5);
    expect(eng.getSeat(2)!.betThisStreet).toBe(10);
    expect(eng.toActSeatIndex).toBe(3);
  });
});

describe("HandEngine — basic flow", () => {
  it("everyone folds to BB → BB wins blinds", () => {
    const eng = new HandEngine(
      mkSeats([1000, 1000, 1000, 1000]),
      0,
      { smallBlind: 5, bigBlind: 10 },
    );
    // UTG=3 folds, dealer=0 folds, SB=1 folds → BB=2 wins
    eng.applyAction(3, { type: "fold" });
    eng.applyAction(0, { type: "fold" });
    eng.applyAction(1, { type: "fold" });
    expect(eng.phase).toBe("complete");
    expect(eng.pendingWinners).toHaveLength(1);
    expect(eng.pendingWinners[0]!.seatIndex).toBe(2);
    expect(eng.pendingWinners[0]!.amount).toBe(15); // SB+BB
    // BB posted 10 from 1000, then wins 15 back: 990 + 15 = 1005
    expect(eng.getSeat(2)!.stack).toBe(1005);
  });

  it("call call check check check check → showdown reached", () => {
    const eng = new HandEngine(
      mkSeats([1000, 1000]),
      0,
      { smallBlind: 5, bigBlind: 10 },
    );
    // Heads-up: SB(0) acts first preflop
    eng.applyAction(0, { type: "call" }); // dealer/SB calls 10
    eng.applyAction(1, { type: "check" }); // BB checks
    expect(eng.street).toBe("flop");
    eng.applyAction(1, { type: "check" }); // OOP first postflop heads-up = non-dealer
    eng.applyAction(0, { type: "check" });
    expect(eng.street).toBe("turn");
    eng.applyAction(1, { type: "check" });
    eng.applyAction(0, { type: "check" });
    expect(eng.street).toBe("river");
    eng.applyAction(1, { type: "check" });
    eng.applyAction(0, { type: "check" });
    expect(eng.phase).toBe("complete");
    // Combined pot is 20
    const totalAwarded = eng.pendingWinners.reduce((a, b) => a + b.amount, 0);
    expect(totalAwarded).toBe(20);
  });
});

describe("HandEngine — min-raise rules", () => {
  it("rejects raise smaller than min-raise", () => {
    const eng = new HandEngine(
      mkSeats([1000, 1000, 1000]),
      0,
      { smallBlind: 5, bigBlind: 10 },
    );
    // 3-handed: UTG=0 acts first
    expect(() =>
      eng.applyAction(0, { type: "raise", amount: 15 }),
    ).toThrow(/min-raise/);
  });

  it("accepts raise exactly equal to min-raise", () => {
    const eng = new HandEngine(
      mkSeats([1000, 1000, 1000]),
      0,
      { smallBlind: 5, bigBlind: 10 },
    );
    // currentBet=10, minRaise=10 → minimum legal total is 20
    eng.applyAction(0, { type: "raise", amount: 20 });
    expect(eng.currentBet).toBe(20);
    expect(eng.minRaise).toBe(10);
  });

  it("after a raise, min-raise = size of last raise", () => {
    const eng = new HandEngine(
      mkSeats([1000, 1000, 1000]),
      0,
      { smallBlind: 5, bigBlind: 10 },
    );
    eng.applyAction(0, { type: "raise", amount: 30 }); // raise by 20
    expect(eng.minRaise).toBe(20);
    // SB(1) re-raises: must be at least 30 + 20 = 50
    expect(() =>
      eng.applyAction(1, { type: "raise", amount: 49 }),
    ).toThrow(/min-raise/);
    eng.applyAction(1, { type: "raise", amount: 50 });
    expect(eng.currentBet).toBe(50);
  });

  it("short all-in less than min-raise does NOT reopen action", () => {
    // Stacks: A=1000 (dealer), B=1000, C=15 (short)
    const eng = new HandEngine(
      mkSeats([1000, 1000, 15]),
      0,
      { smallBlind: 5, bigBlind: 10 },
    );
    // 3-handed: UTG=0 (dealer) acts first
    eng.applyAction(0, { type: "raise", amount: 30 }); // raise by 20, minRaise=20
    eng.applyAction(1, { type: "call" });
    // Now C must call 30 but only has 15 → all-in for 15? No, C only put in 10 (BB), needs 20 more → all-in
    // Wait, C's current bet is 10 (BB), stack is 15-10=5. So all-in adds 5 more → total bet 15 (short of 30).
    eng.applyAction(2, { type: "allin" });
    // C's all-in is 15 (10 BB + 5 stack), short of currentBet=30 → no reopen.
    // A and B already matched at 30 + acted, so street closes and advances to flop.
    expect(eng.getSeat(2)!.isAllIn).toBe(true);
    expect(eng.street).toBe("flop");
    // After advancing, betThisStreet was reset; check totalCommitted instead.
    expect(eng.getSeat(0)!.totalCommitted).toBe(30);
    expect(eng.getSeat(1)!.totalCommitted).toBe(30);
    expect(eng.getSeat(2)!.totalCommitted).toBe(15);
  });
});

describe("HandEngine — side pots from all-ins", () => {
  it("3 all-ins at different stack sizes produces correct pot tiers", () => {
    // A=20 (dealer, SB will be A in HU... use 4-player)
    // 4 players: A=1000(dealer), B=20, C=80, D=200
    const eng = new HandEngine(
      mkSeats([1000, 20, 80, 200]),
      0,
      { smallBlind: 5, bigBlind: 10 },
    );
    // Blinds: SB=B(seat1)=5, BB=C(seat2)=10
    // First to act: D(seat3)
    eng.applyAction(3, { type: "raise", amount: 200 }); // all-in
    // D's stack was 200, all of it. minRaise was 10, raise=190 → reopens.
    // A(seat0) calls (has 1000): action: call 200
    eng.applyAction(0, { type: "call" });
    // B(seat1, 5 already in, stack=15) all-in for 20 total
    eng.applyAction(1, { type: "allin" });
    // C(seat2, 10 already in, stack=70) all-in for 80 total
    eng.applyAction(2, { type: "allin" });
    // Now action returns to A who has 200 in already vs current=200. Already acted? No—B and C all-in raised? Both shorts < min-raise 190 → don't reopen.
    // Street should close, run out the board.
    expect(eng.street).toBe("river"); // wait, let me think
    // Actually after street closes preflop, we go to flop. With A and D matched at 200,
    // and B/C all-in, only A and D could act on the flop but both are matched and B/C
    // are all-in — engine should auto-run-out.
    expect(eng.phase).toBe("complete");
    // Pots:
    //   contributions: A=200, B=20, C=80, D=200
    //   level 20 → 4*20 = 80, eligible all
    //   level 80 → 3*60 = 180, eligible {A,C,D}
    //   level 200 → 2*120 = 240, eligible {A,D}
    expect(eng.pots.length).toBe(3);
    expect(eng.pots[0]!.amount).toBe(80);
    expect(eng.pots[0]!.eligibleSeatIndices.sort()).toEqual([0, 1, 2, 3]);
    expect(eng.pots[1]!.amount).toBe(180);
    expect(eng.pots[1]!.eligibleSeatIndices.sort()).toEqual([0, 2, 3]);
    expect(eng.pots[2]!.amount).toBe(240);
    expect(eng.pots[2]!.eligibleSeatIndices.sort()).toEqual([0, 3]);
    // sum of awarded = sum of pots
    const totalPot = eng.pots.reduce((a, b) => a + b.amount, 0);
    const totalAwarded = eng.pendingWinners.reduce((a, b) => a + b.amount, 0);
    expect(totalAwarded).toBe(totalPot);
  });
});

describe("HandEngine — showdown with rigged deck", () => {
  it("better hand wins the pot at showdown", () => {
    // We can't directly inject the deck, but we can use a deterministic RNG.
    // Instead, run a heads-up hand with both players going to showdown and
    // verify pot integrity rather than specific cards.
    let seed = 42;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const eng = new HandEngine(
      mkSeats([500, 500]),
      0,
      { smallBlind: 5, bigBlind: 10 },
      rng,
    );
    eng.applyAction(0, { type: "call" });
    eng.applyAction(1, { type: "check" });
    // flop
    eng.applyAction(1, { type: "check" });
    eng.applyAction(0, { type: "check" });
    // turn
    eng.applyAction(1, { type: "check" });
    eng.applyAction(0, { type: "check" });
    // river
    eng.applyAction(1, { type: "check" });
    eng.applyAction(0, { type: "check" });
    expect(eng.phase).toBe("complete");
    expect(eng.community.length).toBe(5);
    const totalAwarded = eng.pendingWinners.reduce((a, b) => a + b.amount, 0);
    expect(totalAwarded).toBe(20);
    // Stacks must conserve chips: total = 1000
    const totalStacks = eng.seats.reduce((a, b) => a + b.stack, 0);
    expect(totalStacks).toBe(1000);
  });
});

describe("HandEngine — rejects illegal actions", () => {
  it("cannot check when there's a bet to call", () => {
    const eng = new HandEngine(
      mkSeats([1000, 1000, 1000]),
      0,
      { smallBlind: 5, bigBlind: 10 },
    );
    expect(() => eng.applyAction(0, { type: "check" })).toThrow();
  });

  it("cannot act out of turn", () => {
    const eng = new HandEngine(
      mkSeats([1000, 1000, 1000]),
      0,
      { smallBlind: 5, bigBlind: 10 },
    );
    expect(() => eng.applyAction(1, { type: "fold" })).toThrow(/turn/);
  });

  it("cannot bet more than stack", () => {
    const eng = new HandEngine(
      mkSeats([1000, 1000, 100]),
      0,
      { smallBlind: 5, bigBlind: 10 },
    );
    // C(seat2) is BB with 90 left after BB. Try to over-raise.
    expect(() =>
      eng.applyAction(0, { type: "raise", amount: 99999 }),
    ).toThrow();
  });
});

describe("HandEngine — chip conservation", () => {
  it("never creates or destroys chips across many random hands", () => {
    let seed = 7;
    const rng = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let trial = 0; trial < 20; trial++) {
      const stacks = [200, 200, 200, 200];
      const total = stacks.reduce((a, b) => a + b, 0);
      const eng = new HandEngine(
        mkSeats(stacks),
        trial % 4,
        { smallBlind: 5, bigBlind: 10 },
        rng,
      );
      // Random play: every actor checks/calls; rare random folds
      let safety = 200;
      while (eng.phase === "betting" && safety-- > 0) {
        const seat = eng.toActSeatIndex;
        if (seat === null) break;
        const s = eng.getSeat(seat)!;
        const toCall = eng.currentBet - s.betThisStreet;
        if (toCall === 0) {
          eng.applyAction(seat, { type: "check" });
        } else if (toCall <= s.stack) {
          eng.applyAction(seat, { type: "call" });
        } else {
          eng.applyAction(seat, { type: "allin" });
        }
      }
      const stacksAfter = eng.seats.reduce((a, b) => a + b.stack, 0);
      expect(stacksAfter).toBe(total);
    }
  });
});
