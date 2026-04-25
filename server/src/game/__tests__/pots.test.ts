import { describe, it, expect } from "vitest";
import { computePots } from "../pots.js";

describe("computePots", () => {
  it("single pot when everyone matches", () => {
    const pots = computePots([
      { seatIndex: 0, contribution: 100, folded: false },
      { seatIndex: 1, contribution: 100, folded: false },
      { seatIndex: 2, contribution: 100, folded: false },
    ]);
    expect(pots).toEqual([
      { amount: 300, eligibleSeatIndices: [0, 1, 2] },
    ]);
  });

  it("folded players contribute but cannot win", () => {
    const pots = computePots([
      { seatIndex: 0, contribution: 50, folded: true },
      { seatIndex: 1, contribution: 100, folded: false },
      { seatIndex: 2, contribution: 100, folded: false },
    ]);
    expect(pots.length).toBe(1);
    // The first level (50) is from folded + 2 active = 150, plus second level 50*2 = 100 → 250 total
    expect(pots[0]!.amount).toBe(250);
    expect(pots[0]!.eligibleSeatIndices).toEqual([1, 2]);
  });

  it("two all-in side pots", () => {
    // Stacks: A=50 (all-in), B=200 (all-in), C=200 (calls)
    const pots = computePots([
      { seatIndex: 0, contribution: 50, folded: false },
      { seatIndex: 1, contribution: 200, folded: false },
      { seatIndex: 2, contribution: 200, folded: false },
    ]);
    // Main pot: 50*3=150 (A,B,C eligible)
    // Side pot: 150*2=300 (B,C eligible)
    expect(pots).toEqual([
      { amount: 150, eligibleSeatIndices: [0, 1, 2] },
      { amount: 300, eligibleSeatIndices: [1, 2] },
    ]);
  });

  it("three all-ins at different stack sizes", () => {
    // A=20, B=80, C=200, D=200 (D and C call all-ins)
    const pots = computePots([
      { seatIndex: 0, contribution: 20, folded: false },
      { seatIndex: 1, contribution: 80, folded: false },
      { seatIndex: 2, contribution: 200, folded: false },
      { seatIndex: 3, contribution: 200, folded: false },
    ]);
    // Main: 20*4=80 (A,B,C,D)
    // Side1: 60*3=180 (B,C,D)
    // Side2: 120*2=240 (C,D)
    expect(pots).toEqual([
      { amount: 80, eligibleSeatIndices: [0, 1, 2, 3] },
      { amount: 180, eligibleSeatIndices: [1, 2, 3] },
      { amount: 240, eligibleSeatIndices: [2, 3] },
    ]);
  });

  it("folded all-in still creates side pots", () => {
    // A=100 all-in, B=300 (folded after committing 300), C=300, D=300
    // Should have main+side; D,C eligible only on side; main eligible to A,C,D
    const pots = computePots([
      { seatIndex: 0, contribution: 100, folded: false },
      { seatIndex: 1, contribution: 300, folded: true },
      { seatIndex: 2, contribution: 300, folded: false },
      { seatIndex: 3, contribution: 300, folded: false },
    ]);
    // Level 100: amount=400, eligible {A,C,D} (B folded)
    // Level 300: amount=600, eligible {C,D}
    expect(pots).toEqual([
      { amount: 400, eligibleSeatIndices: [0, 2, 3] },
      { amount: 600, eligibleSeatIndices: [2, 3] },
    ]);
  });

  it("merges orphan layer when only folded players exist at a level", () => {
    // A=100 (all-in), B=200 (folded), only A eligible
    // Layer 100: amount=200, eligible {A}
    // Layer 200: amount=100, eligible {} → merged into A's pot
    const pots = computePots([
      { seatIndex: 0, contribution: 100, folded: false },
      { seatIndex: 1, contribution: 200, folded: true },
    ]);
    expect(pots.length).toBe(1);
    expect(pots[0]!.amount).toBe(300);
    expect(pots[0]!.eligibleSeatIndices).toEqual([0]);
  });

  it("zero contributions produce no pots", () => {
    const pots = computePots([
      { seatIndex: 0, contribution: 0, folded: false },
      { seatIndex: 1, contribution: 0, folded: false },
    ]);
    expect(pots).toEqual([]);
  });
});
