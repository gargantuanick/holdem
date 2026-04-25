import { useEffect, useRef, useState } from "react";

export function WalletBadge({ wallet }: { wallet: number }) {
  const [bumpKey, setBumpKey] = useState(0);
  const prev = useRef(wallet);
  useEffect(() => {
    if (prev.current !== wallet) {
      setBumpKey((k) => k + 1);
      prev.current = wallet;
    }
  }, [wallet]);
  return (
    <div
      key={bumpKey}
      className="rounded-full bg-chip-gold/15 border border-chip-gold/40 text-chip-gold px-3 py-1 text-sm font-mono animate-wallet-bump"
      aria-label={`wallet ${wallet} chips`}
    >
      {wallet.toLocaleString()} ¢
    </div>
  );
}
