import { useState } from "react";
import type { LobbyTableSummary } from "@holdem/shared";
import { Modal } from "./Modal";
import { getSocket } from "../lib/socket";
import { formatChips } from "../lib/format";

export function JoinTableModal({
  table,
  wallet,
  onClose,
  onJoined,
}: {
  table: LobbyTableSummary;
  wallet: number;
  onClose: () => void;
  onJoined: () => void;
}) {
  const minBuy = table.minBuyIn;
  const maxBuy = Math.min(table.maxBuyIn, wallet);
  const initial = Math.min(maxBuy, table.maxBuyIn);
  const [buyIn, setBuyIn] = useState<number>(
    initial >= minBuy ? initial : minBuy,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const insufficient = wallet < minBuy;

  const submit = () => {
    if (insufficient) return;
    setBusy(true);
    setError(null);
    getSocket().emit("table:join", { tableId: table.id, buyIn }, (res) => {
      setBusy(false);
      if (!res.ok) {
        // If we're already at the table from a prior session/device,
        // skip the buy-in and just go to the table page.
        if (res.error === "already at this table") {
          onJoined();
          return;
        }
        setError(res.error);
      } else {
        onJoined();
      }
    });
  };

  return (
    <Modal title={`Join ${table.name}`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <div className="flex justify-between text-white/70">
          <span>Blinds</span>
          <span className="font-mono">
            {formatChips(table.smallBlind)}/{formatChips(table.bigBlind)}
          </span>
        </div>
        <div className="flex justify-between text-white/70">
          <span>Buy-in range</span>
          <span className="font-mono">
            {formatChips(table.minBuyIn)}–{formatChips(table.maxBuyIn)}
          </span>
        </div>
        <div className="flex justify-between text-white/70">
          <span>Wallet</span>
          <span className="font-mono">{formatChips(wallet)}</span>
        </div>

        {insufficient ? (
          <div className="text-red-300 text-sm">
            You need at least {formatChips(minBuy)} to join this table.
          </div>
        ) : (
          <>
            <div>
              <div className="flex justify-between mb-1">
                <span className="text-white/60">Buy-in amount</span>
                <span className="font-mono">{formatChips(buyIn)}</span>
              </div>
              <input
                type="range"
                min={minBuy}
                max={maxBuy}
                step={Math.max(1, table.bigBlind)}
                value={buyIn}
                onChange={(e) => setBuyIn(Number(e.target.value))}
                className="chip-slider w-full"
              />
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => setBuyIn(minBuy)}
                  className="flex-1 text-xs py-1.5 rounded-md bg-white/8 hover:bg-white/12"
                >
                  min
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setBuyIn(Math.floor((minBuy + maxBuy) / 2))
                  }
                  className="flex-1 text-xs py-1.5 rounded-md bg-white/8 hover:bg-white/12"
                >
                  ½
                </button>
                <button
                  type="button"
                  onClick={() => setBuyIn(maxBuy)}
                  className="flex-1 text-xs py-1.5 rounded-md bg-white/8 hover:bg-white/12"
                >
                  max
                </button>
              </div>
            </div>
            {error && <div className="text-sm text-red-300">{error}</div>}
            <button
              onClick={submit}
              disabled={busy}
              className="w-full rounded-lg bg-chip-gold text-black font-semibold py-3 disabled:opacity-50"
            >
              {busy ? "Joining…" : `Buy in for ${formatChips(buyIn)}`}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
