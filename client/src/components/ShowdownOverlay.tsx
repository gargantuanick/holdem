import { useEffect, useState } from "react";
import type { HandFinishedPayload } from "@holdem/shared";
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
  const { winners, potTotal, handNumber } = payload;

  const winnerNames = Array.from(
    new Set(winners.map((w) => w.username)),
  ).join(" & ");
  const totalWon = winners.reduce((acc, w) => acc + w.amount, 0);
  const mainWinner = winners.reduce(
    (best, w) => (w.amount > best.amount ? w : best),
    winners[0]!,
  );
  const uncontested = mainWinner.handDescription === "uncontested";

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
      className="absolute inset-x-0 top-0 z-20 flex justify-center px-3 pt-2 pointer-events-none"
    >
      <div className="pointer-events-auto w-full max-w-md rounded-2xl bg-black/85 border-2 border-chip-gold/70 shadow-[0_0_48px_rgba(212,169,58,0.6)] backdrop-blur-md overflow-hidden animate-winner-banner-in">
        <div
          className="relative px-4 py-2.5 text-center bg-gradient-to-r from-chip-gold/25 via-chip-gold/55 to-chip-gold/25 bg-[length:200%_100%] animate-winner-banner-shine"
        >
          <div className="text-[10px] uppercase tracking-[0.3em] text-chip-gold font-bold">
            Hand #{handNumber} · Winner
          </div>
          <div className="flex items-baseline justify-center gap-2 mt-0.5">
            <div className="text-xl sm:text-2xl font-extrabold text-white drop-shadow-[0_2px_8px_rgba(212,169,58,0.55)] truncate">
              {winnerNames}
            </div>
            <div className="font-mono font-extrabold text-base sm:text-lg text-chip-gold whitespace-nowrap">
              +{formatChips(totalWon)}
            </div>
          </div>
          {!uncontested && mainWinner.handDescription && (
            <div className="text-sm sm:text-base text-white/90 font-semibold mt-0.5">
              with {mainWinner.handDescription}
            </div>
          )}
          {uncontested && potTotal > 0 && (
            <div className="text-xs text-white/70 mt-0.5">
              Pot of {formatChips(potTotal)} taken uncontested
            </div>
          )}
        </div>

        {secondsLeft !== null && (
          <div className="px-3 py-1.5 flex items-center justify-between gap-2 bg-black/40 border-t border-white/10">
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
