# Beta testing BotBot

A run-through you can do entirely from Discord. It takes about 30 minutes.

Work through the rounds **in order**: several cases depend on what earlier ones
left behind, and Round 6 only means anything after Round 5 has deleted
something.

## What you need

- **Two people minimum.** Call them **Admin** (has the Administrator role) and
  **Player** (an ordinary member). Some cases only fail when the wrong person
  runs them.
- Both in the same channel.
- A third person is useful but not required.

Some replies are **private**, meaning only the person who ran the command sees
them. Those are marked *(private)*. If a private reply shows up publicly, or a
public one shows up privately, that is itself a bug worth reporting.

Cases marked **★** can only be checked on a real server. Everything else is also
covered by the automated suite (`npm run smoke`, 43 assertions against a local
copy), so a failure there is surprising and worth reporting immediately.

## What the automated suite cannot check

This is why the run-through exists. Nothing outside Discord can confirm:

- that a *(private)* reply is actually hidden from everyone else
- that mentions on a leaderboard really do stay silent
- that Discord enforces command permissions and the delete button renders
- that the 10 minute undo window expires on real clocks
- how any of it reads to someone who has not seen the code

## Reporting a problem

Open an issue at <https://github.com/adamedgmond/BotBot/issues> with:

1. The exact command you ran, including who ran it
2. What you expected
3. What actually happened, ideally a screenshot
4. Which round and case number

---

## Round 1: empty server

Do these **before anyone reports a match**. They only work once.

- [ ] **1.1** `/season list` → "No seasons here yet."
- [ ] **1.2** `/leaderboard` → "No matches have been recorded here yet."
- [ ] **1.3** `/match recent` → "No matches have been recorded here yet."
- [ ] **1.4** `/stats` → "No matches have been recorded here yet."
- [ ] **1.5** `/undo` → *(private)* "You have no matches from the last 10
      minutes to undo."

## Round 2: opening a season

- [ ] **2.1** Player runs `/season start name:"Nope"` → *(private)* "Only server
      administrators can start a new season."
- [ ] **2.2** ★ Confirm Player's refusal was invisible to Admin.
- [ ] **2.3** Admin runs `/season start name:"Beta Test"` → "**Beta Test** has
      begun."
- [ ] **2.4** `/leaderboard` → "No matches recorded in **Beta Test** yet."
      Note this is **different** from the message in 1.2. A season now exists.
- [ ] **2.5** `/season list` → one entry, Beta Test, running to "now".

## Round 3: reporting matches

- [ ] **3.1** `/report player1:@Admin games1:2 player2:@Player games2:0` →
      "Recorded in **Beta Test**: @Admin defeated @Player 2-0."
- [ ] **3.2** Report a 1-1 → the wording changes to "drew with".
- [ ] **3.3** Report where the first player loses → wording is "lost to".
- [ ] **3.4** Report with the **same person** in both slots → *(private)* "A
      player cannot play themselves."
- [ ] **3.5** Report a 0-0 → *(private)* "At least one player needs to have won
      a game."
- [ ] **3.6** ★ Try to type a score of 10 → Discord refuses before it sends.
- [ ] **3.7** `/leaderboard` → check the win-loss numbers by hand. Draws show as
      a third number, so 1-0-1 means one win, no losses, one draw.
- [ ] **3.8** `/stats` with no player → your own record.
- [ ] **3.9** `/stats player:@Player` → their record.
- [ ] **3.10** `/stats` on someone who has never played → "@them has no matches
      in **Beta Test** yet."
- [ ] **3.11** ★ **Nobody gets pinged.** With several people on the leaderboard,
      confirm no one gets a notification. Names should appear as highlighted
      mentions but stay silent.

## Round 4: withdrawing a match

`/undo` works for **either player** in the match, not just whoever reported it.

- [ ] **4.1** Admin reports a match, then immediately runs `/undo` → public
      "**Match withdrawn by @Admin**" with the match struck through.
- [ ] **4.2** Run `/undo` again → *(private)* "You have no matches from the last
      10 minutes to undo."
- [ ] **4.3** Admin reports a match against Player. **Player** runs `/undo` →
      it works, and the notice names Player as the one who withdrew it while
      still showing Admin as who reported it.
- [ ] **4.4** A third person, not in any recent match, runs `/undo` →
      *(private)* nothing to undo.
- [ ] **4.5** Report **two** matches back to back, then `/undo` once → the
      **second** one is withdrawn, not the first. Matches recorded in the same
      second used to come back in arbitrary order.
- [ ] **4.6** ★ Report a match, wait **more than 10 minutes**, then `/undo` →
      *(private)* nothing to undo. Save this for the end of your session.

## Round 5: admin match removal

- [ ] **5.1** `/match recent` → a list with ids like `#4`, newest first, each
      showing both players, how long ago, and who reported it.
