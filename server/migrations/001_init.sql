-- players: lifetime identity + stats + wallet
CREATE TABLE IF NOT EXISTS players (
  id BIGSERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  wallet_chips BIGINT NOT NULL DEFAULT 10000,
  hands_played BIGINT NOT NULL DEFAULT 0,
  hands_won BIGINT NOT NULL DEFAULT 0,
  tables_joined BIGINT NOT NULL DEFAULT 0,
  total_chips_won BIGINT NOT NULL DEFAULT 0,
  total_chips_lost BIGINT NOT NULL DEFAULT 0,
  biggest_pot_won BIGINT NOT NULL DEFAULT 0,
  last_refill_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hand_history (
  id BIGSERIAL PRIMARY KEY,
  table_id TEXT NOT NULL,
  hand_number BIGINT NOT NULL,
  winners JSONB NOT NULL,
  pot_total BIGINT NOT NULL,
  community_cards TEXT,
  ended_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hand_history_table
  ON hand_history(table_id, ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_players_wallet
  ON players(wallet_chips DESC);
CREATE INDEX IF NOT EXISTS idx_players_chips_won
  ON players(total_chips_won DESC);
