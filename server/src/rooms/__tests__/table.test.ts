import { describe, it, expect } from "vitest";
import { Table } from "../table.js";

const noopEvents = {
  onStateChange: () => {},
  onHandFinished: () => {},
  onActionTimeout: () => {},
};

const cfg = {
  id: "t1",
  name: "Test Table",
  maxSeats: 4,
  smallBlind: 5,
  bigBlind: 10,
  minBuyIn: 100,
  maxBuyIn: 500,
};

describe("Table — seat management", () => {
  it("sit down at first open seat with valid buy-in", () => {
    const t = new Table(cfg, noopEvents);
    const s = t.sitDown({ playerId: 1, username: "alice", buyIn: 200 });
    expect(s.seatIndex).toBe(0);
    expect(s.stack).toBe(200);
    expect(s.username).toBe("alice");
    expect(t.occupiedSeats()).toHaveLength(1);
  });

  it("rejects buy-in below minimum", () => {
    const t = new Table(cfg, noopEvents);
    expect(() =>
      t.sitDown({ playerId: 1, username: "a", buyIn: 50 }),
    ).toThrow(/minimum/);
  });

  it("rejects buy-in above maximum", () => {
    const t = new Table(cfg, noopEvents);
    expect(() =>
      t.sitDown({ playerId: 1, username: "a", buyIn: 999 }),
    ).toThrow(/maximum/);
  });

  it("rejects double-seating same player", () => {
    const t = new Table(cfg, noopEvents);
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    expect(() =>
      t.sitDown({ playerId: 1, username: "a", buyIn: 200 }),
    ).toThrow(/already/);
  });

  it("stand up between hands returns full stack", () => {
    const t = new Table(cfg, noopEvents);
    t.sitDown({ playerId: 1, username: "a", buyIn: 250 });
    const { stack, deferred } = t.standUp(1);
    expect(deferred).toBe(false);
    expect(stack).toBe(250);
    expect(t.occupiedSeats()).toHaveLength(0);
  });

  it("rebuy adds to stack within limits", () => {
    const t = new Table(cfg, noopEvents);
    t.sitDown({ playerId: 1, username: "a", buyIn: 100 });
    const newStack = t.rebuy(1, 150);
    expect(newStack).toBe(250);
  });

  it("rebuy rejected if exceeds max", () => {
    const t = new Table(cfg, noopEvents);
    t.sitDown({ playerId: 1, username: "a", buyIn: 400 });
    expect(() => t.rebuy(1, 200)).toThrow(/maximum/);
  });
});

describe("Table — hand lifecycle", () => {
  it("starts a hand when 2+ eligible players seated and ready", () => {
    const t = new Table(cfg, noopEvents);
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    expect(t.canStartHand()).toBe(false);
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    // Pre-hand-1 gate: every eligible player must press Start.
    expect(t.canStartHand()).toBe(false);
    t.setReady(1, true);
    expect(t.canStartHand()).toBe(false);
    t.setReady(2, true);
    expect(t.canStartHand()).toBe(true);
    t.startHand();
    expect(t.engine).not.toBeNull();
    expect(t.handNumber).toBe(1);
  });

  it("cannot start with player below big blind", () => {
    const t = new Table(cfg, noopEvents);
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    // Drain seat 2 to below BB
    t.seats[1]!.stack = 5;
    expect(t.canStartHand()).toBe(false);
  });

  it("public state strips opponents' hole cards", () => {
    const t = new Table(cfg, noopEvents);
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.startHand();
    const stateForP1 = t.publicState(1);
    const ownSeat = stateForP1.seats.find((s) => s.playerId === 1)!;
    const oppSeat = stateForP1.seats.find((s) => s.playerId === 2)!;
    expect(ownSeat.holeCards).not.toBeNull();
    expect(oppSeat.holeCards).toBeNull();
    expect(oppSeat.hasCards).toBe(true);
  });

  it("dealer rotates each hand", () => {
    const t = new Table(cfg, noopEvents);
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.startHand();
    const firstDealer = t.dealerSeatIndex;
    // Force-finish: fold the non-dealer (heads-up SB acts first which is dealer)
    if (t.engine) {
      const toAct = t.engine.toActSeatIndex!;
      t.applyAction(t.seats[toAct]!.playerId!, { type: "fold" });
    }
    expect(t.engine).toBeNull();
    // simulate auto-start by manually starting
    t.startHand();
    expect(t.dealerSeatIndex).not.toBe(firstDealer);
  });

  it("standUp during hand defers removal until end", () => {
    const t = new Table(cfg, noopEvents);
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    t.startHand();
    const result = t.standUp(2);
    expect(result.deferred).toBe(true);
    // Seat is still there until hand ends
    expect(t.findSeatByPlayer(2)).not.toBeNull();
  });
});

describe("Table — chip conservation across hands", () => {
  it("table stack total + uncommitted = sum of buy-ins after each hand", () => {
    const t = new Table(cfg, noopEvents);
    t.sitDown({ playerId: 1, username: "a", buyIn: 200 });
    t.sitDown({ playerId: 2, username: "b", buyIn: 200 });
    const total = 400;
    t.startHand();
    // Fold the to-act player to end immediately.
    while (t.engine) {
      const seat = t.engine.toActSeatIndex!;
      t.applyAction(t.seats[seat]!.playerId!, { type: "fold" });
    }
    const sum = t.seats.reduce((a, s) => a + s.stack, 0);
    expect(sum).toBe(total);
  });
});
