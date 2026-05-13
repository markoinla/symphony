-- Per-event timeline rows for an agent session.
--
-- Replaces the previous design of accumulating an `eventSummary` array
-- inside the SessionRunner workflow step and writing the full JSON blob
-- into `agent_sessions.messages` from `record-session-end`. That blob
-- (a) had to survive Workflows' ~1 MiB step-output ceiling on every
-- turn, which a chatty run could exceed, and (b) only landed if the
-- workflow reached its terminal step — any throw from a turn step left
-- the row unpopulated.
--
-- This table is appended to live as events stream from the dispatcher,
-- so the dashboard sees timeline rows incrementally and a workflow
-- crash doesn't lose them. `agent_sessions.messages` is kept for
-- historical rows; the debug endpoint prefers this table when any
-- rows exist for the session.
--
-- ON DELETE CASCADE so dropping the parent session also wipes its
-- event history.

CREATE TABLE agent_session_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  turn        INTEGER NOT NULL,
  ts          INTEGER NOT NULL, -- unix milliseconds (matches Date.now())
  type        TEXT    NOT NULL, -- thought | assistant_msg | tool_call | tool_result | error | result | turn_end | other
  body        TEXT             -- truncated payload; NULL when the event has no useful body
);

-- (session_id, id) is the read pattern used by the debug endpoint —
-- the autoincrement id is monotonic per-row so it doubles as a stable
-- ordering key without needing a separate timestamp index.
CREATE INDEX idx_agent_session_events_session ON agent_session_events(session_id, id);
