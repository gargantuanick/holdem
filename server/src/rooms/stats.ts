import type { HandFinishedPayload } from "@holdem/shared";
import type { Table } from "./table.js";
import type { HandStatsDelta } from "../db/handHistory.js";

/**
 * Build per-player stats deltas for the just-finished hand.
 *
 * - hands_played++ for everyone in the hand
 * - hands_won++ for any player who won >0 chips from any pot
 * - total_chips_won += sum of pot shares won (gross)
 * - total_chips_lost += chips contributed and not won back
 * - biggest_pot_won = max single-pot share they won
 *
 * "Biggest pot won" semantics: if a player wins multiple pots in one hand
 * (e.g. main + side), we consider their biggest single pot share, summed across
 * winners of that pot — i.e. the *amount they personally received from one pot*.
 */
export function computeStatsDeltas(
  table: Table,
  payload: HandFinishedPayload,
): HandStatsDelta[] {
  const out: HandStatsDelta[] = [];
  // Walk seats that were in this hand.
  for (const seat of table.seats) {
    if (!seat.inCurrentHand || seat.playerId === null) continue;
    const playerId = seat.playerId;
    const winsByThisPlayer = payload.winners.filter(
      (w) => w.playerId === playerId,
    );
    const grossWon = winsByThisPlayer.reduce((a, w) => a + w.amount, 0);
    const biggestPot = winsByThisPlayer.reduce(
      (max, w) => Math.max(max, w.amount),
      0,
    );
    const contributed = seat.totalCommitted;
    // grossLost is what they put in minus what they got back, floored at 0.
    const grossLost = Math.max(0, contributed - grossWon);
    out.push({
      playerId,
      netDelta: grossWon - contributed,
      grossWon,
      grossLost,
      wonHand: grossWon > 0,
      biggestPotWon: biggestPot,
    });
  }
  return out;
}