- [ ] **5.2** Ids may **skip numbers**. That is expected, not a bug.
- [ ] **5.3** Player runs `/match delete id:<real id>` → *(private)* "Only
      server administrators can delete matches."
- [ ] **5.4** Admin runs `/match delete id:999999` → *(private)* "No match
      #999999 in this server. Check `/match recent`."
- [ ] **5.5** Admin runs `/match delete id:<real id>` → a **public** message
      showing the match with a red **Delete** button. Nothing deleted yet.
- [ ] **5.6** ★ **Player clicks that Delete button** → *(private)* "Only server
      administrators can delete matches." The match survives and the button
      stays. This is the most important case in this round: the prompt is public
      on purpose, so this check is the only thing standing between a normal
      member and someone else's match.
- [ ] **5.7** Admin clicks Delete → the prompt is replaced with "**Match deleted
      by @Admin**" and the match struck through.
- [ ] **5.8** Admin clicks the same button again → "Match #N no longer
      exists; it may have been deleted already."
- [ ] **5.9** `/leaderboard` → the deleted match is gone from the standings.

## Round 6: reporting after a deletion

**Do this immediately after Round 5.** Deleting a match used to corrupt the next
one recorded: the second player was silently filed against a different match, or
the report failed outright. It only showed up once something had been deleted,
which is exactly the state you are now in.

- [ ] **6.1** Report a fresh match between two people who have **not** played
      each other yet → recorded normally, no error.
- [ ] **6.2** `/match recent` → the new match lists **both** players, with the
      scores you entered.
- [ ] **6.3** `/leaderboard` → both players moved by exactly one match. Nobody
      else's record changed.
- [ ] **6.4** Report two or three more, then `/match recent` → every entry shows
      two players. An entry with one player, or with somebody who was not in
      that match, is a serious bug. Report it straight away.

## Round 7: rolling the season and reading history

- [ ] **7.1** Player runs `/season rename name:"Nope"` → *(private)* "Only
      server administrators can rename a season."
- [ ] **7.2** Admin runs `/season rename name:"Beta Test Renamed"` → "**Beta
      Test** is now **Beta Test Renamed**."
- [ ] **7.3** `/leaderboard` → **unchanged**. Renaming must not lose matches.
- [ ] **7.4** Admin runs `/season start name:"Season Two"` → "**Beta Test
      Renamed** is closed and **Season Two** has begun."
- [ ] **7.5** `/leaderboard` → empty, "No matches recorded in **Season Two**
      yet."
- [ ] **7.6** `/season list` → both seasons, the old one with an end date.
- [ ] **7.7** Report a match, then `/leaderboard` → only the new match counts.
- [ ] **7.8** `/leaderboard season:"Beta Test Renamed"` → the **old** season's
      table with its date range. This is the only way to read a finished season,
      so check the numbers against what Rounds 3 to 6 left.
- [ ] **7.9** `/leaderboard season:"beta test renamed"` in lower case → same
      result. Matching ignores case.
- [ ] **7.10** `/leaderboard season:"Nonexistent"` → *(private)* "No season
      called **Nonexistent** here."
- [ ] **7.11** Admin runs `/season start` with a name longer than 64 characters
      → *(private)* "Season names are limited to 64 characters."

## Round 8: odd inputs

- [ ] **8.1** `/leaderboard count:1` → exactly one player.
- [ ] **8.2** ★ Try any BotBot command in a **direct message** to the bot. Either
      it is unavailable, or you get "BotBot only works inside a server."
- [ ] **8.3** Report a match against a **bot account**. It is currently allowed.
      Tell us if you think it should not be.
- [ ] **8.4** Report the same match twice → both are recorded, as two separate
      matches. Expected, but say so if it feels wrong.
- [ ] **8.5** ★ Have an admin remove Player's access under **Server Settings →
      Integrations → BotBot**, then have Player try a command. It should not
      appear for them at all. Restore it afterwards.

## Round 9: two servers (optional but valuable)

Needs BotBot in a second server.

- [ ] **9.1** Report matches in server B. Server A's `/leaderboard` and
      `/match recent` do not show them.
- [ ] **9.2** Take a match id from server A and run `/match delete` on it in
      server B → "No match #N in this server."
- [ ] **9.3** Each server has its own seasons. `/season list` in one does not
      show the other's.

---

## Not covered here

**Data retention.** Removing BotBot from a server erases that server's history
30 days later. Nothing else deletes data: a quiet server keeps its record
indefinitely. That job runs weekly and cannot be triggered from Discord.

**Load.** There is no rate limiting. If you want to hammer it, say so first.

## Things we already know

- Match ids are shared across all servers, so they skip numbers. Cosmetic.
- Deleting a match cannot be undone. The announcement is the only record.
- A season, once started, cannot be deleted. `/season rename` works; removal
  does not.
- `/stats` always means the current season. `/leaderboard` takes an optional
  `season` to read a finished one.
- There is no week or month filter. Seasons are how BotBot buckets time.
