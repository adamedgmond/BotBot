// End-to-end smoke test against a locally running Worker.
//
//   npx wrangler d1 migrations apply botbot --local
//   npx wrangler dev            # in another terminal
//   npm run smoke
//
// This drives the real Worker over HTTP with genuinely signed interactions, so
// it covers signature verification, routing, every handler, and the D1 writes.
// It does not cover anything Discord renders: whether an ephemeral flag really
// hides a reply, whether mentions really stay silent, or whether Discord
// enforces command permissions. Those need a real server.
//
// A test keypair is generated into .smoke-key.pem and its public half written
// to .dev.vars. Both are gitignored. Restart `wrangler dev` after the first run
// so it picks the key up.

import crypto from "node:crypto";
import fs from "node:fs";

const URL_BASE = process.env.SMOKE_URL ?? "http://localhost:8787";
const KEY_FILE = ".smoke-key.pem";

// --- signing ---------------------------------------------------------------

function loadKey() {
  if (fs.existsSync(KEY_FILE)) {
    return crypto.createPrivateKey(fs.readFileSync(KEY_FILE));
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(KEY_FILE, privateKey.export({ format: "pem", type: "pkcs8" }));

  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const vars = fs.existsSync(".dev.vars") ? fs.readFileSync(".dev.vars", "utf8") : "";
  if (!vars.includes("DISCORD_PUBLIC_KEY")) {
    fs.appendFileSync(
      ".dev.vars",
      `DISCORD_PUBLIC_KEY=${raw.toString("hex")}\nDISCORD_TOKEN=smoke-test-not-a-real-token\n`,
    );
  }
  console.log("Generated a test keypair. Restart `wrangler dev`, then rerun.\n");
  process.exit(1);
}

const key = loadKey();

async function post(payload, { sign = true } = {}) {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = sign
    ? crypto.sign(null, Buffer.from(ts + body), key).toString("hex")
    : "ab".repeat(64);
  const res = await fetch(URL_BASE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": signature,
      "x-signature-timestamp": ts,
    },
    body,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text, content: json?.data?.content ?? "" };
}

// --- interaction builders --------------------------------------------------

const GUILD = "SMOKE_GUILD";
const OTHER = "SMOKE_OTHER";

const member = (id, admin) => ({
  user: { id, username: `user-${id}` },
  permissions: admin ? "8" : "0",
});

const command = (name, options, o = {}) => ({
  type: 2,
  guild_id: o.guild ?? GUILD,
  member: member(o.by ?? "ALICE", o.admin ?? false),
  data: { name, options },
});

const sub = (name, subName, options = [], o = {}) =>
  command(name, [{ name: subName, type: 1, options }], o);

const button = (customId, o = {}) => ({
  type: 3,
  guild_id: o.guild ?? GUILD,
  member: member(o.by ?? "ALICE", o.admin ?? false),
  data: { custom_id: customId, component_type: 2 },
});

const report = (p1, g1, p2, g2, o = {}) =>
  command(
    "report",
    [
      { name: "player1", type: 6, value: p1 },
      { name: "games1", type: 4, value: g1 },
      { name: "player2", type: 6, value: p2 },
      { name: "games2", type: 4, value: g2 },
    ],
    o,
  );

// --- assertions ------------------------------------------------------------

let passed = 0;
const failures = [];

