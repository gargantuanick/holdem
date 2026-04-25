// pokersolver doesn't ship types
// @ts-expect-error untyped module
import pokersolver from "pokersolver";
import type { Card } from "@holdem/shared";

const { Hand } = pokersolver as {
  Hand: {
    solve: (cards: string[]) => SolvedHand;
    winners: (hands: SolvedHand[]) => SolvedHand[];
  };
};

export interface SolvedHand {
  rank: number;
  name: string;
  descr: string;
  cards: unknown[];
  toString(): string;
}

/**
 * Evaluate a 5-7 card hand. Returns {rank, descr} where higher rank = better.
 * Note: pokersolver uses uppercase suits in some places; we normalize.
 */
export function solve(cards: Card[]): SolvedHand {
  // pokersolver expects strings like "Ah", "Td", "2s"
  return Hand.solve(cards.map((c) => c));
}

/**
 * Given multiple players' best hands, return indexes into the input array of
 * the winning hands (could be a tie). Each input is the seven cards available
 * to that player (their 2 hole + 5 community).
 */
export function winnersFromSevenCardSets(
  sets: Card[][],
): { winnerIndexes: number[]; descriptions: string[] } {
  const solved = sets.map((s) => solve(s));
  const wins = Hand.winners(solved);
  const winnerIndexes: number[] = [];
  for (let i = 0; i < solved.length; i++) {
    if (wins.includes(solved[i]!)) winnerIndexes.push(i);
  }
  return {
    winnerIndexes,
    descriptions: solved.map((s) => s.descr),
  };
}
