import { useEffect, useState } from "react";
import type { HandFinishedPayload } from "@holdem/shared";
import { PlayingCard } from "./Card";
import { formatChips } from "../lib/format";

interface Props {
  payload: HandFinishedPayload;
  nextHandStartsAt: number | null;
  onDealNow?: () => void;
  canDealNow?: boolean;
}

export function ShowdownOverlay({
  payload,
  nextHandStartsAt,
  onDealNow,
  canDealNow,
}: Props) {
  const { winners, shownHands, communityCards, potTotal, handNumber } = payload;

  const winnerNames = Array.from(
    new Set(winners.map((w) => w.username)),
  ).join(" & ");
  const totalWon = winners.reduce((acc, w) => acc + w.amount, 0);
  const mainWinner = winners.reduce(
    (best, w) => (w.amount > best.amount ? w : best),
    winners[0]!,
  );

  const winnerSeats = new Set(winners.map((w) => w.seatIndex));
  const orderedShown = [...shownHands].sort((a, b) => {
    const aw = winnerSeats.has(a.seatIndex) ? 0 : 1;
    const bw = winnerSeats.has(b.seatIndex) ? 0 : 1;
    return aw - bw;
  });

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!nextHandStartsAt) return;
    const tick = () => setNow(Date.now());
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, [nextHandStartsAt]);

  const secondsLeft =
    nextHandStartsAt !== null
      ? Math.max(0, Math.ceil((nextHandStartsAt - now) / 1000))
      : null;

  return (
    <div
      key={handNumber}
      className="absolute inset-0 flex items-center justify-center px-3 z-20 pointer-events-none animate-showdown-in"
    >
      <div className="pointer-events-auto w-full max-w-md rounded-2xl bg-black/90 border-2 border-chip-gold/70 shadow-[0_0_48px_rgba(212,169,58,0.6)] backdrop-blur-md overflow-hidden">
        <div className="bg-gradient-to-b from-chip-gold/35 to-transparent px-4 py-3 text-center animate-winner-glow">
          <div className="text-[10px] uppercase tracking-[0.3em] text-chip-gold/90 font-bold">
            Hand #{handNumber} · Winner
          </div>
          <div className="text-2xl sm:text-3xl font-extrabold text-white mt-1 drop-shadow-[0_2px_8px_rgba(212,169,58,0.5)]">
            {winnerNames}
          </div>
          {mainWinner.handDescription && (
            <div className="text-base sm:text-lg text-chip-gold font-semibold mt-0.5">
              {mainWinner.handDescription}
            </div>
          )}
          <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-chip-gold/25 border border-chip-gold/60 px-3 py-1 text-sm font-mono font-bold text-chip-gold">
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
          <div className="px-3 py-2 border-t border-white/10 space-y-1.5 max-h-48 overflow-y-auto">
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
                      ? "bg-chip-gold/20 border border-chip-gold/50"
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
                      {isWinner && (
                        <span className="ml-1 text-[10px] uppercase tracking-wider">
                          · won
                        </span>
                      )}
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

        {potTotal > 0 && shownHands.length === 0 && (
          <div className="px-3 py-2 border-t border-white/10 text-center text-[11px] text-white/60">
            Pot of {formatChips(potTotal)} taken uncontested
          </div>
        )}

        {secondsLeft !== null && (
          <div className="px-3 py-2 border-t border-white/10 flex items-center justify-between gap-2">
            <div className="text-[11px] text-white/70">
              Next hand in{" "}
              <span className="font-mono font-bold text-white">
                {secondsLeft}s
              </span>
            </div>
            {canDealNow && onDealNow && (
              <button
                onClick={onDealNow}
                className="px-3 py-1 rounded-md bg-chip-gold text-black text-xs font-bold active:scale-[0.98] hover:bg-chip-gold/90"
              >
                Deal now
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
