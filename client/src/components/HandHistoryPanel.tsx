import { useState } from "react";
import type { HandHistoryEntry } from "@holdem/shared";

export function HandHistoryPanel({ entries }: { entries: HandHistoryEntry[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="absolute top-2 left-2 z-10">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-[11px] uppercase tracking-wider px-2 py-1 rounded-md bg-white/8 hover:bg-white/12 text-white/80"
      >
        History {open ? "▾" : "▸"}
      </button>
      {open && (
        <div className="mt-1 w-64 max-h-72 overflow-y-auto rounded-lg bg-black/70 border border-white/15 p-2 text-xs space-y-2">
          {entries.length === 0 && (
            <div className="text-white/40 text-center py-2">
              No hands recorded yet.
            </div>
          )}
          {entries.slice(0, 15).map((e) => (
            <div
              key={e.handNumber + e.endedAt}
              className="border-b border-white/5 pb-1.5"
            >
              <div className="text-white/50 text-[10px]">
                #{e.handNumber} · {new Date(e.endedAt).toLocaleTimeString()}
              </div>
              {e.winners.map((w, i) => (
                <div key={i}>
                  <span className="text-chip-gold">{w.username}</span> won{" "}
                  <span className="font-mono">{w.amount}</span>
                  {w.handDescription && (
                    <span className="text-white/50">
                      {" "}
                      · {w.handDescription}
                    </span>
                  )}
                </div>
              ))}
              {e.communityCards && (
                <div className="text-white/40">{e.communityCards}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
