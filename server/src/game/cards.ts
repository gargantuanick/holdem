import type { Card, Rank, Suit } from "@holdem/shared";

export const RANKS: Rank[] = [
  "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A",
];
export const SUITS: Suit[] = ["s", "h", "d", "c"];

export function freshDeck(): Card[] {
  const deck: Card[] = [];
  for (const r of RANKS) {
    for (const s of SUITS) {
      deck.push(`${r}${s}` as Card);
    }
  }
  return deck;
}

/**
 * Fisher-Yates shuffle using a provided RNG (default Math.random).
 * Mutates and returns the array.
 */
export function shuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

/** Deals n cards from the top (end) of the deck. Mutates the deck. */
export function deal(deck: Card[], n: number): Card[] {
  const out: Card[] = [];
  for (let i = 0; i < n; i++) {
    const c = deck.pop();
    if (!c) throw new Error("deck empty");
    out.push(c);
  }
  return out;
}
