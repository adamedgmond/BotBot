import * as db from "./db.js";
import {
  ButtonStyle,
  ComponentType,
  reply,
  updateMessage,
  UserError,
} from "./respond.js";
import { isAdmin, optionMap, subcommand, type Interaction } from "./types.js";

/** custom_id for the delete-confirmation button: `match:delete:<id>`. */
const DELETE_PREFIX = "match:delete:";

const TIMEFRAMES: Record<string, number> = {
  week: 7 * 86400,
  month: 30 * 86400,
  year: 365 * 86400,
  all: 0,
};

function since(timeframe: string): number {
  const span = TIMEFRAMES[timeframe] ?? 0;
  return span === 0 ? 0 : db.now() - span;
}

const UNDO_MINUTES = Math.round(db.UNDO_WINDOW_SECONDS / 60);

function record(r: db.StatRow): string {
  const rate = r.matches ? Math.round((r.wins / r.matches) * 100) : 0;
  const draws = r.draws ? `-${r.draws}` : "";
  return `${r.wins}-${r.losses}${draws} (${rate}%)`;
}

export async function handle(
  interaction: Interaction,
  env: { DB: D1Database },
): Promise<Response> {
  const guildId = interaction.guild_id;
  if (!guildId) {
    throw new UserError("BotBot only works inside a server, not in DMs.");
  }
  const callerId = interaction.member?.user.id ?? interaction.user?.id;
  if (!callerId) throw new UserError("Could not identify you.");

  const name = interaction.data?.name;

  switch (name) {
    case "report":
      return report(interaction, env.DB, guildId, callerId);
    case "stats":
      return stats(interaction, env.DB, guildId, callerId);
    case "leaderboard":
      return leaderboard(interaction, env.DB, guildId);
    case "undo":
      return undo(env.DB, guildId, callerId);
    case "season":
      return season(interaction, env.DB, guildId);
    case "match":
      return match(interaction, env.DB, guildId);
    default:
      throw new UserError(`Unknown command \`${name ?? "?"}\`.`);
  }
}

/** Handles button presses. Currently only the delete confirmation. */
export async function handleComponent(
  interaction: Interaction,
  env: { DB: D1Database },
): Promise<Response> {
  const guildId = interaction.guild_id;
  if (!guildId) throw new UserError("BotBot only works inside a server.");

  const customId = interaction.data?.custom_id ?? "";
  if (!customId.startsWith(DELETE_PREFIX)) {
    throw new UserError("That button is no longer valid.");
  }

  // The prompt is public, so anyone can reach this button. Authorisation lives
  // here, not in who can see it -- and permissions may have changed between
  // the prompt and the press regardless.
  if (!isAdmin(interaction.member)) {
    throw new UserError("Only server administrators can delete matches.");
  }
  const actor = interaction.member?.user.id;

  const matchId = Number(customId.slice(DELETE_PREFIX.length));
  if (!Number.isInteger(matchId)) {
    throw new UserError("That button is no longer valid.");
  }

  // Read before deleting so the echo can describe what was removed. Once the
  // row is gone this message is the only remaining record of it.
  const target = await db.matchDetail(env.DB, guildId, matchId);
  const deleted = await db.deleteMatch(env.DB, guildId, matchId);

  if (!deleted || !target) {
    return updateMessage(
      `Match \`#${matchId}\` no longer exists; it may have been deleted already.`,
    );
  }

  return updateMessage(
    `**Match deleted by <@${actor}>**\n~~${describeMatch(target)}~~`,
  );
}

async function report(
  interaction: Interaction,
  database: D1Database,
  guildId: string,
  callerId: string,
): Promise<Response> {
  const o = optionMap(interaction.data?.options);
  const p1 = String(o.player1);
  const p2 = String(o.player2);
  const g1 = Number(o.games1);
  const g2 = Number(o.games2);

  if (p1 === p2) throw new UserError("A player cannot play themselves.");
  if (g1 === 0 && g2 === 0) {
    throw new UserError("At least one player needs to have won a game.");
  }

  const season = await db.ensureSeason(database, guildId);
  await db.reportMatch(
    database,
    guildId,
    season.season_id,
    callerId,
    { userId: p1, games: g1, deck: o.deck1 ? String(o.deck1) : undefined },
    { userId: p2, games: g2, deck: o.deck2 ? String(o.deck2) : undefined },
  );

  const verb = g1 === g2 ? "drew with" : g1 > g2 ? "defeated" : "lost to";
  return reply(
    `Recorded in **${season.name}**: <@${p1}> ${verb} <@${p2}> ${g1}-${g2}.\n` +
      `_Wrong? Either player can \`/undo\` within ${UNDO_MINUTES} minutes, ` +
      `then report it again._`,
  );
}

