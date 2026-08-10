// Registers slash commands with Discord. Run this after changing commands.mjs;
// the Worker itself never registers anything.
//
//   node scripts/register.mjs            -> global (cached up to ~1 hour)
//   node scripts/register.mjs <guild_id> -> that guild only, propagates instantly
//
// Requires DISCORD_TOKEN and DISCORD_APPLICATION_ID in the environment.

import { commands } from "./commands.mjs";

const token = process.env.DISCORD_TOKEN;
const appId = process.env.DISCORD_APPLICATION_ID;

if (!token || !appId) {
  console.error("Set DISCORD_TOKEN and DISCORD_APPLICATION_ID first.");
  process.exit(1);
}

const guildId = process.argv[2];
const url = guildId
  ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${appId}/commands`;

const response = await fetch(url, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(commands),
});

if (!response.ok) {
  console.error(`Registration failed (${response.status}):`);
  console.error(await response.text());
  process.exit(1);
}

const registered = await response.json();
console.log(
  `Registered ${registered.length} commands ${guildId ? `in guild ${guildId}` : "globally"}:`,
);
for (const c of registered) console.log(`  /${c.name}`);
