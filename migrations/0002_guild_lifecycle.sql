-- Tracks which guilds BotBot is installed in and when they were last used, so
-- data for removed or long-abandoned guilds can be reaped. Without a gateway
-- there is no GUILD_DELETE event; a scheduled job reconciles this table against
-- GET /users/@me/guilds instead.

CREATE TABLE guilds (
  guild_id    TEXT PRIMARY KEY,
  first_seen  INTEGER NOT NULL,
  -- Last reconcile that confirmed we are still installed. Refreshed weekly by
  -- the cron job, so it says nothing about whether anyone is using the bot.
  last_seen   INTEGER NOT NULL,
  -- Last time someone actually ran a command here. This is the dormancy signal.
  last_active INTEGER NOT NULL,
  -- NULL normally. Set when the guild is detected as removed or dormant; the
  -- row and all its data are erased after the grace period. Any command clears
  -- it, so a guild that wakes up rescues itself.
  marked_for_purge_at INTEGER
);

CREATE INDEX idx_guilds_marked ON guilds (marked_for_purge_at)
  WHERE marked_for_purge_at IS NOT NULL;
CREATE INDEX idx_guilds_last_active ON guilds (last_active);

-- Backfill from existing data so guilds created before this migration are
-- tracked. Their most recent match is the best available activity estimate.
INSERT INTO guilds (guild_id, first_seen, last_seen, last_active, marked_for_purge_at)
SELECT s.guild_id,
       MIN(s.started_at),
       MIN(s.started_at),
       COALESCE((SELECT MAX(m.played_at) FROM matches m WHERE m.guild_id = s.guild_id),
                MIN(s.started_at)),
       NULL
FROM seasons s
GROUP BY s.guild_id;
