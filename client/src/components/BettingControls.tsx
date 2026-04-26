import { useEffect, useMemo, useState } from "react";
import type { PublicTableState } from "@holdem/shared";
import { getSocket } from "../lib/socket";
import { formatChips } from "../lib/format";

interface Props {
  state: PublicTableState;
  tableId: string;
  localPlayerId: number;
}

/**
 * Fixed bottom bar: fold / check or call / raise (with sizing UI).
 * The raise UI slides up over the buttons.
 */
export function BettingControls({ state, tableId, localPlayerId }: Props) {
  const seat = state.seats.find((s) => s.playerId === localPlayerId);
  const isMyTurn = seat && state.toActSeat === seat.seatIndex;

  const [raiseUiOpen, setRaiseUiOpen] = useState(false);
  const toCall = isMyTurn ? state.currentBet - (seat?.betThisStreet ?? 0) : 0;
  const canCheck = toCall === 0;
  const stack = seat?.stack ?? 0;
  const minRaiseTotal = state.currentBet === 0
    ? Math.max(state.minRaise, state.config.bigBlind)
    : state.currentBet + state.minRaise;
  const maxRaiseTotal = (seat?.betThisStreet ?? 0) + stack;

  const [raiseAmount, setRaiseAmount] = useState<number>(minRaiseTotal);

  useEffect(() => {
    if (!raiseUiOpen) return;
    setRaiseAmount(Math.max(minRaiseTotal, Math.min(maxRaiseTotal, minRaiseTotal)));
  }, [raiseUiOpen, minRaiseTotal, maxRaiseTotal]);

  if (!seat) return null;

  function socketAction(
    action:
      | { type: "fold" }
      | { type: "check" }
      | { type: "call" }
      | { type: "bet"; amount: number }
      | { type: "raise"; amount: number }
      | { type: "allin" },
    tid: string,
  ) {
    getSocket().emit("table:action", { tableId: tid, action });
  }

  // Standard pot-size raise math: a "pot-size raise" is currentBet + the
  // size of the pot AFTER you call. Pot-after-call = totalPot + toCall, and
  // your raise size = (totalPot + 2*toCall). So:
  //   pot-raise total = currentBet + totalPot + 2*toCall
  // For an opening bet (currentBet === 0), pot-size = totalPot.
  const quickButtons = useMemo(() => {
    const potAfterCall = state.totalPot + toCall;
    const fullPotRaise =
      state.currentBet === 0
        ? state.totalPot
        : state.currentBet + potAfterCall + toCall;
    const halfPotRaise =
      state.currentBet === 0
        ? Math.floor(state.totalPot / 2)
        : state.currentBet + Math.floor((potAfterCall + toCall) / 2);
    const twoXPotRaise =
      state.currentBet === 0
        ? state.totalPot * 2
        : state.currentBet + (potAfterCall + toCall) * 2;
    const clamp = (v: number) =>
      Math.max(minRaiseTotal, Math.min(maxRaiseTotal, v));
    return [
      { label: "½ pot", value: clamp(halfPotRaise) },
      { label: "pot", value: clamp(fullPotRaise) },
      { label: "2× pot", value: clamp(twoXPotRaise) },
      { label: "all-in", value: maxRaiseTotal },
    ];
  }, [
    minRaiseTotal,
    maxRaiseTotal,
    state.totalPot,
    state.currentBet,
    toCall,
  ]);

  // Disabled state until our turn
  const dim = !isMyTurn;

  return (
    <div className="fixed bottom-0 inset-x-0 safe-bottom bg-felt-900/95 backdrop-blur border-t border-white/10 px-2 pt-2 pb-2 z-20">
      {raiseUiOpen && isMyTurn && (
        <div className="mb-2 rounded-xl bg-felt-800 border border-white/15 p-2 space-y-2">
          <div className="flex items-center justify-between text-xs text-white/70">
            <span>Raise to</span>
            <span className="font-mono text-white">
              {formatChips(raiseAmount)}
            </span>
          </div>
          <input
            type="range"
            min={minRaiseTotal}
            max={maxRaiseTotal}
            step={Math.max(1, state.config.bigBlind)}
            value={Math.max(minRaiseTotal, Math.min(maxRaiseTotal, raiseAmount))}
            onChange={(e) => setRaiseAmount(Number(e.target.value))}
            className="chip-slider w-full"
          />
          <div className="grid grid-cols-4 gap-1">
            {quickButtons.map((qb) => (
              <button
                key={qb.label}
                onClick={() => setRaiseAmount(qb.value)}
                className="text-[11px] py-1.5 rounded-md bg-white/10 hover:bg-white/15"
              >
                {qb.label}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            <button
              onClick={() => setRaiseUiOpen(false)}
              className="flex-1 py-2 rounded-md bg-white/8 text-sm"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                const total = Math.max(
                  minRaiseTotal,
                  Math.min(maxRaiseTotal, raiseAmount),
                );
                if (state.currentBet === 0) {
                  socketAction({ type: "bet", amount: total }, tableId);
                } else if (total === maxRaiseTotal) {
                  socketAction({ type: "allin" }, tableId);
                } else {
                  socketAction({ type: "raise", amount: total }, tableId);
                }
                setRaiseUiOpen(false);
              }}
              className="flex-[2] py-2 rounded-md bg-chip-gold text-black font-semibold text-sm"
            >
              Confirm {formatChips(raiseAmount)}
            </button>
          </div>
        </div>
      )}
      <div className="grid grid-cols-3 gap-1">
        <button
          disabled={dim}
          onClick={() => socketAction({ type: "fold" }, tableId)}
          className={`min-h-[52px] rounded-lg font-bold text-sm ${
            dim
              ? "bg-white/5 text-white/30"
              : "bg-red-700/80 hover:bg-red-700 text-white active:scale-[0.98]"
          }`}
        >
          Fold
        </button>
        <button
          disabled={dim}
          onClick={() =>
            socketAction(canCheck ? { type: "check" } : { type: "call" }, tableId)
          }
          className={`min-h-[52px] rounded-lg font-bold text-sm ${
            dim
              ? "bg-white/5 text-white/30"
              : "bg-blue-700/80 hover:bg-blue-700 text-white active:scale-[0.98]"
          }`}
        >
          {canCheck ? "Check" : `Call ${formatChips(toCall)}`}
        </button>
        <button
          disabled={
            dim ||
            maxRaiseTotal <= state.currentBet ||
            (seat ? !seat.canStillRaise : true)
          }
          onClick={() => setRaiseUiOpen((v) => !v)}
          className={`min-h-[52px] rounded-lg font-bold text-sm ${
            dim || (seat && !seat.canStillRaise)
              ? "bg-white/5 text-white/30"
              : "bg-green-700/80 hover:bg-green-700 text-white active:scale-[0.98]"
          }`}
        >
          {state.currentBet === 0 ? "Bet" : "Raise"}
        </button>
      </div>
    </div>
  );
}
