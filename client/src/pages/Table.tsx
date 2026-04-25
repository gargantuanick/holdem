import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getSocket } from "../lib/socket";
import { useGameState } from "../hooks/useGameState";
import { useSession } from "../hooks/useSession";
import { TableCanvas } from "../components/TableCanvas";
import { BettingControls } from "../components/BettingControls";
import { ChatPanel } from "../components/ChatPanel";
import { HandHistoryPanel } from "../components/HandHistoryPanel";
import { ProfileModal } from "../components/ProfileModal";
import { WalletBadge } from "../components/WalletBadge";

export function TablePage() {
  const { tableId } = useParams<{ tableId: string }>();
  const navigate = useNavigate();
  const { profile, wallet } = useSession();
  const { state, chat, history, lastHand, errorBanner } = useGameState();
  const [chatOpen, setChatOpen] = useState(false);
  const [profileOf, setProfileOf] = useState<string | null>(null);
  const [unseenChat, setUnseenChat] = useState(0);
  const [rebuyOpen, setRebuyOpen] = useState(false);
  const [_tick, setTick] = useState(0);

  // Force re-render once per second so the timer bar visibly progresses.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Track unseen chat
  useEffect(() => {
    if (!chatOpen && chat.length > 0) {
      setUnseenChat((n) => n + 1);
    }
  }, [chat.length, chatOpen]);
  useEffect(() => {
    if (chatOpen) setUnseenChat(0);
  }, [chatOpen]);

  const leave = useCallback(() => {
    if (!tableId) return;
    getSocket().emit("table:leave", { tableId }, () => {
      navigate("/lobby");
    });
  }, [tableId, navigate]);

  if (!tableId) {
    return <div className="p-6 text-white">No table id</div>;
  }
  const localPlayerId = profile?.id ?? null;
  const mySeat =
    state?.seats.find((s) => s.playerId === localPlayerId) ?? null;
  const sitOut = (out: boolean) => {
    if (!tableId) return;
    getSocket().emit("table:sitOut", { tableId, sittingOut: out });
  };

  return (
    <div className="min-h-full w-full bg-felt-900 text-white relative pb-[120px] safe-top">
      <header className="px-3 py-2 flex items-center gap-2 border-b border-white/10 bg-felt-900/95 backdrop-blur sticky top-0 z-10">
        <button
          onClick={leave}
          className="text-xs px-2 py-1 rounded-md bg-white/8 hover:bg-white/12"
          aria-label="leave table"
        >
          ← Leave
        </button>
        <div className="flex-1 text-center">
          <div className="text-xs text-white/50">{state?.config.name}</div>
          <div className="text-[10px] font-mono text-white/40">
            {state ? `${state.config.smallBlind}/${state.config.bigBlind}` : ""}
          </div>
        </div>
        <WalletBadge wallet={wallet} />
        <button
          onClick={() => setChatOpen(true)}
          className="relative text-xs px-2 py-1 rounded-md bg-white/8 hover:bg-white/12"
          aria-label="chat"
        >
          💬
          {unseenChat > 0 && (
            <span className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full text-[9px] px-1.5">
              {unseenChat}
            </span>
          )}
        </button>
      </header>

      <div className="relative">
        <HandHistoryPanel entries={history} />
        {state ? (
          <TableCanvas
            state={state}
            localPlayerId={localPlayerId}
            lastHandWinners={lastHand?.winners ?? []}
            onProfileClick={(u) => setProfileOf(u)}
          />
        ) : (
          <div className="text-white/60 text-center py-12">Loading table…</div>
        )}
        {errorBanner && (
          <div className="absolute top-2 right-2 left-2 sm:left-auto sm:max-w-xs bg-red-700/90 text-white text-sm px-3 py-2 rounded-md">
            {errorBanner}
          </div>
        )}
        {lastHand && (
          <div className="absolute inset-x-2 top-12 mx-auto max-w-md bg-black/70 border border-chip-gold/40 rounded-lg p-2 text-center text-sm">
            <div className="text-chip-gold font-semibold mb-0.5">
              Hand #{lastHand.handNumber} · pot {lastHand.potTotal}
            </div>
            {lastHand.winners.map((w, i) => (
              <div key={i}>
                <b>{w.username}</b> wins {w.amount}
                {w.handDescription && (
                  <span className="text-white/60"> · {w.handDescription}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="px-3 py-2 flex items-center justify-between text-xs">
        {mySeat && (
          <>
            <div className="flex items-center gap-2">
              <button
                onClick={() => sitOut(!mySeat.sittingOut)}
                className="px-2 py-1 rounded-md bg-white/8 hover:bg-white/12"
              >
                {mySeat.sittingOut ? "Sit in" : "Sit out"}
              </button>
              {state && mySeat.stack < state.config.bigBlind && state.toActSeat !== mySeat.seatIndex && (
                <button
                  onClick={() => setRebuyOpen(true)}
                  className="px-2 py-1 rounded-md bg-chip-gold/80 hover:bg-chip-gold text-black"
                >
                  Rebuy
                </button>
              )}
            </div>
            <div className="text-white/50 font-mono">
              stack {mySeat.stack.toLocaleString()}
            </div>
          </>
        )}
      </div>

      {state && localPlayerId && state.toActSeat !== null && (
        <BettingControls
          state={state}
          tableId={tableId}
          localPlayerId={localPlayerId}
        />
      )}

      {chatOpen && (
        <ChatPanel
          tableId={tableId}
          messages={chat}
          onClose={() => setChatOpen(false)}
        />
      )}
      {profileOf && (
        <ProfileModal
          username={profileOf}
          onClose={() => setProfileOf(null)}
        />
      )}
      {rebuyOpen && state && (
        <RebuyModal
          tableId={tableId}
          state={state}
          wallet={wallet}
          mySeatStack={mySeat?.stack ?? 0}
          onClose={() => setRebuyOpen(false)}
        />
      )}
    </div>
  );
}

function RebuyModal({
  tableId,
  state,
  wallet,
  mySeatStack,
  onClose,
}: {
  tableId: string;
  state: import("@holdem/shared").PublicTableState;
  wallet: number;
  mySeatStack: number;
  onClose: () => void;
}) {
  const cap = state.config.maxBuyIn - mySeatStack;
  const max = Math.min(cap, wallet);
  const min = Math.max(state.config.bigBlind * 2, state.config.minBuyIn - mySeatStack);
  const [amount, setAmount] = useState(Math.min(max, state.config.maxBuyIn / 2));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (max <= 0 || min > max) {
    return (
      <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center px-4">
        <div className="bg-felt-800 p-4 rounded-xl max-w-sm w-full">
          <div>Cannot rebuy: stack already at max or insufficient wallet.</div>
          <button onClick={onClose} className="mt-3 px-3 py-2 bg-white/10 rounded-md">
            Close
          </button>
        </div>
      </div>
    );
  }

  const submit = () => {
    setBusy(true);
    setError(null);
    getSocket().emit("table:rebuy", { tableId, amount }, (res) => {
      setBusy(false);
      if (!res.ok) setError(res.error);
      else onClose();
    });
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/60 flex items-end sm:items-center justify-center px-2">
      <div className="bg-felt-800 border border-white/15 rounded-2xl p-4 w-full max-w-sm safe-bottom">
        <h3 className="text-lg font-semibold mb-2">Rebuy</h3>
        <div className="flex justify-between text-sm text-white/70 mb-1">
          <span>Amount</span>
          <span className="font-mono">{amount.toLocaleString()}</span>
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={Math.max(1, state.config.bigBlind)}
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
          className="chip-slider w-full"
        />
        <div className="flex gap-2 mt-3">
          <button onClick={onClose} className="flex-1 py-2 rounded-md bg-white/8">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="flex-1 py-2 rounded-md bg-chip-gold text-black font-semibold disabled:opacity-50"
          >
            {busy ? "…" : `Rebuy ${amount.toLocaleString()}`}
          </button>
        </div>
        {error && <div className="text-sm text-red-300 mt-2">{error}</div>}
      </div>
    </div>
  );
}
