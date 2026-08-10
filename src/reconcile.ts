import * as db from "./db.js";

/**
 * A guild is flagged for purging once it has gone this long without a single
 * command. Servers that install a match tracker are servers that actively play,
 * so total silence for this long means abandoned, not off-season.
 */
export const DORMANCY_SECONDS = 5 * 365 * 86400;

/**
 * How long a flagged guild survives before its data is erased. Long enough to
 * absorb an accidental kick, a server rebuild, or a bad reconcile.
 */
export const GRACE_PERIOD_SECONDS = 30 * 86400;

/** Discord caps this at 200 per page, so a bot in 201 guilds must paginate. */
const PAGE_SIZE = 200;

export interface ReconcileResult {
  installed: number;
  flaggedRemoved: number;
  flaggedDormant: number;
  unflagged: number;
  purged: number;
}

/**
 * Fetches every guild the bot is currently installed in.
 *
 * Throws rather than returning a partial list: callers delete data based on
 * absence from this set, so an incomplete answer is far worse than no answer.
 */
async function fetchInstalledGuilds(token: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let after: string | undefined;

  for (;;) {
    const url = new URL("https://discord.com/api/v10/users/@me/guilds");
    url.searchParams.set("limit", String(PAGE_SIZE));
    if (after) url.searchParams.set("after", after);

    const response = await fetch(url, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!response.ok) {
      throw new Error(
        `GET /users/@me/guilds failed: ${response.status} ${await response.text()}`,
      );
    }

    const page = (await response.json()) as Array<{ id: string }>;
    for (const g of page) ids.add(g.id);

    if (page.length < PAGE_SIZE) return ids;
    after = page[page.length - 1].id;
  }
}

/**
 * Flags guilds that have been removed or have gone dormant, then purges
 * anything flagged longer than the grace period.
 *
 * Deletion is two-phase on purpose. A guild is only flagged when first
 * detected and erased a grace period later, so a transient API failure, a bot
 * removed and re-added the same week, or a server returning from a long
 * hiatus all cost nothing.
 */
export async function reconcileGuilds(
  database: D1Database,
  token: string,
): Promise<ReconcileResult> {
  const installed = await fetchInstalledGuilds(token);

  // A successful call returning zero guilds is indistinguishable from a
  // revoked token or a bad app id, and acting on it would erase everything.
  const tracked = await db.trackedGuildIds(database);
  if (installed.size === 0 && tracked.length > 0) {
    throw new Error(
      "Discord reports the bot is in no guilds while local data exists; " +
        "refusing to purge. Check DISCORD_TOKEN.",
    );
  }

  const now = db.now();
  const dormantCutoff = now - DORMANCY_SECONDS;

  const removed = tracked.filter((id) => !installed.has(id));
  const flaggedRemoved = await db.markForPurge(database, removed, now);
  const unflagged = await db.markStillInstalled(
    database,
    [...installed],
    now,
    dormantCutoff,
  );

  // Run after markStillInstalled so newly-tracked guilds are visible, and so a
  // guild can't be flagged removed and dormant in the same pass.
  const dormant = await db.dormantGuilds(database, dormantCutoff);
  const flaggedDormant = await db.markForPurge(database, dormant, now);

  const expired = await db.guildsReadyToPurge(
    database,
    now - GRACE_PERIOD_SECONDS,
  );
  for (const guildId of expired) {
    await db.purgeGuild(database, guildId);
  }

  return {
    installed: installed.size,
    flaggedRemoved,
    flaggedDormant,
    unflagged,
    purged: expired.length,
  };
}