function check(label, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(`${label}${detail ? `\n         ${detail}` : ""}`);
    console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ""}`);
  }
}

const has = (res, text) => res.content.includes(text);

function section(name) {
  console.log(`\n${name}`);
}

// --- the run ---------------------------------------------------------------

section("transport and signatures");
{
  const root = await fetch(URL_BASE);
  check("GET / serves a banner", root.status === 200);

  const bad = await post({ type: 1 }, { sign: false });
  check("bad signature is rejected with 401", bad.status === 401, `got ${bad.status}`);

  const ping = await post({ type: 1 });
  if (ping.status === 401) {
    console.error("\nSigned request rejected. Restart `wrangler dev` to load .dev.vars.");
    process.exit(1);
  }
  check("PING answers PONG", ping.json?.type === 1, JSON.stringify(ping.json));

  const dm = await post({ type: 2, user: { id: "X" }, data: { name: "leaderboard" } });
  check("no guild_id is refused", has(dm, "only works inside a server"), dm.content);
}

section("seasons");
{
  const denied = await sub("season", "start", [{ name: "name", type: 3, value: "Nope" }]);
  const r = await post(denied);
  check("non-admin cannot start a season", has(r, "Only server administrators"), r.content);
  check("refusals are ephemeral", r.json?.data?.flags === 64, `flags=${r.json?.data?.flags}`);

  const ok = await post(
    sub("season", "start", [{ name: "name", type: 3, value: "Smoke Season" }], { admin: true }),
  );
  check("admin starts a season", has(ok, "**Smoke Season** has begun"), ok.content);

  const empty = await post(command("leaderboard", []));
  check("empty season reports no matches", has(empty, "No matches recorded in **Smoke Season**"), empty.content);
}

section("reporting");
{
  const r = await post(report("ALICE", 2, "BOB", 0));
  check("match is recorded", has(r, "<@ALICE> defeated <@BOB> 2-0"), r.content);
  check("mentions are suppressed", r.json?.data?.allowed_mentions?.parse?.length === 0);

  const draw = await post(report("CAROL", 1, "DAVE", 1));
  check("a draw reads as a draw", has(draw, "drew with"), draw.content);

  const self = await post(report("ALICE", 2, "ALICE", 0));
  check("self-match is refused", has(self, "cannot play themselves"), self.content);

  const nil = await post(report("ALICE", 0, "BOB", 0));
  check("0-0 is refused", has(nil, "needs to have won a game"), nil.content);

  const lb = await post(command("leaderboard", []));
  check("leaderboard ranks the winner first", /1\.\*\* <@ALICE>/.test(lb.content), lb.content);
  check("leaderboard counts the draw", lb.content.includes("0-0-1"), lb.content);
}

section("undo");
{
  const r = await post(report("EVE", 2, "FRANK", 1, { by: "EVE" }));
  check("match reported for undo", has(r, "<@EVE> defeated <@FRANK>"), r.content);

  // Either player may withdraw, so undo as the loser who did not file it.
  const undone = await post(command("undo", [], { by: "FRANK" }));
  check("opponent can withdraw the match", has(undone, "**Match withdrawn by <@FRANK>**"), undone.content);
  check("withdrawal names the original reporter", has(undone, "reported by <@EVE>"), undone.content);

  const again = await post(command("undo", [], { by: "FRANK" }));
  check("second undo finds nothing", has(again, "no matches from the last"), again.content);
  check("that refusal is ephemeral", again.json?.data?.flags === 64);
}

section("reporting after a deletion (rowid regression)");
{
  // Deleting a match desynchronises the matches and reports rowid counters.
  // last_insert_rowid() used to be reused for the second player's row, which
  // either failed the foreign key or silently attached them to another match.
  const r = await post(report("GRACE", 2, "HEIDI", 0, { by: "GRACE" }));
  check("report still succeeds after a deletion", has(r, "<@GRACE> defeated <@HEIDI>"), r.content);

  const recent = await post(sub("match", "recent"));
  const line = recent.content.split("\n").find((l) => l.includes("GRACE"));
  check("both players are on the new match", !!line && line.includes("HEIDI"), line ?? recent.content);
}

section("admin match removal");
{
  const recent = await post(sub("match", "recent"));
  const id = Number(recent.content.match(/#(\d+)/)?.[1]);
  check("match ids are listed", Number.isInteger(id), recent.content);

  const opts = [{ name: "id", type: 4, value: id }];
  const denied = await post(sub("match", "delete", opts));
  check("non-admin cannot delete", has(denied, "Only server administrators"), denied.content);

  const missing = await post(sub("match", "delete", [{ name: "id", type: 4, value: 999999 }], { admin: true }));
  check("unknown id is refused", has(missing, "No match `#999999` in this server"), missing.content);

  const prompt = await post(sub("match", "delete", opts, { admin: true }));
  const customId = prompt.json?.data?.components?.[0]?.components?.[0]?.custom_id;
  check("delete asks for confirmation", has(prompt, "Delete this match?"), prompt.content);
  check("confirmation carries a button", customId === `match:delete:${id}`, String(customId));
  check("confirmation is public", prompt.json?.data?.flags === 0, `flags=${prompt.json?.data?.flags}`);

  const byPlayer = await post(button(customId, { by: "BOB", admin: false }));
  check("non-admin pressing the button is refused", has(byPlayer, "Only server administrators"), byPlayer.content);

  const byAdmin = await post(button(customId, { admin: true }));
  check("admin pressing the button deletes", has(byAdmin, "**Match deleted by"), byAdmin.content);

  const twice = await post(button(customId, { admin: true }));
  check("second press is harmless", has(twice, "no longer exists"), twice.content);
}

