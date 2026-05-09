import type {
  Card,
  PlayerAction,
  Street,
} from "@holdem/shared";
import { deal, freshDeck, shuffle } from "./cards.js";
import { computePots, type ComputedPot } from "./pots.js";
import { winnersFromSevenCardSets } from "./evaluate.js";

/**
 * Pure Texas Hold'em hand state machine.
 *
 * Inputs to start:
 *   - seats: array of {seatIndex, playerId, stack} for players DEALT IN
 *   - dealerSeatIndex: must be in seats
 *   - smallBlind, bigBlind
 *   - rng: optional rng for deterministic tests
 *
 * The engine knows nothing about wallets, sockets, or the database.
 */

export interface HandSeatInput {
  seatIndex: number;
  playerId: number;
  stack: number;
}

export interface HandSeatState {
  seatIndex: number;
  playerId: number;
  stack: number;
  holeCards: [Card, Card];
  betThisStreet: number;
  totalCommitted: number;
  hasFolded: boolean;
  isAllIn: boolean;
  hasActedThisStreet: boolean;
  /**
   * True if this seat is still allowed to bet/raise on the current street.
   * Reset to true at the start of every street and whenever a *full* raise
   * (>= minRaise) reopens action. An undersized all-in raise does NOT reopen
   * action: prior matched actors keep canStillRaise=false and may only
   * call/fold the extra chips.
   */
  canStillRaise: boolean;
}

export interface HandConfig {
  smallBlind: number;
  bigBlind: number;
}

export interface PendingWinner {
  seatIndex: number;
  playerId: number;
  amount: number;
  handDescription: string;
  potIndex: number;
}

export type HandPhase = "betting" | "showdown" | "complete";

export interface HandEngineOptions {
  /**
   * When true, the engine pauses after dealing each runout street so the
   * host can broadcast the intermediate state and pace the reveal in the
   * UI. The host resumes via `continueRunout()`. Default false preserves
   * the synchronous-runout behavior used by tests.
   */
  pacedRunout?: boolean;
}

export class HandEngine {
  readonly seats: HandSeatState[]; // seats actually dealt in
  readonly config: HandConfig;
  readonly dealerSeatIndex: number;

  street: Street = "preflop";
  community: Card[] = [];
  currentBet = 0;
  /** Minimum legal raise increment (size of last full bet/raise). */
  minRaise: number;
  toActSeatIndex: number | null = null;
  phase: HandPhase = "betting";
  pots: ComputedPot[] = [];
  pendingWinners: PendingWinner[] = [];
  /**
   * True when a paced all-in runout is awaiting `continueRunout()`. The hand
   * has just dealt a street's cards but cannot accept any action because all
   * remaining live seats are all-in (or there's only one acting seat with
   * nobody to bet against). The host should broadcast the intermediate
   * state, then resume on a timer so users see flop / turn / river reveal
   * one at a time. Always false when `pacedRunout` is disabled.
   */
  pendingRunout = false;

  private deck: Card[];
  /** Seat index of the last aggressor; betting closes when action returns to them. */
  private lastAggressor: number | null = null;
  private readonly pacedRunout: boolean;

