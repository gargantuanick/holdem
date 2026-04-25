import type { PlayerProfile } from "@holdem/shared";

const TOKEN_KEY = "holdem.token";
const PROFILE_KEY = "holdem.profile";

export function saveSession(token: string, profile: PlayerProfile) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  // Also write a cookie (best-effort; cross-origin browser may ignore).
  document.cookie = `holdem_token=${token}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

export function loadToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function loadProfile(): PlayerProfile | null {
  const raw = localStorage.getItem(PROFILE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PlayerProfile;
  } catch {
    return null;
  }
}

export function updateProfile(profile: PlayerProfile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(PROFILE_KEY);
  document.cookie = "holdem_token=; Path=/; Max-Age=0; SameSite=Lax";
}
