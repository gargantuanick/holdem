import { useEffect, useState } from "react";
import type { Card as CardT, HandFinishedPayload, Winner } from "@holdem/shared";
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
  const { winners, shownHands, potTotal, handNumber } = payload;

  // Uncalled-portion refunds are not real wins — strip them from the
  // winner display so a short-stack opponent doesn't look like they
  // shared the pot when really the deep stack just got their own
  // over-commit back.
  const realWinners: Winner[] = winners.filter((w) => !w.uncalled);
  const refundedAmount = winners
    .filter((w) => w.uncalled)
    .reduce((a, w) => a + w.amount, 0);

  const winnerSeats = new Set(realWinners.map((w) => w.seatIndex));
  const orderedShown = [...shownHands].sort((a, b) => {
    const aw = winnerSeats.has(a.seatIndex) ? 0 : 1;
    const bw = winnerSeats.has(b.seatIndex) ? 0 : 1;
    return aw - bw;
  });

  const winnerNames = Array.from(
    new Set(realWinners.map((w) => w.username)),
  ).join(" & ");
  const totalWon = realWinners.reduce((acc, w) => acc + w.amount, 0);
  const mainWinner = realWinners.reduce<Winner | null>(
    (best, w) => (best === null || w.amount > best.amount ? w : best),
    null,
  );
  const uncontestedFold = realWinners.length > 0 && shownHands.length === 0;

  const winningCardSet = new Set<CardT>();
  for (const w of realWinners) {
    if (!w.bestCards) continue;
    for (const c of w.bestCards) winningCardSet.add(c);
  }

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
      className="absolute inset-x-0 top-0 z-20 flex justify-center px-2 pt-1 pointer-events-none"
    >
      <div className="pointer-events-auto w-full max-w-md rounded-2xl bg-black/85 border-2 border-chip-gold/70 shadow-[0_0_48px_rgba(212,169,58,0.6)] backdrop-blur-md overflow-hidden animate-winner-banner-in">
        {/* Headline */}
        <div className="relative px-4 py-2 text-center bg-gradient-to-r from-chip-gold/25 via-chip-gold/55 to-chip-gold/25 bg-[length:200%_100%] animate-winner-banner-shine">
          <div className="text-[10px] uppercase tracking-[0.3em] text-chip-gold font-bold">
            Hand #{handNumber} · Winner
          </div>
          <div className="flex items-baseline justify-center gap-2 mt-0.5">
            <div className="text-xl sm:text-2xl font-extrabold text-white drop-shadow-[0_2px_8px_rgba(212,169,58,0.55)] truncate">
              {winnerNames || "—"}
            </div>
            {totalWon > 0 && (
              <div className="font-mono font-extrabold text-base sm:text-lg text-chip-gold whitespace-nowrap">
                +{formatChips(totalWon)}
              </div>
            )}
          </div>
          {mainWinner?.handDescription && (
            <div className="text-sm sm:text-base text-white/90 font-semibold mt-0.5">
              with {mainWinner.handDescription}
            </div>
          )}
          {uncontestedFold && potTotal > 0 && (
            <div className="text-xs text-white/70 mt-0.5">
              Pot of {formatChips(potTotal)} taken uncontested
            </div>
          )}
          {refundedAmount > 0 && (
            <div className="text-[10px] text-white/55 mt-0.5">
              {formatChips(refundedAmount)} uncalled chips returned
            </div>
          )}
        </div>

        {/* Showdown reveal — all non-folded players' hands, side by side */}
        {orderedShown.length > 0 && (
          <div className="px-2 py-2 border-t border-white/10 bg-black/40 space-y-1.5 max-h-72 overflow-y-auto">
            {orderedShown.map((sh) => {
              const isWinner = winnerSeats.has(sh.seatIndex);
              return (
                <div
                  key={sh.seatIndex}
                  className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${
                    isWinner
                      ? "bg-chip-gold/20 border-2 border-chip-gold/70 shadow-[0_0_18px_rgba(212,169,58,0.55)] animate-winner-glow"
                      : "bg-white/5 border border-white/10 opacity-80"
                  }`}
                >
                  <div className="flex gap-0.5 shrink-0">
                    <PlayingCard
                      card={sh.cards[0]}
                      size="md"
                      highlight={isWinner && winningCardSet.has(sh.cards[0])}
                    />
                    <PlayingCard
                      card={sh.cards[1]}
                      size="md"
                      highlight={isWinner && winningCardSet.has(sh.cards[1])}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div
                      className={`text-sm font-bold truncate ${
                        isWinner ? "text-chip-gold" : "text-white/90"
                      }`}
                    >
                      {sh.username}
                      {isWinner && (
                        <span className="ml-1 text-[10px] uppercase tracking-wider">
                          · winner
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-white/70 truncate">
                      {sh.handDescription}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Countdown / Deal now */}
        {secondsLeft !== null && (
          <div className="px-3 py-1.5 flex items-center justify-between gap-2 bg-black/60 border-t border-white/10">
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
