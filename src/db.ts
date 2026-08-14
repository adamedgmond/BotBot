// Guild scoping is the invariant here: no query in this file can read or write
// another guild's rows. Anything taking a guildId threads it into the WHERE
// clause; the few that do not (trackedGuildIds, guildsReadyToPurge, and the
// purge-flag helpers) operate on the guilds table alone, which holds no match
// data.

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
  await registerGuild(db, guildId);

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

// Binds ?1 guild_id, ?2 season_id, ?3 since. Callers continue numbering at ?4,
// so adding a parameter here means renumbering both of them.
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
  // `/season start` is the documented first thing an admin runs, before any
  // report, so this can be the write that first gives a guild data. Register it
  // or retention would never see the guild at all.
  await registerGuild(db, guildId);

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

/**
 * Seasons in this guild with the given name, newest first.
 *
 * Nothing stops a guild from reusing a name, so this returns every match and
 * lets the caller pick and disclose. Matching is case-insensitive because the
 * name has to be typed by hand, from what `/season list` printed.
 */
export async function seasonsNamed(
  db: D1Database,
  guildId: string,
  name: string,
): Promise<Season[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM seasons WHERE guild_id = ? AND name = ? COLLATE NOCASE " +
        "ORDER BY started_at DESC",
    )
    .bind(guildId, name)
    .all<Season>();
  return results;
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
): Promise<MatchDetail | null> {
  const match = await db
    .prepare(
      "SELECT m.match_id FROM matches m JOIN reports r ON r.match_id = m.match_id " +
        "WHERE m.guild_id = ? AND r.user_id = ? AND m.played_at >= ? " +
        "ORDER BY m.played_at DESC LIMIT 1",
    )
    .bind(guildId, userId, now() - UNDO_WINDOW_SECONDS)
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
  // reports rows go with the matches via ON DELETE CASCADE.
  await db.batch([
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
 * Registers a guild so departure detection covers it, and clears any pending
 * purge.
 *
 * Called from the write paths that can give a guild its first data, currently
 * ensureSeason and rollSeason. The weekly reconcile keeps this table current on
 * its own; this only closes the gap where a guild installs, records something,
 * and removes the bot between two reconciles.
 */
export async function registerGuild(
  db: D1Database,
  guildId: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO guilds (guild_id) VALUES (?) " +
        "ON CONFLICT (guild_id) DO UPDATE SET marked_for_purge_at = NULL",
    )
    .bind(guildId)
    .run();
}

/**
 * Every guild we hold data for.
 *
 * Unions `seasons` rather than trusting `guilds` alone: a guild is only
 * reapable if retention can see it, so a write path that forgets to register
 * would otherwise leave data that lives forever. Seasons are the root of the
 * data model, so anything with matches has a season.
 */
export async function trackedGuildIds(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT guild_id FROM guilds UNION SELECT guild_id FROM seasons",
    )
    .all<{ guild_id: string }>();
  return results.map((r) => r.guild_id);
}

/** `(?),(?),(?)` for a multi-row VALUES list of single-column rows. */
const rowsOf1 = (n: number) => new Array(n).fill("(?)").join(",");

/**
 * Flags guilds for eventual purging, returning how many were newly flagged.
 *
 * Two statements, in this order. The insert creates rows for guilds that hold
 * data without ever having been registered, already flagged. The update then
 * flags known guilds, and its `IS NULL` predicate is what stops a repeated
 * sweep from resetting an existing flag and extending the grace period.
 */
export async function markForPurge(
  db: D1Database,
  guildIds: string[],
  ts: number,
): Promise<number> {
  let flagged = 0;
  for (const chunk of chunked(guildIds)) {
    const inserted = await db
      .prepare(
        `INSERT INTO guilds (guild_id, marked_for_purge_at) VALUES ` +
          `${chunk.map(() => "(?, ?)").join(",")} ON CONFLICT DO NOTHING`,
      )
      .bind(...chunk.flatMap((id) => [id, ts]))
      .run();

    const updated = await db
      .prepare(
        `UPDATE guilds SET marked_for_purge_at = ? WHERE marked_for_purge_at IS NULL ` +
          `AND guild_id IN (${placeholders(chunk.length)})`,
      )
      .bind(ts, ...chunk)
      .run();

    flagged += (inserted.meta.changes ?? 0) + (updated.meta.changes ?? 0);
  }
  return flagged;
}

/**
 * Confirms the bot is still installed in these guilds, clearing any pending
 * purge: being present disproves the only reason a guild is ever flagged.
 *
 * Returns how many were flagged and are now cleared, i.e. removed and re-added
 * inside the grace period, which is the case the two-phase delete exists for.
 */
export async function markStillInstalled(
  db: D1Database,
  guildIds: string[],
): Promise<number> {
  let revived = 0;
  for (const chunk of chunked(guildIds)) {
    const cleared = await db
      .prepare(
        `UPDATE guilds SET marked_for_purge_at = NULL ` +
          `WHERE marked_for_purge_at IS NOT NULL ` +
          `AND guild_id IN (${placeholders(chunk.length)})`,
      )
      .bind(...chunk)
      .run();
    revived += cleared.meta.changes ?? 0;

    await db
      .prepare(
        `INSERT INTO guilds (guild_id) VALUES ${rowsOf1(chunk.length)} ` +
          `ON CONFLICT DO NOTHING`,
      )
      .bind(...chunk)
      .run();
  }
  return revived;
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
