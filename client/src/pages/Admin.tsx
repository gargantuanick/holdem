import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { AdminPlayerSummary } from "@holdem/shared";
import { serverUrl } from "../lib/socket";
import { loadToken } from "../lib/session";
import { useSession } from "../hooks/useSession";
import { formatChips } from "../lib/format";

const STARTING_WALLET = 10_000;

export function AdminPage() {
  const { profile, setProfile, setWallet } = useSession();
  const [players, setPlayers] = useState<AdminPlayerSummary[]>([]);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const isAdmin = profile?.username === "nk";

  const loadPlayers = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    setError(null);
    try {
      const token = loadToken();
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      params.set("limit", "200");
      const res = await fetch(`${serverUrl()}/api/admin/players?${params}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const body = (await res.json().catch(() => null)) as
        | { players?: AdminPlayerSummary[]; error?: string }
        | null;
      if (!res.ok) {
        throw new Error(body?.error ?? "failed to load players");
      }
      const nextPlayers = body?.players ?? [];
      setPlayers(nextPlayers);
      setSelectedIds((prev) => {
        const visibleIds = new Set(nextPlayers.map((player) => player.id));
        return new Set([...prev].filter((id) => visibleIds.has(id)));
      });
      setDrafts((prev) => {
        const next: Record<number, string> = {};
        for (const player of nextPlayers) {
          next[player.id] = prev[player.id] ?? String(player.walletChips);
        }
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load players");
    } finally {
      setLoading(false);
    }
  }, [isAdmin, query]);

  useEffect(() => {
    void loadPlayers();
  }, [loadPlayers]);

  const changedCount = useMemo(
    () =>
      players.filter((p) => Number(drafts[p.id]) !== p.walletChips).length,
    [drafts, players],
  );
  const visibleSelectableIds = useMemo(
    () =>
      players
        .filter((player) => player.id !== profile?.id)
        .map((player) => player.id),
    [players, profile?.id],
  );
  const selectedPlayers = useMemo(
    () => players.filter((player) => selectedIds.has(player.id)),
    [players, selectedIds],
  );
  const allVisibleSelected =
    visibleSelectableIds.length > 0 &&
    visibleSelectableIds.every((id) => selectedIds.has(id));

  const setSelected = (playerId: number, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selected) next.add(playerId);
      else next.delete(playerId);
      return next;
    });
  };

  const setAllVisibleSelected = (selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of visibleSelectableIds) {
        if (selected) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const setDraft = (playerId: number, value: number | string) => {
    setDrafts((prev) => ({ ...prev, [playerId]: String(value) }));
  };

  const saveWallet = async (player: AdminPlayerSummary, amountRaw?: number) => {
    const walletChips =
      amountRaw ?? Number.parseInt(drafts[player.id] ?? "", 10);
    if (!Number.isInteger(walletChips) || walletChips < 0) {
      setError("Wallet must be a non-negative whole number.");
      return;
    }
    if (
      !confirm(
        `Set ${player.username}'s wallet to ${formatChips(walletChips)}?`,
      )
    ) {
      return;
    }
    setSavingId(player.id);
    setError(null);
    setFeedback(null);
    try {
      const token = loadToken();
      const res = await fetch(
        `${serverUrl()}/api/admin/players/${player.id}/wallet`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ walletChips }),
        },
      );
      const body = (await res.json().catch(() => null)) as
        | { player?: AdminPlayerSummary; error?: string }
        | null;
      if (!res.ok || !body?.player) {
        throw new Error(body?.error ?? "wallet update failed");
      }
      const updated = body.player;
      setPlayers((prev) =>
        prev.map((p) => (p.id === updated.id ? updated : p)),
      );
      setDraft(updated.id, updated.walletChips);
      if (profile?.id === updated.id) {
        setProfile(updated);
        setWallet(updated.walletChips);
      }
      setFeedback(`${updated.username} wallet set to ${formatChips(updated.walletChips)}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "wallet update failed");
    } finally {
      setSavingId(null);
    }
  };

  const deleteRosterPlayers = async (targets: AdminPlayerSummary[]) => {
    const removable = targets.filter((player) => player.id !== profile?.id);
    if (removable.length === 0) {
      setError("You cannot remove your own admin account.");
      return;
    }
    const preview = removable
      .slice(0, 6)
      .map((player) => player.username)
      .join(", ");
    const more =
      removable.length > 6 ? ` and ${removable.length - 6} more` : "";
    if (
      !confirm(
        `Remove ${removable.length} player profile${removable.length === 1 ? "" : "s"} from the roster?\n\n${preview}${more}\n\nThis deletes their profile and active sessions. This cannot be undone.`,
      )
    ) {
      return;
    }
    setBulkBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const token = loadToken();
      const res =
        removable.length === 1
          ? await fetch(`${serverUrl()}/api/admin/players/${removable[0]!.id}`, {
              method: "DELETE",
              headers: token ? { Authorization: `Bearer ${token}` } : {},
            })
          : await fetch(`${serverUrl()}/api/admin/players/bulk-delete`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify({
                playerIds: removable.map((player) => player.id),
              }),
            });
      const body = (await res.json().catch(() => null)) as
        | { deleted?: AdminPlayerSummary[]; error?: string; missing?: number[] }
        | null;
      if (!res.ok) {
        throw new Error(body?.error ?? "player delete failed");
      }
      const deleted = body?.deleted ?? [];
      const deletedIds = new Set(deleted.map((player) => player.id));
      setPlayers((prev) => prev.filter((player) => !deletedIds.has(player.id)));
      setDrafts((prev) => {
        const next = { ...prev };
        for (const id of deletedIds) delete next[id];
        return next;
      });
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of deletedIds) next.delete(id);
        return next;
      });
      const missingCount = body?.missing?.length ?? 0;
      setFeedback(
        `Removed ${deleted.length} player${deleted.length === 1 ? "" : "s"}${missingCount > 0 ? ` (${missingCount} already missing)` : ""}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "player delete failed");
    } finally {
      setBulkBusy(false);
    }
  };

  if (!isAdmin) {
    return (
      <div className="min-h-full w-full bg-felt-900 text-white safe-top">
        <header className="px-4 py-3 flex items-center gap-3 border-b border-white/10">
          <Link
            to="/lobby"
            className="text-xs px-2 py-1 rounded-md bg-white/8 hover:bg-white/12"
          >
            Lobby
          </Link>
          <h1 className="text-lg font-bold">Admin</h1>
        </header>
        <main className="px-4 py-10 text-center text-white/60">
          Not authorized.
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-full w-full bg-felt-900 text-white safe-top">
      <header className="px-4 py-3 flex items-center gap-3 border-b border-white/10 sticky top-0 bg-felt-900/95 backdrop-blur z-10">
        <Link
          to="/lobby"
          className="text-xs px-2 py-1 rounded-md bg-white/8 hover:bg-white/12"
        >
          Lobby
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-bold">Player Admin</h1>
          <div className="text-[11px] text-white/50">
            Wallet and roster controls. Clear seated players before removing them.
          </div>
        </div>
        <button
          onClick={() => void loadPlayers()}
          disabled={loading}
          className="text-xs px-3 py-1.5 rounded-md bg-white/8 hover:bg-white/12 disabled:opacity-50"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </header>

      <main className="px-4 py-4 space-y-3 pb-20">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void loadPlayers();
          }}
          className="flex gap-2"
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search usernames"
            className="flex-1 rounded-lg bg-white/10 border border-white/15 text-white placeholder-white/40 px-3 py-2 outline-none focus:ring-2 focus:ring-chip-gold/60"
          />
          <button
            type="submit"
            className="px-4 rounded-lg bg-chip-gold text-black font-semibold text-sm"
          >
            Search
          </button>
        </form>

        {(error || feedback) && (
          <div
            role="status"
            className={`rounded-lg px-3 py-2 text-sm border ${
              error
                ? "bg-red-500/15 border-red-400/40 text-red-100"
                : "bg-emerald-500/15 border-emerald-400/40 text-emerald-100"
            }`}
          >
            {error ?? feedback}
          </div>
        )}

        <div className="flex items-center justify-between text-xs text-white/50">
          <span>{players.length} players</span>
          <span>
            {changedCount} unsaved · {selectedPlayers.length} selected
          </span>
        </div>

        <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-2 text-white/70">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              disabled={visibleSelectableIds.length === 0}
              onChange={(e) => setAllVisibleSelected(e.target.checked)}
              className="accent-chip-gold"
            />
            Select visible
          </label>
          <button
            type="button"
            disabled={selectedPlayers.length === 0 || bulkBusy}
            onClick={() => void deleteRosterPlayers(selectedPlayers)}
            className="px-3 py-1.5 rounded-md bg-red-700/80 hover:bg-red-700 text-white font-semibold disabled:opacity-50"
          >
            {bulkBusy ? "Removing..." : "Remove selected"}
          </button>
          <button
            type="button"
            disabled={selectedPlayers.length === 0 || bulkBusy}
            onClick={() => setSelectedIds(new Set())}
            className="px-3 py-1.5 rounded-md bg-white/8 hover:bg-white/12 disabled:opacity-50"
          >
            Clear selection
          </button>
        </div>

        <div className="space-y-2">
          {players.map((player) => {
            const draft = drafts[player.id] ?? String(player.walletChips);
            const draftValue = Number.parseInt(draft, 10);
            const dirty = draftValue !== player.walletChips;
            const saving = savingId === player.id;
            const isSelf = player.id === profile?.id;
            const selected = selectedIds.has(player.id);
            return (
              <section
                key={player.id}
                className={`rounded-lg border p-3 ${
                  selected
                    ? "bg-chip-gold/10 border-chip-gold/50"
                    : "bg-white/5 border-white/10"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={isSelf || bulkBusy}
                      onChange={(e) => setSelected(player.id, e.target.checked)}
                      className="mt-1 accent-chip-gold"
                      aria-label={`select ${player.username}`}
                    />
                    <div className="min-w-0">
                      <div className="font-semibold truncate">
                        {player.username}
                        {isSelf && (
                          <span className="ml-2 text-[10px] font-normal text-white/40">
                            you
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-white/50">
                        ID {player.id} · {player.handsPlayed.toLocaleString()} hands · {player.handsWon.toLocaleString()} won
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-wider text-white/40">
                      Current
                    </div>
                    <div className="font-mono text-chip-gold">
                      {formatChips(player.walletChips)}
                    </div>
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
                  <input
                    type="number"
                    min={0}
                    step={100}
                    value={draft}
                    onChange={(e) => setDraft(player.id, e.target.value)}
                    className="rounded-md bg-white/10 border border-white/15 text-white px-3 py-2 font-mono outline-none focus:border-chip-gold/60"
                  />
                  <button
                    onClick={() => void saveWallet(player)}
                    disabled={saving || !dirty}
                    className="px-4 rounded-md bg-chip-gold text-black font-semibold text-sm disabled:opacity-50"
                  >
                    {saving ? "Saving" : "Set"}
                  </button>
                </div>

                <div className="mt-2 grid grid-cols-4 gap-1">
                  <button
                    onClick={() => void saveWallet(player, 0)}
                    disabled={saving || bulkBusy}
                    className="py-1.5 rounded-md bg-white/8 hover:bg-white/12 text-xs disabled:opacity-50"
                  >
                    Zero
                  </button>
                  <button
                    onClick={() => void saveWallet(player, STARTING_WALLET)}
                    disabled={saving || bulkBusy}
                    className="py-1.5 rounded-md bg-white/8 hover:bg-white/12 text-xs disabled:opacity-50"
                  >
                    Reset {formatChips(STARTING_WALLET)}
                  </button>
                  <button
                    onClick={() =>
                      void saveWallet(player, player.walletChips + 1_000)
                    }
                    disabled={saving || bulkBusy}
                    className="py-1.5 rounded-md bg-white/8 hover:bg-white/12 text-xs disabled:opacity-50"
                  >
                    +{formatChips(1_000)}
                  </button>
                  <button
                    onClick={() => void deleteRosterPlayers([player])}
                    disabled={isSelf || saving || bulkBusy}
                    className="py-1.5 rounded-md bg-red-700/70 hover:bg-red-700 text-xs disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              </section>
            );
          })}

          {!loading && players.length === 0 && (
            <div className="text-center text-white/50 py-12">
              No players found.
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