  constructor(
    seatInputs: HandSeatInput[],
    dealerSeatIndex: number,
    config: HandConfig,
    rng: () => number = Math.random,
    opts: HandEngineOptions = {},
  ) {
    if (seatInputs.length < 2) throw new Error("need >= 2 players to start hand");
    if (!seatInputs.find((s) => s.seatIndex === dealerSeatIndex)) {
      throw new Error("dealer not seated");
    }
    this.config = config;
    this.dealerSeatIndex = dealerSeatIndex;
    this.minRaise = config.bigBlind;
    this.deck = shuffle(freshDeck(), rng);
    this.pacedRunout = opts.pacedRunout ?? false;

    // Deal hole cards in dealer-clockwise order, starting from player after dealer.
    // For tests/UI we don't care about deal order — just give each seat 2 cards.
    const orderedSeats = orderFromAfterDealer(seatInputs, dealerSeatIndex);
    this.seats = orderedSeats.map((s) => {
      const cards = deal(this.deck, 2) as [Card, Card];
      return {
        seatIndex: s.seatIndex,
        playerId: s.playerId,
        stack: s.stack,
        holeCards: cards,
        betThisStreet: 0,
        totalCommitted: 0,
        hasFolded: false,
        isAllIn: false,
        hasActedThisStreet: false,
        canStillRaise: true,
      };
    });

    // Re-sort by seatIndex ascending so our `seats` array is stable; but order
    // of action will be derived dynamically.
    this.seats.sort((a, b) => a.seatIndex - b.seatIndex);

    this.postBlinds();
    this.toActSeatIndex = this.firstToActPreflop();
    // After posting blinds, the action might already be effectively over.
    // The classic case: heads-up where SB has fewer chips than the small
    // blind. SB posts and is all-in; nobody else can act meaningfully
    // (BB has matched currentBet, no opponent left to call/raise). We
    // must auto-run-out the board instead of leaving toActSeatIndex
    // pointing at an all-in seat that the engine then refuses to let act.
    if (this.shouldAutoRunOutPreflop()) {
      this.toActSeatIndex = null;
      this.advanceStreet();
    }
  }

  /**
   * Returns true if preflop action is trivially closed after blinds:
   *   - 0 acting (everyone all-in from posting), or
   *   - 1 acting and that player has already matched the highest all-in
   *     bet — there is nobody for them to extract chips from.
   *
   * In either case the engine should deal the board to showdown rather
   * than wait for input from a seat that can't (or shouldn't) act.
   */
  private shouldAutoRunOutPreflop(): boolean {
    const acting = this.actingSeats();
    if (acting.length === 0) return true;
    if (acting.length > 1) return false;
    let maxAllInBet = 0;
    for (const s of this.seats) {
      if (s.isAllIn && !s.hasFolded && s.betThisStreet > maxAllInBet) {
        maxAllInBet = s.betThisStreet;
      }
    }
    return acting[0]!.betThisStreet >= maxAllInBet;
  }

  /** Seats still in the hand (not folded). */
  liveSeats(): HandSeatState[] {
    return this.seats.filter((s) => !s.hasFolded);
  }

  /** Seats still able to act (not folded, not all-in). */
  actingSeats(): HandSeatState[] {
    return this.seats.filter((s) => !s.hasFolded && !s.isAllIn);
  }

  getSeat(seatIndex: number): HandSeatState | undefined {
    return this.seats.find((s) => s.seatIndex === seatIndex);
  }

  // === Blinds ===
  private postBlinds() {
    const isHeadsUp = this.seats.length === 2;
    let sbSeat: HandSeatState;
    let bbSeat: HandSeatState;
    if (isHeadsUp) {
      // Heads-up: dealer = small blind, other = big blind.
      sbSeat = this.seats.find((s) => s.seatIndex === this.dealerSeatIndex)!;
      bbSeat = this.seats.find((s) => s.seatIndex !== this.dealerSeatIndex)!;
    } else {
      sbSeat = this.nextLiveSeatAfter(this.dealerSeatIndex);
      bbSeat = this.nextLiveSeatAfter(sbSeat.seatIndex);
    }
    this.commit(sbSeat, Math.min(this.config.smallBlind, sbSeat.stack));
    this.commit(bbSeat, Math.min(this.config.bigBlind, bbSeat.stack));
    this.currentBet = this.config.bigBlind;
    this.minRaise = this.config.bigBlind;
    // Big blind is treated as the implicit "last aggressor" preflop.
    this.lastAggressor = bbSeat.seatIndex;
  }

  private firstToActPreflop(): number {
    if (this.seats.length === 2) {
      // Heads up: dealer/SB acts first preflop.
      return this.dealerSeatIndex;
    }
    // 3+: first to act preflop is left of BB = 2 seats after dealer.
    const sb = this.nextLiveSeatAfter(this.dealerSeatIndex);
    const bb = this.nextLiveSeatAfter(sb.seatIndex);
    return this.nextLiveSeatAfter(bb.seatIndex).seatIndex;
  }

