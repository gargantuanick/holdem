/**
 * Display chips as `$X,XXX`. Negative inputs render as `-$X,XXX`.
 * NaN / non-finite render as `$0` so we never spew "$NaN" on screen.
 */
export function formatChips(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "$0";
  if (n < 0) return `-$${Math.abs(Math.trunc(n)).toLocaleString()}`;
  return `$${Math.trunc(n).toLocaleString()}`;
}
