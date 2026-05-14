-- Store the immutable Linear issue key (e.g. SYM-359) separately from
-- the human-editable issue title so dashboard routes and filters do not
-- depend on ambiguous titles.
ALTER TABLE agent_sessions ADD COLUMN linear_issue_identifier TEXT;
