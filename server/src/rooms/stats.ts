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
    if (seat.isBot) continue;
    const playerId = seat.playerId;
    const winsByThisPlayer = payload.winners.filter(
      (w) => w.playerId === playerId,
    );
    // Uncalled-portion refunds are not "winnings" — the player didn't beat
    // anyone to receive them. Strip them from the win-side stats so
    // "hands won", "biggest pot won" and "total chips won" only reflect
    // actually contested wins. They still reduce the loss side, since the
    // refund cancels out the matching contribution the player would
    // otherwise have lost.
    const refunded = winsByThisPlayer
      .filter((w) => w.uncalled)
      .reduce((a, w) => a + w.amount, 0);
    const contestedWins = winsByThisPlayer.filter((w) => !w.uncalled);
    const grossWon = contestedWins.reduce((a, w) => a + w.amount, 0);
    const biggestPot = contestedWins.reduce(
      (max, w) => Math.max(max, w.amount),
      0,
    );
    const contributed = seat.totalCommitted;
    const effectiveContribution = contributed - refunded;
    const grossLost = Math.max(0, effectiveContribution - grossWon);
    out.push({
      playerId,
      netDelta: grossWon - effectiveContribution,
      grossWon,
      grossLost,
      wonHand: grossWon > 0,
      biggestPotWon: biggestPot,
    });
  }
  return out;
}
