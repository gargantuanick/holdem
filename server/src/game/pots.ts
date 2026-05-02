/**
 * Side-pot computation.
 *
 * Given each seat's total contribution this hand and which seats are still
 * eligible to win (i.e. did NOT fold), produce a list of pots:
 *   [{ amount, eligibleSeatIndices }, ...]
 *
 * The standard algorithm:
 *   1. Sort the distinct positive contribution levels ascending.
 *   2. For each level, the pot at that level = (level - prevLevel) * count(seats
 *      whose contribution >= level). Eligibility = seats who reached that level
 *      AND did not fold.
 *   3. Folded players' contributions are still added to pots, but they cannot
 *      win them.
 *
 * Pots with zero eligible winners are merged into the previous pot (which can
 * happen if everyone eligible folded after committing — extremely rare in
 * practice but handled). Empty pots (amount=0) are dropped.
 */

export interface SeatContribution {
  seatIndex: number;
  contribution: number;
  folded: boolean;
}

export interface ComputedPot {
  amount: number;
  eligibleSeatIndices: number[];
}

export function computePots(seats: SeatContribution[]): ComputedPot[] {
  const positive = seats.filter((s) => s.contribution > 0);
  if (positive.length === 0) return [];

  const levels = Array.from(
    new Set(positive.map((s) => s.contribution)),
  ).sort((a, b) => a - b);

  const pots: ComputedPot[] = [];
  let prev = 0;
  for (const level of levels) {
    const layer = level - prev;
    let amount = 0;
    const eligible: number[] = [];
    for (const s of positive) {
      if (s.contribution >= level) {
        amount += layer;
        if (!s.folded) eligible.push(s.seatIndex);
      }
    }
    if (amount > 0) {
      const prevPot = pots[pots.length - 1];
      if (eligible.length === 0 && prevPot) {
        // Folded-only orphan layer — merge into previous pot
        prevPot.amount += amount;
      } else if (eligible.length === 0 && !prevPot) {
        // Nobody at this level can win and there's no preceding pot to
        // merge into. The engine's last-man-standing branch should have
        // fired before this state can be reached. Throwing here makes a
        // future regression impossible to ship silently — chips can't
        // disappear into a pot nobody is eligible to win.
        throw new Error(
          `computePots: chip-leak guard tripped (level=${level} amount=${amount}; every contributor folded). Caller must award via last-man-standing before reaching this state.`,
        );
      } else if (
        prevPot &&
        sameEligibility(prevPot.eligibleSeatIndices, eligible)
      ) {
        // Consecutive layers with same eligibility = same logical pot
        prevPot.amount += amount;
      } else {
        pots.push({ amount, eligibleSeatIndices: eligible });
      }
    }
    prev = level;
  }
  return pots;
}

function sameEligibility(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) return false;
  }
  return true;
}
