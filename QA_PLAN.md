# Holdem QA Plan

Comprehensive QA pass across **server engine**, **table/lobby state machine**,
and **multiplayer/networking** layers. Client/UI behaviour is covered by static
audit since there is no DOM test harness.

This plan is written to be **executed**: every numbered case below should map
to a Vitest case under `server/src/game/__tests__/_qa/` or
`server/src/rooms/__tests__/_qa/`. Cases marked **(static)** are notes from
reading the client code that should be turned into manual repro steps.

## Counter-case to "we already have tests"

The repo has ~30 tests, including a `_qa/` folder of regressions. Argument
against doing more: incremental value is low, the engine has been hardened.

Pushback: most existing tests cover the **happy path** of one or two
mechanics in isolation. They don't cover (a) multi-hand sequences, (b)
disconnect/reconnect interleaved with engine state, (c) the wallet/lobby
boundary where money actually crosses systems, or (d) state-broadcast
semantics. Those are exactly where money-losing bugs hide in a poker app
that already has real users via Netlify. **Worth the pass.**

---

## 1. Server game engine (HandEngine)

### 1.1 Blinds & action order
- 1.1.1 Heads-up: dealer = SB, acts first preflop. Postflop acts second.
- 1.1.2 3-handed: SB next clockwise of dealer, BB next, action starts on dealer (UTG wraps to dealer).
- 1.1.3 4+ handed: action preflop starts left of BB.
- 1.1.4 BB short-stack: posts what they have, marked all-in, currentBet stays = configured BB.
- 1.1.5 SB short-stack: posts what they have, BB still posts in full.
- 1.1.6 **Both SB and BB cannot afford** — degenerate; engine should still run a coherent hand to showdown.

### 1.2 Betting rules
- 1.2.1 `check` rejected when `betThisStreet < currentBet`.
- 1.2.2 `bet` rejected when `currentBet > 0` (must `raise` instead).
- 1.2.3 `raise` rejected when `currentBet === 0` (must `bet`).
- 1.2.4 Raise smaller than `minRaise` rejected unless going all-in.
- 1.2.5 First raise after BB sets `minRaise = raiseSize`, not `currentBet`.
- 1.2.6 Re-raise must be at least `currentBet + minRaise`.
- 1.2.7 Bet `< bigBlind` rejected unless going all-in.
- 1.2.8 Action out of turn rejected.
- 1.2.9 Action in `showdown` / `complete` phase rejected.
- 1.2.10 Bet > stack rejected; raise > stack rejected.
- 1.2.11 Negative or zero bet/raise amount rejected.
- 1.2.12 NaN/Infinity bet/raise amount rejected (already gated at socket boundary; engine should also be safe).

### 1.3 All-in mechanics
- 1.3.1 Calling all-in (toCall > stack) commits stack, sets `isAllIn`.
- 1.3.2 Short all-in raise (raiseSize < minRaise) does NOT reopen action.
- 1.3.3 Short all-in raiser's `canStillRaise` set to false.
- 1.3.4 Already-acted player who short-bumped CANNOT re-raise via `allin` button (regression case).
- 1.3.5 Multiple consecutive short all-ins: action re-opens only when one fully clears `minRaise`.
- 1.3.6 All-in by exactly `minRaise` reopens action (boundary).
- 1.3.7 All-in opening bet (currentBet=0, allin < BB) — should be allowed (you can shove sub-BB stack).
- 1.3.8 All players go all-in preflop → engine deals all five board cards and goes to showdown without further action.

### 1.4 Side pots
- 1.4.1 Two all-ins at different stacks → main + side, eligibility correct.
- 1.4.2 Three all-ins at three stacks → 3 pots, eligibility correct.
- 1.4.3 Folded player who put chips in: their chips count toward pots, they're ineligible to win.
- 1.4.4 Orphan side pot (only-folded layer) merged into preceding pot.
- 1.4.5 Two players matched at top stack → side pot eligibility includes both.
- 1.4.6 Sum of pot amounts = sum of `totalCommitted` across all seats.
- 1.4.7 Sum of pendingWinners = sum of pots (no chip leak).