  private firstToActPostflop(): number | null {
    // First live, non-all-in seat clockwise from dealer (dealer acts last).
    const acting = this.actingSeats();
    if (acting.length === 0) return null;
    // Walk from seat after dealer.
    const ordered = orderFromAfterDealer(this.seats, this.dealerSeatIndex);
    for (const s of ordered) {
      const cur = this.getSeat(s.seatIndex)!;
      if (!cur.hasFolded && !cur.isAllIn) return cur.seatIndex;
    }
    return null;
  }

  // === Action API ===
  applyAction(seatIndex: number, action: PlayerAction): void {
    if (this.phase !== "betting") throw new Error("not in betting phase");
    if (this.toActSeatIndex !== seatIndex) {
      throw new Error(`not seat ${seatIndex}'s turn`);
    }
    const seat = this.getSeat(seatIndex);
    if (!seat) throw new Error("no such seat");
    if (seat.hasFolded || seat.isAllIn) throw new Error("seat cannot act");
    // Defense-in-depth: reject NaN/Infinity at the engine boundary. The
    // socket layer's isValidAction guards against these for incoming
    // payloads, but any future caller that bypasses the socket (tests,
    // refactors, internal API) would otherwise corrupt the chip universe
    // — every comparison with NaN evaluates false and the engine commits
    // a NaN delta, poisoning stack/bet/totalCommitted.
    if (action.amount !== undefined && !Number.isFinite(action.amount)) {
      throw new Error("amount must be a finite number");
    }

    switch (action.type) {
      case "fold":
        seat.hasFolded = true;
        seat.hasActedThisStreet = true;
        break;
      case "check": {
        if (seat.betThisStreet !== this.currentBet) {
          throw new Error("cannot check: there is a bet to call");
        }
        seat.hasActedThisStreet = true;
        break;
      }
      case "call": {
        const toCall = this.currentBet - seat.betThisStreet;
        if (toCall <= 0) throw new Error("nothing to call; use check");
        const pay = Math.min(toCall, seat.stack);
        this.commit(seat, pay);
        seat.hasActedThisStreet = true;
        break;
      }
      case "bet": {
        if (this.currentBet > 0) throw new Error("cannot bet; raise instead");
        if (!seat.canStillRaise) {
          throw new Error("action not reopened; cannot bet");
        }
        const total = action.amount ?? 0;
        const delta = total - seat.betThisStreet;
        if (delta <= 0) throw new Error("bet must increase total");
        if (delta > seat.stack) throw new Error("bet exceeds stack");
        // Min open is 1 BB unless this is the player's entire stack (all-in).
        if (total < this.config.bigBlind && delta < seat.stack) {
          throw new Error("bet must be at least one big blind");
        }
        this.commit(seat, delta);
        this.currentBet = seat.betThisStreet;
        this.minRaise = total;
        this.lastAggressor = seat.seatIndex;
        this.reopenActionExcept(seat.seatIndex);
        seat.hasActedThisStreet = true;
        seat.canStillRaise = false; // can't raise their own bet
        break;
      }
      case "raise": {
        if (this.currentBet === 0) throw new Error("cannot raise; bet instead");
        if (!seat.canStillRaise) {
          throw new Error("action not reopened; you may only call or fold");
        }
        const total = action.amount ?? 0;
        const raiseSize = total - this.currentBet;
        const delta = total - seat.betThisStreet;
        if (delta <= 0) throw new Error("raise must increase total");
        if (delta > seat.stack) throw new Error("raise exceeds stack");
        const isAllIn = delta === seat.stack;
        // Undersized raises are only allowed when going all-in.
        if (raiseSize < this.minRaise && !isAllIn) {
          throw new Error("raise smaller than min-raise");
        }
        this.commit(seat, delta);
        if (raiseSize >= this.minRaise) {
          // Full raise — reopens action for everyone else.
          this.minRaise = raiseSize;
          this.lastAggressor = seat.seatIndex;
          this.reopenActionExcept(seat.seatIndex);
        } else {
          // Short all-in raise — bumps currentBet but does NOT reopen action
          // for players who've already matched the prior bet. Players whose
          // betThisStreet < new currentBet still need to call/fold the extra
          // chips, but they cannot re-raise.
          this.partialBumpAfterShortAllIn(seat.seatIndex);
        }
        this.currentBet = seat.betThisStreet;
        seat.hasActedThisStreet = true;
        seat.canStillRaise = false;
        break;
      }
      case "allin": {
        const delta = seat.stack;
        if (delta <= 0) throw new Error("no chips to all-in");
        const newTotal = seat.betThisStreet + delta;
        // If this all-in would raise the current bet, the seat must still
        // have raise rights — otherwise they can only go all-in to call (and
        // any extra goes nowhere). This blocks the loophole where a capped
        // player tries to bypass canStillRaise=false via the all-in button.
        if (newTotal > this.currentBet && !seat.canStillRaise) {
          throw new Error(
            "action not reopened; you may only call or fold (use call to call)",
          );
        }
        this.commit(seat, delta);
        if (newTotal > this.currentBet) {
          const raiseSize = newTotal - this.currentBet;
          const isFullRaise = raiseSize >= this.minRaise || this.currentBet === 0;
          if (isFullRaise) {
            this.minRaise = this.currentBet === 0 ? newTotal : raiseSize;
            this.lastAggressor = seat.seatIndex;
            this.reopenActionExcept(seat.seatIndex);
          } else {
            // Short all-in — see comment in `raise` case above.
            this.partialBumpAfterShortAllIn(seat.seatIndex);
          }
          this.currentBet = newTotal;
        }
        seat.hasActedThisStreet = true;
        seat.canStillRaise = false;
        break;
      }
      default:
        throw new Error(`unknown action ${(action as PlayerAction).type}`);
    }

    // After action: check if hand is over due to folds.
    if (this.liveSeats().length === 1) {
      this.awardLastManStanding();
      this.phase = "complete";
      this.toActSeatIndex = null;
      return;
    }

    if (this.streetClosed()) {
      this.advanceStreet();
    } else {
      this.toActSeatIndex = this.nextActorAfter(seatIndex);
    }
  }

