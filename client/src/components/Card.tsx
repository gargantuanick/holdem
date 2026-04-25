import type { Card as CardT } from "@holdem/shared";

const SUIT_GLYPH = {
  s: "♠",
  h: "♥",
  d: "♦",
  c: "♣",
} as const;

const SUIT_COLOR = {
  s: "text-black",
  h: "text-red-600",
  d: "text-red-600",
  c: "text-black",
} as const;

export function PlayingCard({
  card,
  size = "md",
  faceDown = false,
  glow = false,
}: {
  card?: CardT | null;
  size?: "sm" | "md" | "lg";
  faceDown?: boolean;
  glow?: boolean;
}) {
  const sizes = {
    sm: "w-7 h-10 text-[12px]",
    md: "w-10 h-14 text-base",
    lg: "w-14 h-20 text-xl",
  };
  if (faceDown || !card) {
    return (
      <div
        className={`${sizes[size]} rounded-md bg-gradient-to-br from-blue-700 to-blue-900 border border-white/30 shadow-md flex items-center justify-center`}
        aria-label="face-down card"
      >
        <div className="w-2/3 h-2/3 rounded-sm border border-white/20" />
      </div>
    );
  }
  const rank = card[0];
  const suit = card[1] as keyof typeof SUIT_GLYPH;
  return (
    <div
      className={`${sizes[size]} relative rounded-md bg-white shadow-md border border-black/20 flex flex-col items-center justify-between p-1 animate-card-deal ${glow ? "ring-2 ring-chip-gold" : ""}`}
    >
      <div className={`leading-none font-bold self-start ${SUIT_COLOR[suit]}`}>
        {rank}
      </div>
      <div className={`leading-none ${SUIT_COLOR[suit]} text-2xl`}>
        {SUIT_GLYPH[suit]}
      </div>
      <div
        className={`leading-none font-bold self-end rotate-180 ${SUIT_COLOR[suit]}`}
      >
        {rank}
      </div>
    </div>
  );
}
