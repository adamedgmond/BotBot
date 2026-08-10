// Every function here takes guildId first and threads it into the WHERE clause.
// There is no query in this file that can read across guilds.

export interface Season {
  season_id: number;
  guild_id: string;
  name: string;
  started_at: number;
  ended_at: number | null;
}

export interface StatRow {
  user_id: string;
  wins: number;
  losses: number;
  draws: number;
  matches: number;
}

export const now = () => Math.floor(Date.now() / 1000);

export async function currentSeason(
  db: D1Database,
  guildId: string,
): Promise<Season | null> {
  return db
    .prepare("SELECT * FROM seasons WHERE guild_id = ? AND ended_at IS NULL")
    .bind(guildId)
    .first<Season>();
}

/**
 * Returns the guild's open season, creating one if this guild has never been
 * seen. New servers get a working bot with no setup step -- important now that
 * anyone can add it.
 */
export async function ensureSeason(
  db: D1Database,
  guildId: string,
): Promise<Season> {
  const existing = await currentSeason(db, guildId);
  if (existing) return existing;

  await db
    .prepare(
      "INSERT INTO seasons (guild_id, name, started_at) VALUES (?, ?, ?) " +
        "ON CONFLICT DO NOTHING",
    )
    .bind(guildId, "Season 1", now())
    .run();

  // Re-read rather than trusting the insert: a concurrent /report may have won
  // the race, in which case the unique index turned our INSERT into a no-op.
  const season = await currentSeason(db, guildId);
  if (!season) throw new Error(`failed to open a season for guild ${guildId}`);
  return season;
}

export async function reportMatch(
  db: D1Database,
  guildId: string,
  seasonId: number,
  reportedBy: string,
  a: { userId: string; games: number; deck?: string },
  b: { userId: string; games: number; deck?: string },
): Promise<void> {
  const insertReport =
    "INSERT INTO reports (match_id, user_id, games, deck) VALUES (last_insert_rowid(), ?, ?, ?)";

  // batch() is a real transaction: sequential, non-concurrent, and rolled back
  // as a unit. D1 has no interactive BEGIN/COMMIT, so all three writes must be
  // handed over together or a failure could leave a match with one player.
  await db.batch([
    db
      .prepare(
        "INSERT INTO matches (guild_id, season_id, reported_by, played_at) VALUES (?, ?, ?, ?)",
      )
      .bind(guildId, seasonId, reportedBy, now()),
    db.prepare(insertReport).bind(a.userId, a.games, a.deck ?? null),
    db.prepare(insertReport).bind(b.userId, b.games, b.deck ?? null),
  ]);
}

const STATS_SELECT = `
  SELECT r.user_id AS user_id,
         SUM(CASE WHEN r.games > o.games THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN r.games < o.games THEN 1 ELSE 0 END) AS losses,
         SUM(CASE WHEN r.games = o.games THEN 1 ELSE 0 END) AS draws,
         COUNT(*) AS matches
  FROM reports r
  JOIN reports o ON o.match_id = r.match_id AND o.user_id != r.user_id
  JOIN matches m ON m.match_id = r.match_id
  WHERE m.guild_id = ?1 AND m.season_id = ?2 AND m.played_at >= ?3
`;

export async function leaderboard(
  db: D1Database,
  guildId: string,
  seasonId: number,
  since: number,
  limit: number,
): Promise<StatRow[]> {
  const { results } = await db
    .prepare(
      `${STATS_SELECT} GROUP BY r.user_id ORDER BY wins DESC, matches ASC LIMIT ?4`,
    )
    .bind(guildId, seasonId, since, limit)
    .all<StatRow>();
  return results;
}

export async function statsFor(
  db: D1Database,
  guildId: string,
  seasonId: number,
  since: number,
  userId: string,
): Promise<StatRow | null> {
  return db
    .prepare(`${STATS_SELECT} AND r.user_id = ?4 GROUP BY r.user_id`)
    .bind(guildId, seasonId, since, userId)
    .first<StatRow>();
}

/** Closes the open season (if any) and opens a new one, atomically. */
export async function rollSeason(
  db: D1Database,
  guildId: string,
  name: string,
): Promise<void> {
  const ts = now();
  await db.batch([
    db
      .prepare(
        "UPDATE seasons SET ended_at = ? WHERE guild_id = ? AND ended_at IS NULL",
      )
      .bind(ts, guildId),
    db
      .prepare(
        "INSERT INTO seasons (guild_id, name, started_at) VALUES (?, ?, ?)",
      )
      .bind(guildId, name, ts),
  ]);
}