  private commit(seat: HandSeatState, amount: number) {
    if (amount <= 0) return;
    const pay = Math.min(amount, seat.stack);
    seat.stack -= pay;
    seat.betThisStreet += pay;
    seat.totalCommitted += pay;
    if (seat.stack === 0) seat.isAllIn = true;
  }

  /**
   * A FULL raise/bet reopens action: every other live, non-all-in seat must
   * act again and is once again allowed to re-raise.
   */
  private reopenActionExcept(seatIndex: number) {
    for (const s of this.seats) {
      if (s.seatIndex !== seatIndex && !s.hasFolded && !s.isAllIn) {
        s.hasActedThisStreet = false;
        s.canStillRaise = true;
      }
    }
  }

  /**
   * A SHORT all-in (raise size < minRaise) bumps currentBet but does NOT
   * reopen action: players who already matched the prior bet must call/fold
   * the extra chips, but cannot re-raise. We re-set hasActed=false on those
   * players so the engine routes back to them, but lock canStillRaise=false.
   * Players who hadn't yet matched the prior bet (still owed chips) keep
   * their existing flags — they were already required to act.
   */
  private partialBumpAfterShortAllIn(seatIndex: number) {
    const newBet = this.getSeat(seatIndex)!.betThisStreet;
    for (const s of this.seats) {
      if (s.seatIndex === seatIndex) continue;
      if (s.hasFolded || s.isAllIn) continue;
      if (s.betThisStreet < newBet) {
        // Need to call (or fold) the extra; lose right to raise.
        s.hasActedThisStreet = false;
        s.canStillRaise = false;
      }
    }
  }

