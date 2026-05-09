import { useEffect, useState } from "react";
import type { HandFinishedPayload, Winner } from "@holdem/shared";
import { PlayingCard } from "./Card";
import { formatChips } from "../lib/format";

interface Props {
  payload: HandFinishedPayload;
  nextHandStartsAt: number | null;
  onDealNow?: () => void;
  canDealNow?: boolean;
}

interface PotGroup {
  potIndex: number;
  amount: number;
  winners: Winner[];
}

export function ShowdownOverlay({
  payload,
  nextHandStartsAt,
  onDealNow,
  canDealNow,
}: Props) {
  const { winners, shownHands, communityCards, potTotal, handNumber } = payload;

  const isUncontested = winners.length > 0 && winners.every(
    (w) => w.handDescription === "uncontested",
  );

  // Group winners by which pot they took. With multiple all-ins, the same
  // player can appear in more than one pot — the per-pot breakdown is the
  // only way to make "who won what" legible.
  const potGroups: PotGroup[] = (() => {
    const byIdx = new Map<number, PotGroup>();
    for (const w of winners) {
      const existing = byIdx.get(w.potIndex);
      if (existing) {
        existing.amount += w.amount;
        existing.winners.push(w);
      } else {
        byIdx.set(w.potIndex, {
          potIndex: w.potIndex,
          amount: w.amount,
          winners: [w],
        });
      }
    }
    return Array.from(byIdx.values()).sort((a, b) => a.potIndex - b.potIndex);
  })();
  const hasSidePots = potGroups.length > 1;

  const totalWon = winners.reduce((acc, w) => acc + w.amount, 0);
  const headlineNames = Array.from(
    new Set(winners.map((w) => w.username)),
  ).join(" & ");
  // With side pots different players can win different pots with different
  // hands. The headline is the simple shared answer; the per-pot breakdown
  // below it carries the per-pot detail.
  const headlineHand = isUncontested
    ? "won uncontested"
    : hasSidePots
      ? "split across side pots"
      : potGroups[0]?.winners[0]?.handDescription ?? "";

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
            Hand #{handNumber} · {hasSidePots ? "Winners" : "Winner"}
          </div>
          <div className="text-2xl sm:text-3xl font-extrabold text-white mt-1 drop-shadow-[0_2px_8px_rgba(212,169,58,0.5)]">
            {headlineNames}
          </div>
          {headlineHand && (
            <div className="text-base sm:text-lg text-chip-gold font-semibold mt-0.5">
              {headlineHand}
            </div>
          )}
          <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-chip-gold/25 border border-chip-gold/60 px-3 py-1 text-sm font-mono font-bold text-chip-gold">
            +{formatChips(totalWon)}
            {hasSidePots && (
              <span className="text-[10px] font-semibold text-chip-gold/80">
                across {potGroups.length} pots
              </span>
            )}
          </div>
        </div>

        {communityCards.length > 0 && (
          <div className="px-3 py-2 flex justify-center gap-1 border-t border-white/10">
            {communityCards.map((c, i) => (
              <PlayingCard key={i} card={c} size="sm" />
            ))}
          </div>
        )}

        <div className="px-3 py-2 border-t border-white/10 space-y-1.5">
          <div className="text-[9px] uppercase tracking-widest text-white/50 font-bold">
            {hasSidePots ? "Pot breakdown" : "Pot"}
          </div>
          {potGroups.map((pg) => (
            <div
              key={pg.potIndex}
              className="rounded-md bg-white/5 border border-white/10 px-2 py-1.5"
            >
              <div className="flex items-center justify-between text-[11px] font-semibold">
                <span className="text-white/85">
                  {potLabel(pg.potIndex, hasSidePots)}
                </span>
                <span className="font-mono text-chip-gold">
                  {formatChips(pg.amount)}
                </span>
              </div>
              <div className="mt-0.5 space-y-0.5">
                {pg.winners.map((w, i) => (
                  <div
                    key={`${w.seatIndex}-${i}`}
                    className="flex items-center justify-between text-[11px]"
                  >
                    <span className="text-white truncate">
                      <span className="font-semibold">{w.username}</span>
                      <span className="text-white/60">
                        {" "}
                        {w.handDescription === "uncontested"
                          ? "— last player standing"
                          : w.handDescription
                            ? `— ${w.handDescription}`
                            : ""}
                      </span>
                    </span>
                    <span className="font-mono text-chip-gold/90 shrink-0 ml-2">
                      +{formatChips(w.amount)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

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
                      {isWinner ? (
                        <span className="ml-1 text-[10px] uppercase tracking-wider">
                          · won
                        </span>
                      ) : (
                        <span className="ml-1 text-[10px] uppercase tracking-wider text-white/55">
                          · lost
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

        {potTotal > 0 && shownHands.length === 0 && isUncontested && (
          <div className="px-3 py-2 border-t border-white/10 text-center text-[11px] text-white/60">
            Everyone else folded — cards not shown
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

function potLabel(potIndex: number, hasSidePots: boolean): string {
  if (!hasSidePots) return "Pot";
  if (potIndex === 0) return "Main pot";
  return `Side pot ${potIndex}`;
}