section("guild isolation");
{
  await post(report("XAVIER", 2, "YOLANDA", 0, { guild: OTHER, by: "XAVIER" }));

  const here = await post(command("leaderboard", []));
  check("other guild's players are absent here", !here.content.includes("XAVIER"), here.content);

  const there = await post(command("leaderboard", [], { guild: OTHER }));
  check("other guild sees only its own", there.content.includes("XAVIER") && !there.content.includes("ALICE"), there.content);

  const theirs = await post(sub("match", "recent", [], { guild: OTHER }));
  const theirId = Number(theirs.content.match(/#(\d+)/)?.[1]);
  const crossDelete = await post(sub("match", "delete", [{ name: "id", type: 4, value: theirId }], { admin: true }));
  check("cannot delete another guild's match by id", has(crossDelete, "in this server"), crossDelete.content);
}

section("season rollover and history");
{
  const before = await post(command("leaderboard", []));

  const renamed = await post(sub("season", "rename", [{ name: "name", type: 3, value: "Smoke Season Renamed" }], { admin: true }));
  check("season renames", has(renamed, "is now **Smoke Season Renamed**"), renamed.content);

  const after = await post(command("leaderboard", []));
  check("rename keeps every match", after.content.split("\n").length === before.content.split("\n").length, after.content);

  const rolled = await post(sub("season", "start", [{ name: "name", type: 3, value: "Smoke Season 2" }], { admin: true }));
  check("season rolls", has(rolled, "is closed and **Smoke Season 2** has begun"), rolled.content);

  const fresh = await post(command("leaderboard", []));
  check("new season starts empty", has(fresh, "No matches recorded in **Smoke Season 2**"), fresh.content);

  const list = await post(sub("season", "list"));
  check("both seasons are listed", has(list, "Smoke Season Renamed") && has(list, "Smoke Season 2"), list.content);

  const past = await post(sub("season", "standings", [{ name: "name", type: 3, value: "smoke season renamed" }]));
  check(
    "past standings are readable, case-insensitively",
    has(past, "**Smoke Season Renamed**") && /\*\*1\.\*\* <@/.test(past.content),
    past.content,
  );

  const nope = await post(sub("season", "standings", [{ name: "name", type: 3, value: "Never Existed" }]));
  check("unknown season name is refused", has(nope, "No season called"), nope.content);
}

section("scheduled retention");
{
  // Needs `wrangler dev --test-scheduled`. Without it the path falls through
  // to the fetch handler and answers with the banner, so detect that and skip
  // rather than reporting a pass or a failure that means nothing.
  let body = "";
  for (const path of ["/cdn-cgi/handler/scheduled?format=json", "/__scheduled?cron=*+*+*+*+*"]) {
    const res = await fetch(`${URL_BASE}${path}`);
    const text = await res.text();
    if (!text.startsWith("BotBot:")) { body = text; break; }
  }
  if (body === "") {
    console.log("  skip reconcile check (restart with `wrangler dev --test-scheduled`)");
  } else {
    // DISCORD_TOKEN is deliberately fake, so the guild fetch must fail and the
    // job must abort rather than treating "no guilds" as "everyone left".
    check("reconcile fails closed on a bad token", /exception|error/i.test(body), body.slice(0, 160));
  }

  const still = await post(command("leaderboard", [], { guild: OTHER }));
  check("a failed reconcile deletes nothing", still.content.includes("XAVIER"), still.content);
}

// --- result ----------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