  /** Returns true if betting on the current street is closed. */
  private streetClosed(): boolean {
    const acting = this.actingSeats();
    if (acting.length === 0) return true;
    // Every acting seat must have acted AND have matched currentBet.
    for (const s of acting) {
      if (!s.hasActedThisStreet) return false;
      if (s.betThisStreet !== this.currentBet) return false;
    }
    return true;
  }

  private nextActorAfter(seatIndex: number): number | null {
    const ordered = orderFromAfterDealer(this.seats, this.dealerSeatIndex);
    // Build cycle starting from seat after `seatIndex`.
    const startIdx = ordered.findIndex((s) => s.seatIndex === seatIndex);
    if (startIdx < 0) return null;
    for (let i = 1; i <= ordered.length; i++) {
      const s = ordered[(startIdx + i) % ordered.length]!;
      const seat = this.getSeat(s.seatIndex)!;
      if (!seat.hasFolded && !seat.isAllIn) return seat.seatIndex;
    }
    return null;
  }

  private nextLiveSeatAfter(seatIndex: number): HandSeatState {
    const ordered = orderFromAfterDealer(this.seats, this.dealerSeatIndex);
    const startIdx = ordered.findIndex((s) => s.seatIndex === seatIndex);
    if (startIdx < 0) {
      throw new Error(`nextLiveSeatAfter: seat ${seatIndex} not in hand`);
    }
    for (let i = 1; i <= ordered.length; i++) {
      const s = ordered[(startIdx + i) % ordered.length]!;
      const seat = this.getSeat(s.seatIndex)!;
      if (!seat.hasFolded) return seat;
    }
    throw new Error("no live seats");
  }

  // === Street advancement ===
  private advanceStreet(): void {
    // Rotate bets into pots is handled lazily — pots computed from totalCommitted.
    // Reset per-street state.
    for (const s of this.seats) {
      s.betThisStreet = 0;
      s.hasActedThisStreet = false;
      s.canStillRaise = true;
    }
    this.currentBet = 0;
    this.minRaise = this.config.bigBlind;
    this.lastAggressor = null;

    // If only 0 or 1 seats can still act, run out the board to showdown.
    const canAct = this.actingSeats().length;

    switch (this.street) {
      case "preflop": {
        // burn 1, deal 3
        deal(this.deck, 1);
        const flop = deal(this.deck, 3);
        this.community.push(...flop);
        this.street = "flop";
        break;
      }
      case "flop": {
        deal(this.deck, 1);
        const turn = deal(this.deck, 1);
        this.community.push(...turn);
        this.street = "turn";
        break;
      }
      case "turn": {
        deal(this.deck, 1);
        const river = deal(this.deck, 1);
        this.community.push(...river);
        this.street = "river";
        break;
      }
      case "river": {
        this.goToShowdown();
        return;
      }
      default:
        throw new Error(`unexpected street ${this.street}`);
    }

    // If <=1 can act, auto-advance again (run-out for all-in scenarios).
    if (canAct <= 1) {
      this.toActSeatIndex = null;
      if (this.pacedRunout) {
        // Pause so the host can broadcast this street's reveal before the
        // next card lands. The host resumes via continueRunout().
        this.pendingRunout = true;
        return;
      }
      // Recurse to deal next street(s) immediately.
      this.advanceStreet();
      return;
    }

    this.toActSeatIndex = this.firstToActPostflop();
    if (this.toActSeatIndex === null) {
      // Nobody can act; advance again.
      this.advanceStreet();
    }
  }

  /**
   * Advance one street during a paced all-in runout. Either pendingRunout
   * stays true (more streets to come) or phase flips to "complete" (showdown
   * was reached). Throws if not currently paused.
   */
  continueRunout(): void {
    if (!this.pendingRunout) throw new Error("not in pending runout");
    this.pendingRunout = false;
    this.advanceStreet();
  }

  private goToShowdown(): void {
    this.phase = "showdown";
    this.toActSeatIndex = null;
    this.computeAndAwardPots();
    this.phase = "complete";
  }

