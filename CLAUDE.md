# Working contract for this repo

This file is the contract for any Claude session working in this repo
(`gargantuanick/holdem`). It applies to **this repo only**.

## After a meaningful change

When finishing a meaningful change to source files:

1. Build all three workspaces:
   ```
   npm run build -w @holdem/shared && \
   npm run build -w @holdem/server && \
   npm run build -w @holdem/client
   ```
2. Run server tests:
   ```
   npm test -w @holdem/server
   ```
3. **Only if both pass**, commit and push.
4. **Never** push if tests fail. **Never** `git add -A`. Stage only the
   files actually touched.
5. If the change touches `server/` or `shared/`, **also deploy the
   server to Railway manually** (see "Deploying the server" below).
   `git push` alone is not enough for the server right now —
   Railway's GitHub integration is broken (see notes there). Client-
   only changes (only `client/` touched) auto-deploy via Netlify and
   need no extra step.

## How to push

Two paths, depending on environment:

### From a normal shell or Claude Code (preferred)

`git` works directly. Stage explicitly, commit with a HEREDOC message, push:

```
git add path/to/file1 path/to/file2
git commit -F- <<'EOF'
short subject

body explaining the change
EOF
git push origin main
```

### From Cowork (sandboxed)

`git commit` and `git push` don't work because the sandbox can't write to
`.git/`. Use the API-based pusher in `scripts/push-via-api.mjs` instead.
This is **only** wired up for this repo — it's hard-pinned to
`gargantuanick/holdem` and refuses to run anywhere else.

```
GH_TOKEN=ghp_... node scripts/push-via-api.mjs \
  --message "short subject

  body explaining the change" \
  --file path/to/file1 \
  --file path/to/file2
```

Flags:
- `--dry-run` — log the file list and exit without calling GitHub.
- `--with-migration` — required if any `server/migrations/*.sql` is in
  the file list. Schema changes can't be rolled back by reverting code,
  so this flag exists to make the caller pause.
- `--revert <sha>` — create a revert commit on top of `main` for the
  given commit. Uses the same API path. Logs the revert SHA on success.
- Globs are not accepted. Pass every file by name.

`GH_TOKEN` is a fine-grained GitHub PAT scoped to **only this repo**
with `contents:write`. It must never be checked in or logged.

## Rolling back

Three options, fastest to slowest:

1. **Platform-level rollback.** Both Netlify and Railway keep deploy
   history. To stop the bleeding fast, re-promote the previous deploy
   from their dashboard. Takes ~30s and doesn't touch git. Works for
   the server even though auto-deploy is broken — the Railway
   dashboard's "redeploy" on a prior deploy is independent of the
   GitHub link.
2. **Revert via the script.** Each successful push logs its own SHA
   and the revert command. Run that command, the script creates a
   revert commit on `main`. Netlify auto-deploys; for the server,
   follow up with `cd server && railway up` to push the revert.
3. **Revert via GitHub UI.** Open the commit on github.com → Revert
   button → merge. Same caveat — server still needs `railway up`.

Note: a code revert does NOT undo a SQL migration. Schema rollbacks
need a down-migration file written and applied separately.

## Auto-deploy

- **Netlify** (client) — auto-deploys. Builds `client/` on every push
  to `main`, serves at https://holdem-nk.netlify.app (and
  https://poker.gargantua.llc if the custom domain is wired up). No
  manual step needed.
- **Railway** (server) — **NOT auto-deploying right now.** The
  GitHub App connection on this repo is broken (the repo doesn't
  show up in Railway's "Connect Repo" dropdown despite the App
  having `All repositories` access). Until that's resolved, server
  deploys are manual via the Railway CLI.

So a push to `main` is "live on Netlify in ~30s" but the server
stays on whatever was last `railway up`'d.

## Deploying the server

Until Railway auto-deploy is restored, run this from a normal shell
(not Cowork — the CLI needs interactive auth):

```
cd server
railway up
```

First-time setup on a new machine:
```
npm i -g @railway/cli
railway login          # opens browser
railway link           # pick the holdem project + the server service
```

`railway up` packages the current working tree of `server/` (plus
the `@holdem/shared` workspace it depends on), builds, and replaces
the running deployment. The Railway dashboard shows a new deploy
ID and the in-memory state is wiped — i.e., any seated players are
evicted on restart.

To verify the deploy landed: open Railway → Deployments → confirm a
fresh timestamp on the active deploy. The Beginner Stakes table
will show `0/6` after a server restart since seats are not
persisted to Postgres.

### When Railway's GitHub integration is fixed

If/when the Connect Repo dropdown finally shows `gargantuanick/
holdem`, reconnect it and remove the manual `railway up` step from
the workflow above. Things tried so far that did NOT fix it:
- Setting GitHub App "Repository access" to "All repositories"
- Suspending and unsuspending the Railway GitHub App installation
- Hard refresh of Railway's dashboard

Things still worth trying:
- Uninstall the Railway GitHub App entirely on github.com, then
  reinstall fresh from Railway's "Connect Repo" flow
- Disconnect/reconnect Railway's account-level GitHub integration
  in Railway → Account Settings → Integrations

## What to commit

Source files only. Don't commit:
- `node_modules/`, `dist/`, `*.tsbuildinfo`
- `.env*` (only `.env.example` if updated)
- `client/vite.config.ts.timestamp-*.mjs` (vite scratch artefact)
- Files under `server/src/game/__tests__/_qa/` are scratch QA tests —
  they're fine to commit but expect them to be pruned over time.

## Sandbox limitations (Cowork-only)

Heads-up that two things won't work from Cowork:

- The full `npm run build` in step 1 fails on the client step with
  `EPERM` (the bridge blocks deleting files in `client/dist/`). Substitute
  `npx tsc -b --noEmit` in `client/` to typecheck, and run the real
  build from your shell. Server + shared builds work fine.
- `git` operations on `.git/` fail. Use `scripts/push-via-api.mjs`.