### 1.5 Showdown & evaluation
- 1.5.1 Higher hand wins single pot.
- 1.5.2 Tie split: pot divided floor; remainder distributed clockwise from dealer.
- 1.5.3 Tie split with odd remainder: receiver is deterministic across multiple invocations.
- 1.5.4 Last-man-standing (everyone else folds): pot awarded uncontested, description = "uncontested".
- 1.5.5 Each pot evaluated independently (player can win main but lose side).
- 1.5.6 Hole cards + 5 community = 7-card best-of evaluation.

### 1.6 Street advancement
- 1.6.1 Street advances when all acting seats matched currentBet AND have acted.
- 1.6.2 BB option preflop: when limped, BB gets to check/raise (lastAggressor=BB triggers close).
- 1.6.3 Run-out: when ≤1 acting seat remains (others all-in), engine deals to river without prompts.
- 1.6.4 `betThisStreet` reset to 0 on street advance; `totalCommitted` accumulates.
- 1.6.5 `canStillRaise` reset to true on street advance for all live seats.
- 1.6.6 Burn cards: 1 burned before flop, turn, river (deck consumption count).

### 1.7 Chip conservation (invariant)
- 1.7.1 Across N random hands, `sum(stacks_after) === sum(stacks_before)`.
- 1.7.2 Across N random hands with random folds, conservation holds.
- 1.7.3 Across N random hands with aggressive shoving, conservation holds.
- 1.7.4 Across N random hands with sub-BB stacks, conservation holds.

### 1.8 Determinism
- 1.8.1 Same RNG seed → same deal, same showdown, same winners.

---

## 2. Table / Lobby state machine

### 2.1 Seat lifecycle
- 2.1.1 sitDown rejects buy-in below min, above max, non-integer, NaN, negative.
- 2.1.2 sitDown rejects double-seating same playerId.
- 2.1.3 sitDown rejects occupied seat index.
- 2.1.4 standUp between hands returns full stack immediately (`deferred: false`).
- 2.1.5 standUp during own active hand defers (`deferred: true`); seat removed at hand end.
- 2.1.6 standUp during hand by a folded player → return chips immediately (FOLDED ≠ in current hand for cashout? See bug audit below).
- 2.1.7 rebuy mid-hand rejected.
- 2.1.8 rebuy push above max rejected.
- 2.1.9 setReady toggles; ready=false prevents being dealt in.

### 2.2 Hand auto-start
- 2.2.1 startHand requires ≥2 ready, non-sitting-out, stack≥BB.
- 2.2.2 Newly seated player NOT dealt in until they ready up.
- 2.2.3 Existing players keep ready=true across hands.
- 2.2.4 sitOut → sitIn re-enables auto-start.
- 2.2.5 Auto-start scheduled 2.5s after hand finish (fires even if a player just left).
- 2.2.6 Auto-start cancelled if no longer eligible.

### 2.3 Dealer rotation (dead button)
- 2.3.1 First hand: dealer = lowest eligible seatIndex.
- 2.3.2 Subsequent hands: dealer = next eligible seatIndex strictly > previous, wrap.
- 2.3.3 Previous dealer busts: rotation still moves to next clockwise eligible (NOT reset to seat 0).
- 2.3.4 Previous dealer was highest seat: wrap to lowest eligible.
- 2.3.5 New player joins between hands → does not skip the rotation.

### 2.4 Action timer
- 2.4.1 Timer starts on each turn (30s default).
- 2.4.2 Timeout when no bet to call → forced check.
- 2.4.3 Timeout when bet to call → forced fold.
- 2.4.4 Timed-out player auto-`sittingOut = true`.
- 2.4.5 Timer cleared on hand finish.
- 2.4.6 Force-timeout when even fold throws → calls abortHand to prevent stuck table.