  /** When all but one fold. */
  private awardLastManStanding(): void {
    const winner = this.liveSeats()[0]!;
    const total = this.seats.reduce((acc, s) => acc + s.totalCommitted, 0);
    winner.stack += total;
    this.pots = [{ amount: total, eligibleSeatIndices: [winner.seatIndex] }];
    this.pendingWinners = [
      {
        seatIndex: winner.seatIndex,
        playerId: winner.playerId,
        amount: total,
        handDescription: "uncontested",
        potIndex: 0,
      },
    ];
  }

  private computeAndAwardPots(): void {
    const contributions = this.seats.map((s) => ({
      seatIndex: s.seatIndex,
      contribution: s.totalCommitted,
      folded: s.hasFolded,
    }));
    const pots = computePots(contributions);
    this.pots = pots;

    const winners: PendingWinner[] = [];

    // For each pot: among eligible seats, evaluate 7-card hands and split.
    for (let potIdx = 0; potIdx < pots.length; potIdx++) {
      const pot = pots[potIdx]!;
      const eligibleSeats = pot.eligibleSeatIndices
        .map((i) => this.getSeat(i)!)
        .filter(Boolean);
      if (eligibleSeats.length === 0) continue;
      if (eligibleSeats.length === 1) {
        const w = eligibleSeats[0]!;
        w.stack += pot.amount;
        winners.push({
          seatIndex: w.seatIndex,
          playerId: w.playerId,
          amount: pot.amount,
          handDescription: this.handDescr(w),
          potIndex: potIdx,
        });
        continue;
      }
      const sets = eligibleSeats.map((s) => [
        ...s.holeCards,
        ...this.community,
      ]);
      const { winnerIndexes, descriptions } = winnersFromSevenCardSets(sets);
      const share = Math.floor(pot.amount / winnerIndexes.length);
      const remainder = pot.amount - share * winnerIndexes.length;
      // Distribute remainder chips clockwise from dealer to keep determinism.
      const orderedWinners = winnerIndexes
        .map((i) => eligibleSeats[i]!)
        .sort((a, b) => {
          const oa = this.clockwiseDistanceFromDealer(a.seatIndex);
          const ob = this.clockwiseDistanceFromDealer(b.seatIndex);
          return oa - ob;
        });
      for (let wi = 0; wi < orderedWinners.length; wi++) {
        const w = orderedWinners[wi]!;
        const extra = wi < remainder ? 1 : 0;
        const amt = share + extra;
        w.stack += amt;
        const idxInOriginal = eligibleSeats.indexOf(w);
        winners.push({
          seatIndex: w.seatIndex,
          playerId: w.playerId,
          amount: amt,
          handDescription: descriptions[idxInOriginal] ?? "",
          potIndex: potIdx,
        });
      }
    }
    this.pendingWinners = winners;
  }

  private handDescr(seat: HandSeatState): string {
    const set = [...seat.holeCards, ...this.community];
    const { descriptions } = winnersFromSevenCardSets([set]);
    return descriptions[0] ?? "";
  }

  private clockwiseDistanceFromDealer(seatIndex: number): number {
    const ordered = orderFromAfterDealer(this.seats, this.dealerSeatIndex);
    return ordered.findIndex((s) => s.seatIndex === seatIndex);
  }
}

// === Helpers ===

/**
 * Orders seats clockwise starting from the seat AFTER the dealer.
 * Works for any subset of seats (we don't model empty seats here — caller passes
 * only seats that are dealt in).
 */
export function orderFromAfterDealer<T extends { seatIndex: number }>(
  seats: T[],
  dealerSeatIndex: number,
): T[] {
  const sorted = [...seats].sort((a, b) => a.seatIndex - b.seatIndex);
  const dealerPos = sorted.findIndex((s) => s.seatIndex === dealerSeatIndex);
  if (dealerPos < 0) return sorted;
  return [...sorted.slice(dealerPos + 1), ...sorted.slice(0, dealerPos + 1)];
}
