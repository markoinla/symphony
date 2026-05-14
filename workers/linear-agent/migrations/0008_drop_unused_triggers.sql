-- 0008_drop_unused_triggers.sql
--
-- Drop trigger rows whose event_type is no longer supported by the
-- inbound webhook mapper. Both event types had a working resolver
-- path but no upstream event source after we audited the mapper:
--
--   - `comment_added` needed an inline Linear GraphQL fetch from the
--     Comment envelope to populate the issue context the dispatcher
--     requires. Not worth paying inside the 5s webhook SLA window.
--   - `label_removed` would have required a label-name cache —
--     Linear's webhook only ships the old labelIds, not the names,
--     so name-keyed triggers can't match reliably.
--
-- The seed used to plant a `/retry` comment_added trigger on every
-- org's first webhook delivery, so prod almost certainly has rows
-- to clean up. Without this, the workflow editor renders these rows
-- with an empty event-type picker and saves 400 on the way out.
--
-- The `comment_match` column on workflow_triggers is left in place
-- — no schema change here. It just becomes always-NULL going forward.

DELETE FROM workflow_triggers
WHERE event_type IN ('comment_added', 'label_removed');
