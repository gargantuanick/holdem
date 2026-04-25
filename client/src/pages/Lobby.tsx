import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { LobbyTableSummary } from "@holdem/shared";
import { getSocket } from "../lib/socket";
import { useSession } from "../hooks/useSession";
import { WalletBadge } from "../components/WalletBadge";
import { CreateTableModal } from "../components/CreateTableModal";
import { JoinTableModal } from "../components/JoinTableModal";

export function LobbyPage() {
  const { profile, wallet, logout, setWallet } = useSession();
  const [tables, setTables] = useState<LobbyTableSummary[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [joining, setJoining] = useState<LobbyTableSummary | null>(null);
  const [refillBusy, setRefillBusy] = useState(false);
  const [refillMsg, setRefillMsg] = useState<string | null>(null);
  const navigate = useNavigate();

  const refresh = useCallback(() => {
    getSocket().emit("lobby:list", (list) => setTables(list));
  }, []);

  const isAdmin = profile?.username === "nk";

  const clearTable = (tableId: string) => {
    if (!confirm("Clear all seats at this table?")) return;
    getSocket().emit("admin:clearTable", { tableId }, (res) => {
      if (res.ok) {
        refresh();
      } else {
        alert(`Clear failed: ${res.error}`);
      }
    });
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [refresh]);

  const requestRefill = () => {
    setRefillBusy(true);
    setRefillMsg(null);
    getSocket().emit("auth:refill", (res) => {
      setRefillBusy(false);
      if (res.ok) {
        setWallet(res.wallet);
        setRefillMsg("Refilled! +1,000 chips");
      } else {
        if (res.nextRefillAt) {
          setRefillMsg(
            `Daily refill on cooldown until ${new Date(res.nextRefillAt).toLocaleString()}`,
          );
        } else if (res.error === "wallet not empty") {
          setRefillMsg("Refill is only available when your wallet is empty.");
        } else {
          setRefillMsg(res.error);
        }
      }
    });
  };

  return (
    <div className="min-h-full w-full bg-felt-900 text-white safe-top">
      <header className="px-4 py-3 flex items-center justify-between border-b border-white/10 sticky top-0 bg-felt-900/95 backdrop-blur z-10">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold tracking-tight">Hold'em</h1>
          <Link
            to="/leaderboard"
            className="text-xs text-white/60 hover:text-white"
          >
            Leaderboard
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <WalletBadge wallet={wallet} />
          <button
            onClick={logout}
            className="text-xs text-white/50 hover:text-white px-2 py-1"
            aria-label="logout"
          >
            ↪
          </button>
        </div>
      </header>

      <main className="px-4 py-4 space-y-4 pb-24">
        <section>
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="text-sm text-white/60">Welcome,</div>
              <div className="text-lg font-semibold">{profile?.username}</div>
            </div>
            <div className="text-right">
              <div className="text-xs text-white/50">Hands won</div>
              <div className="font-mono text-lg">{profile?.handsWon ?? 0}</div>
            </div>
          </div>
          {wallet === 0 && (
            <div className="rounded-lg border border-chip-gold/40 bg-chip-gold/10 p-3 mt-2">
              <div className="text-sm">You're broke! Get your daily refill.</div>
              <button
                disabled={refillBusy}
                onClick={requestRefill}
                className="mt-2 rounded-md bg-chip-gold text-black font-semibold px-3 py-2 text-sm disabled:opacity-50"
              >
                {refillBusy ? "Requesting…" : "Claim 1,000 chips"}
              </button>
              {refillMsg && (
                <div className="mt-2 text-xs text-white/70">{refillMsg}</div>
              )}
            </div>
          )}
          {refillMsg && wallet > 0 && (
            <div className="mt-2 text-xs text-white/70">{refillMsg}</div>
          )}
        </section>

        <section>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-white/60">
              Open tables
            </h2>
            <button
              onClick={() => setCreateOpen(true)}
              className="text-xs px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/15"
            >
              + Create table
            </button>
          </div>
          <div className="space-y-2">
            {tables.length === 0 && (
              <div className="text-center text-white/40 py-8">No tables yet</div>
            )}
            {tables.map((t) => (
              <div
                key={t.id}
                className="rounded-xl bg-white/5 border border-white/10 flex items-stretch"
              >
                <button
                  onClick={() => setJoining(t)}
                  className="flex-1 text-left p-3 flex items-center justify-between gap-3 hover:bg-white/5 active:bg-white/10 rounded-l-xl"
                >
                  <div>
                    <div className="font-semibold">{t.name}</div>
                    <div className="text-xs text-white/60">
                      {t.smallBlind}/{t.bigBlind} blinds · buy-in {t.minBuyIn}–{t.maxBuyIn}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-white/50">Seats</div>
                    <div className="font-mono">
                      {t.occupiedSeats}/{t.maxSeats}
                    </div>
                  </div>
                </button>
                {isAdmin && t.occupiedSeats > 0 && (
                  <button
                    onClick={() => clearTable(t.id)}
                    className="px-3 text-xs text-red-300 hover:bg-red-500/20 border-l border-white/10 rounded-r-xl"
                    title="Admin: clear all seats"
                  >
                    Clear
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      </main>

      {createOpen && (
        <CreateTableModal
          onClose={() => setCreateOpen(false)}
          onCreated={(tableId) => {
            setCreateOpen(false);
            refresh();
            // After creating, find it and trigger join modal.
            const t = tables.find((x) => x.id === tableId);
            if (t) setJoining(t);
            else {
              // Fetch fresh list with the new table
              getSocket().emit("lobby:list", (list) => {
                setTables(list);
                const fresh = list.find((x) => x.id === tableId);
                if (fresh) setJoining(fresh);
              });
            }
          }}
        />
      )}
      {joining && (
        <JoinTableModal
          table={joining}
          wallet={wallet}
          onClose={() => setJoining(null)}
          onJoined={() => {
            setJoining(null);
            navigate(`/table/${joining.id}`);
          }}
        />
      )}
    </div>
  );
}
