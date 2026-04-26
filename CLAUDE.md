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
   from their dashboard. Takes ~30s and doesn't touch git.
2. **Revert via the script.** Each successful push logs its own SHA
   and the revert command. Run that command, the script creates a
   revert commit on `main`, auto-deploy follows.
3. **Revert via GitHub UI.** Open the commit on github.com → Revert
   button → merge.

Note: a code revert does NOT undo a SQL migration. Schema rollbacks
need a down-migration file written and applied separately.

## Auto-deploy

`main` is wired to:
- **Netlify** (client) — builds `client/` on push, serves at
  https://poker.gargantua.llc.
- **Railway** (server) — builds `server/` on push, serves at
  https://poker-api.gargantua.llc.

So a push to `main` is the same event as "the change is live in prod."

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
