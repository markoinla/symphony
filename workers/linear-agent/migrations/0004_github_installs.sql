-- SYM-284: GitHub App installation tracking per org.
-- One row per org; stores the GitHub App installation_id so we can
-- mint scoped installation tokens via github-app.ts.

CREATE TABLE IF NOT EXISTS github_installs (
  org_id          TEXT PRIMARY KEY,
  install_id      INTEGER NOT NULL,
  account_login   TEXT NOT NULL,
  account_type    TEXT NOT NULL DEFAULT 'Organization',
  repo_selection  TEXT NOT NULL DEFAULT 'all',
  selected_repos  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
