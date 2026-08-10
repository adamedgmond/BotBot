// Registers slash commands with Discord. Run this after changing commands.mjs;
// the Worker itself never registers anything.
//
//   npm run register -- <guild_id>           -> that guild only, instantly
//   npm run register -- <guild_id> --clear   -> remove that guild's copies
//   npm run register -- --global             -> global, cached up to ~1 hour
//
// The `--` after `npm run register` is required: without it npm swallows any
// flags and this script sees an empty argv. Global registration is therefore
// behind an explicit --global rather than being the zero-argument default, so
// a swallowed flag can never publish commands by accident.
//
// Clear a test guild's commands before going global, or that guild sees every
// command twice: guild and global registrations stack rather than replace.
//
// Requires DISCORD_TOKEN and DISCORD_APPLICATION_ID in the environment.

import { commands } from "./commands.mjs";

const USAGE = `Usage:
  npm run register -- <guild_id>           register to one guild
  npm run register -- <guild_id> --clear   remove that guild's commands
  npm run register -- --global             register globally

Note the "--": npm swallows flags without it.`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const KNOWN_FLAGS = new Set(["--clear", "--global"]);

const unknown = args.filter((a) => a.startsWith("-") && !KNOWN_FLAGS.has(a));
if (unknown.length > 0) {
  // A typo like --clera must not quietly fall through to re-registering.
  fail(`Unknown option: ${unknown.join(", ")}\n\n${USAGE}`);
}

const positional = args.filter((a) => !a.startsWith("-"));
if (positional.length > 1) {
  fail(`Expected at most one guild id, got: ${positional.join(", ")}`);
}

const guildId = positional[0];
const clear = args.includes("--clear");
const isGlobal = args.includes("--global");

if (!guildId && !isGlobal) fail(USAGE);
if (guildId && isGlobal) {
  fail("Pass a guild id or --global, not both.");
}
if (clear && !guildId) {
  fail("--clear needs a guild id. Refusing to wipe global commands.");
}

const token = process.env.DISCORD_TOKEN;
const appId = process.env.DISCORD_APPLICATION_ID;
if (!token || !appId) {
  fail("Set DISCORD_TOKEN and DISCORD_APPLICATION_ID first.");
}

const url = guildId
  ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${appId}/commands`;

const response = await fetch(url, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(clear ? [] : commands),
});

if (!response.ok) {
  console.error(`Registration failed (${response.status}):`);
  console.error(await response.text());
  process.exit(1);
}

if (clear) {
  console.log(`Cleared all commands from guild ${guildId}.`);
  process.exit(0);
}

const registered = await response.json();
console.log(
  `Registered ${registered.length} commands ${guildId ? `in guild ${guildId}` : "globally"}:`,
);
for (const c of registered) console.log(`  /${c.name}`);
