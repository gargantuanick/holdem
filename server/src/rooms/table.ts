import type {
  ActionType,
  Card,
  HandFinishedPayload,
  PlayerAction,
  PublicSeat,
  PublicTableState,
  TableConfig,
  Winner,
} from "@holdem/shared";
import { HandEngine, type HandSeatInput } from "../game/hand.js";

/**
 * A Table holds:
 *   - configuration (blinds, max seats, buy-in range)
 *   - up to N seats (each may be empty or hold a player with a stack)
 *   - the current HandEngine (or null between hands)
 *   - timers and a hand counter
 *
 * The Table is **transport-agnostic**: it exposes events via callbacks. The
 * socket layer subscribes and broadcasts.
 *
 * Wallets live in the DB; Table only owns table stacks. A "TableHost" wires
 * wallet debit on buyIn and credit on cashOut.
 */

export interface TableSeat {
  seatIndex: number;
  playerId: number | null;
  username: string | null;
  stack: number;
  sittingOut: boolean;
  isConnected: boolean;
  isBot: boolean;
  // tracking for current hand
  inCurrentHand: boolean;
  betThisStreet: number;
  totalCommitted: number;
  hasFolded: boolean;
  isAllIn: boolean;
  holeCards: [Card, Card] | null;
  showCardsAtShowdown: boolean;
  /** Set when player wants to leave; will be removed after current hand ends. */
  pendingLeave: boolean;
  /**
   * Set when a player toggles sit-out while in the current hand. Standard
   * poker behaviour: sit-out queues to the next hand boundary so it can't
   * be used to dodge an in-progress decision (which blocks every other
   * player while they wait out the action timer).
   */
  pendingSitOut: boolean;
  /** True if this player has clicked "Start" while waiting for the first hand. */
  ready: boolean;
  /** Mirror of HandSeatState.canStillRaise; default true outside a hand. */
  canStillRaise: boolean;
  /** Last action this seat took in the current hand. Drives the UI pill. */
  lastAction: { type: ActionType; amount?: number; at: number } | null;
}

export interface TableEvents {
  onStateChange: (table: Table) => void;
  onHandFinished: (table: Table, payload: HandFinishedPayload) => void;
  onActionTimeout: (table: Table, seatIndex: number) => void;
}

const DEFAULT_TURN_MS = 30_000;

export class Table {
  readonly config: TableConfig;
  readonly seats: TableSeat[];
  handNumber = 0;
  dealerSeatIndex: number | null = null;
  engine: HandEngine | null = null;
  events: TableEvents;
  actionDeadline: number | null = null;
  lastHand: HandFinishedPayload | null = null;
  /** Auto-start the next hand after a finished one when 2+ seats remain seated. */
  private nextHandTimer: NodeJS.Timeout | null = null;
  private actionTimer: NodeJS.Timeout | null = null;
  /** Disconnect grace timers per playerId; if not back in time, auto-fold + stand up. */
  private disconnectTimers = new Map<number, NodeJS.Timeout>();
  /** Test hook: rng used by HandEngine. */
  private rng: () => number;

  constructor(config: TableConfig, events: TableEvents, rng?: () => number) {
    this.config = config;
    this.events = events;
    this.rng = rng ?? Math.random;
    this.seats = Array.from({ length: config.maxSeats }, (_, i) => ({
      seatIndex: i,
      playerId: null,
      username: null,
      stack: 0,
      sittingOut: false,
      isConnected: true,
      isBot: false,
      inCurrentHand: false,
      betThisStreet: 0,
      totalCommitted: 0,
      hasFolded: false,
      isAllIn: false,
      holeCards: null,
      showCardsAtShowdown: false,
      pendingLeave: false,
      pendingSitOut: false,
      ready: false,
      canStillRaise: true,
      lastAction: null,
    }));
  }

  // === Seat management ===

  occupiedSeats(): TableSeat[] {
    return this.seats.filter((s) => s.playerId !== null);
  }

  findSeatByPlayer(playerId: number): TableSeat | null {
    return this.seats.find((s) => s.playerId === playerId) ?? null;
  }

