import { describe, it, expect } from "vitest";
import { Table } from "../table.js";

const noopEvents = {
  onStateChange: () => {},
  onHandFinished: () => {},
  onActionTimeout: () => {},
};

const cfg = {
  id: "t1",
  name: "Test",
  maxSeats: 5,
  smallBlind: 5,
  bigBlind: 10,
  minBuyIn: 100,
  maxBuyIn: 500,
};

describe("dead-button rotation when dealer busts", () => {
  it("rotates to next-clockwise eligible seat, not back to seat 0", () => {
    const t = new Table(cfg, noopEvents);
    t.sitDown({ playerId: 1, username: "a", buyIn: 200, seatIndex: 0 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200, seatIndex: 2 });
    t.sitDown({ playerId: 3, username: "c", buyIn: 200, seatIndex: 4 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.setReady(3, true);
    t.startHand();
    // Force the dealer position to seat 2.
    t.dealerSeatIndex = 2;
    // Simulate seat 2 busting: drain stack to 0 and end the hand.
    t.seats[2]!.stack = 0;
    // Finish the hand by folding everyone; the engine's eligible filter
    // ignores stack==0 anyway. Instead, abort and start fresh.
    t.abortHand();
    t.seats[2]!.stack = 0; // still busted
    // start the next hand; eligible = [0, 4]
    t.startHand();
    // Expected: dealer rotates from prior position (2) to next clockwise
    // eligible, which is seat 4. Pre-fix it incorrectly reset to seat 0.
    expect(t.dealerSeatIndex).toBe(4);
  });

  it("wraps to first eligible when previous dealer was the highest seat", () => {
    const t = new Table(cfg, noopEvents);
    t.sitDown({ playerId: 1, username: "a", buyIn: 200, seatIndex: 0 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200, seatIndex: 4 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.startHand();
    t.dealerSeatIndex = 4;
    t.abortHand();
    t.startHand();
    expect(t.dealerSeatIndex).toBe(0);
  });
});

describe("pendingLeave is preserved through finishHand", () => {
  it("standUp during a hand sets pendingLeave; flag is still true after hand ends", () => {
    let finishedFired = false;
    let leavingFlag: boolean | null = null;
    const t = new Table(
      cfg,
      {
        onStateChange: () => {},
        onActionTimeout: () => {},
        onHandFinished: (table) => {
          finishedFired = true;
          // Lobby's hook sees pendingLeave still true here.
          leavingFlag = table.seats.find((s) => s.playerId === 2)?.pendingLeave ?? null;
        },
      },
    );
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    t.startHand();
    // Player 2 wants to leave mid-hand
    const r = t.standUp(2);
    expect(r.deferred).toBe(true);
    expect(t.findSeatByPlayer(2)?.pendingLeave).toBe(true);
    // End the hand by folding to the other player.
    while (t.engine) {
      const seatIdx = t.engine.toActSeatIndex!;
      t.applyAction(t.seats[seatIdx]!.playerId!, { type: "fold" });
    }
    expect(finishedFired).toBe(true);
    expect(leavingFlag).toBe(true);
  });
});

describe("first-hand lockup grief", () => {
  it("can start with 2 ready players even if a 3rd never presses Start", () => {
    const t = new Table(cfg, noopEvents);
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.sitDown({ playerId: 3, username: "c", buyIn: 200 });
    t.setReady(1, true);
    t.setReady(2, true);
    // player 3 never readies
    expect(t.canStartHand()).toBe(true);
    t.startHand();
    // Player 3 was not dealt in.
    expect(t.seats[2]!.inCurrentHand).toBe(false);
    expect(t.seats[0]!.inCurrentHand).toBe(true);
    expect(t.seats[1]!.inCurrentHand).toBe(true);
  });
});
