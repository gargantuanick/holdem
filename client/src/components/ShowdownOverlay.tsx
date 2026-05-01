import type { HandFinishedPayload } from "@holdem/shared";
import { PlayingCard } from "./Card";
import { formatChips } from "../lib/format";

export function ShowdownOverlay({ payload }: { payload: HandFinishedPayload }) {
  const { winners, shownHands, communityCards, potTotal, handNumber } = payload;
  // De-dup winners by player (split-pot side pots may list same player twice).
  const winnerNames = Array.from(
    new Set(winners.map((w) => w.username)),
  ).join(" & ");
  const totalWon = winners.reduce((acc, w) => acc + w.amount, 0);
  // Use the highest-pot winner's hand description as the "winning hand".
  const mainWinner = winners.reduce(
    (best, w) => (w.amount > best.amount ? w : best),
    winners[0]!,
  );

  // Order shown hands: winners first, then losers.
  const winnerSeats = new Set(winners.map((w) => w.seatIndex));
  const orderedShown = [...shownHands].sort((a, b) => {
    const aw = winnerSeats.has(a.seatIndex) ? 0 : 1;
    const bw = winnerSeats.has(b.seatIndex) ? 0 : 1;
    return aw - bw;
  });

  return (
    <div
      key={handNumber}
      className="absolute inset-x-0 top-2 mx-auto max-w-md px-3 pointer-events-none animate-showdown-in"
    >
      <div className="rounded-xl bg-black/85 border-2 border-chip-gold/70 shadow-[0_0_32px_rgba(212,169,58,0.55)] backdrop-blur-sm overflow-hidden">
        <div className="bg-gradient-to-b from-chip-gold/30 to-transparent px-4 py-2 text-center animate-winner-glow">
          <div className="text-[10px] uppercase tracking-[0.25em] text-chip-gold/90 font-bold">
            Hand #{handNumber} · Winner
          </div>
          <div className="text-xl sm:text-2xl font-extrabold text-white mt-0.5">
            {winnerNames}
          </div>
          {mainWinner.handDescription && (
            <div className="text-sm sm:text-base text-chip-gold font-semibold">
              {mainWinner.handDescription}
            </div>
          )}
          <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-chip-gold/20 border border-chip-gold/50 px-2.5 py-0.5 text-xs font-mono font-bold text-chip-gold">
            +{formatChips(totalWon)}
          </div>
        </div>

        {communityCards.length > 0 && (
          <div className="px-3 py-2 flex justify-center gap-1 border-t border-white/10">
            {communityCards.map((c, i) => (
              <PlayingCard key={i} card={c} size="sm" />
            ))}
          </div>
        )}

        {orderedShown.length > 0 && (
          <div className="px-3 py-2 border-t border-white/10 space-y-1.5">
            <div className="text-[9px] uppercase tracking-widest text-white/50 font-bold">
              Showdown
            </div>
            {orderedShown.map((sh) => {
              const isWinner = winnerSeats.has(sh.seatIndex);
              return (
                <div
                  key={sh.seatIndex}
                  className={`flex items-center gap-2 rounded-md px-2 py-1 ${
                    isWinner
                      ? "bg-chip-gold/15 border border-chip-gold/40"
                      : "bg-white/5"
                  }`}
                >
                  <div className="flex gap-0.5 shrink-0">
                    <PlayingCard card={sh.cards[0]} size="sm" />
                    <PlayingCard card={sh.cards[1]} size="sm" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div
                      className={`text-xs font-bold truncate ${
                        isWinner ? "text-chip-gold" : "text-white/90"
                      }`}
                    >
                      {sh.username}
                    </div>
                    <div className="text-[10px] text-white/70 truncate">
                      {sh.handDescription}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
