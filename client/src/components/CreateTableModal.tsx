import { useState } from "react";
import { Modal } from "./Modal";
import { getSocket } from "../lib/socket";

export function CreateTableModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (tableId: string) => void;
}) {
  const [name, setName] = useState("My Table");
  const [maxSeats, setMaxSeats] = useState(6);
  const [smallBlind, setSmallBlind] = useState(5);
  const [bigBlind, setBigBlind] = useState(10);
  const [minBuyIn, setMinBuyIn] = useState(200);
  const [maxBuyIn, setMaxBuyIn] = useState(1000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    getSocket().emit(
      "lobby:create",
      { name, maxSeats, smallBlind, bigBlind, minBuyIn, maxBuyIn },
      (res) => {
        setBusy(false);
        if (!res.ok) {
          setError(res.error);
        } else {
          onCreated(res.tableId);
        }
      },
    );
  };

  return (
    <Modal title="Create table" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input"
            maxLength={40}
          />
        </Field>
        <Field label={`Max seats (${maxSeats})`}>
          <input
            type="range"
            min={2}
            max={9}
            value={maxSeats}
            onChange={(e) => setMaxSeats(Number(e.target.value))}
            className="chip-slider w-full"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Small blind">
            <input
              type="number"
              value={smallBlind}
              onChange={(e) => setSmallBlind(Number(e.target.value))}
              className="input"
              min={1}
            />
          </Field>
          <Field label="Big blind">
            <input
              type="number"
              value={bigBlind}
              onChange={(e) => setBigBlind(Number(e.target.value))}
              className="input"
              min={2}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Min buy-in">
            <input
              type="number"
              value={minBuyIn}
              onChange={(e) => setMinBuyIn(Number(e.target.value))}
              className="input"
              min={bigBlind * 2}
            />
          </Field>
          <Field label="Max buy-in">
            <input
              type="number"
              value={maxBuyIn}
              onChange={(e) => setMaxBuyIn(Number(e.target.value))}
              className="input"
              min={minBuyIn}
            />
          </Field>
        </div>
        {error && <div className="text-sm text-red-300">{error}</div>}
        <button
          disabled={busy}
          type="submit"
          className="w-full rounded-lg bg-chip-gold text-black font-semibold py-3 disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create"}
        </button>
      </form>
      <style>{`.input { width:100%; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); color: white; padding: 0.6rem 0.75rem; border-radius: 0.5rem; }`}</style>
    </Modal>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-xs text-white/60 mb-1">{label}</div>
      {children}
    </label>
  );
}
