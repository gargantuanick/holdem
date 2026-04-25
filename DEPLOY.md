# Deployment guide

Split hosting: client on Netlify, server on Railway, database on Supabase. All three sit under custom subdomains of `gargantua.llc`.

## 1. Supabase (database)

1. Create a new project at https://supabase.com. Save the database password you set during creation — you'll need it next.
2. Go to **Project Settings → Database → Connection string**.
3. Select **Transaction** mode (port `6543`) and copy the URI. It looks like:
   ```
   postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
   ```
   Replace `<password>` with the project password from step 1. This is `DATABASE_URL`. Do **not** use the direct `5432` connection — the pooler protects Supabase's per-project connection limit.
4. No further setup required: the Node server runs SQL migrations from `/server/migrations` automatically on first boot. Row-level security is left off — the server is the sole client.

## 2. Railway (server)

1. In the Railway dashboard, open your project (`446e721d-3563-4fc5-b803-16240bafbe2f`).
2. **+ New → GitHub Repo** and select `gargantuanick/holdem`. Railway picks up `/railway.json` at the repo root for build + start commands.
3. Under the new service's **Variables**, set:
   - `DATABASE_URL` — the Supabase pooled URL from step 1.
   - `CLIENT_ORIGIN` — initially `http://localhost:5173`; will be updated after DNS in step 4.
   - `NODE_VERSION` — `20`.
4. Under **Settings → Networking → Public Networking**, click **Generate Domain**. Railway issues a `*.up.railway.app` URL. Confirm `https://<that-url>/health` returns 200.

Railway's free tier doesn't sleep like Render's, but does have a monthly execution-time cap. The client is still built to tolerate disconnects (Socket.IO auto-reconnects).

## 3. Netlify (client)

1. Connect the repo at https://netlify.com.
2. Netlify auto-picks up `/netlify.toml` (base = `client`, build = `npm run build`, publish = `client/dist`).
3. Set the env var:
   - `VITE_SERVER_URL` — initially the Railway `.up.railway.app` URL from step 2; will become the custom subdomain after step 4.
4. Deploy. Netlify serves at `https://<site>.netlify.app`.

## 4. DNS

In your `gargantua.llc` DNS:

| Record | Name | Value |
|--------|------|-------|
| CNAME | `poker` | (Netlify-provided target, e.g. `<site>.netlify.app`) |
| CNAME | `poker-api` | (Railway-provided target, from custom domain panel) |

In Railway: **Settings → Networking → Custom Domain → Add `poker-api.gargantua.llc`** to get the CNAME target.
In Netlify: **Domain settings → Add custom domain → `poker.gargantua.llc`**.

Both providers issue Let's Encrypt certs automatically once the CNAMEs propagate.

## 5. Final wiring

After DNS propagates and certs are issued:

1. Update `VITE_SERVER_URL` on Netlify to `https://poker-api.gargantua.llc` and trigger a rebuild.
2. Update `CLIENT_ORIGIN` on Railway to `https://poker.gargantua.llc` and let it redeploy.

That's it — `https://poker.gargantua.llc` is live.

## Notes & troubleshooting

- **Monorepo build:** `railway.json` runs `npm install` at the repo root (workspaces) then builds `@holdem/shared` and `@holdem/server` in order. The client is **not** built on Railway — it ships via Netlify.
- **Connection limits:** the Supabase pooler is shared. We keep `DB_POOL_MAX=10` per server instance by default; tune via env var if you scale Railway replicas.
- **Migrations:** add new SQL files in `/server/migrations` with a numeric prefix (e.g. `002_something.sql`). They apply in lex order on next boot. Each filename is recorded in `schema_migrations` and won't re-apply.
- **CORS / WebSocket upgrade:** Railway's HTTPS termination supports WebSocket upgrade with no extra config. CORS origin is read from `CLIENT_ORIGIN`.
