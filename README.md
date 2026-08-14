# BotBot

A Discord bot for tracking casual Transformers TCG matches, built on Cloudflare
Workers and D1. Every server that adds it gets its own independent record and
its own seasons.

BotBot is a spiritual successor to [SeekerBot](https://github.com/yequari/seekerbot)
by yequari; see [what changed](#what-changed-since-seekerbot).

## Commands

| Command | Who | What |
| --- | --- | --- |
| `/report player1 games1 player2 games2 [deck1] [deck2]` | anyone | Record a match |
| `/stats [player] [timeframe]` | anyone | A player's record this season |
| `/leaderboard [count] [timeframe]` | anyone | Current standings |
| `/undo` | either player | Withdraw your most recent match, within 10 minutes |
| `/match recent [count]` | anyone | List recent matches with their ids |
| `/match delete <id>` | **admins** | Remove any recorded match |
| `/season current` · `/season list` | anyone | Inspect seasons |
| `/season standings <name>` | anyone | Final standings for any past season |
| `/season start <name>` | **admins** | Close the season and start fresh |
| `/season rename <name>` | **admins** | Rename the current season, keeping its matches |

Running a beta? [TESTING.md](TESTING.md) is a Discord-only run-through for
testers, with exact expected replies.

## Local testing

`npm run smoke` drives a locally running Worker with genuinely signed
interactions, so it exercises signature verification, every handler, and the D1
writes without touching Discord:

```sh
npx wrangler d1 migrations apply botbot --local
npx wrangler dev --test-scheduled     # in another terminal
npm run smoke                         # generates a test keypair on first run
```

The first run writes a throwaway keypair to `.smoke-key.pem` and its public half
to `.dev.vars`, both gitignored, then asks you to restart `wrangler dev` so it
picks the key up. `--test-scheduled` is what exposes the retention job; without
it that check is skipped rather than failed.

It cannot test anything Discord renders: whether an ephemeral flag really hides
a reply, whether suppressed mentions really stay silent, or whether Discord
enforces command permissions. Those need a real server, which is what
[TESTING.md](TESTING.md) is for.

### Correcting the record

`/undo` covers a fumbled score. Either player in the match can withdraw it
within 10 minutes.

Any edit after that is an admin job: `/match recent` surfaces match ids, and
`/match delete <id>` removes one after showing exactly what will go and asking
for confirmation.

**Every deletion is announced in the channel.** Both `/undo` and `/match delete`
reply publicly, naming who removed what:

> **Match withdrawn by @bob**
> ~~`#31` @alice 2 – @bob 0 · 2 minutes ago, reported by @alice~~

That message is deliberately the only remaining record (the row is gone), so it
doubles as the audit trail.

### Seasons instead of wipes

Resetting the record is `/season start "Season 2"`. Nothing is deleted; the old
season is stamped with an end date and new matches attach to the new one, so
standings start clean while past results survive. A partial unique index
guarantees each server has at most one open season at a time.

`/leaderboard` and `/stats` always mean the season in progress. To read a
finished one, `/season list` gives the names and `/season standings <name>`
gives the table. Names are matched case-insensitively and are not required to
be unique; if two seasons share one, the most recent wins and the reply says
so.

### Naming the first season

No season exists until it is needed: the first `/report` opens one named
"Season 1". That is right for a new server and wrong for one continuing an
existing count, so on a fresh install have an admin run `/season start "<name>"`
**before announcing the bot**.

If someone reports first, use `/season rename`, not `/season start`. Rename
adopts the matches already recorded; starting a new season would strand them
under the auto-generated name.

## Moderation

To cut off someone abusing the bot: **Server Settings → Integrations → BotBot →
Manage**, then under **Roles and Members** add them and toggle their access off.
Set at the app level it covers every command at once, and they stop appearing for
that person. The same panel restricts commands to particular channels.

This is narrower than a kick, which is usually what you want:

- **Their access stops,** before the command reaches BotBot.
- **Their history survives.** BotBot stores nothing about permissions.
- **Others can still record matches with them.** The check is on who *runs* a
  command, not the user IDs inside it.

Caveats:

- **Administrator bypasses all overrides.** Strip the role first.
- **100 overrides per command,** counting users, roles, and channels together.
- **Do not use it to _grant_ `/season start`, `/season rename`, or
  `/match delete` to a non-admin role.** BotBot re-checks for Administrator
  itself, so Discord would offer the command and BotBot would refuse it.
- **It does not reach buttons.** Component interactions bypass command
  permissions; the `/match delete` confirmation is safe only because the handler
  re-checks Administrator on the press.
- **There is no rate limiting.** The remedy is reactive: notice, then deny.

## Setup

1. **Create the app** at the [Discord Developer Portal](https://discord.com/developers/applications).
   Note the Application ID, Public Key, and Bot token.

2. **Create the database** and paste the printed id into `wrangler.jsonc`:

   ```sh
   npx wrangler d1 create botbot
   npm run db:migrate
   ```

3. **Set secrets:**

   ```sh
   npx wrangler secret put DISCORD_PUBLIC_KEY
   npx wrangler secret put DISCORD_TOKEN
   ```

   `DISCORD_APPLICATION_ID` is only needed locally, by the registration script.
   Put it in a `.env` or export it in your shell. `DISCORD_TOKEN` is needed in
   both places: locally to register commands, and in the Worker for the weekly
   retention job.

4. **Register the commands.** Pass a guild id while iterating; guild commands
   propagate immediately, global ones can take up to an hour to appear.

   ```sh
   npm run register -- <your_guild_id>            # development
   npm run register -- <your_guild_id> --clear    # before going global
   npm run register -- --global                   # for release
   ```

   The `--` is required; without it npm swallows the flags and the script sees
   no arguments. Global registration is behind an explicit `--global` for that
   reason, so a swallowed flag cannot publish commands by accident.

   Clear the test guild's copies before registering globally. Guild and global
   registrations stack rather than replace, so that server would otherwise see
   every command listed twice.

5. **Deploy**, then set the Worker URL as the **Interactions Endpoint URL** in
   the Developer Portal. Discord probes it with an intentionally invalid
   signature and expects a 401; the Worker handles that.

   ```sh
   npm run deploy
   ```

6. **Invite it** with the `applications.commands` scope. The bot needs no
   gateway intents and no message permissions.

## Architecture notes

BotBot is written in TypeScript and runs entirely on Cloudflare's developer
platform: a single Worker handles every request, with match data in D1,
Cloudflare's serverless SQLite database, managed through Wrangler migrations.
Because a Worker cannot hold a persistent WebSocket connection, it is built as
an HTTP-interactions app rather than a traditional gateway bot: Discord POSTs
each slash command to the Worker, which verifies the Ed25519 request signature
using `discord-interactions` (the only runtime dependency) and answers within
that same HTTP response, leaving no background process at all. Slash commands
are registered separately by a small Node script against Discord's REST API, and
a weekly Cron Trigger handles data retention by reconciling against Discord's
guild list. The schema, covering seasons, matches, reports, and guilds with
every row scoped to a single server, was written fresh, though the
one-row-per-player-per-match model is inherited from SeekerBot; multi-row writes
go through D1's `batch()` so a match and its two result rows land together or
not at all.

The decisions worth not reversing:

**HTTP interactions, not a gateway.** Workers can't hold a WebSocket to
Discord, so the bot is a webhook receiver: it only ever sees explicit slash
commands. It cannot read messages, and there is no background process.

**Snowflakes are `TEXT`.** Discord IDs exceed 2^53 and D1's JS binding returns
`INTEGER` columns as lossy JS numbers.

**Writes go through `batch()`.** D1 has no interactive transactions. `/report`
inserts one `matches` row and two `reports` rows, which must land together or
not at all.

**Names are never stored.** Players render as `<@id>` mentions, so display names
always match each server's nicknames and can never go stale. Replies set
`allowed_mentions: { parse: [] }` so a leaderboard doesn't ping everyone on it.

**Guild scoping.** Every table carries `guild_id` and every query in
[`src/db.ts`](src/db.ts) filters on it. `matches.guild_id` is denormalized from
its season on purpose: it keeps the hot queries single-join and makes a
cross-guild leak require two independent mistakes.

## Data retention

A server that keeps BotBot installed keeps its history for as long as it wants it, 
however long it goes between matches.

When the bot is removed, that server's data is erased 30 days later. There is no
gateway to deliver a `GUILD_DELETE` event, so a weekly Cron Trigger reconciles
the `guilds` table against `GET /users/@me/guilds`, which is ground truth for
where the bot is installed. Deletion is two-phase: a server is flagged on the
first reconcile that misses it and erased a grace period later, so a bot removed
and re-added the same week loses nothing. Re-flagging keeps the original
timestamp, so the grace period cannot drift.

Two safeguards in [`src/reconcile.ts`](src/reconcile.ts): a partial guild fetch
throws rather than returning what it has, and a successful response listing zero
servers while local data exists aborts the run (that shape means a revoked
token, not a mass exodus). Nothing is deleted unless ground truth was fully
established.

## What changed since SeekerBot

[SeekerBot](https://github.com/yequari/seekerbot) tracked Transformers TCG
community servers' matches for years. BotBot is a fresh build rather than a
fork, but its data model, one row per player per match, is SeekerBot's design.

### New

- **Reset the standings in one command.** `/season start` clears the leaderboard
  without deleting anything, and `/season list` keeps past seasons readable.
- **Admins can remove any match.** `/match delete <id>`, with the match shown for
  confirmation first, and `/match recent` to find the id.
- **Every deletion is announced,** naming who removed what. Since the row is
  gone, that message is the receipt.
- **Optional deck tracking** on `/report`, recorded per player.
- **Data doesn't outlive its welcome.** Removing the bot from a server erases
  that server's history. See [Data retention](#data-retention).

### Improved

- **A longer, accountable undo.** Ten minutes instead of five, and withdrawing a
  match announces it in the channel, naming both players and whoever ran it.
- **Slash commands with real inputs:** labelled fields, a player picker, scores
  validated before submission, timeframes as a menu.
- **Names are always current.** Players render as live mentions.
- **No message-reading permission,** because everything is a slash command.
- **Nothing to keep running.** Workers wake on demand.

### Carried over

- Match reporting with per-game scores, so 2–0 and 2–1 stay distinguishable
- Player stats and leaderboards, filterable by week, month, year, or all time
- Per-server isolation. SeekerBot gave each server its own SQLite file; BotBot
  tags every row with its server, which is what D1 allows. Same outcome.
- The `reports`-per-player data model, which is why scores, draws, and decks all
  fit without contortions
- Undo scoped to either player in the match, which is SeekerBot's rule. The
  loser is often the one who notices a wrong score.