// Registers slash commands with Discord. Run this after changing commands.mjs;
// the Worker itself never registers anything.
//
//   node scripts/register.mjs                    -> global (cached up to ~1 hour)
//   node scripts/register.mjs <guild_id>         -> that guild only, instantly
//   node scripts/register.mjs <guild_id> --clear -> remove that guild's copies
//
// Clear a guild's commands before going global, or that guild sees every
// command twice: guild and global registrations stack rather than replace.
//
// Requires DISCORD_TOKEN and DISCORD_APPLICATION_ID in the environment.

import { commands } from "./commands.mjs";

const token = process.env.DISCORD_TOKEN;
const appId = process.env.DISCORD_APPLICATION_ID;

if (!token || !appId) {
  console.error("Set DISCORD_TOKEN and DISCORD_APPLICATION_ID first.");
  process.exit(1);
}

// Skip flags when looking for the guild id, or `--clear` alone would be read
// as the guild and PUT an empty list to a nonsense endpoint.
const args = process.argv.slice(2);
const guildId = args.find((a) => !a.startsWith("--"));
const clear = args.includes("--clear");

if (clear && !guildId) {
  console.error("--clear needs a guild id. Refusing to wipe global commands.");
  process.exit(1);
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
