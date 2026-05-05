// Shared types between client and server.

export type Suit = "s" | "h" | "d" | "c";
export type Rank =
  | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "T" | "J" | "Q" | "K" | "A";

/** A card encoded as e.g. "Ah", "Td", "2s". */
export type Card = `${Rank}${Suit}`;

export type Street = "preflop" | "flop" | "turn" | "river" | "showdown" | "idle";

export type ActionType = "fold" | "check" | "call" | "bet" | "raise" | "allin";

export interface PlayerAction {
  type: ActionType;
  amount?: number; // for bet/raise: total amount to put in this street (not delta)
}

export interface PublicSeat {
  seatIndex: number;
  playerId: number | null;
  username: string | null;
  stack: number;
  betThisStreet: number;
  totalCommitted: number; // total this hand
  hasFolded: boolean;
  isAllIn: boolean;
  sittingOut: boolean;
  isConnected: boolean;
  isBot: boolean;
  /** True if this player has hit "Start" while waiting for the first hand. */
  ready: boolean;
  /**
   * True if this seat is allowed to bet/raise on the current street. False
   * after a short all-in capped their action, in which case they can only
   * call/fold (the UI should disable the raise button).
   */
  canStillRaise: boolean;
  /**
   * Last action this player took in the current hand. Cleared on hand start
   * and on street advance so the UI only flashes for the current decision.
   * Drives the "Folded / Checked / Called X / Bet X / Raised X / All-in"
   * action pill that fades on the seat after they act.
   */
  lastAction: { type: ActionType; amount?: number; at: number } | null;
  // hole cards: only present in personalized payload for the seat owner
  holeCards?: [Card, Card] | null;
  hasCards: boolean; // whether this seat has been dealt cards this hand
}

export interface PotInfo {
  amount: number;
  eligibleSeatIndices: number[];
}

export interface Winner {
  seatIndex: number;
  playerId: number;
  username: string;
  amount: number;
  handDescription: string;
  potIndex: number; // 0 = main pot, 1+ = side pots
  showCards: [Card, Card] | null; // null if mucked
}

export interface HandHistoryEntry {
  handNumber: number;
  winners: Array<{
    playerId: number;
    username: string;
    amount: number;
    handDescription: string;
  }>;
  potTotal: number;
  communityCards: string;
  endedAt: string; // ISO
}

export interface TableConfig {
  id: string;
  name: string;
  maxSeats: number; // 2-5
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
}

export interface PublicTableState {
  config: TableConfig;
  seats: PublicSeat[];
  street: Street;
  communityCards: Card[];
  pots: PotInfo[];
  totalPot: number;
  dealerSeat: number | null;
  toActSeat: number | null;
  currentBet: number; // highest bet on current street
  minRaise: number;
  handNumber: number;
  actionDeadline: number | null; // epoch ms, when current actor times out
  // last completed hand summary, for table panel
  lastHand: HandFinishedPayload | null;
  /** Epoch ms when the next hand will auto-deal. null if no hand pending. */
  nextHandStartsAt: number | null;
}

export interface HandFinishedPayload {
  handNumber: number;
  winners: Winner[];
  shownHands: Array<{
    seatIndex: number;
    playerId: number;
    username: string;
    cards: [Card, Card];
    handDescription: string;
  }>;
  potTotal: number;
  communityCards: Card[];
}

// === Socket message types ===

