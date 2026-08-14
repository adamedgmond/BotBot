-- Drops the deck column. It was written by /report and read by nothing: no
-- query selected it and no command displayed it, so it collected data that was
-- unreachable from Discord. Tracking the metagame is a different feature with
-- its own schema needs; this was a guess at it that never paid off.
--
-- Added as a new migration rather than editing 0001, because 0001 has now been
-- applied. Migrations are append-only from here.

ALTER TABLE reports DROP COLUMN deck;
