export function ChipStack({
  amount,
  small = false,
}: {
  amount: number;
  small?: boolean;
}) {
  if (amount <= 0) return null;
  return (
    <div
      className={`inline-flex items-center gap-1 rounded-full bg-black/40 border border-chip-gold/40 px-2 py-0.5 ${
        small ? "text-[10px]" : "text-xs"
      } font-mono animate-chip-pop`}
    >
      <span className="w-2 h-2 rounded-full bg-chip-gold" />
      {amount.toLocaleString()}
    </div>
  );
}
