-- Add GitHub App installation id to the installations table.
-- Each org that installs the Symphony GitHub App on their GitHub org
-- gets a numeric installation id from GitHub. We store it here so
-- session-runner can mint short-lived installation tokens per /run.

ALTER TABLE installations ADD COLUMN github_app_installation_id INTEGER;