  /** Take a seat at the table with a buy-in stack. Returns the seat, or throws. */
  sitDown(args: {
    playerId: number;
    username: string;
    buyIn: number;
    seatIndex?: number;
    isBot?: boolean;
  }): TableSeat {
    if (this.findSeatByPlayer(args.playerId)) {
      throw new Error("already seated at this table");
    }
    if (args.buyIn < this.config.minBuyIn) {
      throw new Error(`buy-in below table minimum (${this.config.minBuyIn})`);
    }
    if (args.buyIn > this.config.maxBuyIn) {
      throw new Error(`buy-in above table maximum (${this.config.maxBuyIn})`);
    }
    let seat: TableSeat | undefined;
    if (args.seatIndex !== undefined) {
      seat = this.seats[args.seatIndex];
      if (!seat) throw new Error("invalid seat index");
      if (seat.playerId !== null) throw new Error("seat occupied");
    } else {
      seat = this.seats.find((s) => s.playerId === null);
      if (!seat) throw new Error("table full");
    }
    seat.playerId = args.playerId;
    seat.username = args.username;
    seat.stack = args.buyIn;
    seat.sittingOut = false;
    seat.isConnected = true;
    seat.isBot = !!args.isBot;
    seat.pendingLeave = false;
    this.events.onStateChange(this);
    return seat;
  }

  /**
   * Player requests to leave. If a hand is active and this player is in it,
   * mark for removal after the hand. Returns the chips that should be credited
   * back to the player's wallet.
   */
  standUp(playerId: number): { stack: number; deferred: boolean } {
    const seat = this.findSeatByPlayer(playerId);
    if (!seat) throw new Error("not seated");
    if (this.engine && seat.inCurrentHand && !seat.hasFolded) {
      seat.pendingLeave = true;
      return { stack: 0, deferred: true };
    }
    return { stack: this.removeSeat(seat), deferred: false };
  }

  /**
   * Admin-only: nuke any in-progress hand and stop timers so seats can be
   * removed cleanly. Stacks remain on the seats; caller is expected to
   * removeSeat() each one and credit wallets.
   */
  abortHand(): void {
    this.clearActionTimer();
    if (this.nextHandTimer) {
      clearTimeout(this.nextHandTimer);
      this.nextHandTimer = null;
    }
    this.engine = null;
    this.actionDeadline = null;
    for (const s of this.seats) {
      s.inCurrentHand = false;
      s.holeCards = null;
      s.showCardsAtShowdown = false;
      s.betThisStreet = 0;
      s.totalCommitted = 0;
      s.hasFolded = false;
      s.isAllIn = false;
      s.pendingLeave = false;
      s.pendingSitOut = false;
      s.canStillRaise = true;
      s.lastAction = null;
    }
    this.events.onStateChange(this);
  }

  /** Force-remove a seat now. Returns the stack to credit back. */
  removeSeat(seat: TableSeat): number {
    const stack = seat.stack;
    seat.playerId = null;
    seat.username = null;
    seat.stack = 0;
    seat.sittingOut = false;
    seat.inCurrentHand = false;
    seat.betThisStreet = 0;
    seat.totalCommitted = 0;
    seat.hasFolded = false;
    seat.isAllIn = false;
    seat.holeCards = null;
    seat.showCardsAtShowdown = false;
    seat.pendingLeave = false;
    seat.pendingSitOut = false;
    seat.isConnected = true;
    seat.isBot = false;
    seat.ready = false;
    seat.canStillRaise = true;
    seat.lastAction = null;
    this.events.onStateChange(this);
    return stack;
  }

  /** Mark a player as ready (or unready) for the first hand. */
  setReady(playerId: number, ready: boolean): void {
    const seat = this.findSeatByPlayer(playerId);
    if (!seat) throw new Error("not seated");
    seat.ready = ready;
    this.events.onStateChange(this);
  }

  rebuy(playerId: number, amount: number): number {
    const seat = this.findSeatByPlayer(playerId);
    if (!seat) throw new Error("not seated");
    if (this.engine && seat.inCurrentHand) {
      throw new Error("cannot rebuy mid-hand");
    }
    const newStack = seat.stack + amount;
    if (newStack > this.config.maxBuyIn) {
      throw new Error(`stack would exceed table maximum`);
    }
    if (newStack < this.config.minBuyIn) {
      throw new Error(`stack would still be below table minimum`);
    }
    seat.stack = newStack;
    this.events.onStateChange(this);
    return seat.stack;
  }

  setSittingOut(playerId: number, sittingOut: boolean): void {
    const seat = this.findSeatByPlayer(playerId);
    if (!seat) throw new Error("not seated");
    // Sitting OUT mid-hand is queued — applying it immediately would
    // either let the player dodge their decision (if it's their turn) or
    // freeze the table while every other player waits out their action
    // timer. Sitting back IN can take effect immediately; it doesn't
    // affect the in-progress hand because the player wasn't dealt in.
    if (sittingOut && this.engine && seat.inCurrentHand && !seat.hasFolded) {
      seat.pendingSitOut = true;
    } else {
      seat.sittingOut = sittingOut;
      seat.pendingSitOut = false;
    }
    this.events.onStateChange(this);
  }

