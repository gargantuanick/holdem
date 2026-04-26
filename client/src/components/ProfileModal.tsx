import { useEffect, useState } from "react";
import type { PlayerProfile } from "@holdem/shared";
import { Modal } from "./Modal";
import { serverUrl } from "../lib/socket";
import { formatChips } from "../lib/format";

export function ProfileModal({
  username,
  onClose,
}: {
  username: string;
  onClose: () => void;
}) {
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${serverUrl()}/api/profile/${encodeURIComponent(username)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error("not found");
        return (await r.json()) as PlayerProfile;
      })
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "error");
      });
    return () => {
      cancelled = true;
    };
  }, [username]);

  return (
    <Modal title={`@${username}`} onClose={onClose}>
      {error && <div className="text-red-300 text-sm">{error}</div>}
      {!profile && !error && (
        <div className="text-white/60 text-sm py-6 text-center">Loading…</div>
      )}
      {profile && (
        <div className="space-y-2 text-sm">
          <Stat label="Wallet" value={formatChips(profile.walletChips)} />
          <Stat label="Hands played" value={profile.handsPlayed.toLocaleString()} />
          <Stat label="Hands won" value={profile.handsWon.toLocaleString()} />
          <Stat
            label="Win rate"
            value={
              profile.handsPlayed > 0
                ? ((profile.handsWon / profile.handsPlayed) * 100).toFixed(1) + "%"
                : "—"
            }
          />
          <Stat
            label="Total chips won"
            value={formatChips(profile.totalChipsWon)}
          />
          <Stat
            label="Total chips lost"
            value={formatChips(profile.totalChipsLost)}
          />
          <Stat
            label="Biggest pot won"
            value={formatChips(profile.biggestPotWon)}
          />
          <Stat label="Tables joined" value={profile.tablesJoined.toLocaleString()} />
          <Stat
            label="Member since"
            value={new Date(profile.createdAt).toLocaleDateString()}
          />
        </div>
      )}
    </Modal>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-white/8 pb-1">
      <span className="text-white/60">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}
