import type {
  Card as CardT,
  HandFinishedPayload,
  PublicTableState,
  Winner,
} from "@holdem/shared";
import { PlayingCard } from "./Card";
import { Seat } from "./Seat";
import { ChipStack } from "./ChipStack";

interface Props {
  state: PublicTableState;
  localPlayerId: number | null;
  lastHandWinners: Winner[];
  shownHands: HandFinishedPayload["shownHands"];
  onProfileClick?: (username: string) => void;
}

/**
 * Mobile horseshoe layout: local player at the bottom, opponents arranged in
 * an arc above. We compute fractional positions along an upper arc.
 */
export function TableCanvas({
  state,
  localPlayerId,
  lastHandWinners,
  shownHands,
  onProfileClick,
}: Props) {
  // Order seats so the local player is at the bottom, then opponents going
  // clockwise.
  const seats = [...state.seats];
  const localIdx = seats.findIndex((s) => s.playerId === localPlayerId);
  const arranged = arrangeForBottomLocal(seats, localIdx);

  return (
    <div className="relative w-full max-w-lg aspect-[3/4] max-h-full mx-auto">
      {/* Felt */}
      <div className="absolute inset-2 rounded-[40%/30%] bg-gradient-to-b from-felt-700 to-felt-900 border-4 border-felt-500/50 shadow-inner" />
      <div className="absolute inset-4 rounded-[40%/30%] border border-white/10" />

      {/* Community cards + pot in the center */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 pointer-events-none">
        <div
          className={`text-[10px] uppercase tracking-widest font-bold ${
            state.inRunout
              ? "text-yellow-300 animate-pulse"
              : "text-white/40"
          }`}
        >
          {state.street === "idle"
            ? "waiting"
            : state.inRunout
              ? `All-in · running it out (${state.street})`
              : `Hand #${state.handNumber} · ${state.street}`}
        </div>
        <div className="flex gap-1 sm:gap-1.5">
          {Array.from({ length: 5 }).map((_, i) => {
            const card = state.communityCards[i];
            return card ? (
              <PlayingCard key={i} card={card} size="lg" />
            ) : (
              <div
                key={i}
                className="w-12 h-[4.25rem] sm:w-16 sm:h-[5.75rem] rounded-md border border-white/10 bg-white/5"
              />
            );
          })}
        </div>
        {state.totalPot > 0 && (
          <div className="mt-1">
            <ChipStack amount={state.totalPot} />
          </div>
        )}
      </div>

      {/* Seats arranged around */}
      {arranged.map((entry, i) => {
        const { seat, position } = entry;
        const isLocal = seat.playerId === localPlayerId;
        const isToAct = state.toActSeat === seat.seatIndex;
        const isDealer = state.dealerSeat === seat.seatIndex;
        const winner =
          lastHandWinners.find((w) => w.seatIndex === seat.seatIndex) ?? null;
        const revealed: [CardT, CardT] | null =
          shownHands.find((sh) => sh.seatIndex === seat.seatIndex)?.cards ?? null;
        return (
          <div
            key={seat.seatIndex}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${position.x * 100}%`, top: `${position.y * 100}%` }}
          >
            <Seat
              seat={seat}
              isLocal={isLocal}
              isToAct={isToAct}
              isDealer={isDealer}
              actionDeadline={isToAct ? state.actionDeadline : null}
              winner={winner}
              revealedCards={revealed}
              onClickName={
                seat.username && !seat.isBot
                  ? () => onProfileClick?.(seat.username!)
                  : undefined
              }
            />
          </div>
        );
      })}
    </div>
  );
}

interface ArrangedSeat {
  seat: import("@holdem/shared").PublicSeat;
  position: { x: number; y: number };
}

/**
 * Layout: local player anchored at bottom-center. Up to 8 opponents arranged
 * along an upper arc.
 *
 * Coordinates are 0..1 across the canvas.
 */
function arrangeForBottomLocal(
  seats: import("@holdem/shared").PublicSeat[],
  localIdx: number,
): ArrangedSeat[] {
  if (localIdx === -1) {
    // Spectator-style: just spread around
    return seats.map((seat, i) => ({
      seat,
      position: pointOnArc(i / seats.length),
    }));
  }
  const result: ArrangedSeat[] = [];
  const N = seats.length;
  // Order: starting from local, go clockwise (increasing seat index modulo).
  const ordered: typeof seats = [];
  for (let k = 0; k < N; k++) {
    ordered.push(seats[(localIdx + k) % N]!);
  }
  // Local player anchored toward the bottom — y=0.85 leaves room for the
  // chunky xl hero cards without spilling past the canvas edge.
  result.push({ seat: ordered[0]!, position: { x: 0.5, y: 0.85 } });
  // Other seats along an upper arc.
  const others = ordered.slice(1);
  for (let i = 0; i < others.length; i++) {
    const t = others.length === 1 ? 0.5 : i / (others.length - 1);
    result.push({ seat: others[i]!, position: pointOnArc(t) });
  }
  return result;
}

function pointOnArc(t: number): { x: number; y: number } {
  // Arc across the top of the canvas. x range tightened to [0.18, 0.82] so
  // edge seats stay fully on-screen at 320–375px viewports — at the prior
  // [0.05, 0.95] range the leftmost/rightmost seat boxes overflowed off
  // the table on mobile.
  const x = 0.18 + t * 0.64;
  // y in [0.14, 0.32]; peak (lowest y) at t=0.5
  const y = 0.32 - Math.sin(t * Math.PI) * 0.18;
  return { x, y };
}
