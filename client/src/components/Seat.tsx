import { useEffect, useRef, useState } from "react";
import type { Card as CardT, PublicSeat, Winner } from "@holdem/shared";
import { PlayingCard } from "./Card";
import { ChipStack } from "./ChipStack";
import { formatChips } from "../lib/format";

interface Props {
  seat: PublicSeat;
  isLocal: boolean;
  isToAct: boolean;
  isDealer: boolean;
  actionDeadline: number | null;
  winner: Winner | null;
  revealedCards: [CardT, CardT] | null;
  onClickName?: () => void;
}

export function Seat({
  seat,
  isLocal,
  isToAct,
  isDealer,
  actionDeadline,
  winner,
  revealedCards,
  onClickName,
}: Props) {
  if (seat.playerId === null) {
    return (
      <div className="rounded-xl bg-white/5 border border-dashed border-white/15 px-3 py-2 text-xs text-white/40 text-center min-w-[88px] sm:min-w-[110px]">
        empty seat
      </div>
    );
  }
  const winnerHighlight = !!winner;
  const dimmedForOut = seat.sittingOut && !isLocal;
  return (
    <div
      className={`relative rounded-xl border px-2 py-1.5 flex flex-col items-center
        ${isLocal ? "min-w-[120px] sm:min-w-[140px] bg-felt-700/80 border-chip-gold/50" : "min-w-[88px] sm:min-w-[110px] bg-felt-800/80 border-white/15"}
        ${isToAct ? "ring-2 ring-chip-gold animate-pulse" : ""}
        ${winnerHighlight ? "animate-winner-glow" : ""}
        ${seat.hasFolded ? "opacity-50" : ""}
        ${seat.sittingOut ? "ring-2 ring-yellow-500/70" : ""}
        ${dimmedForOut ? "opacity-60 grayscale" : ""}
      `}
    >
      {isDealer && (
        <div className="absolute -top-2 -left-2 w-5 h-5 rounded-full bg-white text-black text-[10px] font-bold flex items-center justify-center shadow">
          D
        </div>
      )}
      {seat.sittingOut && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 text-[9px] font-bold uppercase tracking-widest bg-yellow-500 text-black px-2 py-0.5 rounded-full shadow whitespace-nowrap">
          sitting out
        </div>
      )}
      {!seat.isConnected && (
        <div className="absolute -top-2 right-1 text-[9px] uppercase tracking-wider bg-red-700 text-white px-1.5 py-0.5 rounded">
          DC
        </div>
      )}

      <div
        className={`flex gap-1 mb-1 ${
          isLocal ? "h-20 sm:h-28" : "h-[3.25rem]"
        }`}
      >
        {isLocal && seat.holeCards ? (
          <>
            <PlayingCard card={seat.holeCards[0]} size="xl" />
            <PlayingCard card={seat.holeCards[1]} size="xl" />
          </>
        ) : revealedCards ? (
          <>
            <PlayingCard card={revealedCards[0]} size="sm" />
            <PlayingCard card={revealedCards[1]} size="sm" />
          </>
        ) : seat.hasCards ? (
          <>
            <PlayingCard faceDown size="sm" />
            <PlayingCard faceDown size="sm" />
          </>
        ) : null}
      </div>
      <div className="flex items-center justify-center gap-1 max-w-[112px]">
        {onClickName ? (
          <button
            type="button"
            onClick={onClickName}
            className="min-w-0 text-xs font-semibold truncate hover:underline"
          >
            {seat.username}
          </button>
        ) : (
          <div className="min-w-0 text-xs font-semibold truncate">
            {seat.username}
          </div>
        )}
        {seat.isBot && (
          <span className="shrink-0 rounded bg-sky-400/20 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-sky-100">
            CPU
          </span>
        )}
      </div>
      <StackDisplay stack={seat.stack} prominent={isLocal} />
      {seat.betThisStreet > 0 && (
        <div className="absolute -bottom-3">
          <ChipStack amount={seat.betThisStreet} small />
        </div>
      )}
      {seat.lastAction &&
        (seat.lastAction.type === "bet" ||
          seat.lastAction.type === "call" ||
          seat.lastAction.type === "raise" ||
          seat.lastAction.type === "allin") && (
          <FlyingChip key={`fly-${seat.lastAction.at}`} />
        )}
      {seat.isAllIn && (
        <div className="absolute top-0 right-1 text-[9px] uppercase font-bold text-red-300">
          all-in
        </div>
      )}
      {seat.lastAction && (
        <ActionPill action={seat.lastAction} />
      )}
      {isToAct && actionDeadline !== null && (
        <TimerBar deadline={actionDeadline} />
      )}
    </div>
  );
}

