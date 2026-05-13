-- Track Linear OAuth access-token expiry on each install so we can
-- proactively refresh before `expires_at` instead of only reacting to
-- 401s mid-session. Mirrors the `linear_oauth.expires_at` Setting that
-- the Elixir orchestrator's `SymphonyElixir.Linear.OAuth.Refresher`
-- relies on for scheduling (lib/symphony_elixir/linear/oauth/refresher.ex).
--
-- Nullable: existing rows have no recorded expiry, so the refresh path
-- treats NULL as "unknown — refresh defensively on next use". After the
-- first refresh the column is populated and subsequent sessions skip
-- the round-trip when the token still has comfortable runway.

ALTER TABLE linear_agent_installs ADD COLUMN expires_at INTEGER;
