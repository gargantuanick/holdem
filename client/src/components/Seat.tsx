import type { PublicSeat, Winner } from "@holdem/shared";
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
  onClickName?: () => void;
}

export function Seat({
  seat,
  isLocal,
  isToAct,
  isDealer,
  actionDeadline,
  winner,
  onClickName,
}: Props) {
  if (seat.playerId === null) {
    return (
      <div className="rounded-xl bg-white/5 border border-dashed border-white/15 px-3 py-2 text-xs text-white/40 text-center min-w-[110px]">
        empty seat
      </div>
    );
  }
  const winnerHighlight = !!winner;
  const dimmedForOut = seat.sittingOut && !isLocal;
  return (
    <div
      className={`relative rounded-xl border px-2 py-1.5 min-w-[110px] flex flex-col items-center
        ${isLocal ? "bg-felt-700/80 border-chip-gold/50" : "bg-felt-800/80 border-white/15"}
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
          isLocal ? "h-[4.25rem]" : "h-[3.25rem]"
        }`}
      >
        {seat.hasCards ? (
          isLocal && seat.holeCards ? (
            <>
              <PlayingCard card={seat.holeCards[0]} size="md" />
              <PlayingCard card={seat.holeCards[1]} size="md" />
            </>
          ) : (
            <>
              <PlayingCard faceDown size="sm" />
              <PlayingCard faceDown size="sm" />
            </>
          )
        ) : null}
      </div>
      <button
        type="button"
        onClick={onClickName}
        className="text-xs font-semibold truncate max-w-[100px] hover:underline"
      >
        {seat.username}
      </button>
      <div className="text-[11px] font-mono text-white/80">
        {formatChips(seat.stack)}
      </div>
      {seat.betThisStreet > 0 && (
        <div className="absolute -bottom-3">
          <ChipStack amount={seat.betThisStreet} small />
        </div>
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
  fold: { label: "Fold", cls: "bg-red-700/90 text-white" },
  check: { label: "Check", cls: "bg-blue-700/90 text-white" },
  call: { label: "Call", cls: "bg-blue-700/90 text-white" },
  bet: { label: "Bet", cls: "bg-emerald-700/90 text-white" },
  raise: { label: "Raise", cls: "bg-emerald-700/90 text-white" },
  allin: { label: "All-in", cls: "bg-yellow-500 text-black" },
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
      // Re-key on `at` so a new action restarts the animation even if the
      // component is reused.
      key={action.at}
      className={`absolute -top-3 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider shadow whitespace-nowrap pointer-events-none animate-action-pill ${style!.cls}`}
    >
      {style!.label}
      {showAmount ? ` ${action.amount!.toLocaleString()}` : ""}
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