  /** Apply any deferred pendingSitOut flags. Called at hand finish. */
  private applyPendingSitOuts(): void {
    for (const s of this.seats) {
      if (s.pendingSitOut) {
        s.sittingOut = true;
        s.pendingSitOut = false;
      }
    }
  }

  setConnected(playerId: number, connected: boolean): void {
    const seat = this.findSeatByPlayer(playerId);
    if (!seat) return;
    seat.isConnected = connected;
    this.events.onStateChange(this);
  }

  // === Hand lifecycle ===

  canStartHand(): boolean {
    if (this.engine) return false;
    // Players must press Start to be dealt in — applies to every hand, not
    // just hand 1. Newly joined players default to ready=false so they
    // spectate the current hand and are dealt in next hand once they ready
    // up. Existing players keep ready=true across hands until they leave.
    const eligible = this.seats.filter(
      (s) =>
        s.playerId !== null &&
        !s.sittingOut &&
        s.ready &&
        s.stack >= this.config.bigBlind,
    );
    return eligible.length >= 2 && eligible.some((s) => !s.isBot);
  }

  startHand(): void {
    if (this.engine) throw new Error("hand in progress");
    const eligible = this.seats.filter(
      (s) =>
        s.playerId !== null &&
        !s.sittingOut &&
        s.ready &&
        s.stack >= this.config.bigBlind,
    );
    if (eligible.length < 2) throw new Error("not enough players");
    if (!eligible.some((s) => !s.isBot)) {
      throw new Error("at least one real player is required");
    }

    this.handNumber++;
    // Choose dealer: rotate clockwise from the previous dealer's seat
    // position, even if that player is no longer eligible (dead-button
    // approximation).
    const sortedEligible = eligible.sort((a, b) => a.seatIndex - b.seatIndex);
    if (this.dealerSeatIndex === null) {
      this.dealerSeatIndex = sortedEligible[0]!.seatIndex;
    } else {
      const cur = this.dealerSeatIndex;
      // Next eligible seatIndex strictly greater than the previous dealer's
      // seatIndex; wrap around if none.
      const after = sortedEligible.find((s) => s.seatIndex > cur);
      this.dealerSeatIndex = (after ?? sortedEligible[0]!).seatIndex;
    }

    const seatInputs: HandSeatInput[] = sortedEligible.map((s) => ({
      seatIndex: s.seatIndex,
      playerId: s.playerId!,
      stack: s.stack,
    }));

    // Mark which seats are in the hand & reset per-hand state.
    for (const s of this.seats) {
      s.inCurrentHand = false;
      s.holeCards = null;
      s.showCardsAtShowdown = false;
      s.betThisStreet = 0;
      s.totalCommitted = 0;
      s.hasFolded = false;
      s.isAllIn = false;
      s.canStillRaise = true;
      s.lastAction = null;
    }

    this.engine = new HandEngine(
      seatInputs,
      this.dealerSeatIndex,
      { smallBlind: this.config.smallBlind, bigBlind: this.config.bigBlind },
      this.rng,
    );

    // Snapshot hole cards & stacks into table seats.
    for (const eseat of this.engine.seats) {
      const ts = this.seats[eseat.seatIndex]!;
      ts.inCurrentHand = true;
      ts.holeCards = eseat.holeCards;
      ts.stack = eseat.stack;
      ts.betThisStreet = eseat.betThisStreet;
      ts.totalCommitted = eseat.totalCommitted;
    }
    this.lastHand = null;
    this.scheduleActionTimer();
    this.events.onStateChange(this);
  }

  applyAction(playerId: number, action: PlayerAction): void {
    if (!this.engine) throw new Error("no hand in progress");
    const seat = this.findSeatByPlayer(playerId);
    if (!seat) throw new Error("not seated");
    if (this.engine.toActSeatIndex !== seat.seatIndex) {
      throw new Error("not your turn");
    }
    const streetBeforeAction = this.engine.street;
    const engineSeatBefore = this.engine.getSeat(seat.seatIndex);
    const betBeforeAction = engineSeatBefore?.betThisStreet ?? seat.betThisStreet;
    this.engine.applyAction(seat.seatIndex, action);
    const engineSeatAfter = this.engine.getSeat(seat.seatIndex);
    const betAfterAction = engineSeatAfter?.betThisStreet ?? betBeforeAction;
    // Stamp lastAction *after* the engine commits so we know the action was
    // legal. Amount reflects what they actually committed this street, which
    // is the meaningful number for the UI ("Called 50", "Bet 100").
    seat.lastAction = {
      type: action.type,
      amount: lastActionAmount(action, betBeforeAction, betAfterAction),
      at: Date.now(),
    };
    // If the street changed (action closed the round), wipe everyone's
    // lastAction — the new street starts fresh.
    if (this.engine.street !== streetBeforeAction) {
      for (const s of this.seats) s.lastAction = null;
      seat.lastAction = null;
    }
    this.syncFromEngine();

    if (this.engine.phase === "complete") {
      this.finishHand();
    } else {
      this.scheduleActionTimer();
      this.events.onStateChange(this);
    }
  }

