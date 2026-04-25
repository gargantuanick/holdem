import { createContext, useContext } from "react";
import type { PlayerProfile } from "@holdem/shared";

export interface SessionContextValue {
  profile: PlayerProfile | null;
  wallet: number;
  setWallet: (n: number) => void;
  setProfile: (p: PlayerProfile | null) => void;
  logout: () => void;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error("useSession outside provider");
  return v;
}
