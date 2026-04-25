import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@holdem/shared";
import { getSocket } from "../lib/socket";

export function ChatPanel({
  tableId,
  messages,
  onClose,
}: {
  tableId: string;
  messages: ChatMessage[];
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  const send = () => {
    const t = draft.trim();
    if (!t) return;
    getSocket().emit("table:chat", { tableId, message: t });
    setDraft("");
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/40">
      <div className="w-full bg-felt-800 border-t border-white/15 max-h-[70dvh] flex flex-col safe-bottom">
        <div className="flex items-center justify-between p-3 border-b border-white/10">
          <h3 className="font-semibold">Table chat</h3>
          <button
            onClick={onClose}
            className="text-white/60 hover:text-white px-2"
          >
            ×
          </button>
        </div>
        <div ref={listRef} className="flex-1 overflow-y-auto p-3 space-y-1">
          {messages.length === 0 && (
            <div className="text-white/40 text-sm text-center py-8">
              No messages yet. Say hi!
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className="text-sm">
              <span className="font-semibold text-chip-gold">{m.username}</span>
              <span className="text-white/85 ml-2">{m.message}</span>
            </div>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="p-2 flex gap-2 border-t border-white/10"
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="message…"
            maxLength={200}
            className="flex-1 bg-white/10 border border-white/15 rounded-md px-3 py-2 text-sm text-white placeholder-white/40 outline-none focus:border-chip-gold/40"
          />
          <button
            type="submit"
            className="px-4 rounded-md bg-chip-gold text-black font-semibold text-sm"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
