import type {
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
      inCurrentHand: false,
      betThisStreet: 0,
      totalCommitted: 0,
      hasFolded: false,
      isAllIn: false,
      holeCards: null,
      showCardsAtShowdown: false,
      pendingLeave: false,
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
    seat.isConnected = true;
    this.events.onStateChange(this);
    return stack;
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
    seat.sittingOut = sittingOut;
    this.events.onStateChange(this);
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
    const eligible = this.seats.filter(
      (s) =>
        s.playerId !== null &&
        !s.sittingOut &&
        s.stack >= this.config.bigBlind, // need at least BB to be dealt in
    );
    return eligible.length >= 2;
  }

  startHand(): void {
    if (this.engine) throw new Error("hand in progress");
    const eligible = this.seats.filter(
      (s) =>
        s.playerId !== null &&
        !s.sittingOut &&
        s.stack >= this.config.bigBlind,
    );
    if (eligible.length < 2) throw new Error("not enough players");

    this.handNumber++;
    // Choose dealer: rotate clockwise from previous dealer (or pick first eligible).
    const sortedEligible = eligible.sort((a, b) => a.seatIndex - b.seatIndex);
    if (
      this.dealerSeatIndex === null ||
      !sortedEligible.find((s) => s.seatIndex === this.dealerSeatIndex)
    ) {
      this.dealerSeatIndex = sortedEligible[0]!.seatIndex;
    } else {
      // pick next eligible after current dealer
      const cur = this.dealerSeatIndex;
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
    this.engine.applyAction(seat.seatIndex, action);
    this.syncFromEngine();

    if (this.engine.phase === "complete") {
      this.finishHand();
    } else {
      this.scheduleActionTimer();
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
    try {
      this.engine.applyAction(seatIndex, action);
    } catch {
      // ignore
    }
    // Auto-sit-out the player who timed out so they don't keep timing out.
    const ts = this.seats[seatIndex];
    if (ts) ts.sittingOut = true;
    this.syncFromEngine();
    if (this.engine.phase === "complete") {
      this.finishHand();
    } else {
      this.scheduleActionTimer();
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

    // Process pending leaves.
    for (const ts of this.seats) {
      if (ts.pendingLeave) {
        // Fire onStateChange before/after; outer host handles wallet credit.
        ts.pendingLeave = false;
        // Don't actually remove here — host receives via state and triggers cashOut+removeSeat.
      }
    }

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
