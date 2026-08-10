-- BotBot initial schema.
--
-- Multi-tenancy rule: every row is owned by exactly one guild, and every query
-- filters on guild_id. Discord snowflakes are stored as TEXT, not INTEGER --
-- they exceed 2^53 and D1's JS binding would return them as lossy numbers.

CREATE TABLE seasons (
  season_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  started_at INTEGER NOT NULL,          -- unix seconds
  ended_at   INTEGER                    -- NULL = the currently open season
);

-- At most one open season per guild. This is the invariant the whole
-- "wipe the record" feature rests on, so let SQLite enforce it.
CREATE UNIQUE INDEX idx_seasons_one_open ON seasons (guild_id) WHERE ended_at IS NULL;
CREATE INDEX idx_seasons_guild ON seasons (guild_id, started_at DESC);

CREATE TABLE matches (
  match_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT    NOT NULL,
  season_id   INTEGER NOT NULL REFERENCES seasons (season_id) ON DELETE CASCADE,
  reported_by TEXT    NOT NULL,         -- who ran /report, for auditing and /undo
  played_at   INTEGER NOT NULL          -- unix seconds
);

CREATE INDEX idx_matches_season ON matches (season_id, played_at DESC);
CREATE INDEX idx_matches_guild ON matches (guild_id, played_at DESC);
CREATE INDEX idx_matches_reporter ON matches (reported_by, played_at DESC);

-- One row per player per match, so 2-0 and 2-1 are both representable and a
-- future 3+ player format needs no schema change.
CREATE TABLE reports (
  match_id INTEGER NOT NULL REFERENCES matches (match_id) ON DELETE CASCADE,
  user_id  TEXT    NOT NULL,
  games    INTEGER NOT NULL CHECK (games >= 0),
  deck     TEXT,
  PRIMARY KEY (match_id, user_id)
);

CREATE INDEX idx_reports_user ON reports (user_id);
