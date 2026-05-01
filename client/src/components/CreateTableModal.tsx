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
  const [maxSeats, setMaxSeats] = useState(5);
  const [smallBlind, setSmallBlind] = useState(5);
  const [bigBlind, setBigBlind] = useState(10);
  const [minBuyIn, setMinBuyIn] = useState(200);
  const [maxBuyIn, setMaxBuyIn] = useState(1000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const validationError = validateTableConfig({
    name,
    maxSeats,
    smallBlind,
    bigBlind,
    minBuyIn,
    maxBuyIn,
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    setError(null);
    getSocket().emit(
      "lobby:create",
      { name: name.trim(), maxSeats, smallBlind, bigBlind, minBuyIn, maxBuyIn },
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
            max={5}
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
        {(validationError ?? error) && (
          <div className="text-sm text-red-300">{validationError ?? error}</div>
        )}
        <button
          disabled={busy || !!validationError}
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

function validateTableConfig({
  name,
  maxSeats,
  smallBlind,
  bigBlind,
  minBuyIn,
  maxBuyIn,
}: {
  name: string;
  maxSeats: number;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
}): string | null {
  const checks = { maxSeats, smallBlind, bigBlind, minBuyIn, maxBuyIn };
  const labels: Record<keyof typeof checks, string> = {
    maxSeats: "Max seats",
    smallBlind: "Small blind",
    bigBlind: "Big blind",
    minBuyIn: "Min buy-in",
    maxBuyIn: "Max buy-in",
  };
  for (const [label, value] of Object.entries(checks)) {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      return `${labels[label as keyof typeof checks]} must be a whole number`;
    }
  }
  if (name.trim().length === 0) return "Name is required";
  if (maxSeats < 2 || maxSeats > 5) return "Max seats must be 2–5";
  if (smallBlind <= 0 || bigBlind <= 0) return "Blinds must be positive";
  if (smallBlind >= bigBlind) return "Small blind must be below big blind";
  if (minBuyIn < bigBlind * 2) return "Min buy-in must be at least 2 BB";
  if (maxBuyIn < minBuyIn) return "Max buy-in must be at least min buy-in";
  return null;
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
