import type { HandHistoryEntry } from "@holdem/shared";
import { getSql } from "./client.js";

export interface HandWinnerRecord {
  playerId: number;
  username: string;
  amount: number;
  handDescription: string;
}

export interface HandStatsDelta {
  playerId: number;
  netDelta: number; // signed: + winnings, - losses (can be 0)
  grossWon: number; // chips won this hand (>= 0)
  grossLost: number; // chips contributed and lost (>= 0)
  wonHand: boolean; // did this player win any pot?
  biggestPotWon: number; // largest pot share they won this hand (0 if none)
}

export interface RecordHandResultArgs {
  tableId: string;
  handNumber: number;
  winners: HandWinnerRecord[];
  potTotal: number;
  communityCards: string;
  perPlayer: HandStatsDelta[];
}

/**
 * Single transaction:
 *  - insert hand_history row
 *  - apply per-player stats (hands_played++, hands_won maybe++, total_chips_won/lost,
 *    biggest_pot_won = greatest)
 * NOTE: wallet adjustments (returning final stack to wallet on leave) are handled
 * separately. This records the hand result audit + lifetime aggregates.
 */
export async function recordHandResult(args: RecordHandResultArgs): Promise<void> {
  const sql = getSql();
  await sql.begin(async (tx) => {
    const winnersJson = JSON.stringify(args.winners);
    await tx`
      INSERT INTO hand_history
        (table_id, hand_number, winners, pot_total, community_cards)
      VALUES (
        ${args.tableId},
        ${args.handNumber},
        ${winnersJson}::jsonb,
        ${args.potTotal},
        ${args.communityCards}
      )
    `;
    for (const p of args.perPlayer) {
      await tx`
        UPDATE players
        SET
          hands_played = hands_played + 1,
          hands_won = hands_won + ${p.wonHand ? 1 : 0},
          total_chips_won = total_chips_won + ${p.grossWon},
          total_chips_lost = total_chips_lost + ${p.grossLost},
          biggest_pot_won = GREATEST(biggest_pot_won, ${p.biggestPotWon})
        WHERE id = ${p.playerId}
      `;
    }
  });
}

export async function fetchHandHistory(
  tableId: string,
  limit = 50,
): Promise<HandHistoryEntry[]> {
  const sql = getSql();
  const rows = await sql<{
    hand_number: string;
    winners: HandWinnerRecord[];
    pot_total: string;
    community_cards: string | null;
    ended_at: Date;
  }[]>`
    SELECT hand_number, winners, pot_total, community_cards, ended_at
    FROM hand_history
    WHERE table_id = ${tableId}
    ORDER BY ended_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    handNumber: Number(r.hand_number),
    winners: r.winners,
    potTotal: Number(r.pot_total),
    communityCards: r.community_cards ?? "",
    endedAt: r.ended_at.toISOString(),
  }));
}
