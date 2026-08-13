-- Tracks which guilds BotBot is installed in, so data for a guild that removed
-- the bot can be reaped. Without a gateway there is no GUILD_DELETE event; a
-- scheduled job reconciles this table against GET /users/@me/guilds instead.
--
-- Removal is the only deletion trigger. A guild that keeps the bot installed
-- keeps its history for as long as it wants it, however quiet it gets.

CREATE TABLE guilds (
  guild_id TEXT PRIMARY KEY,
  -- NULL normally. Set when the guild is found to have removed the bot; the
  -- row and all its data are erased after the grace period. Being seen again
  -- clears it, so a bot removed and re-added loses nothing.
  marked_for_purge_at INTEGER
);

CREATE INDEX idx_guilds_marked ON guilds (marked_for_purge_at)
  WHERE marked_for_purge_at IS NOT NULL;

-- Backfill so guilds created before this migration are tracked.
INSERT INTO guilds (guild_id) SELECT DISTINCT guild_id FROM seasons;
