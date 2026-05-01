import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { LeaderboardEntry } from "@holdem/shared";
import { serverUrl } from "../lib/socket";
import { ProfileModal } from "../components/ProfileModal";
import { formatChips } from "../lib/format";

type SortKey = "wallet" | "won" | "hands_won";

const TABS: { key: SortKey; label: string; col: keyof LeaderboardEntry }[] = [
  { key: "wallet", label: "Wallet", col: "walletChips" },
  { key: "won", label: "Chips Won", col: "totalChipsWon" },
  { key: "hands_won", label: "Hands Won", col: "handsWon" },
];

export function LeaderboardPage() {
  const [tab, setTab] = useState<SortKey>("wallet");
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [profileOf, setProfileOf] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${serverUrl()}/api/leaderboard?sort=${tab}`)
      .then((r) => {
        if (!r.ok) throw new Error("leaderboard unavailable");
        return r.json();
      })
      .then((j: { entries: LeaderboardEntry[] }) => {
        if (!cancelled) {
          setEntries(j.entries);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEntries([]);
          setError("Leaderboard is unavailable right now.");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tab]);

  const tabConf = TABS.find((t) => t.key === tab)!;

  return (
    <div className="min-h-full w-full bg-felt-900 text-white safe-top pb-12">
      <header className="px-4 py-3 flex items-center gap-3 border-b border-white/10 sticky top-0 bg-felt-900/95 backdrop-blur z-10">
        <Link
          to="/lobby"
          className="text-xs px-2 py-1 rounded-md bg-white/8 hover:bg-white/12"
        >
          ← Lobby
        </Link>
        <h1 className="text-lg font-bold">Leaderboard</h1>
      </header>
      <div className="grid grid-cols-3 border-b border-white/10">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`py-3 text-sm ${
              tab === t.key
                ? "text-chip-gold border-b-2 border-chip-gold"
                : "text-white/60"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <ul>
        {entries.map((e) => (
          <li key={e.username}>
            <button
              onClick={() => setProfileOf(e.username)}
              className="w-full px-4 py-3 flex items-center gap-3 text-left border-b border-white/5 hover:bg-white/5"
            >
              <div className="w-7 text-center font-mono text-white/60">
                {e.rank}
              </div>
              <div className="flex-1">
                <div className="font-semibold">{e.username}</div>
                <div className="text-xs text-white/50">
                  {e.handsPlayed} hands · {e.handsWon} won
                </div>
              </div>
              <div className="font-mono">
                {tab === "hands_won"
                  ? (e[tabConf.col] as number).toLocaleString()
                  : formatChips(e[tabConf.col] as number)}
              </div>
            </button>
          </li>
        ))}
        {loading && (
          <li className="text-center text-white/50 py-12">
            Loading leaderboard…
          </li>
        )}
        {!loading && error && (
          <li className="text-center text-red-300 py-12 px-4">{error}</li>
        )}
        {!loading && !error && entries.length === 0 && (
          <li className="text-center text-white/50 py-12">
            No entries yet.
          </li>
        )}
      </ul>
      {profileOf && (
        <ProfileModal username={profileOf} onClose={() => setProfileOf(null)} />
      )}
    </div>
  );
}