### 2.5 Public state serialization
- 2.5.1 Hole cards included only for the requesting player.
- 2.5.2 `hasCards` true for in-hand non-folded seats.
- 2.5.3 totalPot reflects sum of totalCommitted.
- 2.5.4 `actionDeadline` null when no engine.
- 2.5.5 `pots` empty array when no engine.
- 2.5.6 `lastHand` survives between hands until next start.

### 2.6 Last-action pill
- 2.6.1 Call records amount actually paid.
- 2.6.2 Bet/raise records the new total (not delta).
- 2.6.3 Wiped on street advance.
- 2.6.4 Timeout shows check (when free) instead of fold.

### 2.7 Show cards at showdown
- 2.7.1 Winners auto-shown.
- 2.7.2 Losers shown only if `showCardsAtShowdown` was opted in.
- 2.7.3 Folded players never shown.
- 2.7.4 Show flag does NOT leak across hands (cleared on next startHand).

---

## 3. Lobby (DB + wallet boundary)

### 3.1 Buy-in rollback
- 3.1.1 Failed sitDown after debit triggers refund-with-retry.
- 3.1.2 Refund retried up to 5x with exponential backoff.
- 3.1.3 Hard error logged on final failure (no silent chip loss).
- 3.1.4 Buy-in non-integer / negative / NaN / Infinity rejected.

### 3.2 Cash-out
- 3.2.1 Out of an active hand returns full stack immediately.
- 3.2.2 In-hand non-folded → deferred; processed in handleHandFinished.
- 3.2.3 In-hand folded → can immediately cash out (verify NOT deferred — bug suspect).

### 3.3 Admin force-clear
- 3.3.1 Synchronously empties seats in pass 1 even if a credit fails.
- 3.3.2 Wallet credits attempted in parallel.
- 3.3.3 Notifies cleared sockets via `table:evicted`.
- 3.3.4 Stops in-progress hand, clears all timers.
- 3.3.5 Auth-gated: non-admin rejected.

### 3.4 Disconnect handling
- 3.4.1 Socket disconnect starts 60s grace timer.
- 3.4.2 Reconnect within grace cancels timer, restores `isConnected=true`.
- 3.4.3 No reconnect: cashOut runs (mid-hand → defers).
- 3.4.4 Disconnect timer is per-table, per-player.
- 3.4.5 Two-tab login: kicked-tab disconnect must NOT trigger grace timer on the new active socket.

### 3.5 Hand history
- 3.5.1 Hand result recorded only when `DATABASE_URL` set.
- 3.5.2 Recording failure does not crash hand-finish flow.
- 3.5.3 Stats deltas computed correctly: hands_played++, hands_won++ for any pot share, biggest_pot tracks largest single share.

---

## 4. Socket layer

### 4.1 Auth
- 4.1.1 auth:login validates username (2–20, [A-Z0-9_]).
- 4.1.2 auth:login kicks prior socket; new socket becomes active.
- 4.1.3 auth:resume with bad token → ok:false.
- 4.1.4 Handshake auto-resume populates sock.data BEFORE buffered events fire.

### 4.2 Action validation
- 4.2.1 Unknown action type rejected.
- 4.2.2 bet/raise without amount rejected.
- 4.2.3 bet/raise amount > 1e9 rejected.
- 4.2.4 Rate limit: 6 burst, 4/sec; over-limit emits "rate limited".

### 4.3 Chat
- 4.3.1 Trims to 200 chars.
- 4.3.2 Empty after trim dropped silently.
- 4.3.3 Rate limit: 4 burst, 1.5/sec.
- 4.3.4 Non-seated players cannot chat.

### 4.4 State broadcast
- 4.4.1 `table:state` per-socket personalization (each socket gets their own hole cards).
- 4.4.2 Broadcast on every onStateChange.
- 4.4.3 Sockets not in the room don't receive the update.