/**
 * Renames the guild's open season, keeping every match attached to it.
 *
 * This is the repair for a season that got auto-created by the first `/report`
 * before an admin named it: renaming adopts those matches, where starting a new
 * season would strand them under the wrong name.
 *
 * Returns the previous name, or null if no season is open.
 */
export async function renameSeason(
  db: D1Database,
  guildId: string,
  name: string,
): Promise<string | null> {
  const current = await currentSeason(db, guildId);
  if (!current) return null;

  await db
    .prepare("UPDATE seasons SET name = ? WHERE season_id = ? AND guild_id = ?")
    .bind(name, current.season_id, guildId)
    .run();
  return current.name;
}

export async function listSeasons(
  db: D1Database,
  guildId: string,
): Promise<Season[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM seasons WHERE guild_id = ? ORDER BY started_at DESC LIMIT 25",
    )
    .bind(guildId)
    .all<Season>();
  return results;
}

/** How long after a match is recorded it can still be withdrawn. */
export const UNDO_WINDOW_SECONDS = 600;

/**
 * Deletes the caller's most recent match in this guild.
 *
 * Scoped to participation, not to who filed the report: either player can
 * withdraw a match they were in, since the loser is often the one who spots a
 * wrong score. Abuse is deterred by publicity rather than permissions -- the
 * withdrawal is announced in-channel naming both players and who withdrew it.
 */
export async function undoLast(
  db: D1Database,
  guildId: string,
  userId: string,
  window = UNDO_WINDOW_SECONDS,
): Promise<MatchDetail | null> {
  const match = await db
    .prepare(
      "SELECT m.match_id FROM matches m JOIN reports r ON r.match_id = m.match_id " +
        "WHERE m.guild_id = ? AND r.user_id = ? AND m.played_at >= ? " +
        "ORDER BY m.played_at DESC LIMIT 1",
    )
    .bind(guildId, userId, now() - window)
    .first<{ match_id: number }>();
  if (!match) return null;

  // Read before deleting: the caller echoes this publicly, and afterwards the
  // announcement is the only surviving record of what was withdrawn.
  const detail = await matchDetail(db, guildId, match.match_id);

  // reports rows go with it via ON DELETE CASCADE.
  await db
    .prepare("DELETE FROM matches WHERE match_id = ? AND guild_id = ?")
    .bind(match.match_id, guildId)
    .run();
  return detail;
}

export interface MatchDetail {
  match_id: number;
  played_at: number;
  reported_by: string;
  players: Array<{ user_id: string; games: number }>;
}

interface MatchRow {
  match_id: number;
  played_at: number;
  reported_by: string;
  user_id: string;
  games: number;
}

function groupMatches(rows: MatchRow[]): MatchDetail[] {
  const byId = new Map<number, MatchDetail>();
  for (const row of rows) {
    let match = byId.get(row.match_id);
    if (!match) {
      match = {
        match_id: row.match_id,
        played_at: row.played_at,
        reported_by: row.reported_by,
        players: [],
      };
      byId.set(row.match_id, match);
    }
    match.players.push({ user_id: row.user_id, games: row.games });
  }
  return [...byId.values()];
}

const MATCH_SELECT =
  "SELECT m.match_id, m.played_at, m.reported_by, r.user_id, r.games " +
  "FROM matches m JOIN reports r ON r.match_id = m.match_id ";

/** Most recent matches in a guild, newest first, across all seasons. */
export async function recentMatches(
  db: D1Database,
  guildId: string,
  limit: number,
): Promise<MatchDetail[]> {
  // The IN subquery does the limiting, so `limit` counts matches rather than
  // the two report rows each one joins to.
  const { results } = await db
    .prepare(
      MATCH_SELECT +
        "WHERE m.guild_id = ?1 AND m.match_id IN " +
        "(SELECT match_id FROM matches WHERE guild_id = ?1 ORDER BY played_at DESC LIMIT ?2) " +
        "ORDER BY m.played_at DESC, r.games DESC",
    )
    .bind(guildId, limit)
    .all<MatchRow>();
  return groupMatches(results);
}

export async function matchDetail(
  db: D1Database,
  guildId: string,
  matchId: number,
): Promise<MatchDetail | null> {
  const { results } = await db
    .prepare(
      MATCH_SELECT +
        "WHERE m.guild_id = ? AND m.match_id = ? ORDER BY r.games DESC",
    )
    .bind(guildId, matchId)
    .all<MatchRow>();
  return groupMatches(results)[0] ?? null;
}

/**
 * Deletes a single match. The guild_id predicate is what stops a valid match id
 * from one server being deleted by an admin of another; match_id alone is
 * globally unique, so without it a typo could reach across tenants.
 */