  /** Public force-fold for timeouts. Treats free check as check, else fold. */
  forceTimeoutAction(): void {
    if (!this.engine) return;
    const seatIndex = this.engine.toActSeatIndex;
    if (seatIndex === null) return;
    const eseat = this.engine.getSeat(seatIndex);
    if (!eseat) return;
    const toCall = this.engine.currentBet - eseat.betThisStreet;
    const action: PlayerAction =
      toCall === 0 ? { type: "check" } : { type: "fold" };
    // Try check (if free) or fold; if the first attempt throws, force a
    // fold. If even that fails, abort the hand to avoid getting stuck on
    // the same seat forever.
    try {
      this.engine.applyAction(seatIndex, action);
    } catch (err1) {
      try {
        this.engine.applyAction(seatIndex, { type: "fold" });
      } catch (err2) {
        console.error(
          "[table] forceTimeoutAction: engine refused both",
          action.type,
          "and fold:",
          err1,
          err2,
        );
        this.abortHand();
        return;
      }
    }
    // Auto-sit-out the player who timed out so they don't keep timing out.
    const ts = this.seats[seatIndex];
    if (ts) {
      ts.sittingOut = true;
      ts.lastAction = { type: action.type, at: Date.now() };
    }
    this.syncFromEngine();
    if (this.engine.phase === "complete") {
      this.finishHand();
    } else {
      this.scheduleActionTimer();
      this.events.onStateChange(this);
    }
    this.events.onActionTimeout(this, seatIndex);
  }

  private syncFromEngine(): void {
    if (!this.engine) return;
    for (const eseat of this.engine.seats) {
      const ts = this.seats[eseat.seatIndex]!;
      ts.stack = eseat.stack;
      ts.betThisStreet = eseat.betThisStreet;
      ts.totalCommitted = eseat.totalCommitted;
      ts.hasFolded = eseat.hasFolded;
      ts.isAllIn = eseat.isAllIn;
      ts.canStillRaise = eseat.canStillRaise;
    }
  }

  private finishHand(): void {
    if (!this.engine) return;
    const eng = this.engine;

    // Build the showdown payload: which players showed which cards.
    const shownHands: HandFinishedPayload["shownHands"] = [];
    if (eng.community.length === 5) {
      // showdown: anyone who didn't fold and has cards may be shown (auto-show
      // for winners; losers can choose). For now: auto-show winners' cards;
      // mucked otherwise unless `showCardsAtShowdown` was set.
      const winnerSeats = new Set(eng.pendingWinners.map((w) => w.seatIndex));
      for (const eseat of eng.seats) {
        if (eseat.hasFolded) continue;
        const ts = this.seats[eseat.seatIndex];
        if (!ts || !ts.username) continue;
        if (winnerSeats.has(eseat.seatIndex) || ts.showCardsAtShowdown) {
          shownHands.push({
            seatIndex: eseat.seatIndex,
            playerId: eseat.playerId,
            username: ts.username,
            cards: eseat.holeCards,
            handDescription: this.descrFor(eseat.seatIndex),
          });
        }
      }
    }

    const winners: Winner[] = eng.pendingWinners.map((w) => {
      const ts = this.seats[w.seatIndex]!;
      const shown = shownHands.find((sh) => sh.seatIndex === w.seatIndex);
      return {
        seatIndex: w.seatIndex,
        playerId: w.playerId,
        username: ts.username ?? "?",
        amount: w.amount,
        handDescription: w.handDescription,
        potIndex: w.potIndex,
        showCards: shown ? shown.cards : null,
      };
    });

    const payload: HandFinishedPayload = {
      handNumber: this.handNumber,
      winners,
      shownHands,
      potTotal: eng.pots.reduce((a, b) => a + b.amount, 0),
      communityCards: eng.community,
    };
    this.lastHand = payload;
    this.clearActionTimer();
    this.actionDeadline = null;

    // Apply any deferred sit-out toggles now that the hand is done. This
    // takes effect BEFORE onHandFinished so the lobby's hand-finish hook
    // and any auto-start eligibility check see the up-to-date sittingOut
    // flags.
    this.applyPendingSitOuts();

    // pendingLeave is intentionally preserved here — the lobby reads it in
    // its handleHandFinished hook to actually removeSeat + creditWallet.
    this.engine = null;
    this.events.onHandFinished(this, payload);
    this.events.onStateChange(this);

    // Schedule auto-start of next hand if eligible.
    if (this.canStartHand()) {
      if (this.nextHandTimer) clearTimeout(this.nextHandTimer);
      this.nextHandTimer = setTimeout(() => {
        this.nextHandTimer = null;
        if (this.canStartHand()) {
          try {
            this.startHand();
          } catch (err) {
            console.error("[table] auto-start failed:", err);
          }
        }
      }, 2500);
    }
  }

