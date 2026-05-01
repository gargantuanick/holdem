import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ChatMessage,
  HandFinishedPayload,
  HandHistoryEntry,
  PublicTableState,
} from "@holdem/shared";
import { getSocket } from "../lib/socket";

export interface GameState {
  state: PublicTableState | null;
  chat: ChatMessage[];
  history: HandHistoryEntry[];
  lastHand: HandFinishedPayload | null;
  errorBanner: string | null;
  /** False while the socket is mid-reconnect. UI can dim controls and
   *  surface a banner so users don't think the app is frozen. */
  connected: boolean;
}

const GameStateContext = createContext<GameState | null>(null);

export function GameStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PublicTableState | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [history, setHistory] = useState<HandHistoryEntry[]>([]);
  const [lastHand, setLastHand] = useState<HandFinishedPayload | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [connected, setConnected] = useState<boolean>(() => getSocket().connected);
  const currentTableId = useRef<string | null>(null);

  useEffect(() => {
    const sock = getSocket();
    const onState = (s: PublicTableState) => {
      if (currentTableId.current !== s.config.id) {
        currentTableId.current = s.config.id;
        setChat([]);
        setHistory([]);
        setLastHand(null);
      }
      setState(s);
    };
    const onChat = (m: ChatMessage) =>
      setChat((prev) => [...prev.slice(-49), m]);
    const onHist = (h: HandHistoryEntry[]) => setHistory(h);
    const onFinish = (p: HandFinishedPayload) => {
      setLastHand(p);
      setTimeout(() => setLastHand((cur) => (cur === p ? null : cur)), 6000);
    };
    const onErr = (msg: string) => {
      setErrorBanner(msg);
      setTimeout(() => setErrorBanner((cur) => (cur === msg ? null : cur)), 4000);
    };
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    sock.on("table:state", onState);
    sock.on("table:chat", onChat);
    sock.on("table:history", onHist);
    sock.on("table:handFinished", onFinish);
    sock.on("error", onErr);
    sock.on("connect", onConnect);
    sock.on("disconnect", onDisconnect);
    return () => {
      sock.off("table:state", onState);
      sock.off("table:chat", onChat);
      sock.off("table:history", onHist);
      sock.off("table:handFinished", onFinish);
      sock.off("error", onErr);
      sock.off("connect", onConnect);
      sock.off("disconnect", onDisconnect);
    };
  }, []);

  const value: GameState = { state, chat, history, lastHand, errorBanner, connected };
  return createElement(GameStateContext.Provider, { value }, children);
}

export function useGameState(): GameState {
  const ctx = useContext(GameStateContext);
  if (!ctx) {
    throw new Error("useGameState must be used inside GameStateProvider");
  }
  return ctx;
}