---

## 5. Client / UI (static audit)

These are noted from reading the client; they need a browser to verify but
are flagged as risk areas.

- 5.1 **BettingControls.tsx ½-pot math.** When `currentBet === 0`, half-pot
  uses `Math.floor(state.totalPot / 2)`. If `totalPot < 2 * BB`, this yields
  a value below `minRaiseTotal` and is silently `clamp()`'d up — fine, but
  worth a manual check that the slider doesn't get stuck.
- 5.2 **Pot-size raise formula.** `currentBet + potAfterCall + toCall` —
  this matches the standard "true pot raise" definition, but worth one
  manual check that "pot" button doesn't allow an amount > stack
  (clamp catches it).
- 5.3 **Raise button enabled only if `canStillRaise`.** Correctly disabled.
  But the all-in button inside the raise UI still appears even if
  short-stacked + capped; user might click and get the "action not
  reopened" error. (Confirmed in code: `onlyAllInRaiseLegal` returns true
  even when `canStillRaise=false`. Bug candidate.)
- 5.4 **Reconnect banner.** `connected: false` only set on disconnect
  event; the GameState provider doesn't re-broadcast a fresh
  `table:state` on reconnect — only the server's auth middleware does
  via `handleReconnect`, which doesn't push state. Risk: stale UI on
  reconnect. (Verify: client emits `table:requestState` on reconnect?)
- 5.5 **lastHand auto-clears at 6s.** If a new hand starts before 6s, the
  setTimeout still fires and could nuke `lastHand` mid-display — but the
  guard `cur === p` prevents that. Looks safe.
- 5.6 **Showdown overlay.** No test; verify it survives a 4-way showdown
  with 2 winners.

---

## 6. Multiplayer scenarios (integration-style)

These require driving Table + Lobby together. Implemented as e2e-ish unit
tests against the in-memory engine without spinning up an actual socket.

- 6.1 Two players join, ready, hand starts; one disconnects mid-action; 60s grace; cashout returns stack.
- 6.2 Three players in hand; one disconnects, other two play to showdown; disconnected player still tracked correctly.
- 6.3 Player A joins; Player B joins; B leaves before readying; A still cannot start.
- 6.4 Hand in progress with 2 players; admin force-clear nukes hand and returns chips; subsequent hand cannot start.
- 6.5 Player rage-quits mid-hand: standUp → pendingLeave → hand finishes → seat removed, stack credited.
- 6.6 Reconnect mid-hand restores isConnected and CANCELS the disconnect timer.
- 6.7 Multi-hand sequence: 5 hands in a row, dealer rotates each time, no chip leak.
- 6.8 Player times out → auto-sit-out; remaining players continue; timed-out player must sit back in to be dealt.
- 6.9 Sit-back-in mid-hand → not dealt until next hand.

---

## 7. Edge cases / exploits

- 7.1 Two players with identical username (DB-level) — should be impossible; assumes username unique constraint.
- 7.2 Player joins, leaves, joins again — should not double-count `tables_joined`.
- 7.3 sitOut while in-hand: cannot sit out mid-hand? (Code allows it. What happens to the engine? Verify they still must act.)
- 7.4 Race: two `table:action` from same player land within rate-limit window — second should fail "not your turn" OR be queued; verify no double-deduction.
- 7.5 Race: player A acts, then B acts before broadcast — only one is the to-act; second errors.
- 7.6 Chip overflow: 10^9 bet sanity-cap at socket layer; engine should also be safe.
- 7.7 Negative stack possible? (Should be impossible — `commit()` clamps to stack.)

---

## Pass criteria

- All Vitest tests pass (`npm test -w @holdem/server`).
- Chip conservation invariant holds across 1000+ random hands of mixed
  player counts and stack sizes.
- No "stuck table" reproductions: timeout always advances.
- No silent state divergence between Engine and Table after any action.