  private descrFor(seatIndex: number): string {
    if (!this.engine) return "";
    const eseat = this.engine.getSeat(seatIndex);
    if (!eseat) return "";
    const w = this.engine.pendingWinners.find((x) => x.seatIndex === seatIndex);
    return w?.handDescription ?? "";
  }

  // === Timers ===

  private scheduleActionTimer() {
    this.clearActionTimer();
    if (!this.engine) return;
    const seatIndex = this.engine.toActSeatIndex;
    if (seatIndex === null) {
      this.actionDeadline = null;
      return;
    }
    this.actionDeadline = Date.now() + DEFAULT_TURN_MS;
    this.actionTimer = setTimeout(() => {
      this.forceTimeoutAction();
    }, DEFAULT_TURN_MS);
  }

  private clearActionTimer() {
    if (this.actionTimer) {
      clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
  }

  startDisconnectTimer(playerId: number, ms: number, onTimeout: () => void) {
    const existing = this.disconnectTimers.get(playerId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.disconnectTimers.delete(playerId);
      onTimeout();
    }, ms);
    this.disconnectTimers.set(playerId, t);
  }

  cancelDisconnectTimer(playerId: number) {
    const t = this.disconnectTimers.get(playerId);
    if (t) {
      clearTimeout(t);
      this.disconnectTimers.delete(playerId);
    }
  }

  destroy() {
    this.clearActionTimer();
    if (this.nextHandTimer) clearTimeout(this.nextHandTimer);
    for (const t of this.disconnectTimers.values()) clearTimeout(t);
    this.disconnectTimers.clear();
  }

  // === State serialization ===

  /**
   * Serialize public state. If `forPlayerId` is provided, that player's hole
   * cards are included; everyone else's are stripped.
   */
  publicState(forPlayerId: number | null): PublicTableState {
    const seats: PublicSeat[] = this.seats.map((s) => {
      const showHole =
        forPlayerId !== null &&
        s.playerId === forPlayerId &&
        s.holeCards !== null &&
        !s.hasFolded;
      return {
        seatIndex: s.seatIndex,
        playerId: s.playerId,
        username: s.username,
        stack: s.stack,
        betThisStreet: s.betThisStreet,
        totalCommitted: s.totalCommitted,
        hasFolded: s.hasFolded,
        isAllIn: s.isAllIn,
        sittingOut: s.sittingOut,
        isConnected: s.isConnected,
        isBot: s.isBot,
        ready: s.ready,
        canStillRaise: s.canStillRaise,
        lastAction: s.lastAction,
        holeCards: showHole ? s.holeCards : null,
        hasCards: s.inCurrentHand && !s.hasFolded && s.holeCards !== null,
      };
    });

    const eng = this.engine;
    return {
      config: this.config,
      seats,
      street: eng?.street ?? "idle",
      communityCards: eng ? [...eng.community] : [],
      pots: eng ? eng.pots.map((p) => ({ ...p })) : [],
      totalPot: this.computeLivePot(),
      dealerSeat: this.dealerSeatIndex,
      toActSeat: eng?.toActSeatIndex ?? null,
      currentBet: eng?.currentBet ?? 0,
      minRaise: eng?.minRaise ?? this.config.bigBlind,
      handNumber: this.handNumber,
      actionDeadline: this.actionDeadline,
      lastHand: this.lastHand,
    };
  }

  private computeLivePot(): number {
    if (!this.engine) return 0;
    return this.engine.seats.reduce((a, s) => a + s.totalCommitted, 0);
  }
}

function lastActionAmount(
  action: PlayerAction,
  betBeforeAction: number,
  betAfterAction: number,
): number | undefined {
  switch (action.type) {
    case "call":
    case "allin":
      return Math.max(0, betAfterAction - betBeforeAction);
    case "bet":
    case "raise":
      return betAfterAction;
    default:
      return undefined;
  }
}