const PILL_STYLES: Record<string, { label: string; cls: string }> = {
  fold: {
    label: "Fold",
    cls: "bg-red-600 text-white ring-2 ring-red-300/60 shadow-[0_0_14px_rgba(239,68,68,0.7)]",
  },
  check: {
    label: "Check",
    cls: "bg-sky-500 text-white ring-2 ring-sky-200/60 shadow-[0_0_14px_rgba(56,189,248,0.7)]",
  },
  call: {
    label: "Call",
    cls: "bg-blue-600 text-white ring-2 ring-blue-200/60 shadow-[0_0_14px_rgba(59,130,246,0.7)]",
  },
  bet: {
    label: "Bet",
    cls: "bg-emerald-500 text-white ring-2 ring-emerald-200/60 shadow-[0_0_14px_rgba(16,185,129,0.8)]",
  },
  raise: {
    label: "Raise",
    cls: "bg-emerald-500 text-white ring-2 ring-emerald-200/60 shadow-[0_0_14px_rgba(16,185,129,0.8)]",
  },
  allin: {
    label: "All-In",
    cls: "bg-yellow-400 text-black ring-2 ring-yellow-100 shadow-[0_0_18px_rgba(234,179,8,0.9)]",
  },
};

function ActionPill({
  action,
}: {
  action: { type: string; amount?: number; at: number };
}) {
  const style = PILL_STYLES[action.type] ?? PILL_STYLES.fold;
  const showAmount =
    typeof action.amount === "number" &&
    (action.type === "bet" ||
      action.type === "raise" ||
      action.type === "allin");
  return (
    <div
      key={action.at}
      className={`absolute -top-5 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-xs sm:text-sm font-extrabold uppercase tracking-wider whitespace-nowrap pointer-events-none z-10 animate-action-pill ${style!.cls}`}
    >
      {style!.label}
      {showAmount ? ` ${action.amount!.toLocaleString()}` : ""}
    </div>
  );
}

function FlyingChip() {
  return (
    <div
      className="absolute left-1/2 -translate-x-1/2 -bottom-3 w-3 h-3 rounded-full bg-chip-gold shadow-[0_0_8px_rgba(212,169,58,0.9)] pointer-events-none animate-chip-fly"
      aria-hidden
    />
  );
}

function StackDisplay({
  stack,
  prominent,
}: {
  stack: number;
  prominent: boolean;
}) {
  const prev = useRef(stack);
  const [delta, setDelta] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    if (prev.current === stack) return;
    setDelta(stack > prev.current ? "up" : "down");
    prev.current = stack;
    const t = setTimeout(() => setDelta(null), 700);
    return () => clearTimeout(t);
  }, [stack]);
  const sizeCls = prominent ? "text-base sm:text-lg" : "text-sm";
  const colorCls =
    delta === "up"
      ? "text-emerald-300"
      : delta === "down"
        ? "text-red-300"
        : "text-chip-gold";
  return (
    <div
      key={delta ? `${stack}-${delta}` : "static"}
      className={`flex items-center gap-1 font-mono font-bold ${sizeCls} ${colorCls} ${
        delta ? "animate-wallet-bump" : ""
      }`}
    >
      <span className="w-2 h-2 rounded-full bg-chip-gold shadow-[0_0_4px_rgba(212,169,58,0.7)]" />
      {formatChips(stack)}
    </div>
  );
}

function TimerBar({ deadline }: { deadline: number }) {
  const total = 30_000;
  const remaining = Math.max(0, deadline - Date.now());
  const pct = Math.max(0, Math.min(100, (remaining / total) * 100));
  return (
    <div className="absolute -bottom-1 left-1 right-1 h-0.5 bg-white/15 overflow-hidden rounded">
      <div
        className="h-full bg-chip-gold"
        style={{
          width: `${pct}%`,
          transition: `width ${remaining}ms linear`,
        }}
      />
    </div>
  );
}
