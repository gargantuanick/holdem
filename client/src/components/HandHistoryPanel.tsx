import type { HandHistoryEntry } from "@holdem/shared";
import { formatChips } from "../lib/format";

interface Props {
  entries: HandHistoryEntry[];
  onClose: () => void;
}

/**
 * Slide-up modal showing recent hand history. Mirrors ChatPanel UX so it's
 * discoverable from the table header.
 */
export function HandHistoryPanel({ entries, onClose }: Props) {
  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/40">
      <div className="w-full bg-felt-800 border-t border-white/15 max-h-[70dvh] flex flex-col safe-bottom">
        <div className="flex items-center justify-between p-3 border-b border-white/10">
          <h3 className="font-semibold">Hand history</h3>
          <button
            onClick={onClose}
            className="text-white/60 hover:text-white px-2"
            aria-label="close"
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2 text-sm">
          {entries.length === 0 && (
            <div className="text-white/40 text-center py-8">
              No hands recorded yet.
            </div>
          )}
          {entries.map((e) => (
            <HistoryEntry key={e.handNumber + e.endedAt} entry={e} />
          ))}
        </div>
      </div>
    </div>
  );
}

function HistoryEntry({ entry }: { entry: HandHistoryEntry }) {
  const winners = Array.isArray(entry.winners) ? entry.winners : [];
  return (
    <div className="rounded-md bg-white/5 border border-white/10 p-2">
      <div className="text-white/50 text-[11px] mb-0.5">
        #{entry.handNumber} · {new Date(entry.endedAt).toLocaleTimeString()} · pot{" "}
        <span className="font-mono">{formatChips(entry.potTotal)}</span>
      </div>
      {winners.map((w, i) => (
        <div key={i}>
          <span className="text-chip-gold font-semibold">{w.username}</span>{" "}
          won <span className="font-mono">{formatChips(w.amount)}</span>
          {w.handDescription && (
            <span className="text-white/50"> · {w.handDescription}</span>
          )}
        </div>
      ))}
      {entry.communityCards && (
        <div className="text-white/40 text-xs font-mono mt-0.5">
          {entry.communityCards}
        </div>
      )}
    </div>
  );
}