async function stats(
  interaction: Interaction,
  database: D1Database,
  guildId: string,
  callerId: string,
): Promise<Response> {
  const o = optionMap(interaction.data?.options);
  const target = o.player ? String(o.player) : callerId;
  const timeframe = o.timeframe ? String(o.timeframe) : "all";

  const season = await db.currentSeason(database, guildId);
  if (!season) return reply("No matches have been recorded here yet.");

  const row = await db.statsFor(
    database,
    guildId,
    season.season_id,
    since(timeframe),
    target,
  );
  if (!row) {
    return reply(`<@${target}> has no matches in **${season.name}** yet.`);
  }
  return reply(
    `**<@${target}>** · ${season.name}${timeframe === "all" ? "" : ` (past ${timeframe})`}\n` +
      `${record(row)} across ${row.matches} match${row.matches === 1 ? "" : "es"}.`,
  );
}

async function leaderboard(
  interaction: Interaction,
  database: D1Database,
  guildId: string,
): Promise<Response> {
  const o = optionMap(interaction.data?.options);
  const limit = Math.min(Math.max(Number(o.count ?? 10), 1), 25);
  const timeframe = o.timeframe ? String(o.timeframe) : "all";

  const season = await db.currentSeason(database, guildId);
  if (!season) return reply("No matches have been recorded here yet.");

  const rows = await db.leaderboard(
    database,
    guildId,
    season.season_id,
    since(timeframe),
    limit,
  );
  if (rows.length === 0) {
    return reply(`No matches recorded in **${season.name}** yet.`);
  }

  return reply(
    standings(
      `**${season.name}** leaderboard${timeframe === "all" ? "" : ` (past ${timeframe})`}`,
      rows,
    ),
  );
}

/** Shared by `/leaderboard` and `/season standings`. */
function standings(heading: string, rows: db.StatRow[]): string {
  const lines = rows.map(
    (r, i) => `**${i + 1}.** <@${r.user_id}> · ${record(r)}`,
  );
  return `${heading}\n${lines.join("\n")}`;
}

async function undo(
  database: D1Database,
  guildId: string,
  callerId: string,
): Promise<Response> {
  const removed = await db.undoLast(database, guildId, callerId);
  if (!removed) {
    // Nothing happened, so keep the noise out of the channel.
    return reply(
      `You have no matches from the last ${UNDO_MINUTES} minutes to undo.`,
      { ephemeral: true },
    );
  }
  // Public, and names both players. Either player can withdraw a match, so this
  // announcement is the whole accountability story: it puts the withdrawal in
  // front of the opponent instead of relying on who was allowed to run it.
  return reply(
    `**Match withdrawn by <@${callerId}>**\n~~${describeMatch(removed)}~~`,
  );
}

/** `#12  <@a> 2–0 <@b>  · <t:...:R>, reported by <@x>` */
function describeMatch(m: db.MatchDetail): string {
  const score = m.players
    .map((p) => `<@${p.user_id}> ${p.games}`)
    .join(" – ");
  return (
    `\`#${m.match_id}\` ${score} · <t:${m.played_at}:R>, ` +
    `reported by <@${m.reported_by}>`
  );
}

async function match(
  interaction: Interaction,
  database: D1Database,
  guildId: string,
): Promise<Response> {
  const sub = subcommand(interaction.data?.options);
  const o = optionMap(sub?.options);

  switch (sub?.name) {
    case "recent": {
      const limit = Math.min(Math.max(Number(o.count ?? 10), 1), 25);
      const matches = await db.recentMatches(database, guildId, limit);
      if (matches.length === 0) {
        return reply("No matches have been recorded here yet.");
      }
      return reply(
        `**Recent matches**\n${matches.map(describeMatch).join("\n")}\n` +
          `_Admins can remove one with \`/match delete\`._`,
      );
    }

    case "delete": {
      if (!isAdmin(interaction.member)) {
        throw new UserError("Only server administrators can delete matches.");
      }
      const matchId = Number(o.id);
      if (!Number.isInteger(matchId) || matchId < 1) {
        throw new UserError("Give the numeric match id from `/match recent`.");
      }

      // Show what will be destroyed before destroying it: a mistyped id should
      // be obvious here rather than discovered in the standings later.
      const target = await db.matchDetail(database, guildId, matchId);
      if (!target) {
        throw new UserError(
          `No match \`#${matchId}\` in this server. Check \`/match recent\`.`,
        );
      }

      // Deliberately public, not ephemeral. Deleting someone's result should
      // leave a visible trace, and the prompt itself is part of that record --
      // it names the match before it disappears. The button is safe to expose
      // because the press is re-checked for admin.
      return reply(
        `**Delete this match?** This cannot be undone.\n${describeMatch(target)}`,
        {
          buttons: [
            {
              type: ComponentType.BUTTON,
              style: ButtonStyle.DANGER,
              label: "Delete",
              custom_id: `${DELETE_PREFIX}${matchId}`,
            },
          ],
        },
      );
    }

    default:
      throw new UserError("Unknown `/match` subcommand.");
  }
}

