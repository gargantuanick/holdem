# Deployment guide

Split hosting: client on Netlify, server on Render free tier, database on Supabase. All three sit under custom subdomains of `gargantua.llc`.

## 1. Supabase (database)

1. Create a new project at https://supabase.com.
2. Once provisioned, go to **Project Settings → Database → Connection Pooling**.
3. Copy the **Transaction-mode** URL (port `6543`). It looks like:
   ```
   postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
   ```
   This is the URL we'll use as `DATABASE_URL`. Do **not** use the direct connection on port 5432 — Render free tier may scale connections, and the pooler protects Supabase's per-project connection limit (~60).
4. No further setup required: the Node server runs SQL migrations from `/server/migrations` automatically on first boot. Row-level security is left off — the server is the sole client.

## 2. Render (server)

1. Connect your GitHub repo at https://render.com.
2. **New → Blueprint** and point it at this repo. Render will pick up `/server/render.yaml`.
3. Set the env vars on the new service:
   - `DATABASE_URL` — the Supabase pooled URL from step 1.
   - `CLIENT_ORIGIN` — initially `http://localhost:5173`, will be updated after DNS in step 5.
4. Deploy. Render serves at `https://<service>.onrender.com`. Confirm `/health` returns 200.

The free tier sleeps after ~15 min idle and takes ~30s to wake. The client is built to handle this gracefully (it shows a "connecting…" state and Socket.IO auto-reconnects).

## 3. Netlify (client)

1. Connect the repo at https://netlify.com.
2. Netlify auto-picks up `/netlify.toml` (base = `client`, build = `npm run build`, publish = `client/dist`).
3. Set the env var:
   - `VITE_SERVER_URL` — initially the Render `.onrender.com` URL from step 2; will become the custom subdomain after step 5.
4. Deploy. Netlify serves at `https://<site>.netlify.app`.

## 4. DNS

In your `gargantua.llc` DNS:

| Record | Name | Value |
|--------|------|-------|
| CNAME | `poker` | (Netlify-provided target, e.g. `<site>.netlify.app`) |
| CNAME | `poker-api` | (Render-provided target, e.g. `<service>.onrender.com`) |

Both Netlify and Render will issue Let's Encrypt certificates for the subdomains automatically. Wait for SSL to provision (usually a few minutes after propagation).

## 5. Final wiring

After DNS propagates and certs are issued:

1. Update `VITE_SERVER_URL` on Netlify to `https://poker-api.gargantua.llc` and trigger a rebuild.
2. Update `CLIENT_ORIGIN` on Render to `https://poker.gargantua.llc` and redeploy.

That's it — `https://poker.gargantua.llc` is live.

## Notes & troubleshooting

- **First-request lag:** Render free tier cold starts take ~30s. Players see a brief loading state on a freshly-woken server.
- **Connection limits:** the Supabase pooler is shared. We keep `DB_POOL_MAX=10` per server instance by default; tune via env var if you scale Render dynos.
- **Migrations:** add new SQL files in `/server/migrations` with a numeric prefix (e.g. `002_something.sql`). They apply in lex order on next boot. Each filename is recorded in `schema_migrations` and won't re-apply.
- **CORS / WebSocket upgrade:** Render's HTTPS termination supports WebSocket upgrade with no extra config. CORS origin is read from `CLIENT_ORIGIN`.