export interface ClientToServerEvents {
  ping: (cb: (s: string) => void) => void;
  "lobby:list": (cb: (tables: LobbyTableSummary[]) => void) => void;
  "lobby:create": (
    args: {
      name: string;
      maxSeats: number;
      smallBlind: number;
      bigBlind: number;
      minBuyIn: number;
      maxBuyIn: number;
    },
    cb: (res: { ok: true; tableId: string } | { ok: false; error: string }) => void,
  ) => void;
  "table:join": (
    args: { tableId: string; buyIn: number; seatIndex?: number },
    cb: (res: { ok: true } | { ok: false; error: string }) => void,
  ) => void;
  "table:leave": (
    args: { tableId: string },
    cb: (res: { ok: true } | { ok: false; error: string }) => void,
  ) => void;
  "table:rebuy": (
    args: { tableId: string; amount: number },
    cb: (res: { ok: true } | { ok: false; error: string }) => void,
  ) => void;
  "table:sitOut": (args: { tableId: string; sittingOut: boolean }) => void;
  "table:setReady": (args: { tableId: string; ready: boolean }) => void;
  "table:requestState": (
    args: { tableId: string },
    cb?: (res: { ok: true } | { ok: false; error: string }) => void,
  ) => void;
  "admin:kickPlayer": (
    args: { tableId: string; targetPlayerId: number },
    cb: (res: { ok: true } | { ok: false; error: string }) => void,
  ) => void;
  "admin:clearTable": (
    args: { tableId: string },
    cb: (
      res:
        | { ok: true; cleared: number; occupiedAfter: number }
        | { ok: false; error: string },
    ) => void,
  ) => void;
  "admin:addBot": (
    args: { tableId: string; buyIn?: number },
    cb: (
      res:
        | { ok: true; playerId: number; username: string }
        | { ok: false; error: string },
    ) => void,
  ) => void;
  "admin:removeBot": (
    args: { tableId: string; targetPlayerId: number },
    cb: (res: { ok: true; deferred: boolean } | { ok: false; error: string }) => void,
  ) => void;
  "table:action": (args: { tableId: string; action: PlayerAction }) => void;
  "table:chat": (args: { tableId: string; message: string }) => void;
  "table:showCards": (args: { tableId: string }) => void;
  "table:dealNow": (
    args: { tableId: string },
    cb?: (res: { ok: true } | { ok: false; error: string }) => void,
  ) => void;
  "auth:login": (
    args: { username: string },
    cb: (
      res:
        | { ok: true; token: string; player: PlayerProfile }
        | { ok: false; error: string },
    ) => void,
  ) => void;
  "auth:resume": (
    args: { token: string },
    cb: (
      res:
        | { ok: true; player: PlayerProfile }
        | { ok: false; error: string },
    ) => void,
  ) => void;
  "auth:refill": (
    cb: (
      res:
        | { ok: true; wallet: number }
        | { ok: false; error: string; nextRefillAt?: string },
    ) => void,
  ) => void;
  "auth:logout": (cb: (res: { ok: true }) => void) => void;
}

export interface ServerToClientEvents {
  "table:state": (state: PublicTableState) => void;
  "table:chat": (msg: ChatMessage) => void;
  "table:handFinished": (payload: HandFinishedPayload) => void;
  "table:history": (entries: HandHistoryEntry[]) => void;
  "table:evicted": (payload: { tableId: string; reason: string }) => void;
  "wallet:update": (wallet: number) => void;
  "session:kicked": (reason: string) => void;
  "error": (msg: string) => void;
}

export interface ChatMessage {
  username: string;
  message: string;
  at: number; // epoch ms
}

export interface LobbyTableSummary {
  id: string;
  name: string;
  maxSeats: number;
  occupiedSeats: number;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
}

export interface PlayerProfile {
  id: number;
  username: string;
  walletChips: number;
  handsPlayed: number;
  handsWon: number;
  tablesJoined: number;
  totalChipsWon: number;
  totalChipsLost: number;
  biggestPotWon: number;
  createdAt: string;
  lastSeenAt: string;
  lastRefillAt: string | null;
}

export interface LeaderboardEntry {
  rank: number;
  username: string;
  walletChips: number;
  totalChipsWon: number;
  handsWon: number;
  handsPlayed: number;
}

export interface AdminPlayerSummary extends PlayerProfile {}

export interface AdminPlayersResponse {
  players: AdminPlayerSummary[];
}