/** Shared validation for the season name that `start` and `rename` both take. */
function seasonName(raw: string | number | boolean | undefined): string {
  const name = String(raw ?? "").trim();
  if (!name) throw new UserError("Give the season a name.");
  if (name.length > 64) {
    throw new UserError("Season names are limited to 64 characters.");
  }
  return name;
}

async function season(
  interaction: Interaction,
  database: D1Database,
  guildId: string,
): Promise<Response> {
  const sub = subcommand(interaction.data?.options);
  const o = optionMap(sub?.options);

  switch (sub?.name) {
    case "start": {
      // The only gate on the destructive-looking operation. Discord's
      // default_member_permissions can't scope to a single subcommand, so this
      // check is authoritative rather than belt-and-braces.
      if (!isAdmin(interaction.member)) {
        throw new UserError(
          "Only server administrators can start a new season.",
        );
      }
      const name = seasonName(o.name);
      const previous = await db.currentSeason(database, guildId);
      await db.rollSeason(database, guildId, name);
      return reply(
        previous
          ? `**${previous.name}** is closed and **${name}** has begun. ` +
              `Standings start fresh; past results stay available with \`/season list\`.`
          : `**${name}** has begun.`,
      );
    }

    case "rename": {
      if (!isAdmin(interaction.member)) {
        throw new UserError("Only server administrators can rename a season.");
      }
      const name = seasonName(o.name);
      const previous = await db.renameSeason(database, guildId, name);
      if (previous === null) {
        throw new UserError(
          "No season is open yet, so there's nothing to rename. " +
            "Use `/season start` to open one.",
        );
      }
      return reply(
        `**${previous}** is now **${name}**. Every match recorded in it is unchanged.`,
      );
    }

    case "standings": {
      const name = seasonName(o.name);
      const found = await db.seasonsNamed(database, guildId, name);
      if (found.length === 0) {
        throw new UserError(
          `No season called **${name}** here. \`/season list\` has the names.`,
        );
      }

      // Names are not unique. Take the most recent and say so, rather than
      // silently picking one of several and looking like the wrong answer.
      const target = found[0];
      const limit = Math.min(Math.max(Number(o.count ?? 10), 1), 25);
      const rows = await db.leaderboard(
        database,
        guildId,
        target.season_id,
        0,
        limit,
      );

      const span = target.ended_at
        ? `<t:${target.started_at}:D> to <t:${target.ended_at}:D>`
        : `<t:${target.started_at}:D> to now`;
      if (rows.length === 0) {
        return reply(`**${target.name}** (${span}) recorded no matches.`);
      }

      const note =
        found.length > 1
          ? `\n_${found.length} seasons share that name; this is the most recent._`
          : "";
      return reply(standings(`**${target.name}** · ${span}`, rows) + note);
    }

    case "current": {
      const current = await db.currentSeason(database, guildId);
      return reply(
        current
          ? `Current season: **${current.name}**, started <t:${current.started_at}:D>.`
          : "No season has started here yet; it opens with the first `/report`.",
      );
    }

    case "list": {
      const seasons = await db.listSeasons(database, guildId);
      if (seasons.length === 0) return reply("No seasons here yet.");
      const lines = seasons.map(
        (s) =>
          `• **${s.name}** · <t:${s.started_at}:D> to ` +
          (s.ended_at ? `<t:${s.ended_at}:D>` : "_now_"),
      );
      return reply(lines.join("\n"));
    }

    default:
      throw new UserError("Unknown `/season` subcommand.");
  }
}
