# Extracting `workers/` into its own repository

This document describes how to carve `workers/linear-agent` and
`workers/sandbox-dispatcher` (and all their support files: scripts, CI,
docs) out of the Symphony Elixir monorepo into a standalone repository,
**preserving per-file git history**.

`workers/oauth-proxy` deliberately stays in the Symphony repo — it is
not part of this split. See the "Repository layout" banner in the
parent repo's `CLAUDE.md`.

## What moves

Single contiguous path under `workers/` plus one CI workflow at the
repo root:

```
workers/linear-agent/        (whole tree)
workers/sandbox-dispatcher/  (whole tree)
workers/scripts/             (deploy/smoke/rotate/debug ops scripts)
workers/docs/                (cloudflare_sandbox_integration, linear_agent_api_v1, architecture)
workers/CLAUDE.md            (becomes the new repo's root CLAUDE.md)
workers/README.md            (becomes the new repo's root README.md)
workers/.gitignore           (becomes the new repo's root .gitignore)
.github/workflows/workers-deploy.yml   (kept at repo root in the new repo too)
```

Note that **`workers/oauth-proxy/`** is intentionally excluded.

## Prerequisites

[`git-filter-repo`](https://github.com/newren/git-filter-repo) installed
locally. It's faster, safer, and better-supported than `git
filter-branch`.

```bash
# macOS:        brew install git-filter-repo
# Debian/Ubu:   apt install git-filter-repo
# pip:          pipx install git-filter-repo
```

## Step 1 — Make a fresh, throwaway clone of Symphony

Never run `git filter-repo` against a working clone you care about — it
rewrites history irreversibly.

```bash
git clone --no-local /path/to/symphony symphony-workers-extracted
cd symphony-workers-extracted
git checkout main          # or whichever branch you're extracting from
```

`--no-local` forces a real network-style clone (decoupled object
store), which is what `git filter-repo` requires.

## Step 2 — Filter to only the worker-related paths

```bash
git filter-repo \
  --path workers/linear-agent/ \
  --path workers/sandbox-dispatcher/ \
  --path workers/scripts/ \
  --path workers/docs/ \
  --path workers/CLAUDE.md \
  --path workers/README.md \
  --path workers/.gitignore \
  --path .github/workflows/workers-deploy.yml
```

This keeps exactly those paths (and the full commit history that
touched any of them). Everything else — `lib/`, `dashboard/`, `config/`,
`test/`, the root `CLAUDE.md`, `AGENTS.md`, `README.md`, `mix.*`,
`workers/oauth-proxy/`, etc. — is gone. Per-file rename history
(including the `scripts/*.sh` → `workers/scripts/*.sh` and `docs/*` →
`workers/docs/*` moves made during the consolidation PR) is followed
through automatically.

## Step 3 — Point the clone at its new remote

Create the new empty GitHub repo first (e.g.
`markoinla/symphony-workers`), then:

```bash
git remote add origin git@github.com:markoinla/symphony-workers.git
git push -u origin main
```

## Step 4 — Set up the new repo's secrets and Wrangler accounts

The deploy workflow at `.github/workflows/workers-deploy.yml` expects
these repo secrets (same names as in Symphony):

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `LINEAR_AGENT_ADMIN_TOKEN`

Worker secrets in Cloudflare (`DISPATCH_HMAC_SECRET`,
`LINEAR_*_CLIENT_SECRET`, `ADMIN_TOKEN`, etc.) are stored on the
Cloudflare side, not GitHub. They do not move during extraction. Just
re-confirm via `npx wrangler secret list` after first deploy.

## Step 5 — Drop the workers tree from the Symphony repo

In the Symphony working clone (not the extraction clone), once the new
repo is live and you've verified a deploy from it:

```bash
git rm -r workers/linear-agent workers/sandbox-dispatcher \
          workers/scripts workers/docs workers/CLAUDE.md \
          workers/README.md workers/.gitignore
git rm .github/workflows/workers-deploy.yml
```

Keep `workers/oauth-proxy/` — it stays. After that delete you may also
want to:

- Update `CLAUDE.md` "Repository layout" banner to drop the
  `linear-agent` / `sandbox-dispatcher` references.
- Update `AGENTS.md` similarly.
- Remove the now-orphan root `package.json` + `package-lock.json` if
  you haven't already (they only declared `@cloudflare/sandbox`, which
  was never imported at root — see the "things to clean up later" note
  in the extraction PR).
- Update the doc comments in
  `lib/symphony_elixir/cloudflare/dispatcher_client.ex` and its test
  to link to the new repo if you want a hard cross-reference.

Commit and push that cleanup to Symphony as a separate PR.

## What we deliberately did **not** consolidate

- `.github/workflows/workers-deploy.yml` stays under `.github/` (not
  `workers/.github/`) because GitHub only honors workflow files at the
  repo root. After extraction it lands at the new repo's root
  `.github/`, exactly where it needs to be. The Symphony repo's other
  workflows (`pr-check.yml`, `docker-build.yml`) are not worker-related
  and stay in Symphony.

- `.secrets/admin-token` is per-developer, gitignored, and is never
  committed. Re-create yours in the new repo root after extraction.

## Sanity-checking the extracted repo before pushing

From inside the extraction clone, post-filter:

```bash
ls -la                      # should show workers/, .github/ — nothing else
ls workers/                 # linear-agent  sandbox-dispatcher  scripts  docs  CLAUDE.md  README.md  .gitignore
git log --oneline | wc -l   # commit count should be smaller than Symphony's
git log --oneline -- workers/linear-agent/src/index.ts | head    # original Symphony hashes preserved

cd workers/sandbox-dispatcher && npm ci && npm run typecheck && npm test
cd ../linear-agent          && npm ci && npm run typecheck && npm test
```

If those all pass and the `workers-deploy.yml` workflow's paths still
match (`workers/**`), the new repo is ready.
