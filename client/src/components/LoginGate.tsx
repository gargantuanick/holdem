import { useEffect, useState, type ReactNode } from "react";
import type { PlayerProfile } from "@holdem/shared";
import { getSocket } from "../lib/socket";
import {
  clearSession,
  loadProfile,
  loadToken,
  saveSession,
  updateProfile,
} from "../lib/session";
import { SessionContext } from "../hooks/useSession";

export function LoginGate({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<PlayerProfile | null>(loadProfile());
  const [wallet, setWalletState] = useState<number>(profile?.walletChips ?? 0);
  const [error, setError] = useState<string | null>(null);
  const [usernameInput, setUsernameInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [resuming, setResuming] = useState<boolean>(!!loadToken());

  // Try to resume an existing session on mount.
  useEffect(() => {
    const token = loadToken();
    if (!token) {
      setResuming(false);
      return;
    }
    const sock = getSocket();
    const tryResume = () => {
      sock.emit("auth:resume", { token }, (res) => {
        if (res.ok) {
          setProfile(res.player);
          setWalletState(res.player.walletChips);
          updateProfile(res.player);
        } else {
          clearSession();
          setProfile(null);
        }
        setResuming(false);
      });
    };
    if (sock.connected) tryResume();
    else sock.once("connect", tryResume);
  }, []);

  // Subscribe to wallet updates and session kicks.
  useEffect(() => {
    const sock = getSocket();
    const onWallet = (n: number) => {
      setWalletState(n);
      const p = loadProfile();
      if (p) {
        const updated = { ...p, walletChips: n };
        updateProfile(updated);
        setProfile(updated);
      }
    };
    const onKicked = (reason: string) => {
      setError(`Session ended: ${reason}`);
      clearSession();
      setProfile(null);
      setWalletState(0);
    };
    sock.on("wallet:update", onWallet);
    sock.on("session:kicked", onKicked);
    return () => {
      sock.off("wallet:update", onWallet);
      sock.off("session:kicked", onKicked);
    };
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const sock = getSocket();
    setBusy(true);
    setError(null);
    sock.emit("auth:login", { username: usernameInput }, (res) => {
      setBusy(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      saveSession(res.token, res.player);
      setProfile(res.player);
      setWalletState(res.player.walletChips);
    });
  };

  const logout = () => {
    clearSession();
    setProfile(null);
    setWalletState(0);
    // Soft refresh socket so server clears session-bound state.
    getSocket().disconnect();
    getSocket().connect();
  };

  if (resuming) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-felt-900">
        <div className="text-white/70 text-sm">Resuming session…</div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-felt-900 px-6 safe-top safe-bottom">
        <div className="w-full max-w-sm">
          <h1 className="text-3xl font-bold tracking-tight text-white mb-1">
            Hold'em
          </h1>
          <p className="text-white/60 text-sm mb-6">
            Pick a username. New users start with 10,000 chips.
          </p>
          <form onSubmit={submit} className="space-y-3">
            <input
              autoFocus
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className="w-full rounded-lg bg-white/10 border border-white/15 text-white placeholder-white/40 px-4 py-3 outline-none focus:ring-2 focus:ring-chip-gold/60"
              placeholder="username"
              value={usernameInput}
              onChange={(e) => setUsernameInput(e.target.value)}
              maxLength={20}
            />
            <button
              type="submit"
              disabled={busy || !usernameInput.trim()}
              className="w-full rounded-lg bg-chip-gold text-black font-semibold py-3 disabled:opacity-50 active:scale-[0.99]"
            >
              {busy ? "Connecting…" : "Play"}
            </button>
            {error && (
              <div className="text-sm text-red-300 mt-2">{error}</div>
            )}
            <p className="text-xs text-white/40 mt-4">
              No password. Anyone with this name can play as you. This is a
              hobby app.
            </p>
          </form>
        </div>
      </div>
    );
  }

  return (
    <SessionContext.Provider
      value={{
        profile,
        wallet,
        setWallet: setWalletState,
        setProfile,
        logout,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}