export async function deleteMatch(
  db: D1Database,
  guildId: string,
  matchId: number,
): Promise<boolean> {
  const { meta } = await db
    .prepare("DELETE FROM matches WHERE match_id = ? AND guild_id = ?")
    .bind(matchId, guildId)
    .run();
  return (meta.changes ?? 0) > 0;
}

/** Removes every trace of a guild. For when the bot is kicked, or on request. */
export async function purgeGuild(
  db: D1Database,
  guildId: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "DELETE FROM reports WHERE match_id IN (SELECT match_id FROM matches WHERE guild_id = ?)",
      )
      .bind(guildId),
    db.prepare("DELETE FROM matches WHERE guild_id = ?").bind(guildId),
    db.prepare("DELETE FROM seasons WHERE guild_id = ?").bind(guildId),
    db.prepare("DELETE FROM guilds WHERE guild_id = ?").bind(guildId),
  ]);
}

// --- guild lifecycle -------------------------------------------------------

/** SQLite caps bound parameters per statement; stay well under it. */
const CHUNK = 100;

function chunked<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    out.push(items.slice(i, i + CHUNK));
  }
  return out;
}

const placeholders = (n: number) => new Array(n).fill("?").join(",");

/**
 * Records real usage of the bot in this guild. Called for every command, so
 * reading a leaderboard counts as activity just as much as reporting a match.
 * Clears any pending purge: a guild that comes back rescues itself.
 */
export async function touchGuild(
  db: D1Database,
  guildId: string,
): Promise<void> {
  const ts = now();
  await db
    .prepare(
      "INSERT INTO guilds (guild_id, first_seen, last_seen, last_active) VALUES (?1, ?2, ?2, ?2) " +
        "ON CONFLICT (guild_id) DO UPDATE SET last_seen = ?2, last_active = ?2, " +
        "marked_for_purge_at = NULL",
    )
    .bind(guildId, ts)
    .run();
}

export async function trackedGuildIds(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT guild_id FROM guilds")
    .all<{ guild_id: string }>();
  return results.map((r) => r.guild_id);
}

/** Flags guilds for eventual purging. Already-flagged guilds keep their original
 * timestamp, so the grace period can't be extended by repeated sweeps. */
export async function markForPurge(
  db: D1Database,
  guildIds: string[],
  ts: number,
): Promise<number> {
  let marked = 0;
  for (const chunk of chunked(guildIds)) {
    const { meta } = await db
      .prepare(
        `UPDATE guilds SET marked_for_purge_at = ? WHERE marked_for_purge_at IS NULL ` +
          `AND guild_id IN (${placeholders(chunk.length)})`,
      )
      .bind(ts, ...chunk)
      .run();
    marked += meta.changes ?? 0;
  }
  return marked;
}

/**
 * Confirms the bot is still installed in these guilds, without touching
 * last_active -- installation is not usage.
 *
 * Unflags any that were pending purge for having been removed. Note this does
 * NOT rescue a dormant guild: being present is why it was flagged. Only a real
 * command, via touchGuild(), clears that.
 */
export async function markStillInstalled(
  db: D1Database,
  guildIds: string[],
  ts: number,
  dormantCutoff: number,
): Promise<number> {
  let revived = 0;
  for (const chunk of chunked(guildIds)) {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM guilds WHERE marked_for_purge_at IS NOT NULL ` +
          `AND last_active >= ? AND guild_id IN (${placeholders(chunk.length)})`,
      )
      .bind(dormantCutoff, ...chunk)
      .first<{ n: number }>();
    revived += row?.n ?? 0;

    await db.batch(
      chunk.map((id) =>
        db
          .prepare(
            "INSERT INTO guilds (guild_id, first_seen, last_seen, last_active) VALUES (?1, ?2, ?2, ?2) " +
              "ON CONFLICT (guild_id) DO UPDATE SET last_seen = ?2, " +
              "marked_for_purge_at = CASE WHEN guilds.last_active >= ?3 THEN NULL " +
              "ELSE guilds.marked_for_purge_at END",
          )
          .bind(id, ts, dormantCutoff),
      ),
    );
  }
  return revived;
}

/** Installed guilds with no command use since `cutoff`. */
export async function dormantGuilds(
  db: D1Database,
  cutoff: number,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT guild_id FROM guilds WHERE last_active < ? AND marked_for_purge_at IS NULL",
    )
    .bind(cutoff)
    .all<{ guild_id: string }>();
  return results.map((r) => r.guild_id);
}

/** Guilds flagged before `cutoff`, whose grace period has now run out. */
export async function guildsReadyToPurge(
  db: D1Database,
  cutoff: number,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT guild_id FROM guilds WHERE marked_for_purge_at IS NOT NULL AND marked_for_purge_at < ?",
    )
    .bind(cutoff)
    .all<{ guild_id: string }>();
  return results.map((r) => r.guild_id);
}
