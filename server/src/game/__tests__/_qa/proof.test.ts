// Regression test for the undersized-all-in reopens-action bug.
// Pre-fix: engine accepted A's re-raise after C's short all-in.
// Post-fix: engine rejects (canStillRaise=false on A after the short bump).
import { describe, it, expect } from "vitest";
import { HandEngine } from "../../hand.js";

const mkSeats = (stacks: number[]) =>
  stacks.map((stack, i) => ({ seatIndex: i, playerId: 100 + i, stack }));

describe("undersized all-in does not reopen action", () => {
  it("3-handed: A raises, B calls, C short-all-in; A may NOT re-raise", () => {
    const eng = new HandEngine(
      mkSeats([1000, 1000, 33]),
      0,
      { smallBlind: 5, bigBlind: 10 },
    );
    eng.applyAction(0, { type: "raise", amount: 30 });
    eng.applyAction(1, { type: "call" });
    eng.applyAction(2, { type: "allin" });
    // C all-in for 33, raiseSize=3 < minRaise(20). Action returns to A who
    // already matched 30 — they may only call the extra 3 or fold.
    if (eng.phase !== "betting") return;
    expect(eng.toActSeatIndex).toBe(0);
    const a = eng.getSeat(0)!;
    expect(a.canStillRaise).toBe(false);
    expect(() =>
      eng.applyAction(0, { type: "raise", amount: 100 }),
    ).toThrow(/reopen|min-raise|cannot/i);
    // But calling the extra 3 must work.
    eng.applyAction(0, { type: "call" });
  });

  it("FULL raise reopens action normally (not a regression)", () => {
    const eng = new HandEngine(
      mkSeats([1000, 1000, 1000]),
      0,
      { smallBlind: 5, bigBlind: 10 },
    );
    eng.applyAction(0, { type: "raise", amount: 30 }); // raise size 20
    eng.applyAction(1, { type: "raise", amount: 60 }); // raise size 30 (full)
    // C must act, A's canStillRaise should be reopened.
    const a = eng.getSeat(0)!;
    expect(a.canStillRaise).toBe(true);
  });
});
