# Hold'em — multiplayer Texas Hold'em web app

A mobile-first, real-time, internet-multiplayer Texas Hold'em poker app. Username-only login, persistent wallets and lifetime stats, cash-game tables only.

## Quick start

```bash
# from repo root
npm install

# create a Supabase project and grab the POOLED connection string
# (Project Settings → Database → Connection Pooling, transaction mode, port 6543)

# /server/.env
echo "DATABASE_URL=<your-supabase-pooled-url>" > server/.env
echo "CLIENT_ORIGIN=http://localhost:5173" >> server/.env

# /client/.env (optional; defaults to localhost:3001)
echo "VITE_SERVER_URL=http://localhost:3001" > client/.env

# run both client and server
npm run dev
```

The server applies SQL migrations from `/server/migrations` automatically on startup.

## Architecture

Monorepo with three workspaces: `client/` (React + Vite + Tailwind), `server/` (Node + Express + Socket.IO), and `shared/` (TypeScript types shared across both).

### Server layers

```
server/src/
  game/        Pure game engine. No DB, no I/O. Fully unit-tested.
    cards.ts   Deck, shuffle, deal
    pots.ts    Side-pot computation
    evaluate.ts  Wraps pokersolver for hand evaluation
    hand.ts    HandEngine state machine: blinds, betting, streets, showdown

  rooms/       Stateful table layer that hosts a HandEngine per active hand.
    table.ts   Seats, dealer rotation, hand lifecycle, action timer
    lobby.ts   The set of tables + wallet broker (debit on buy-in, credit on cash-out)
    stats.ts   Per-hand stats deltas

  db/          Postgres repositories (porsager/postgres directly, no Supabase SDK)
    client.ts  Connection pool to Supabase pooler
    migrate.ts Applies plain SQL files in /server/migrations
    players.ts findOrCreate, debit/credit wallet, refill
    sessions.ts Token → playerId
    handHistory.ts End-of-hand audit + lifetime-stat updates in one TX
    leaderboard.ts Top-20 query, 60s in-memory cache

  socket/      Socket.IO handlers — auth, lobby, table actions, chat
  api/         REST endpoints for /api/profile/:username and /api/leaderboard
  server.ts    Bootstraps Express + Socket.IO, runs migrations
```

### Real-time guarantees

- **Game logic runs only on the server.** The client sends action *intents*; the server validates and broadcasts state.
- **Hole cards never leak.** `Table.publicState(forPlayerId)` returns a per-recipient payload with opponents' cards stripped before each emit.
- **DB writes are end-of-hand only.** During a hand, all updates are in memory.
- **Reconnects** replay current state to the rejoining socket. Disconnects start a 60s grace timer; if they don't return, their stack is auto-cashed-out to wallet.

### Game engine notes

- Side-pot algorithm walks distinct contribution levels, building tiers per all-in. Folded contributors fund pots they cannot win. Consecutive tiers with identical eligibility are merged. Test: `pots.test.ts`.
- Heads-up handles the special blind rule: dealer = SB and acts first preflop.
- Min-raise enforcement uses "size of last full raise"; a short all-in below min-raise does not reopen action for prior actors.
- Pot remainders from indivisible splits go clockwise from dealer.

## Schema

```sql
players       -- lifetime identity + stats + wallet
sessions      -- session token → player_id
hand_history  -- per-hand audit (winners JSONB, pot, community)
schema_migrations -- internal: applied migration filenames
```

Indexes:
- `idx_players_wallet` for leaderboard wallet sort
- `idx_players_chips_won` for total-won leaderboard
- `idx_hand_history_table` for fast per-table history lookups

Row-level security is intentionally disabled — the Node server is the only client and connects with full credentials via the Supabase pooler.

## Wallet flow

- New username → `findOrCreatePlayer` creates a row with **10,000 starting chips**.
- Joining a table: `debitWallet(buyIn)` then `Table.sitDown` (refund on failure).
- Leaving / disconnect-timeout: `Table.standUp` → returns the table stack → `creditWallet`.
- Mid-table broke: rebuy from wallet (between hands) up to table max.
- Wallet at 0 → daily refill of 1,000 chips, gated by `last_refill_at < NOW() - 24h`.
- All wallet adjustments use a `WHERE wallet + delta >= 0` guard so concurrent debits cannot overdraft.

## Tests

```bash
# All tests (game engine + table rules + DB integration if TEST_DATABASE_URL set)
npm test

# Just the game engine unit tests (no DB needed)
npm test -- src/game

# DB integration tests — point at a separate Supabase project (or local Postgres)
TEST_DATABASE_URL=postgresql://... npm test
```

Coverage:
- `src/game/__tests__/pots.test.ts` — side-pot math (folded, multi-all-in, orphan layers)
- `src/game/__tests__/hand.test.ts` — blinds (HU + 3-/4-handed), min-raise, action ordering, all-in run-outs, chip conservation across random hands
- `src/rooms/__tests__/table.test.ts` — seat lifecycle, buy-in limits, hole-card stripping, dealer rotation, deferred standup
- `src/db/__tests__/integration.test.ts` — `findOrCreatePlayer`, debit/credit math, session round-trip, transactional `recordHandResult`, `tryRefill` cooldown, leaderboard ordering. Skipped automatically when no `TEST_DATABASE_URL`.

## What's implemented vs. not

**Done:**
- Username login + session resume + cross-device kick
- Persistent wallets (10k start, 1k/day refill at 0)
- Lobby with multiple table configs (auto-seeded: beginner, mid, heads-up); custom table creation
- Full Texas Hold'em: blinds, all four streets, fold/check/call/bet/raise/all-in, side pots, showdown via pokersolver, auto-muck losers, optional show-cards
- 30-second turn timer with auto-fold/check; visual countdown
- Mobile-first table layout (bottom-anchored local player, arc opponents); fixed-bottom action bar; touch-friendly bet slider with ½/pot/2×/all-in buttons
- Sit-out / sit-in, rebuy, leave-table-returns-stack, disconnect grace
- Chat, hand history panel (last 50/table, persisted), end-of-hand winners overlay
- Profile modal (clickable usernames at table + leaderboard)
- Leaderboard with three tabs (wallet/won/hands_won), 60s cache
- Wallet/card/chip animations
- Render + Netlify deploy configs

**Known limitations / TODO:**
- No spectator mode; only seated players see a table.
- No collusion detection or anti-cheat heuristics.
- Single-server only — no horizontal scaling. State lives in memory, so a server restart drops in-progress hands (each hand ends and stats are persisted only at end-of-hand).
- Render free-tier server sleeps after 15 min idle. First request after sleep takes ~30s to wake — the client shows a loading state. Acceptable for hobby use.
- No private tables / invite codes; all tables are public.
- No tournament / sit-and-go formats.
- "Show cards" is server-side flagged but UI affordance is minimal — winners auto-show; losers can opt to show via socket event but no UI button is wired into the current build.
- Username-only login means anyone who knows your name can play as you. By design — this is a hobby app.

## Scripts

```bash
npm run dev      # client + server in parallel
npm run build    # build shared, server, client
npm test         # run server vitest suite
npm run lint     # type-check both workspaces
```
