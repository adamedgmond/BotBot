// Slash command definitions. Shared by scripts/register.mjs.
// Option types: 3=STRING, 4=INTEGER, 6=USER, 1=SUB_COMMAND

const TIMEFRAME = {
  name: "timeframe",
  description: "How far back to look (default: whole season)",
  type: 3,
  required: false,
  choices: [
    { name: "This week", value: "week" },
    { name: "This month", value: "month" },
    { name: "This year", value: "year" },
    { name: "Whole season", value: "all" },
  ],
};

export const commands = [
  {
    name: "report",
    description: "Record the result of a match",
    options: [
      { name: "player1", description: "First player", type: 6, required: true },
      { name: "games1", description: "Games won by the first player", type: 4, required: true, min_value: 0, max_value: 9 },
      { name: "player2", description: "Second player", type: 6, required: true },
      { name: "games2", description: "Games won by the second player", type: 4, required: true, min_value: 0, max_value: 9 },
      { name: "deck1", description: "First player's deck (optional)", type: 3, required: false },
      { name: "deck2", description: "Second player's deck (optional)", type: 3, required: false },
    ],
  },
  {
    name: "stats",
    description: "Show a player's record this season",
    options: [
      { name: "player", description: "Whose stats to show (default: you)", type: 6, required: false },
      TIMEFRAME,
    ],
  },
  {
    name: "leaderboard",
    description: "Show the current season standings",
    options: [
      { name: "count", description: "How many players to list (1-25, default 10)", type: 4, required: false, min_value: 1, max_value: 25 },
      TIMEFRAME,
    ],
  },
  {
    name: "undo",
    // Deliberately no time limit in the text: this file can't import the
    // constant from src/, so a number here would drift. The reply says it.
    description: "Withdraw a match you just played, so it can be re-entered",
  },
  {
    name: "match",
    description: "Inspect or remove recorded matches",
    // Same reasoning as /season: default_member_permissions is command-wide and
    // `recent` should be readable by anyone. `delete` is gated in handlers.ts.
    options: [
      {
        name: "recent",
        description: "List recent matches with their ids",
        type: 1,
        options: [
          { name: "count", description: "How many to list (1-25, default 10)", type: 4, required: false, min_value: 1, max_value: 25 },
        ],
      },
      {
        name: "delete",
        description: "Remove a recorded match (admins only)",
        type: 1,
        options: [
          { name: "id", description: "Match id, from /match recent", type: 4, required: true, min_value: 1 },
        ],
      },
    ],
  },
  {
    name: "season",
    description: "View or roll over the season",
    // Deliberately not restricted with default_member_permissions: that applies
    // to the whole command, and `current`/`list` should be readable by anyone.
    // `start` is guarded server-side in handlers.ts instead.
    options: [
      {
        name: "start",
        description: "Close the current season and start a fresh one",
        type: 1,
        options: [
          { name: "name", description: "Name for the new season", type: 3, required: true },
        ],
      },
      {
        name: "rename",
        description: "Rename the season in progress, keeping its matches",
        type: 1,
        options: [
          { name: "name", description: "New name for the current season", type: 3, required: true },
        ],
      },
      { name: "current", description: "Show the season in progress", type: 1 },
      { name: "list", description: "List past seasons", type: 1 },
    ],
  },
];
